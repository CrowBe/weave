"""Paired, offline GLiNER2.5-Decide probe on the existing Jev transfer sample.

This is a classification experiment, not a gateway implementation. Model output
is recorded as an observation; no permissions or action transitions use it.
"""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import resource
import statistics
import time


ROOT = Path(__file__).resolve().parents[3]
KEV_HOME = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))
SUITE = KEV_HOME / "src/evals/v4/transfer-v4/development.jsonl"
JEV = ROOT / "benchmarks/inference/jev/transfer-results.json"
CHECKPOINT = "7ee5da4c2415e32259bcdc0b1a7367c32ce8d6f6"


def render(value, indent=0):
    """The same state rendering as the existing OpenJev transfer probe."""
    pad = "  " * indent
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "\n".join(f"{pad}- {render(x, indent + 1).lstrip()}" for x in value)
    return "\n".join(
        f"{pad}{k}:\n{render(x, indent + 1)}" if isinstance(x, (dict, list))
        else f"{pad}{k}: {render(x)}" for k, x in value.items())


def classify_input(record):
    question = next(iter(record["questions"].values()))
    state = render(record["state"])
    kind = question["type"]
    prompt = question["instructions"]
    if kind == "choice":
        labels = {key: render(desc).strip() or key
                  for key, desc in question["criteria"].items()}
    elif kind == "noul":
        criteria = question.get("criteria") or {}
        labels = {
            "yes": render(criteria.get("true")).strip() or "The answer is yes",
            "no": render(criteria.get("false")).strip() or "The answer is no",
        }
    elif kind == "score":
        labels = {str(i): render(desc) for i, desc in enumerate(question["criteria"])}
    else:
        raise ValueError(f"unmapped kind: {kind}")
    return state, {"answer": {"labels": labels, "prompt": prompt}}, question


def decode_prediction(question, answer):
    if not isinstance(answer, dict) or "label" not in answer:
        raise ValueError(f"unexpected classification result: {answer!r}")
    raw = answer["label"]
    if question["type"] == "noul":
        if raw not in ("yes", "no"):
            raise ValueError(f"unexpected NOUL label: {raw!r}")
        return raw == "yes"
    if question["type"] == "score":
        return int(raw)
    return raw


def selected_records():
    # Exact ids of the existing 125-case hosted Jev / Kev comparison, in its
    # recorded order. This avoids a newly favorable sample for this model.
    jev = json.loads(JEV.read_text())
    ordered_ids = list(dict.fromkeys(row["id"] for row in jev))
    by_id = {}
    for line in SUITE.read_text().splitlines():
        record = json.loads(line)
        by_id[record["_meta"]["id"]] = record
    missing = set(ordered_ids) - by_id.keys()
    if missing:
        raise ValueError(f"sample absent from suite: {sorted(missing)[:3]}")
    return [by_id[id_] for id_ in ordered_ids]


def summarize(rows):
    by_source = collections.defaultdict(list)
    for row in rows:
        by_source[row["source"]].append(row)
    sources = {}
    floor_hits = 0
    for source, group in sorted(by_source.items()):
        labels = collections.Counter(str(row["label"]) for row in group)
        majority = labels.most_common(1)[0][1]
        floor_hits += majority
        sources[source] = {
            "n": len(group),
            "correct": sum(row["correct"] for row in group),
            "accuracy": sum(row["correct"] for row in group) / len(group),
            "majority_floor": majority / len(group),
            "median_ms": statistics.median(row["latency_ms"] for row in group),
        }
    n = len(rows)
    return {
        "n": n,
        "correct": sum(row["correct"] for row in rows),
        "accuracy": sum(row["correct"] for row in rows) / n,
        "majority_floor": floor_hits / n,
        "median_ms": statistics.median(row["latency_ms"] for row in rows),
        "p95_ms": sorted(row["latency_ms"] for row in rows)[int(0.95 * (n - 1))],
        "by_source": sources,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=ROOT / ".local/gliner-decide/model")
    parser.add_argument("--output", type=Path, default=ROOT / "benchmarks/inference/gliner-decide/results.json")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()

    import torch
    from gliner2 import AutoExtractor

    torch.set_num_threads(args.threads)
    records = selected_records()
    if args.limit is not None:
        records = records[:args.limit]
    model = AutoExtractor.from_pretrained(str(args.model), map_location="cpu")
    model.classify_text("A meeting is scheduled.", {"answer": ["scheduled", "cancelled"]})
    rows = []
    for record in records:
        state, schema, question = classify_input(record)
        started = time.perf_counter()
        result = model.classify_text(state, schema, include_confidence=True)
        elapsed_ms = (time.perf_counter() - started) * 1000
        answer = result["answer"]
        predicted = decode_prediction(question, answer)
        row = {
            "id": record["_meta"]["id"],
            "group": record["_meta"]["group_id"],
            "source": question["src"],
            "kind": question["type"],
            "label": question["label"],
            "predicted": predicted,
            "correct": predicted == question["label"],
            "top_score": answer.get("confidence"),
            "latency_ms": round(elapsed_ms, 2),
        }
        rows.append(row)
        print(json.dumps({k: row[k] for k in ("id", "source", "correct", "latency_ms")}), flush=True)

    report = {
        "status": "experimental",
        "checkpoint": "fastino/GLiNER2.5-Decide",
        "revision": CHECKPOINT,
        "suite_sha256": hashlib.sha256(SUITE.read_bytes()).hexdigest(),
        "sample": "ids from benchmarks/inference/jev/transfer-results.json",
        "mapping": "state text plus per-question prompt and described labels; yes/no and ordinal levels are classes",
        "device": "cpu",
        "threads": args.threads,
        "torch": torch.__version__,
        "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "summary": summarize(rows),
        "rows": rows,
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary"], indent=2), flush=True)


if __name__ == "__main__":
    main()
