"""Local Decider-2B v11 on the exact 125-case Jev/Kev transfer comparison."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import time


ROOT = Path(__file__).resolve().parents[3]
KEV_HOME = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))
SUITE = KEV_HOME / "src/evals/v4/transfer-v4/development.jsonl"
KEV_RUN = KEV_HOME / "runs/kev-4b-fp32-transfer/predictions.jsonl"
JEV_RUN = ROOT / "benchmarks/inference/jev/transfer-results.json"
DEFAULT_MODEL = ROOT / ".local/decider-2b/model"
DEFAULT_OUTPUT = ROOT / "benchmarks/inference/decider-2b/transfer-results.json"
MODEL_REVISION = "533964dae8be954c5b5e19fa4948e48408094c1e"


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def selected_records():
    kev = {row["id"]: row for row in read_jsonl(KEV_RUN)}
    jev = {row["id"]: row for row in json.loads(JEV_RUN.read_text())}
    if len(kev) != 125 or len(jev) != 125 or set(kev) != set(jev):
        raise ValueError("Jev and Kev paired ID sets must contain the same 125 cases")
    records = []
    for row in read_jsonl(SUITE):
        case_id = row["_meta"]["id"]
        if case_id not in kev:
            continue
        for qid, question in row["questions"].items():
            records.append({
                "id": case_id,
                "source": question.get("src", row["_meta"]["source"]),
                "state": row["state"],
                "question_id": qid,
                "question": {key: question[key] for key in ("type", "instructions", "criteria") if key in question},
                "label": question["label"],
                "jev_correct": jev[case_id]["correct"],
                "kev_correct": max(range(len(kev[case_id]["rows"][0]["p"])),
                                   key=kev[case_id]["rows"][0]["p"].__getitem__) ==
                               kev[case_id]["rows"][0]["label"],
            })
    if len(records) != 125 or {row["id"] for row in records} != set(kev):
        raise ValueError("transfer suite did not resolve exactly the 125 paired cases")
    for row in records:
        reference = jev[row["id"]]
        if row["source"] != reference["source"] or row["question"]["type"] != reference["type"] or row["label"] != reference["label"]:
            raise ValueError(f"Jev reference metadata differs for {row['id']}")
    return records


def score_answer(question, label, answer):
    kind = question["type"]
    if kind == "choice":
        predicted = answer["choice"]
        probability = answer.get("probabilities", {}).get(predicted)
        return predicted, predicted == label, probability, None
    if kind == "noul":
        probability = float(answer["noul"])
        predicted = probability >= 0.5
        return predicted, predicted == label, probability if predicted else 1 - probability, None
    if kind == "score":
        expected_value = float(answer["score"])
        predicted = math.floor(expected_value + 0.5)  # Same positive-scale rule as JS Math.round.
        probability = answer.get("probabilities", {}).get(str(predicted))
        return predicted, predicted == int(label), probability, abs(expected_value - int(label))
    raise ValueError(f"unknown question type {kind}")


def write_report(path, report):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    records = selected_records()
    if args.limit is not None and not 1 <= args.limit <= len(records):
        raise ValueError("limit must be 1..125")
    manifest = {
        "status": "exploratory local paired comparison; not routing evidence",
        "checkpoint": "Mapika/decider-2b",
        "revision": MODEL_REVISION,
        "model_config": json.loads((args.model / "decider_config.json").read_text()),
        "suite_sha256": hashlib.sha256(SUITE.read_bytes()).hexdigest(),
        "paired_ids_sha256": hashlib.sha256("\n".join(row["id"] for row in records).encode()).hexdigest(),
        "run": {"device": "cpu", "dtype": "bfloat16", "threads": 4,
                "interface": "native Decider.system_one, one question per state"},
    }
    report = {**manifest, "rows": []}
    if args.output.exists():
        previous = json.loads(args.output.read_text())
        if any(previous.get(key) != value for key, value in manifest.items()):
            raise ValueError("existing output has a different checkpoint, suite, or recipe")
        report["rows"] = previous["rows"]
    done = {row["id"] for row in report["rows"]}
    planned = records[:args.limit] if args.limit is not None else records
    if all(record["id"] in done for record in planned):
        print(f"already complete: {len(report['rows'])}/{len(records)}")
        return

    import torch
    from decider.infer import Decider

    torch.set_num_threads(4)
    model = Decider(str(args.model), device="cpu", dtype=torch.bfloat16, use_graphs=False)
    if model.name != "decider-2b-v11":
        raise ValueError(f"unexpected loaded model identity {model.name}")
    for index, record in enumerate(planned):
        if record["id"] in done:
            continue
        start = time.monotonic()
        response = model.system_one(record["state"], {record["question_id"]: record["question"]})
        answer = response["answers"][record["question_id"]]
        predicted, correct, confidence, score_error = score_answer(record["question"], record["label"], answer)
        report["rows"].append({
            "id": record["id"], "source": record["source"], "type": record["question"]["type"],
            "label": record["label"], "predicted": predicted, "correct": correct,
            "confidence": confidence, "score_error": score_error,
            "jev_correct": record["jev_correct"], "kev_correct": record["kev_correct"],
            "answer": answer,
            "latency_ms": round((time.monotonic() - start) * 1000),
        })
        write_report(args.output, report)
        if (index + 1) % 10 == 0 or index + 1 == len(planned):
            print(f"{index + 1}/{len(planned)} scored; correct {sum(row['correct'] for row in report['rows'])}/{len(report['rows'])}", flush=True)
    report["peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    write_report(args.output, report)


if __name__ == "__main__":
    main()
