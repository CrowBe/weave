"""Bounded CPU measurement of Kev's typed-decision contract.

Upstream already owns scoring: `kev.benchmark` defines the metrics, validates
returned distributions, and writes the report. This script does not reimplement
any of that. It contributes the two things upstream's CLI does not provide and
that a bounded local experiment needs:

  1. A deterministic, source-stratified subsample. The development split is 1204
     records; on this CPU a full pass costs hours. A subsample makes the
     measurement affordable, but it cannot be drawn record by record: a permuted
     record is scored against its clean parent, and a contrastive pair is scored
     against its sibling. Sampling below that granularity does not degrade the
     report, it raises. So the sampling unit is the connected component over
     parent-group and contrastive-pair edges, and the component closure is
     asserted before anything is scored.

  2. A constant predictor, so the corpus can be shown to reject a model that
     reads nothing before a real checkpoint is allowed to pass it.

Everything else -- loading, encoding, the forward pass, the HTTP client, the
metric definitions -- is upstream's, called as a library.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import sys
import time
from collections import defaultdict
from pathlib import Path

KEV_HOME = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))


# ---------------------------------------------------------------------------
# Sampling. The unit is a component, never a record.
# ---------------------------------------------------------------------------

def parent_key(meta: dict) -> str:
    """The clean record a variant is scored against. Mirrors kev.benchmark."""
    return meta.get("parent_id") or (
        meta["id"] if meta["variant"] == "clean" else meta["group_id"]
    )


def components(records: list[dict]) -> list[list[dict]]:
    """Group records that must be scored together, or not at all.

    Two records share a component when one is a variant of the other (they
    share a parent key) or when they are the two halves of a contrastive pair.
    Pairs span parent groups, so these edges genuinely merge groups.
    """
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for record in records:
        meta = record["_meta"]
        union(f"id:{meta['id']}", f"parent:{parent_key(meta)}")
        if meta.get("pair_id"):
            union(f"id:{meta['id']}", f"pair:{meta['pair_id']}")

    grouped: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        grouped[find(f"id:{record['_meta']['id']}")].append(record)
    # Sort by the smallest member id so the enumeration does not depend on
    # dict iteration order.
    return sorted(grouped.values(), key=lambda c: min(r["_meta"]["id"] for r in c))


def _rank(component: list[dict], seed: int) -> str:
    key = min(r["_meta"]["id"] for r in component)
    return hashlib.sha256(f"{seed}:{key}".encode()).hexdigest()


def subsample(records: list[dict], target: int, seed: int) -> list[dict]:
    """Deterministic source-stratified subsample of about `target` records.

    Allocation is proportional to each source's share of the split. Components
    are admitted whole, so the realised count overshoots the allocation by at
    most the size of the last component taken.
    """
    if target >= len(records):
        return records

    by_source: dict[str, list[list[dict]]] = defaultdict(list)
    for component in components(records):
        # A component spanning sources is charged to one of them, chosen
        # deterministically, so every component is offered exactly once.
        source = min(r["_meta"]["source"] for r in component)
        by_source[source].append(component)

    selected: list[dict] = []
    for source in sorted(by_source):
        pool = sorted(by_source[source], key=lambda c: _rank(c, seed))
        share = sum(len(c) for c in pool) / len(records)
        allowance = max(1, round(target * share))
        taken = 0
        for component in pool:
            if taken >= allowance:
                break
            selected.extend(component)
            taken += len(component)

    order = {r["_meta"]["id"]: i for i, r in enumerate(records)}
    selected.sort(key=lambda r: order[r["_meta"]["id"]])
    assert_closed(selected)
    return selected


def assert_closed(records: list[dict]) -> None:
    """Refuse a sample that would make the report raise, or quietly mean less.

    These are the same invariants kev.benchmark.summarize and paired_flip rely
    on. Checking them here turns a confusing failure deep in scoring into a
    statement about the sample.
    """
    ids = {r["_meta"]["id"] for r in records}
    orphans = sorted(
        r["_meta"]["id"] for r in records
        if r["_meta"]["variant"] != "clean" and parent_key(r["_meta"]) not in ids
    )
    if orphans:
        raise ValueError(f"variant records without their clean parent: {orphans[:5]}")

    siblings: dict[str, set[str]] = defaultdict(set)
    for record in records:
        meta = record["_meta"]
        if meta.get("pair_id"):
            siblings[meta["pair_id"]].add(meta["sibling"])
    broken = sorted(pid for pid, half in siblings.items() if half != {"a", "b"})
    if broken:
        raise ValueError(f"incomplete contrastive pairs: {broken[:5]}")

    if not any(r["_meta"]["variant"] == "clean" for r in records):
        raise ValueError("sample contains no clean records to score")


# ---------------------------------------------------------------------------
# The red-first predictor. It reads the option keys and nothing else.
# ---------------------------------------------------------------------------

class ConstantPredictor:
    """Answers every question identically, ignoring the state and the question.

    `mode="first"` puts all mass on the first declared option; `mode="uniform"`
    spreads it evenly. Neither reads the input, so both must fail the corpus.
    If either passes, the corpus is not measuring what it claims to.
    """

    def __init__(self, mode: str = "first") -> None:
        if mode not in ("first", "uniform"):
            raise ValueError(f"unknown constant mode: {mode}")
        self.mode = mode
        self.served_model = f"constant-{mode}"

    def __call__(self, record: dict) -> dict:
        from kev.benchmark import labels

        start = time.perf_counter()
        probabilities = {}
        for qid, question in record["questions"].items():
            keys, _ = labels(question)
            if self.mode == "uniform":
                probabilities[qid] = {k: 1 / len(keys) for k in keys}
            else:
                probabilities[qid] = {k: (1.0 if i == 0 else 0.0) for i, k in enumerate(keys)}
        return {"probabilities": probabilities,
                "latency_ms": 1000 * (time.perf_counter() - start),
                "input_tokens": None}


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def peak_rss_kib() -> int:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suite", default=str(KEV_HOME / "src/evals/v4/decision-v4"))
    ap.add_argument("--run", help="checkpoint directory or Hub id, scored in process")
    ap.add_argument("--remote", help="base URL of a System One endpoint to score over HTTP")
    ap.add_argument("--remote-model", default="kev-latest")
    ap.add_argument("--stub", choices=["first", "uniform"],
                    help="score the constant predictor instead of a model (red-first check)")
    ap.add_argument("--limit", type=int, default=120, help="approximate record count")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", required=True, help="output directory; must not exist")
    ap.add_argument("--threads", type=int, default=8)
    args = ap.parse_args()

    chosen = [bool(args.run), bool(args.remote), bool(args.stub)]
    if sum(chosen) != 1:
        ap.error("give exactly one of --run, --remote, or --stub")

    import torch
    torch.set_num_threads(args.threads)

    from kev.benchmark import LocalPredictor, RemotePredictor, evaluate_records
    from kev.suite import digest, load_split

    suite = Path(args.suite)
    records = load_split(str(suite), "development")
    sample = subsample(records, args.limit, args.seed)
    manifest = json.loads((suite / "manifest.json").read_text())
    heldout = manifest["holdout_sources"]

    load_seconds = None
    if args.stub:
        predictor = ConstantPredictor(args.stub)
        subject = f"constant-{args.stub}"
        dtype = None
    elif args.remote:
        predictor = RemotePredictor(args.remote, args.remote_model,
                                    os.environ.get("KEV_REMOTE_API_KEY", "local"))
        subject = args.remote
        dtype = None
    else:
        start = time.perf_counter()
        predictor = LocalPredictor(args.run, "cpu")
        load_seconds = round(time.perf_counter() - start, 2)
        subject = args.run
        dtype = str(next(predictor.model.lm.parameters()).dtype)
        print(json.dumps({"event": "loaded", "seconds": load_seconds, "dtype": dtype,
                          "rss_kib": peak_rss_kib()}), flush=True)

    report, _ = evaluate_records(sample, predictor, args.out, heldout_sources=tuple(heldout))
    report.update(
        subject=subject,
        split="development",
        calibration_applied=False,
        suite=suite.name,
        suite_path=str(suite),
        suite_sha256=digest(suite / "manifest.json"),
        split_sha256=digest(suite / "development.jsonl"),
        # A suite whose sources were all trained on measures the install, not
        # generalisation. transfer-v4 declares trainable_sources: [].
        in_distribution=bool(manifest["trainable_sources"]),
        trainable_sources=manifest["trainable_sources"],
        holdout_sources=heldout,
        sample={"requested": args.limit, "records": len(sample),
                "of_records": len(records), "seed": args.seed,
                "sources": {s: sum(1 for r in sample if r["_meta"]["source"] == s)
                            for s in sorted({r["_meta"]["source"] for r in sample})}},
        environment={"device": "cpu", "dtype": dtype, "threads": torch.get_num_threads(),
                     "torch": torch.__version__, "python": sys.version.split()[0],
                     "load_seconds": load_seconds, "peak_rss_kib": peak_rss_kib(),
                     "offline": os.environ.get("HF_HUB_OFFLINE") == "1"},
    )
    if args.remote:
        report["remote"] = {"base_url": args.remote, "requested_model": args.remote_model,
                            "served_model": predictor.served_model}
    (Path(args.out) / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n")

    print(json.dumps({"subject": subject, "clean": report["clean"],
                      "latency_ms": report["latency_ms"],
                      "sample": report["sample"],
                      "environment": report["environment"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
