"""Offline Lumma 4B probe on frozen, private BEV capability-proxy cases."""

from collections import Counter, defaultdict
import json
from pathlib import Path
import platform
import resource
import statistics
import time

from prepare_bev import digest, jsonl, ROOT, OUT as PRIVATE
from probe import MODEL, REVISION, validate_answer


OUTPUT = ROOT / "benchmarks/inference/lumma-fev/bev-results.json"


def summarize(rows):
    out = {}
    for slice_name in ("tool_suitability", "tool_selection"):
        group = [row for row in rows if row["slice"] == slice_name]
        if not group:
            continue
        item = {"n": len(group), "lumma_correct": sum(row["correct"] for row in group),
                "median_ms": statistics.median(row["latency_ms"] for row in group),
                "p95_ms": sorted(row["latency_ms"] for row in group)[int(.95 * (len(group) - 1))]}
        if slice_name == "tool_suitability":
            item["gliner_correct"] = sum(row["gliner_correct"] for row in group)
            item["lumma_only"] = sum(row["correct"] and not row["gliner_correct"] for row in group)
            item["gliner_only"] = sum(row["gliner_correct"] and not row["correct"] for row in group)
            item["by_label"] = {
                str(label).lower(): {"n": sum(row["label"] is label for row in group),
                                   "lumma_correct": sum(row["correct"] for row in group if row["label"] is label),
                                   "gliner_correct": sum(row["gliner_correct"] for row in group if row["label"] is label)}
                for label in (True, False)
            }
        else:
            item["by_order"] = {
                order: {"n": sum(row["order"] == order for row in group),
                        "correct": sum(row["correct"] for row in group if row["order"] == order)}
                for order in ("original", "reversed")
            }
            pairs = defaultdict(dict)
            for row in group:
                pairs[row["group"]][row["order"]] = row
            complete = [pair for pair in pairs.values() if set(pair) == {"original", "reversed"}]
            item["complete_pairs"] = len(complete)
            item["both_correct"] = sum(pair["original"]["correct"] and pair["reversed"]["correct"] for pair in complete)
            item["same_prediction"] = sum(pair["original"]["predicted"] == pair["reversed"]["predicted"] for pair in complete)
            item["first_option_baseline"] = {"original": item["by_order"]["original"]["n"], "reversed": 0}
        out[slice_name] = item
    return out


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=MODEL)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--dtype", choices=("float32", "bfloat16"), default="float32")
    args = parser.parse_args()
    private_manifest = json.loads((PRIVATE / "manifest.json").read_text())
    if digest(PRIVATE / "cases.jsonl") != private_manifest["cases_sha256"] or digest(PRIVATE / "labels.json") != private_manifest["labels_sha256"]:
        raise ValueError("private BEV cases or labels changed")
    cases = jsonl(PRIVATE / "cases.jsonl")
    labels = json.loads((PRIVATE / "labels.json").read_text())
    if len(cases) != 153 or len(labels) != 153 or {case["id"] for case in cases} != set(labels):
        raise ValueError("expected 153 distinct paired cases and labels")
    if args.limit is not None and not 1 <= args.limit <= len(cases):
        parser.error("--limit must be 1..153")
    manifest = {"status": "exploratory local BEV capability proxy; not Weave route evidence",
                "checkpoint": "FrontiersMind/Lumma-fev-4b", "revision": REVISION,
                "bev_revision": private_manifest["revision"],
                "source_sha256": private_manifest["source_sha256"],
                "cases_sha256": private_manifest["cases_sha256"], "labels_sha256": private_manifest["labels_sha256"],
                "gliner_report_sha256": private_manifest["gliner_report_sha256"],
                "selection": private_manifest["selection"],
                "run": {"device": "cpu", "dtype": args.dtype, "threads": args.threads,
                        "python": platform.python_version(), "interface": "native decide; labels excluded"}}
    report = {**manifest, "rows": []}
    if args.output.exists():
        report = json.loads(args.output.read_text())
        if any(report.get(key) != value for key, value in manifest.items()):
            raise ValueError("existing report differs in model, source, or recipe")
    done = {row["id"] for row in report["rows"]}
    planned = cases[:args.limit] if args.limit is not None else cases
    if all(case["id"] in done for case in planned):
        return

    import torch
    import transformers
    from transformers import AutoModel

    torch.set_num_threads(args.threads)
    started = time.monotonic()
    model = AutoModel.from_pretrained(str(args.model), trust_remote_code=True, local_files_only=True,
                                      dtype=getattr(torch, args.dtype), low_cpu_mem_usage=True)
    load_s = round(time.monotonic() - started, 2)
    for index, case in enumerate(planned):
        if case["id"] in done:
            continue
        kind = case["question"]["type"]
        started = time.monotonic()
        answers = model.decide(case["state"], {case["question_id"]: case["question"]})
        latency_ms = round((time.monotonic() - started) * 1000, 2)
        predicted = validate_answer({"id": case["id"], "kind": kind, "question": case["question"]},
                                    answers[case["question_id"]])
        gold = labels[case["id"]]["gold"]
        if (kind == "noul" and type(gold) is not bool) or (kind == "choice" and gold not in case["question"]["criteria"]):
            raise ValueError(f"invalid gold label for {case['id']}")
        row = {"id": case["id"], "slice": case["slice"], "kind": kind, "label": gold,
               "predicted": predicted, "correct": predicted == gold, "answer": answers[case["question_id"]],
               "latency_ms": latency_ms}
        if case["slice"] == "tool_suitability":
            gliner_predicted = labels[case["id"]]["gliner_prediction"] == "call"
            row.update({"gliner_predicted": gliner_predicted, "gliner_correct": gliner_predicted == gold})
        else:
            row.update({"group": case["group"], "order": case["order"]})
        report["rows"].append(row)
        report["summary"] = summarize(report["rows"])
        report["runtime"] = {"torch": torch.__version__, "transformers": transformers.__version__,
                             "load_s": load_s, "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(args.output)
        print(f"{index + 1}/{len(planned)} {case['slice']} {case['id']}: {row['correct']} {latency_ms} ms", flush=True)
    print(json.dumps(report["summary"], indent=2), flush=True)


if __name__ == "__main__":
    main()
