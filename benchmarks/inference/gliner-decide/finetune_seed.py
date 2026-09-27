"""Train one purpose-specific LoRA adapter from the pinned untouched base.

This is a CPU feasibility pilot over authored synthetic rows. It never reads
validation or test examples during training and does not admit an inference
route or capability.
"""
import argparse
import json
from pathlib import Path
import resource
import time

import collect


CHECKPOINT = "7ee5da4c2415e32259bcdc0b1a7367c32ce8d6f6"
SITES = ("capability.match", "result.evaluate")
STEPS = 60


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", choices=SITES, required=True)
    parser.add_argument("--model", type=Path, default=collect.ROOT / ".local/gliner-decide/model")
    parser.add_argument("--data", type=Path, default=collect.ROOT / ".local/gliner-decide/collected")
    parser.add_argument("--output-root", type=Path, default=collect.ROOT / ".local/gliner-decide/pilot")
    parser.add_argument("--steps", type=int, default=STEPS, help="one-epoch row count for a new corpus")
    args = parser.parse_args()
    if args.steps <= 0:
        parser.error("--steps must be positive")

    directory = args.data / args.site
    manifest = json.loads((directory / "manifest.json").read_text())
    train_path = directory / "train.jsonl"
    if collect.digest(train_path) != manifest["output_sha256"]["train"]:
        raise ValueError("train data digest differs from manifest")
    output = args.output_root / args.site
    if output.exists():
        raise FileExistsError(f"pilot output already exists: {output}")
    base_weights_sha256 = collect.digest(args.model / "model.safetensors")

    import torch
    from gliner2 import AutoExtractor
    from gliner2.training.data import TrainingDataset
    from gliner2.training.trainer import ExtractorTrainer, TrainingConfig

    torch.set_num_threads(2)
    torch.manual_seed(42)
    dataset = TrainingDataset.load(train_path)
    if len(dataset) != args.steps:
        raise ValueError(f"expected {args.steps} training rows, got {len(dataset)}")
    started = time.monotonic()
    # A separate invocation per site creates a fresh base model in memory.
    model = AutoExtractor.from_pretrained(str(args.model), map_location="cpu")
    loaded = time.monotonic()
    config = TrainingConfig(
        output_dir=str(output), experiment_name=f"pilot-{args.site}",
        num_epochs=1, max_steps=args.steps, batch_size=1, gradient_accumulation_steps=1,
        eval_strategy="no", save_best=False, num_workers=0, pin_memory=False,
        fp16=False, bf16=False, use_lora=True, lora_r=8, lora_alpha=16,
        lora_target_modules=["encoder.query", "encoder.value"],
        save_adapter_only=True, logging_steps=10, seed=42,
    )
    trainer = ExtractorTrainer(model, config)
    ready = time.monotonic()
    result = trainer.train(train_data=dataset)
    finished = time.monotonic()
    adapter = output / "final" / "adapter_model.safetensors"
    if not adapter.is_file():
        raise FileNotFoundError(f"expected saved adapter: {adapter}")
    report = {
        "status": "synthetic CPU LoRA pilot; not promotion evidence",
        "site": args.site, "checkpoint": "fastino/GLiNER2.5-Decide",
        "base_revision": CHECKPOINT, "base_weights_sha256": base_weights_sha256,
        "train_sha256": manifest["output_sha256"]["train"],
        "train_rows": len(dataset), "train_groups": manifest["group_counts"]["train"],
        "recipe": {"steps": args.steps, "epochs": 1, "batch_size": 1,
                   "seed": 42, "lora_r": 8, "lora_alpha": 16,
                   "targets": ["encoder.query", "encoder.value"],
                   "precision": "float32", "threads": 2},
        "adapter_path": str(adapter), "adapter_sha256": collect.digest(adapter),
        "adapter_bytes": adapter.stat().st_size,
        "trainable_parameters": sum(p.numel() for p in trainer.model.parameters() if p.requires_grad),
        "load_s": round(loaded - started, 2),
        "setup_s": round(ready - loaded, 2),
        "train_s": round(finished - ready, 2),
        "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "global_step": trainer.global_step,
    }
    (output / "pilot-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
