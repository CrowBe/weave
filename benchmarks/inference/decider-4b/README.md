# Decider 4B transfer probe

This exploratory comparison runs the public [`Mapika/decider-4b`](https://huggingface.co/Mapika/decider-4b)
checkpoint at immutable Hugging Face revision
`eb5fbdfc9448473ec25e399882912863afbdb70e` (v2.1, released 2026-09-24) on
the exact 125 paired Jev/Kev transfer IDs used by
[`decider-2b/transfer.py`](../decider-2b/transfer.py). The Hub model card describes
the checkpoint as 8.4 GB bf16 and supports the native `Decider.system_one`
interface. This run uses the CPU eager path and never calls a remote inference
provider.

For every case, the runner gives the model the state plus the native question
fields `type`, `instructions`, and `criteria`. The reference `label` is excluded
from model input. The raw typed answer and probabilities are retained in the
result JSON. Choice uses the returned key, NOUL uses probability `>= 0.5`, and
Score rounds the expected score half up, matching the existing 2B transfer
scorer.

## Measured results

The full run completed on the same 125 IDs as the saved Jev and Kev transfer
reports. Model accuracy was 96/125 (76.8%); Jev scored 104/125 (83.2%) and Kev
97/125 (77.6%). Decider 4B was correct where Jev was wrong on 6 cases; Jev was
correct where Decider 4B was wrong on 14. Against Kev, those counts were 6 and
7. This is a small exploratory transfer probe, not evidence to change routing.

| Type | N | Decider 4B | Jev | Kev |
| --- | ---: | ---: | ---: | ---: |
| Choice | 72 | 57 (79.2%) | 59 (81.9%) | 57 (79.2%) |
| NOUL | 43 | 35 (81.4%) | 36 (83.7%) | 34 (79.1%) |
| Score | 10 | 4 (40.0%) | 9 (90.0%) | 6 (60.0%) |

| Source | N | Decider 4B | Jev | Kev |
| --- | ---: | ---: | ---: | ---: |
| MMLU | 20 | 11 (55.0%) | 16 (80.0%) | 10 (50.0%) |
| Emotion | 18 | 12 (66.7%) | 10 (55.6%) | 14 (77.8%) |
| Offensive tweet | 13 | 9 (69.2%) | 9 (69.2%) | 9 (69.2%) |
| QNLI | 13 | 12 (92.3%) | 11 (84.6%) | 11 (84.6%) |
| PAWS | 13 | 10 (76.9%) | 12 (92.3%) | 10 (76.9%) |
| SciQ | 18 | 18 (100%) | 18 (100%) | 18 (100%) |
| Authorization contrasts | 4 | 4 (100%) | 4 (100%) | 4 (100%) |
| Deadline score contrasts | 10 | 4 (40.0%) | 9 (90.0%) | 6 (60.0%) |
| Held composition (and/or) | 8 | 8 (100%) | 7 (87.5%) | 7 (87.5%) |
| Held composition (or/not) | 8 | 8 (100%) | 8 (100%) | 8 (100%) |

On the ten ordinal Score items, absolute error on the rounded ordinal was 6
levels total (mean 0.60) for Decider 4B, 8 (mean 0.80) for Decider 2B, and 1
(mean 0.10) for Jev. Exact ordinal counts were 4, 2, and 9 respectively. The
raw expected scores, rounded predictions, and per-item errors are in
[`score-comparison.json`](score-comparison.json). The small Score sample is
especially weak for Decider 4B and does not establish a general improvement.

Across all 125 per-case calls, latency mean was 43.1 s, median 36.5 s, and p95
93.3 s; the maximum was 109.7 s. The process peak RSS was 7.74 GiB. This used
CPU eager inference, bf16, and four PyTorch threads; model loading is excluded
from the per-case latency figures. Long states caused substantial latency
variation.

## Reproduce

The downloaded, pinned snapshot was stored under ignored `.local/decider-4b/model`.
If those ignored weights have been removed, redownload the same revision with
the existing `.local/openjev/venv` before running the probe:

```sh
.local/openjev/venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download(
    "Mapika/decider-4b",
    revision="eb5fbdfc9448473ec25e399882912863afbdb70e",
    local_dir=".local/decider-4b/model",
)
PY
```

The existing `.local/openjev/venv` supplies PyTorch 2.14.0+cpu,
Transformers 5.15.0 and Hugging Face Hub. The checkpoint includes the inference
package under `decider/`.

To reproduce a fresh pilot and then continue the same output through all 125
cases, use a separate ignored output path so the measured report is
preserved:

```sh
PYTHONPATH=.local/decider-4b/model HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .local/openjev/venv/bin/python benchmarks/inference/decider-4b/transfer.py \
  --limit 3 --output .local/decider-4b/reproduction-results.json
PYTHONPATH=.local/decider-4b/model HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .local/openjev/venv/bin/python benchmarks/inference/decider-4b/transfer.py \
  --output .local/decider-4b/reproduction-results.json
```

The runner writes atomically after each case, checks the suite and paired-ID
hashes when resuming, and records the model revision, config, runtime versions,
raw answers, latency, and process peak RSS in
[`transfer-results.json`](transfer-results.json). Its scorer tests can be run
with:

```sh
.local/openjev/venv/bin/python -m unittest discover -s benchmarks/inference/decider-4b -p 'test_*.py'
```

After all three paired 125-row result files are available, generate the
per-case Score comparison (expected values, rounded ordinals, and ordinal
absolute errors for 4B, 2B, and Jev) with:

```sh
.local/openjev/venv/bin/python benchmarks/inference/decider-4b/analyse.py
```

The 125 mixed cases are a small transfer probe, not a protected evaluation set
or routing evidence. Public source-family overlap with training is possible.
