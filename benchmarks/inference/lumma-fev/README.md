# Lumma-Fev 4B small local probe

Status: exploratory, 2026-09-28. This is an offline model test, not a Weave
judgment-site admission or routing change. The checkpoint was fetched at
[`7e6e82c7db7ee401f4cd7acae9d59f2b75b2b7c2`](https://huggingface.co/FrontiersMind/Lumma-fev-4b/tree/7e6e82c7db7ee401f4cd7acae9d59f2b75b2b7c2).
Its model code was inspected for obvious process and network operations before
loading. It is Apache-2.0; see the [research note](../../../docs/research/lumma-fev-weave.md).
The downloaded `model.safetensors` SHA-256 is
`4e1a15421d394473553a00f90bae6864f13d522002c569e7b7918bad618150b7`.

## Method

[`probe.py`](probe.py) fixes a 60-case slice before reading model answers:

- 24 existing Kev/Jev `transfer-v4` IDs: 12 `choice`, 6 `noul`, and 6 `score`,
  selected by the SHA-256 sort of IDs within each kind. The exact saved Kev and
  Jev outcomes are joined by ID.
- 18 `capability.match` and 18 `result.evaluate` cases: the first three sorted
  test scenario groups at each site, retaining both wording variants and all
  base/relevant/irrelevant arms. These are paired with the saved fine-tuned
  GLiNER predictions. The cases are synthetic, and several semantic themes
  overlap earlier authored training cases; they are **not** a protected route
  evaluation.

The model receives state, question type, instructions and criteria through its
native `decide()` method. Labels and saved comparator answers stay in the local
scorer. Choice takes the returned option, `noul` uses `P(yes) >= 0.5`, and an
expected `score` is rounded half up to the nearest level. The script validates
all returned probability maps and writes each case atomically to
[`results.json`](results.json). CPU inference used fp32, two PyTorch threads,
PyTorch 2.14.0+cpu, Transformers 5.15.0, and an offline pinned snapshot.

## Results

| Fixed slice | Lumma 4B | Paired comparator | Median Lumma call |
| --- | ---: | ---: | ---: |
| Transfer, 24 IDs | **19/24** | Kev 18/24; Jev 22/24 | 4.27 s |
| `capability.match`, 18 cases | **18/18** | tuned GLiNER 15/18 | 7.18 s |
| `result.evaluate`, 18 cases | 16/18 | tuned GLiNER **18/18** | 6.75 s |

On transfer, Lumma alone corrected two Kev errors and Kev alone corrected one.
By kind, Lumma/Kev scored choice **8/12 vs 8/12**, `noul` **6/6 vs 6/6**, and
ordinal score **5/6 vs 4/6**. This one-case difference does not establish a
general advantage. On `capability.match`, all three Lumma-only corrections
were `none` cases: Lumma got **6/6**, GLiNER **3/6**. On `result.evaluate`,
both Lumma errors are wording variants of one approval-binding case; it said
`unmet` where the authored label is `unknown`. The saved report contains IDs,
labels, typed answers, per-case latency, and paired correctness.

The run's recorded peak RSS was **24,497,788 KiB** (about 23.4 GiB), including
model and inference process, versus the GLiNER pilot's roughly 4.07 GiB.
That cost and the roughly 7× per-case latency make Lumma unsuitable as a
presumed resident/default route on this 32 GB CPU host. Its initial small
synthetic-site advantage justified the [BEV capability-proxy follow-up](bev.md).
That follow-up found no choice advantage over Kev and substantially worse
tool suitability than a BEV-tuned GLiNER. The local Lumma checkpoint was
removed after the follow-up under the user's cleanup condition. A fresh,
independently adjudicated site set would be needed before any route proposal.

## Reproduce and cleanup

If the pinned snapshot is fetched again into `.local/lumma-fev/model/` and
the existing Kev and GLiNER source artifacts are present:

```sh
HF_HOME=.local/lumma-fev/hf OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .local/openjev/venv/bin/python benchmarks/inference/lumma-fev/probe.py \
  --output .local/lumma-fev/reproduction.json
```

The original 60-case report is preserved. The checkpoint and transient
Hugging Face dynamic-module cache have been removed from this host.
