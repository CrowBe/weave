"""Sustained-clock measurement. Warm for a fixed wall-clock period rather than
until consecutive blocks agree: the turbo plateau is itself flat, so a
convergence test settles inside it. The reference forward is re-timed after the
measurements and the run is only valid if it has not drifted."""
import argparse, json, os, statistics, time
from pathlib import Path
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--dtype", choices=["bfloat16", "float32"], required=True)
ap.add_argument("--warmup-seconds", type=float, default=200.0)
ap.add_argument("--thread-counts", default="8")
ap.add_argument("--output", type=Path, required=True)
args = ap.parse_args()

import torch, resource
from transformers import AutoModelForSequenceClassification, AutoTokenizer
torch.set_num_interop_threads(1); torch.set_num_threads(8)
tok = AutoTokenizer.from_pretrained(args.model, local_files_only=True, trust_remote_code=False)
model = AutoModelForSequenceClassification.from_pretrained(
    args.model, local_files_only=True, trust_remote_code=False,
    dtype=getattr(torch, args.dtype)).eval()
model.config.use_cache = False
labels = {int(i): l for i, l in model.config.id2label.items()}
template = model.config.nli_template
CASES = json.loads(Path("benchmarks/inference/openjev/cases.json").read_text())
COUNTS = [int(x) for x in args.thread_counts.split(",")]

FILLER = ("The deployment pipeline promoted build 4471 to the staging cluster at 09:14 UTC "
          "after the integration suite reported no regressions. ")
HYP = "The build reached staging."
reps = 1
while len(tok(template.format(premise=FILLER * reps, hypothesis=HYP))["input_ids"]) < 128:
    reps += 1
REF = tok(template.format(premise=FILLER * reps, hypothesis=HYP), return_tensors="pt")

def timed(inputs):
    t0 = time.monotonic()
    with torch.inference_mode():
        logits = model(**inputs).logits[0].float()
    return logits, time.monotonic() - t0

def reference():
    torch.set_num_threads(8)
    return statistics.median([timed(REF)[1] for _ in range(3)])

started = time.monotonic()
trace = []
while time.monotonic() - started < args.warmup_seconds:
    trace.append(round(timed(REF)[1], 3))
print(f"warmup: {len(trace)} forwards over {time.monotonic()-started:.0f}s; "
      f"first {trace[0]:.2f}s last {trace[-1]:.2f}s ({100*(trace[-1]/trace[0]-1):+.0f}%)", flush=True)

ref_start = reference()
results = {}
for t in COUNTS:
    torch.set_num_threads(t)
    rows = []
    for c in CASES:
        inputs = tok(template.format(premise=c["premise"], hypothesis=c["hypothesis"]),
                     return_tensors="pt")
        logits, seconds = timed(inputs)
        s = torch.softmax(logits, dim=-1).tolist()
        scores = {labels[i]: v for i, v in enumerate(s)}
        best = max(scores.values()); win = [k for k, v in scores.items() if v == best]
        label = win[0] if len(win) == 1 else "undetermined"
        rows.append({"id": c["id"], "expected": c["expected"], "label": label,
                     "correct": label == c["expected"], "input_tokens": inputs["input_ids"].shape[1],
                     "seconds": seconds, "scores": scores})
    med = statistics.median(r["seconds"] for r in rows)
    ref128 = statistics.median([timed(REF)[1] for _ in range(3)])
    results[str(t)] = {"correct": sum(r["correct"] for r in rows), "total": len(rows),
                       "median_seconds": med, "total_seconds": sum(r["seconds"] for r in rows),
                       "reference_128tok_seconds": ref128, "rows": rows}
    print(f"threads {t:2d}: {results[str(t)]['correct']}/{len(rows)} corpus median {med:.2f}s; "
          f"128-tok reference {ref128:.2f}s", flush=True)

ref_end = reference()
drift = 100 * (ref_end / ref_start - 1)
print(f"\nreference 8-thread: start {ref_start:.2f}s end {ref_end:.2f}s drift {drift:+.1f}% "
      f"-> {'VALID' if abs(drift) < 5 else 'NOT AT STEADY STATE'}", flush=True)
args.output.write_text(json.dumps({
    "dtype": args.dtype, "device": "cpu", "torch": torch.__version__,
    "warmup_seconds": args.warmup_seconds, "warmup_forwards": len(trace),
    "warmup_trace": trace, "warmup_cold_vs_settled": trace[0] / trace[-1],
    "reference_start": ref_start, "reference_end": ref_end, "drift_pct": drift,
    "steady_state": abs(drift) < 5,
    "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    "by_threads": results,
}, indent=2) + "\n")
