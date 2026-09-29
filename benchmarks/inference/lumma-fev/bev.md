# BEV capability-proxy follow-up: Lumma 4B

Status: exploratory local benchmark, 2026-09-28. This is not a Weave
`capability.match` evaluation or route-admission result. The BEV source has
mixed, unresolved rights, possible upstream overlap, and no row-level source
identity. Raw source text and labels remain in ignored `.local/` artifacts.

## Frozen slices and scoring

[`prepare_bev.py`](prepare_bev.py) pinned the BEV Parquet revision
`f83fe8b97094112fa305bfc793be07c8f8742282` and its file digests. It
produced two capability-related proxy slices:

| Slice | Independent units | Presentations | Question | Paired comparator |
| --- | ---: | ---: | --- | --- |
| Tool suitability | 72 request groups, 105 request/tool rows | 105 | Is the offered tool suitable? | BEV-tuned GLiNER on exactly these 105 rows |
| Tool selection | 24 distinct requests | 48 | Choose one of two offered tools | Kev 4B on exactly these 48 presentations |

The suitability slice reuses the filtered, frozen GLiNER test partition.
Some requests occur with multiple offered tools, so the 105 rows are not
independent tasks. Lumma received BEV state and the NOUL question through
its native `decide()` API; the Boolean gold label and GLiNER prediction were
held in the scorer. A returned probability of at least 0.5 meant `call`.

The pinned BEV `tool_selection` target puts the labeled option **first in
all 779 test rows**; an independent inspection also found it first in all
2,836 train rows. Original-order accuracy alone would be a position shortcut.
The selection slice therefore freezes one row per normalized request and
runs each with both the original and reversed criterion order. The first-option
baseline gets 24/48 presentations and **zero complete pairs**. Each request
has exactly two offered tools and no `none` option. We excluded exact
normalized train-state duplicates, long rows, contact/URL-shaped rows, and
simple prompt-override patterns. This does not establish semantic separation
from training or the upstream source.

The same frozen private cases and labels fed [`probe_bev.py`](probe_bev.py) and
the existing Kev BEV runner through [`export_bev_kev.py`](export_bev_kev.py).
[`analyse_bev.py`](analyse_bev.py) checks all case IDs, sample hashes, labels,
accepted Kev results, and pair completeness before comparing scores. Tracked
reports contain case IDs, labels, predictions, timings, and hashes, but no raw
BEV text. Lumma used the pinned `FrontiersMind/Lumma-fev-4b` revision in
offline fp32 CPU mode with two threads. Kev used the existing local Kev 4B
run, based on pinned `Qwen/Qwen3-4B-Base`, also offline with two threads.

## Results

| Slice | Lumma 4B | Paired comparator | Median CPU call |
| --- | ---: | ---: | ---: |
| Tool suitability | **92/105** | BEV-tuned GLiNER **103/105** | Lumma 4.34 s; GLiNER 1.11 s |
| Tool selection, original order | 24/24 | Kev 24/24 | — |
| Tool selection, reversed order | 24/24 | Kev 24/24 | — |
| Tool selection, both orders correct per request | **24/24** | Kev **24/24** | Lumma 8.22 s; Kev 8.20 s per presentation |

For suitability, both models got all 45 `call` rows right. Lumma falsely
called 13 of 60 `skip` rows; GLiNER falsely called two. GLiNER alone corrected
11 Lumma errors, and Lumma alone corrected none. The two disputed GLiNER
errors noted in the [GLiNER pilot](../gliner-decide/bev-tool-v1.md) retain
their source labels here; we did not change labels after seeing predictions.

For selection, both models got all 48 presentations right and made the same
choice across option orders in each of the 24 requests. Count these as **24
paired decisions**, not 48 independent successes. The result rules out a
simple first-option shortcut on this sample; it does not distinguish the two
models' accuracy or prove either can abstain when no offered tool fits. The
Lumma process peaked at 22,841,736 KiB RSS (about 21.8 GiB).

The earlier [60-case probe](README.md) gave Lumma a small advantage on
synthetic `capability.match` and transfer slices. This more source-grounded
BEV follow-up does not confirm an advantage over Kev for choice or tuned
GLiNER for suitability. No runtime route or semantic contract changed. The
Lumma checkpoint was removed after this run under the user's cleanup
condition; reports and private frozen cases remain for audit.

## Reproduce

Preparing again requires the pinned BEV and GLiNER private artifacts, and
the output directory must be absent:

```sh
/home/bencrow/.local/share/weave/kev/src/.venv/bin/python benchmarks/inference/lumma-fev/prepare_bev.py
/home/bencrow/.local/share/weave/kev/src/.venv/bin/python benchmarks/inference/lumma-fev/export_bev_kev.py
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
  .local/openjev/venv/bin/python benchmarks/inference/lumma-fev/probe_bev.py
HF_HOME=/home/bencrow/.local/share/weave/kev/hf HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
  /home/bencrow/.local/share/weave/kev/src/.venv/bin/python benchmarks/inference/bev-sample/runner.py \
  --cases .local/lumma-fev/bev/kev-cases.json --labels .local/lumma-fev/bev/kev-labels.json \
  --output benchmarks/inference/lumma-fev/bev-kev-results.json --threads 2
python3 benchmarks/inference/lumma-fev/analyse_bev.py
```

[`bev-results.json`](bev-results.json) and
[`bev-kev-results.json`](bev-kev-results.json) are the saved case-level
evidence. Re-running Lumma requires fetching and validating its pinned
checkpoint again; the model is not retained locally.
