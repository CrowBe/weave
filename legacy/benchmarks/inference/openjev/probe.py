"""Offline, batch-one CPU evaluation. Output is evidence, not an admitted route."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import statistics
import time

from assess import LABELS, assess

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--cases", type=Path, default=Path(__file__).with_name("cases.json"))
    parser.add_argument("--dtype", choices=["bfloat16", "float32"], default="bfloat16")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.threads < 1 or args.max_tokens < 1 or (args.limit is not None and args.limit < 1):
        parser.error("threads, max-tokens and limit must be positive")

    import torch
    import transformers
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    cases_bytes = args.cases.read_bytes()
    cases = json.loads(cases_bytes)
    if args.limit is not None:
        cases = cases[:args.limit]
    if not cases or any(c["expected"] not in LABELS for c in cases):
        raise ValueError("invalid labeled corpus")

    started = time.monotonic()
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True, trust_remote_code=False)
    tokenizer.padding_side = "right"
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model, local_files_only=True, trust_remote_code=False,
        dtype=getattr(torch, args.dtype),
    ).eval()
    model.config.use_cache = False
    labels = {int(i): label for i, label in model.config.id2label.items()}
    if set(labels) != {0, 1, 2} or set(labels.values()) != LABELS:
        raise ValueError("checkpoint label mapping does not satisfy the contract")
    template = model.config.nli_template
    load_seconds = time.monotonic() - started
    print(f"Loaded on CPU in {load_seconds:.2f}s; dtype={args.dtype}", flush=True)

    rows = []
    input_tokens = 0

    def predict(premise, hypothesis):
        nonlocal input_tokens
        text = template.format(premise=premise, hypothesis=hypothesis)
        inputs = tokenizer(text, return_tensors="pt", truncation=False)
        input_tokens = inputs["input_ids"].shape[1]
        if input_tokens > args.max_tokens:
            raise ValueError(f"input has {input_tokens} tokens; maximum is {args.max_tokens}")
        with torch.inference_mode():
            logits = model(**inputs).logits[0].float()
            scores = torch.softmax(logits, dim=-1).tolist()
        return {labels[i]: value for i, value in enumerate(scores)}

    for case in cases:
        began = time.monotonic()
        result = assess(case["premise"], case["hypothesis"], predict)
        row = {
            "id": case["id"], "expected": case["expected"], **result,
            "correct": result["label"] == case["expected"],
            "input_tokens": input_tokens, "seconds": time.monotonic() - began,
        }
        rows.append(row)
        print(json.dumps(row), flush=True)

    report = {
        "operation": "text.assess-entailment", "status": "experimental",
        "checkpoint_revision": "4b5f9a67fa2ebe77466bce0656ce350effc3148c",
        "checkpoint_subfolder": "qwen3.5-4b-nli-v2",
        "corpus_sha256": hashlib.sha256(cases_bytes).hexdigest(),
        "torch": torch.__version__, "transformers": transformers.__version__,
        "device": "cpu", "dtype": args.dtype, "threads": args.threads,
        "max_tokens": args.max_tokens, "batch_size": 1,
        "offline": True, "calibrated": False, "load_seconds": load_seconds,
        "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "correct": sum(row["correct"] for row in rows), "total": len(rows),
        "median_seconds": statistics.median(row["seconds"] for row in rows),
        "rows": rows,
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Saved {args.output}: {report['correct']}/{report['total']} correct", flush=True)


if __name__ == "__main__":
    main()
