"""Run a reviewed BEV sample through the pinned local Kev checkpoint.

This is an exploratory smoke test, not a benchmark promotion gate. It imports
Kev's existing LocalPredictor so encoding and model execution match its native
path. Labels are joined only after loading and never enter the model-visible
request.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import sys
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
KEV_HOME = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))
KEV_SOURCE = KEV_HOME / "src"
DEFAULT_RUN = KEV_HOME / "models/kev-4b"
SAMPLE = ROOT / ".local/bev-decision-150k/f83fe8b97094112fa305bfc793be07c8f8742282/sample-v1"


def exact_keys(value: Any, expected: set[str], where: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        got = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise ValueError(f"{where}: expected keys {sorted(expected)}, got {got}")


def load_sample(cases_path: Path, labels_path: Path) -> tuple[dict, dict[str, dict], dict[str, Any]]:
    manifest = json.loads(cases_path.read_text())
    exact_keys(manifest, {"dataset", "selection", "cases"}, "cases manifest")
    label_doc = json.loads(labels_path.read_text())
    exact_keys(label_doc, {"dataset_revision", "labels"}, "labels file")
    if manifest["dataset"]["revision"] != label_doc["dataset_revision"]:
        raise ValueError("dataset revision differs between cases and labels")
    rows: dict[str, dict] = {}
    for i, case in enumerate(manifest["cases"]):
        exact_keys(case, {"id", "row_index", "domain", "type", "question_key", "state", "question"}, f"case[{i}]")
        if "label" in case or "labels" in case:
            raise ValueError(f"case {case['id']} unexpectedly contains label data")
        if case["id"] in rows:
            raise ValueError(f"duplicate case id: {case['id']}")
        q = case["question"]
        exact_keys(q, {"type", "instructions", "criteria"}, f"case {case['id']} question")
        if case["type"] not in {"choice", "noul", "score"} or q["type"] != case["type"]:
            raise ValueError(f"case {case['id']} has unsupported or inconsistent type")
        rows[case["id"]] = case
    labels: dict[str, Any] = {}
    for i, row in enumerate(label_doc["labels"]):
        exact_keys(row, {"id", "label"}, f"labels[{i}]")
        if row["id"] in labels:
            raise ValueError(f"duplicate label id: {row['id']}")
        labels[row["id"]] = row["label"]
    if set(rows) != set(labels):
        raise ValueError("case and label IDs do not match exactly")
    if not rows:
        raise ValueError("sample is empty")
    return manifest, rows, labels


def option_keys(question: dict) -> list[str]:
    if question["type"] == "choice":
        criteria = question["criteria"]
        if not isinstance(criteria, dict) or not criteria:
            raise ValueError("choice criteria must be a non-empty object")
        return list(criteria)
    if question["type"] == "noul":
        return ["false", "true"]
    criteria = question["criteria"]
    if not isinstance(criteria, list) or not criteria:
        raise ValueError("score criteria must be a non-empty list")
    return [str(i) for i in range(len(criteria))]


def predict(predictor, case: dict, label: Any) -> dict:
    """Build the library's label-bearing wrapper; materialize strips it before encoding."""
    qid = case["question_key"]
    question = dict(case["question"])
    question["label"] = label
    question["src"] = "bev"
    request = {"state": case["state"], "questions": {qid: question}}
    # Assert the exact payload that Kev's own api_request declares model-visible.
    from kev.benchmark import api_request
    payload = api_request(request)
    if set(payload) != {"state", "questions"} or set(payload["questions"][qid]) != {"type", "instructions", "criteria"}:
        raise ValueError("Kev model-visible payload contains unexpected fields")
    return predictor(request)


def prediction_for(case: dict, label: Any, returned: dict) -> dict:
    qid = case["question_key"]
    from kev.benchmark import labels as kev_labels, validate_distribution
    q = {**case["question"], "label": label, "src": "bev"}
    keys, expected_index = kev_labels(q)
    if set(returned) != {"probabilities", "latency_ms", "input_tokens"}:
        raise ValueError("Kev predictor returned unexpected fields")
    probabilities = returned["probabilities"]
    if set(probabilities) != {qid}:
        raise ValueError("Kev predictor returned unexpected question IDs")
    raw = probabilities[qid]
    probs, _ = validate_distribution(raw, keys)
    predicted_index = int(probs.argmax())
    result = {
        "raw_probabilities": raw,
        "option_keys": keys,
        "expected": label,
        "predicted": keys[predicted_index],
        "correct": predicted_index == expected_index,
        "latency_ms": returned["latency_ms"],
        "input_tokens": returned["input_tokens"],
    }
    if case["type"] == "score":
        # Native System One exposes the distribution's expected level as Score.
        expected_level = sum(i * float(p) for i, p in enumerate(probs))
        rounded = int(expected_level + 0.5)
        result.update({"expected_level": expected_level, "rounded_level": rounded,
                       "rounded_correct": rounded == expected_index,
                       "ordinal_absolute_error": abs(rounded - expected_index)})
    return result


def atomic_write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False, allow_nan=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def summaries(records: list[dict]) -> dict:
    grouped: dict[str, list[dict]] = defaultdict(list)
    cells: dict[str, list[dict]] = defaultdict(list)
    for row in records:
        cell = f"{row['domain']} / {row['type']}"
        cells[cell].append(row)
        grouped["overall"].append(row)
        grouped[f"type:{row['type']}"].append(row)
        grouped[cell].append(row)
    out = {}
    for key, rows in sorted(grouped.items()):
        hits = sum(row["result"]["correct"] for row in rows)
        # Descriptive in-sample majority is calculated within each source/type
        # cell; mixing labels from unrelated tasks is not meaningful.
        included_cells = {f"{row['domain']} / {row['type']}" for row in rows}
        majority = sum(Counter(json.dumps(row["label"], sort_keys=True)
                               for row in cells[cell]).most_common(1)[0][1]
                       for cell in included_cells)
        score_rows = [row for row in rows if row["type"] == "score"]
        native_hits = hits - sum(row["result"]["correct"] for row in score_rows) + sum(
            row["result"]["rounded_correct"] for row in score_rows)
        out[key] = {"n": len(rows), "argmax_correct": hits, "argmax_accuracy": hits / len(rows),
                    "decision_correct": native_hits, "decision_accuracy": native_hits / len(rows),
                    "first_option_baseline_correct": sum(row["result"]["option_keys"][0] ==
                                                         (str(row["label"]) if row["type"] == "score" else
                                                          str(row["label"]).lower() if row["type"] == "noul" else row["label"])
                                                         for row in rows),
                    "sample_majority_baseline_correct": majority,
                    **({"score_rounded_correct": sum(row["result"]["rounded_correct"] for row in score_rows),
                        "score_ordinal_absolute_error_total": sum(row["result"]["ordinal_absolute_error"] for row in score_rows),
                        "score_expected_absolute_error_mean": sum(abs(row["result"]["expected_level"] - row["label"]) for row in score_rows) / len(score_rows)}
                       if score_rows else {})}
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cases", type=Path, default=SAMPLE / "cases.json")
    ap.add_argument("--labels", type=Path, default=SAMPLE / "labels.json")
    ap.add_argument("--run", type=Path, default=DEFAULT_RUN)
    ap.add_argument("--output", type=Path, default=HERE / "kev-results.json")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--limit", type=int, help="run only the first N cases as a resource pilot")
    args = ap.parse_args()

    manifest, cases, labels = load_sample(args.cases, args.labels)
    process_started = time.monotonic()
    if args.limit is not None:
        if not 1 <= args.limit <= len(cases):
            raise ValueError("limit must be within the selected case count")
        cases = dict(list(cases.items())[:args.limit])
    sys.path.insert(0, str(KEV_SOURCE))
    import torch
    torch.set_num_threads(args.threads)
    from kev.benchmark import LocalPredictor
    predictor = LocalPredictor(str(args.run), "cpu")
    head = torch.load(args.run / "head.pt", map_location="cpu", weights_only=True)

    report = {"status": "running", "dataset": manifest["dataset"], "selection": manifest["selection"],
              "sample_sha256": {"cases": file_sha256(args.cases), "labels": file_sha256(args.labels)},
              "requested_cases": len(cases),
              "model": {"name": "Kev", "run": str(args.run), "device": "cpu",
                        "base": head["base"], "base_revision": head["base_revision"],
                        "adapter_sha256": file_sha256(args.run / "adapter_model.safetensors"),
                        "head_sha256": file_sha256(args.run / "head.pt"),
                        "training_config_sha256": file_sha256(args.run / "training_config.json")},
              "records": []}
    atomic_write(args.output, report)
    for i, (case_id, case) in enumerate(cases.items(), 1):
        started = time.time()
        try:
            returned = predict(predictor, case, labels[case_id])
            result = prediction_for(case, labels[case_id], returned)
            status = "accepted"
            reason = None
        except Exception as exc:
            # Keep raw status and stop: malformed requests/results must not be silently skipped.
            result = None
            status = "error"
            reason = f"{type(exc).__name__}: {exc}"
        report["records"].append({"id": case_id, "row_index": case["row_index"], "domain": case["domain"],
                                  "type": case["type"], "label": labels[case_id], "status": status,
                                  "elapsed_ms": round((time.time() - started) * 1000, 1),
                                  **({"result": result} if result is not None else {"reason": reason})})
        report["status"] = "running" if status == "accepted" else "failed"
        report["summary"] = summaries([r for r in report["records"] if r["status"] == "accepted"])
        atomic_write(args.output, report)
        print(f"{i}/{len(cases)} {case_id}: {status}", flush=True)
        if status != "accepted":
            return 1
    report["status"] = "complete"
    report["summary"] = summaries(report["records"])
    report["peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report["wall_elapsed_seconds"] = round(time.monotonic() - process_started, 2)
    atomic_write(args.output, report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
