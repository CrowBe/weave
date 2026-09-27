"""One-site GLiNER probe: capability.match as a bounded choice judgment.

The corpus is an illustrative semantic matching task. Candidate descriptions
are data; neither a model choice nor a corpus label grants execution authority.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import resource
import statistics
import time


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CASES = HERE / "capability-match-cases.json"
CHECKPOINT = "7ee5da4c2415e32259bcdc0b1a7367c32ce8d6f6"
PROMPT = (
    "Which listed operation satisfies the desired operation by itself? "
    "Choose none if no listed operation does. This is semantic matching only."
)


def load_cases(path=CASES):
    corpus = json.loads(Path(path).read_text())
    if corpus.get("version") != "capability.match.choice.v1":
        raise ValueError("unexpected corpus version")
    catalogues = corpus["catalogues"]
    groups = corpus["groups"]
    seen = set()
    rows = []
    for group in groups:
        group_id = group["id"]
        if group_id in seen:
            raise ValueError(f"duplicate group: {group_id}")
        seen.add(group_id)
        split = group["split"]
        if split not in ("development", "test"):
            raise ValueError(f"invalid split: {split}")
        catalogue_name = group["catalogue"]
        candidates = catalogues[catalogue_name]
        if len(candidates) < 3 or "none" not in candidates:
            raise ValueError(f"invalid catalogue: {catalogue_name}")
        if any(not isinstance(value, str) or not value.strip() for value in candidates.values()):
            raise ValueError(f"blank candidate description: {catalogue_name}")
        arms = {arm["arm"]: arm for arm in group["arms"]}
        if set(arms) != {"base", "relevant", "irrelevant"} or len(group["arms"]) != 3:
            raise ValueError(f"incomplete contrast group: {group_id}")
        if arms["base"]["label"] == arms["relevant"]["label"]:
            raise ValueError(f"relevant arm must change answer: {group_id}")
        if arms["base"]["label"] != arms["irrelevant"]["label"]:
            raise ValueError(f"irrelevant arm must preserve answer: {group_id}")
        if len({arm["desired"] for arm in arms.values()}) != 3:
            raise ValueError(f"contrast arms must have distinct inputs: {group_id}")
        for arm in group["arms"]:
            if arm["label"] not in candidates:
                raise ValueError(f"unknown label: {group_id}:{arm['arm']}")
            rows.append({
                "id": f"{group_id}.{arm['arm']}",
                "group": group_id,
                "split": split,
                "catalogue": catalogue_name,
                "arm": arm["arm"],
                "desired": arm["desired"],
                "candidates": candidates,
                "label": arm["label"],
            })
    if not any(row["split"] == "development" for row in rows):
        raise ValueError("missing development split")
    if not any(row["split"] == "test" for row in rows):
        raise ValueError("missing test split")
    # A semantic family must not straddle splits: contrast groups and catalogue
    # semantics stay together, including when a later checkpoint is fine-tuned.
    by_catalogue = collections.defaultdict(set)
    for row in rows:
        by_catalogue[row["catalogue"]].add(row["split"])
    if any(len(splits) != 1 for splits in by_catalogue.values()):
        raise ValueError("catalogue family crosses development/test boundary")
    return rows


def schema_for(row, reverse=False):
    candidates = list(row["candidates"].items())
    if reverse:
        candidates.reverse()
    return {"match": {"labels": dict(candidates), "prompt": PROMPT}}


def summarize(rows):
    if not rows:
        raise ValueError("no predictions")
    by_group = collections.defaultdict(dict)
    by_catalogue = collections.defaultdict(list)
    for row in rows:
        by_group[row["group"]][row["arm"]] = row
        by_catalogue[row["catalogue"]].append(row)
    groups = list(by_group.values())
    return {
        "n": len(rows),
        "correct": sum(row["correct"] for row in rows),
        "accuracy": sum(row["correct"] for row in rows) / len(rows),
        "no_match_cases": sum(row["label"] == "none" for row in rows),
        "false_match": sum(row["label"] == "none" and row["predicted"] != "none" for row in rows),
        "false_no_match": sum(row["label"] != "none" and row["predicted"] == "none" for row in rows),
        "uniform_floor": statistics.mean(1 / row["option_count"] for row in rows),
        "majority_label_floor": max(collections.Counter(row["label"] for row in rows).values()) / len(rows),
        "median_ms": statistics.median(row["latency_ms"] for row in rows),
        "p95_ms": sorted(row["latency_ms"] for row in rows)[int(0.95 * (len(rows) - 1))],
        "relevant_flip": sum(g["base"]["predicted"] != g["relevant"]["predicted"] for g in groups),
        "irrelevant_hold": sum(g["base"]["predicted"] == g["irrelevant"]["predicted"] for g in groups),
        "groups": len(groups),
        "by_catalogue": {name: {
            "n": len(items), "correct": sum(item["correct"] for item in items),
        } for name, items in sorted(by_catalogue.items())},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=ROOT / ".local/gliner-decide/model")
    parser.add_argument("--split", choices=("development", "test"), required=True)
    parser.add_argument("--order", choices=("normal", "reverse"), default="normal")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    rows = [row for row in load_cases() if row["split"] == args.split]
    if args.validate_only:
        print(f"{args.split}: {len(rows)} cases in {len(rows)//3} contrast groups")
        return

    import torch
    from gliner2 import AutoExtractor

    torch.set_num_threads(args.threads)
    model = AutoExtractor.from_pretrained(str(args.model), map_location="cpu")
    model.classify_text("A report is ready.", {"match": ["draft", "publish"]})
    outcomes = []
    for row in rows:
        started = time.perf_counter()
        result = model.classify_text(
            row["desired"], schema_for(row, args.order == "reverse"), include_confidence=True)
        elapsed = (time.perf_counter() - started) * 1000
        answer = result["match"]
        if not isinstance(answer, dict) or answer.get("label") not in row["candidates"]:
            raise ValueError(f"invalid model result for {row['id']}: {result!r}")
        outcome = {
            "id": row["id"], "group": row["group"], "catalogue": row["catalogue"],
            "arm": row["arm"], "label": row["label"],
            "predicted": answer["label"], "correct": answer["label"] == row["label"],
            "top_score": answer.get("confidence"),
            "option_count": len(row["candidates"]), "latency_ms": round(elapsed, 2),
        }
        outcomes.append(outcome)
        print(json.dumps({k: outcome[k] for k in ("id", "predicted", "correct", "latency_ms")}), flush=True)
    report = {
        "status": "experimental", "site": "capability.match", "kind": "choice",
        "checkpoint": "fastino/GLiNER2.5-Decide", "revision": CHECKPOINT,
        "corpus_sha256": hashlib.sha256(CASES.read_bytes()).hexdigest(),
        "split": args.split, "order": args.order,
        "device": "cpu", "threads": args.threads, "torch": torch.__version__,
        "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "summary": summarize(outcomes), "rows": outcomes,
    }
    output = args.output or HERE / f"capability-match-{args.split}-{args.order}.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary"], indent=2), flush=True)


if __name__ == "__main__":
    main()
