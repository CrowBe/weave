"""Small, paired offline probe of Lumma-Fev 4B. No runtime route is changed."""

import argparse
from collections import defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import resource
import statistics
import time


ROOT = Path(__file__).resolve().parents[3]
KEV_HOME = Path(os.environ.get("WEAVE_KEV_HOME", Path.home() / ".local/share/weave/kev"))
SUITE = KEV_HOME / "src/evals/v4/transfer-v4/development.jsonl"
KEV = KEV_HOME / "runs/kev-4b-fp32-transfer/predictions.jsonl"
JEV = ROOT / "benchmarks/inference/jev/transfer-results.json"
GLINER = ROOT / "benchmarks/inference/gliner-decide/weave-v2-results.json"
COLLECTED = ROOT / ".local/gliner-decide/weave-v2"
MODEL = ROOT / ".local/lumma-fev/model"
OUTPUT = ROOT / "benchmarks/inference/lumma-fev/results.json"
REVISION = "7e6e82c7db7ee401f4cd7acae9d59f2b75b2b7c2"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def transfer_cases():
    kev = {row["id"]: row for row in jsonl(KEV)}
    jev = {row["id"]: row for row in json.loads(JEV.read_text())}
    if len(kev) != 125 or len(jev) != 125 or set(kev) != set(jev):
        raise ValueError("expected 125 identical Jev/Kev transfer IDs")
    cases = []
    for record in jsonl(SUITE):
        ident = record["_meta"]["id"]
        if ident not in kev:
            continue
        if len(record["questions"]) != 1:
            raise ValueError(f"expected one question for {ident}")
        question_id, question = next(iter(record["questions"].items()))
        reference = jev[ident]
        if (question["type"], question["label"], question["src"]) != (reference["type"], reference["label"], reference["source"]):
            raise ValueError(f"reference metadata differs for {ident}")
        prediction = kev[ident]["rows"][0]
        kev_correct = max(range(len(prediction["p"])), key=prediction["p"].__getitem__) == prediction["label"]
        cases.append({
            "id": ident, "site": "transfer", "kind": question["type"],
            "source": question["src"], "state": record["state"], "question_id": question_id,
            "question": {key: question[key] for key in ("type", "instructions", "criteria") if key in question},
            "label": question["label"], "jev_correct": reference["correct"], "kev_correct": kev_correct,
        })
    if len(cases) != 125 or len({case["id"] for case in cases}) != 125:
        raise ValueError("transfer suite did not resolve 125 unique cases")
    # Fix a balanced, ID-based slice before seeing Lumma's answers.
    quotas = {"choice": 12, "noul": 6, "score": 6}
    selected = []
    for kind, count in quotas.items():
        group = sorted((case for case in cases if case["kind"] == kind),
                       key=lambda case: hashlib.sha256(case["id"].encode()).hexdigest())
        if len(group) < count:
            raise ValueError(f"insufficient {kind} cases")
        selected.extend(group[:count])
    return selected


def site_cases(site, groups=3):
    directory = COLLECTED / site
    manifest = json.loads((directory / "manifest.json").read_text())
    data_path = directory / "test.jsonl"
    if digest(data_path) != manifest["output_sha256"]["test"]:
        raise ValueError(f"{site} test data changed")
    data = jsonl(data_path)
    index = jsonl(directory / "test-index.jsonl")
    if len(data) != len(index):
        raise ValueError(f"{site} index length differs")
    paired = {row["id"]: row for row in json.loads(GLINER.read_text())["sites"][site]["splits"]["test"]["rows"]}
    chosen_groups = sorted({row["group"] for row in index})[:groups]
    cases = []
    for item, meta in zip(data, index):
        if meta["group"] not in chosen_groups:
            continue
        c = item["output"]["classifications"][0]
        reference = paired[meta["id"]]
        if reference["label"] != meta["semantic_label"] or reference["adapter_correct"] != (reference["adapter_prediction"] == meta["wire_label"]):
            raise ValueError(f"GLiNER reference differs for {meta['id']}")
        cases.append({
            "id": meta["id"], "site": site, "kind": "choice", "group": meta["group"],
            "arm": meta["arm"], "state": item["input"], "question_id": c["task"],
            "question": {"type": "choice", "instructions": c["prompt"], "criteria": c["label_descriptions"]},
            "label": meta["wire_label"], "gliner_correct": reference["adapter_correct"],
        })
    if len(cases) != groups * 6:
        raise ValueError(f"expected {groups * 6} grouped {site} cases, got {len(cases)}")
    return cases


def validate_answer(case, answer):
    kind = case["kind"]
    if answer.get("type") != kind:
        raise ValueError(f"wrong answer type for {case['id']}")
    if kind == "noul":
        p = answer.get("noul")
        if not isinstance(p, (float, int)) or not math.isfinite(p) or not 0 <= p <= 1:
            raise ValueError(f"invalid noul for {case['id']}")
        return p >= 0.5
    keys = list(case["question"]["criteria"]) if kind == "choice" else [str(i) for i in range(len(case["question"]["criteria"]))]
    probs = answer.get("probabilities")
    if not isinstance(probs, dict) or set(probs) != set(keys) or any(not isinstance(p, (float, int)) or not math.isfinite(p) or not 0 <= p <= 1 for p in probs.values()):
        raise ValueError(f"invalid probability map for {case['id']}")
    if abs(sum(probs.values()) - 1) > 0.001:
        raise ValueError(f"probabilities do not sum to one for {case['id']}")
    if kind == "choice":
        if answer.get("choice") not in keys or answer["choice"] != max(keys, key=probs.__getitem__):
            raise ValueError(f"invalid choice for {case['id']}")
        return answer["choice"]
    score = answer.get("score")
    if not isinstance(score, (float, int)) or not math.isfinite(score) or not 0 <= score <= len(keys) - 1:
        raise ValueError(f"invalid score for {case['id']}")
    return math.floor(score + 0.5)


def summary(rows):
    out = {}
    for site in sorted({row["site"] for row in rows}):
        group = [row for row in rows if row["site"] == site]
        reference = "gliner_correct" if site != "transfer" else "kev_correct"
        out[site] = {
            "n": len(group), "lumma_correct": sum(row["correct"] for row in group),
            "reference_correct": sum(row[reference] for row in group),
            "lumma_only": sum(row["correct"] and not row[reference] for row in group),
            "reference_only": sum(row[reference] and not row["correct"] for row in group),
            "median_ms": statistics.median(row["latency_ms"] for row in group),
        }
        if site == "transfer":
            out[site]["jev_correct"] = sum(row["jev_correct"] for row in group)
            out[site]["by_kind"] = {
                kind: {"n": sum(row["kind"] == kind for row in group),
                       "lumma_correct": sum(row["correct"] for row in group if row["kind"] == kind),
                       "kev_correct": sum(row["kev_correct"] for row in group if row["kind"] == kind)}
                for kind in ("choice", "noul", "score")
            }
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=MODEL)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--limit", type=int, help="smoke-test first N preselected cases; resume later")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--dtype", choices=("float32", "bfloat16"), default="float32")
    args = parser.parse_args()
    cases = transfer_cases() + site_cases("capability.match") + site_cases("result.evaluate")
    if args.limit is not None and not 1 <= args.limit <= len(cases):
        parser.error(f"--limit must be 1..{len(cases)}")
    manifest = {
        "status": "exploratory paired local probe; not route evidence", "checkpoint": "FrontiersMind/Lumma-fev-4b",
        "revision": REVISION, "suite_sha256": digest(SUITE), "jev_sha256": digest(JEV),
        "kev_sha256": digest(KEV), "gliner_sha256": digest(GLINER),
        "site_test_sha256": {s: digest(COLLECTED / s / "test.jsonl") for s in ("capability.match", "result.evaluate")},
        "selection": "12 choice, 6 noul, 6 score by SHA256(ID), then first three sorted test scenario groups per site",
        "run": {"device": "cpu", "dtype": args.dtype, "threads": args.threads, "python": platform.python_version(),
                "interface": "native model.decide; reference labels excluded from requests"},
    }
    report = {**manifest, "rows": []}
    if args.output.exists():
        report = json.loads(args.output.read_text())
        if any(report.get(key) != value for key, value in manifest.items()):
            raise ValueError("existing report differs in model, data, or recipe")
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
        started = time.monotonic()
        answers = model.decide(case["state"], {case["question_id"]: case["question"]})
        latency_ms = round((time.monotonic() - started) * 1000, 2)
        answer = answers[case["question_id"]]
        predicted = validate_answer(case, answer)
        row = {key: case[key] for key in ("id", "site", "kind", "label")}
        row.update({"predicted": predicted, "correct": predicted == case["label"],
                    "answer": answer, "latency_ms": latency_ms})
        for key in ("source", "group", "arm", "jev_correct", "kev_correct", "gliner_correct"):
            if key in case:
                row[key] = case[key]
        report["rows"].append(row)
        report["summary"] = summary(report["rows"])
        report["runtime"] = {"torch": torch.__version__, "transformers": transformers.__version__,
                             "load_s": load_s, "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(args.output)
        print(f"{index + 1}/{len(planned)} {case['site']} {case['id']}: {row['correct']} {latency_ms} ms", flush=True)
    print(json.dumps(report["summary"], indent=2), flush=True)


if __name__ == "__main__":
    main()
