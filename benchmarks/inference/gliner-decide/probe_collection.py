"""Probe a fresh base or one adapter on one fixed synthetic split.

Use test only after fixing the training recipe and making no further tuning
changes. This is a synthetic-data check, not a route or promotion measurement.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import resource
import statistics
import time

import collect


CHECKPOINT = "7ee5da4c2415e32259bcdc0b1a7367c32ce8d6f6"


def summarize(rows):
    groups = defaultdict(dict)
    for row in rows:
        groups[(row["group"], row["variant"])][row["arm"]] = row
    labels = Counter(row["label"] for row in rows)
    return {
        "n": len(rows), "correct": sum(row["correct"] for row in rows),
        "groups": len({row["group"] for row in rows}),
        "label_counts": dict(labels),
        "majority_floor": max(labels.values()),
        "uniform_floor": sum(1 / row["option_count"] for row in rows),
        "relevant_flips": sum(g["base"]["predicted"] != g["relevant"]["predicted"] for g in groups.values()),
        "irrelevant_holds": sum(g["base"]["predicted"] == g["irrelevant"]["predicted"] for g in groups.values()),
        "contrast_pairs": len(groups),
        "median_ms": statistics.median(row["latency_ms"] for row in rows),
        "p95_ms": sorted(row["latency_ms"] for row in rows)[int(0.95 * (len(rows) - 1))],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=collect.ROOT / ".local/gliner-decide/model")
    parser.add_argument("--data", type=Path, default=collect.ROOT / ".local/gliner-decide/collected")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--split", choices=("validation", "test"), default="validation")
    parser.add_argument("--site", choices=("capability.match", "result.evaluate"))
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--output", type=Path, help="write report here instead of the default checked-in path")
    args = parser.parse_args()
    if args.adapter and not args.site:
        parser.error("--adapter requires --site")

    import torch
    from gliner2 import AutoExtractor
    from peft import PeftModel

    torch.set_num_threads(args.threads)
    model = AutoExtractor.from_pretrained(str(args.model), map_location="cpu")
    if args.adapter:
        model = PeftModel.from_pretrained(model, str(args.adapter))
    model.classify_text("A report is ready.", {"match": ["draft", "publish"]})
    report = {"status": "synthetic adapter probe" if args.adapter else "synthetic base probe",
              "checkpoint": "fastino/GLiNER2.5-Decide",
              "revision": CHECKPOINT, "split": args.split,
              "device": "cpu", "threads": args.threads,
              "torch": torch.__version__, "sites": {}}
    if args.adapter:
        report["adapter_sha256"] = collect.digest(args.adapter / "adapter_model.safetensors")
    for site in ((args.site,) if args.site else ("capability.match", "result.evaluate")):
        directory = args.data / site
        manifest = json.loads((directory / "manifest.json").read_text())
        if manifest["output_sha256"][args.split] != collect.digest(directory / f"{args.split}.jsonl"):
            raise ValueError(f"{args.split} digest changed for {site}")
        cases = [json.loads(line) for line in (directory / f"{args.split}.jsonl").read_text().splitlines()]
        index = [json.loads(line) for line in (directory / f"{args.split}-index.jsonl").read_text().splitlines()]
        if len(cases) != len(index) or len(cases) != manifest["examples"][args.split]:
            raise ValueError(f"{args.split} index does not align for {site}")
        outcomes = []
        for case, meta in zip(cases, index):
            classification = case["output"]["classifications"][0]
            schema = {classification["task"]: {
                "labels": classification["label_descriptions"],
                "prompt": classification["prompt"],
            }}
            started = time.perf_counter()
            prediction = model.classify_text(case["input"], schema, include_confidence=True)
            elapsed = (time.perf_counter() - started) * 1000
            answer = prediction[classification["task"]]
            if answer["label"] not in classification["labels"]:
                raise ValueError(f"invalid result for {meta['id']}")
            outcomes.append({"id": meta["id"], "group": meta["group"], "variant": meta["variant"],
                             "arm": meta["arm"], "label": meta["wire_label"],
                             "predicted": answer["label"], "correct": answer["label"] == meta["wire_label"],
                             "top_score": answer.get("confidence"), "option_count": len(classification["labels"]),
                             "latency_ms": round(elapsed, 2)})
        report["sites"][site] = {"split_sha256": manifest["output_sha256"][args.split],
                                 "summary": summarize(outcomes), "rows": outcomes}
        print(json.dumps({"site": site, "summary": report["sites"][site]["summary"]}), flush=True)
    report["peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    output = args.output or collect.HERE / (f"collection-{args.site.replace('.', '-')}-adapter-{args.split}.json"
                                          if args.adapter else f"collection-{args.split}-baseline.json")
    output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
