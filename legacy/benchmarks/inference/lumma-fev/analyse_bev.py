"""Validate and summarize the paired BEV Lumma, GLiNER, and Kev records."""

from collections import defaultdict
import json
from pathlib import Path
import statistics

from prepare_bev import digest, jsonl, OUT as PRIVATE, ROOT


DIRECTORY = ROOT / "benchmarks/inference/lumma-fev"


def summarize_choice(rows):
    pairs = defaultdict(dict)
    for row in rows:
        pairs[row["group"]][row["order"]] = row
    if len(pairs) != 24 or any(set(pair) != {"original", "reversed"} for pair in pairs.values()):
        raise ValueError("expected 24 complete, distinct order pairs")
    return {
        "presentations_correct": sum(row["correct"] for row in rows),
        "original_correct": sum(pair["original"]["correct"] for pair in pairs.values()),
        "reversed_correct": sum(pair["reversed"]["correct"] for pair in pairs.values()),
        "both_correct_pairs": sum(pair["original"]["correct"] and pair["reversed"]["correct"] for pair in pairs.values()),
        "order_consistent_pairs": sum(pair["original"]["predicted"] == pair["reversed"]["predicted"] for pair in pairs.values()),
        "median_ms": statistics.median(row["latency_ms"] for row in rows),
    }


def main():
    manifest = json.loads((PRIVATE / "manifest.json").read_text())
    if digest(PRIVATE / "cases.jsonl") != manifest["cases_sha256"] or digest(PRIVATE / "labels.json") != manifest["labels_sha256"]:
        raise ValueError("private source or label digest changed")
    cases = jsonl(PRIVATE / "cases.jsonl")
    labels = json.loads((PRIVATE / "labels.json").read_text())
    lumma = json.loads((DIRECTORY / "bev-results.json").read_text())
    kev = json.loads((DIRECTORY / "bev-kev-results.json").read_text())
    if lumma["cases_sha256"] != manifest["cases_sha256"] or lumma["labels_sha256"] != manifest["labels_sha256"]:
        raise ValueError("Lumma report uses a different sample")
    if kev["sample_sha256"] != {"cases": digest(PRIVATE / "kev-cases.json"),
                                "labels": digest(PRIVATE / "kev-labels.json")}:
        raise ValueError("Kev report uses a different sample")
    planned = {case["id"]: case for case in cases}
    lumma_rows = {row["id"]: row for row in lumma["rows"]}
    kev_rows = {row["id"]: row for row in kev["records"]}
    choice_ids = {case_id for case_id, case in planned.items() if case["slice"] == "tool_selection"}
    if len(planned) != 153 or len(lumma_rows) != 153 or set(lumma_rows) != set(planned):
        raise ValueError("Lumma did not complete exactly the frozen sample")
    if len(choice_ids) != 48 or len(kev_rows) != 48 or set(kev_rows) != choice_ids:
        raise ValueError("Kev did not complete exactly the frozen choice sample")
    for case_id, case in planned.items():
        row = lumma_rows[case_id]
        if row["label"] != labels[case_id]["gold"] or row["correct"] != (row["predicted"] == row["label"]):
            raise ValueError(f"invalid Lumma scoring: {case_id}")
        if case_id in choice_ids:
            kev_row = kev_rows[case_id]
            result = kev_row["result"]
            if kev_row["status"] != "accepted" or kev_row["label"] != row["label"] or result["predicted"] not in case["question"]["criteria"]:
                raise ValueError(f"invalid Kev record: {case_id}")
            if result["correct"] != (result["predicted"] == row["label"]):
                raise ValueError(f"invalid Kev scoring: {case_id}")
    lumma_choice = [lumma_rows[case_id] for case_id in choice_ids]
    kev_choice = [{"group": planned[case_id]["group"], "order": planned[case_id]["order"],
                   "predicted": kev_rows[case_id]["result"]["predicted"],
                   "correct": kev_rows[case_id]["result"]["correct"],
                   "latency_ms": kev_rows[case_id]["result"]["latency_ms"]} for case_id in choice_ids]
    suitability = [row for row in lumma_rows.values() if row["slice"] == "tool_suitability"]
    if len(suitability) != 105:
        raise ValueError("expected 105 tool-suitability records")
    report = {
        "tool_suitability": {
            "n": len(suitability),
            "lumma_correct": sum(row["correct"] for row in suitability),
            "gliner_correct": sum(row["gliner_correct"] for row in suitability),
            "lumma_false_calls": sum(row["predicted"] and not row["label"] for row in suitability),
            "gliner_false_calls": sum(row["gliner_predicted"] and not row["label"] for row in suitability),
        },
        "tool_selection": {
            "distinct_requests": 24,
            "lumma": summarize_choice(lumma_choice),
            "kev": summarize_choice(kev_choice),
            "lumma_only_correct": sum(lumma_rows[case_id]["correct"] and not kev_rows[case_id]["result"]["correct"] for case_id in choice_ids),
            "kev_only_correct": sum(kev_rows[case_id]["result"]["correct"] and not lumma_rows[case_id]["correct"] for case_id in choice_ids),
        },
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
