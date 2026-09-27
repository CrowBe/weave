"""Private BEV tool-suitability pilot; dataset text stays in ignored .local.

This is a narrow NOUL proxy for capability matching, not Weave-site labels.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import resource
import statistics
import time
import unicodedata

from collect import digest, ROOT

REVISION = "f83fe8b97094112fa305bfc793be07c8f8742282"
SOURCE = ROOT / ".local/bev-decision-150k" / REVISION / "data"
OUT = ROOT / ".local/gliner-decide/bev-tool-v1"
MODEL = ROOT / ".local/gliner-decide/model"
TRAIN_SHA = "1b163182db155ba986c8ab8d3d582ac09ec1b1dcbc13c65d048e61379be9fe5b"
TEST_SHA = "eba9f9df6ad54ccdc3aa6516ab97e4f9dea4030422e0dc90510b85e462206a61"
LABELS = {"call": "The available tool can address the user's request.",
          "skip": "The available tool cannot address the user's request."}
PROMPT = "Decide whether the available tool is suitable for the request."
CONTACT = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?://|\b\+?\d[\d ().-]{8,}\d\b", re.I)
OVERRIDE = re.compile(r"\b(?:ignore|disregard|forget|override|bypass)\b.{0,60}\b(?:previous|prior|above|earlier|all)\b.{0,35}\b(?:instructions|prompts|rules|messages)\b|\bDAN\b|developer mode", re.I | re.S)


def norm(text):
    return unicodedata.normalize("NFKC", text).strip().casefold()


def row_to_case(row, index, split):
    questions = json.loads(row["questions_json"])
    q = questions.get("should_call_available_tool")
    if row["domain"] != "Tool and workflow decisions" or not q:
        return None
    if q.get("type") != "noul" or type(q.get("label")) is not bool:
        return None
    state = json.loads(row["state"])
    if set(state) != {"request", "available_tool"} or not isinstance(state["request"], str):
        return None
    tool = state["available_tool"]
    if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
        return None
    if not 20 <= len(row["state"]) <= 1400 or CONTACT.search(row["state"]) or OVERRIDE.search(row["state"]):
        return None
    # Request grouping blocks identical requests with different offered tools.
    group = hashlib.sha256(norm(state["request"]).encode()).hexdigest()
    label = "call" if q["label"] else "skip"
    return {"id": f"{split}:{index}:should_call_available_tool", "group": group,
            "text": row["state"], "label": label}


def choose_cases(train_rows, test_rows):
    train = [x for i, r in enumerate(train_rows) if (x := row_to_case(r, i, "train"))]
    test = [x for i, r in enumerate(test_rows) if (x := row_to_case(r, i, "test"))]
    test_groups = {x["group"] for x in test}
    train = [x for x in train if x["group"] not in test_groups]
    groups = defaultdict(list)
    for x in train:
        groups[x["group"]].append(x)
    selected = {"train": [], "validation": [], "test": test}
    for group, rows in groups.items():
        # Group-level deterministic 80/20 split, fixed independently of labels.
        bucket = int(hashlib.sha256(("weave-bev-tool-v1:" + group).encode()).hexdigest()[:8], 16) % 5
        selected["validation" if bucket == 0 else "train"].extend(rows)
    for split in selected:
        selected[split].sort(key=lambda x: x["id"])
    all_groups = [set(x["group"] for x in selected[s]) for s in selected]
    if any(all_groups[i] & all_groups[j] for i in range(3) for j in range(i + 1, 3)):
        raise ValueError("request group leaked across splits")
    if any(not selected[s] or set(x["label"] for x in selected[s]) != set(LABELS) for s in selected):
        raise ValueError("empty or single-class split")
    return selected


def training_case(x):
    return {"input": x["text"], "output": {"classifications": [{
        "task": "tool_suitability", "labels": list(LABELS),
        "true_label": [x["label"]], "label_descriptions": LABELS, "prompt": PROMPT}]}}


def prepare():
    import pyarrow.parquet as pq
    paths = [SOURCE / "train.parquet", SOURCE / "test.parquet"]
    if [digest(p) for p in paths] != [TRAIN_SHA, TEST_SHA]:
        raise ValueError("BEV source digest mismatch")
    cases = choose_cases(*(pq.read_table(p).to_pylist() for p in paths))
    if OUT.exists():
        raise FileExistsError(OUT)
    OUT.mkdir(parents=True)
    manifest = {"dataset": "avbiswas/bev-decision-150K", "revision": REVISION,
                "task": "should_call_available_tool", "source_sha256": {"train": TRAIN_SHA, "test": TEST_SHA},
                "status": "private exploratory proxy; source rights not resolved for redistribution or commercial use",
                "splits": {}}
    for split, rows in cases.items():
        path = OUT / f"{split}.jsonl"
        index_path = OUT / f"{split}-index.jsonl"
        path.write_text("".join(json.dumps(training_case(x), ensure_ascii=False) + "\n" for x in rows))
        index_path.write_text(
            "".join(json.dumps({k: x[k] for k in ("id", "group", "label")}) + "\n" for x in rows))
        manifest["splits"][split] = {"rows": len(rows), "groups": len({x["group"] for x in rows}),
                                    "labels": dict(Counter(x["label"] for x in rows)),
                                    "sha256": digest(path), "index_sha256": digest(index_path)}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2), flush=True)


def load_split(split):
    manifest = json.loads((OUT / "manifest.json").read_text())
    path = OUT / f"{split}.jsonl"
    index_path = OUT / f"{split}-index.jsonl"
    if digest(path) != manifest["splits"][split]["sha256"]:
        raise ValueError("split changed")
    if digest(index_path) != manifest["splits"][split]["index_sha256"]:
        raise ValueError("index changed")
    data = [json.loads(s) for s in path.read_text().splitlines()]
    index = [json.loads(s) for s in index_path.read_text().splitlines()]
    if len(data) != len(index) or len(data) != manifest["splits"][split]["rows"]:
        raise ValueError("index mismatch")
    for case, meta in zip(data, index):
        true_label = case["output"]["classifications"][0]["true_label"]
        if true_label != [meta["label"]]:
            raise ValueError(f"label mismatch for {meta['id']}")
    return data, index, manifest


def probe_row(meta, result, latency_ms):
    if not isinstance(result, dict) or type(result.get("label")) is not str or result["label"] not in LABELS:
        raise ValueError(f"invalid tool-suitability result: {result!r}")
    top_score = result.get("confidence")
    if (top_score is not None and (type(top_score) not in (int, float)
            or not math.isfinite(top_score) or not 0 <= top_score <= 1)):
        raise ValueError(f"invalid tool-suitability score: {top_score!r}")
    return {"id": meta["id"], "group": meta["group"], "label": meta["label"],
            "prediction": result["label"], "top_score": top_score,
            "latency_ms": latency_ms}


def train():
    import torch
    from gliner2 import AutoExtractor
    from gliner2.training.data import TrainingDataset
    from gliner2.training.trainer import ExtractorTrainer, TrainingConfig
    data, _, manifest = load_split("train")
    if (OUT / "adapter").exists():
        raise FileExistsError(OUT / "adapter")
    torch.set_num_threads(2)
    torch.manual_seed(42)
    model = AutoExtractor.from_pretrained(str(MODEL), map_location="cpu")
    dataset = TrainingDataset.load(OUT / "train.jsonl")
    started = time.monotonic()
    config = TrainingConfig(output_dir=str(OUT / "adapter"),
        experiment_name="bev-tool-v1", num_epochs=1, max_steps=len(data),
        batch_size=1, gradient_accumulation_steps=1, eval_strategy="no",
        save_best=False, num_workers=0, pin_memory=False, fp16=False,
        bf16=False, use_lora=True, lora_r=8, lora_alpha=16,
        lora_target_modules=["encoder.query", "encoder.value"],
        save_adapter_only=True, logging_steps=25, seed=42)
    trainer = ExtractorTrainer(model, config)
    trainer.train(train_data=dataset)
    adapter = OUT / "adapter/final/adapter_model.safetensors"
    report = {"source": manifest["dataset"], "split_sha256": manifest["splits"]["train"]["sha256"],
              "base_sha256": digest(MODEL / "model.safetensors"),
              "adapter_sha256": digest(adapter), "steps": trainer.global_step,
              "train_s": round(time.monotonic() - started, 2),
              "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    (OUT / "train-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


def probe(split, adapter):
    import torch
    from gliner2 import AutoExtractor
    from peft import PeftModel
    data, index, manifest = load_split(split)
    torch.set_num_threads(2)
    model = AutoExtractor.from_pretrained(str(MODEL), map_location="cpu")
    if adapter:
        model = PeftModel.from_pretrained(model, str(OUT / "adapter/final"))
    schema = {"tool_suitability": {"labels": LABELS, "prompt": PROMPT}}
    model.classify_text("A tool is available.", schema)
    rows = []
    for case, meta in zip(data, index):
        start = time.perf_counter()
        result = model.classify_text(case["input"], schema, include_confidence=True)["tool_suitability"]
        rows.append(probe_row(meta, result, round((time.perf_counter() - start) * 1000, 2)))
    report = {"split": split, "arm": "adapter" if adapter else "base",
              "split_sha256": manifest["splits"][split]["sha256"],
              "base_sha256": digest(MODEL / "model.safetensors"),
              "rows": rows, "n": len(rows),
              "correct": sum(x["label"] == x["prediction"] for x in rows),
              "predictions": dict(Counter(x["prediction"] for x in rows)),
              "median_ms": statistics.median(x["latency_ms"] for x in rows),
              "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    if adapter:
        report["adapter_sha256"] = digest(OUT / "adapter/final/adapter_model.safetensors")
    (OUT / f"{split}-{report['arm']}.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "train", "probe"))
    parser.add_argument("--split", choices=("validation", "test"), default="validation")
    parser.add_argument("--adapter", action="store_true")
    args = parser.parse_args()
    {"prepare": prepare, "train": train,
     "probe": lambda: probe(args.split, args.adapter)}[args.action]()
