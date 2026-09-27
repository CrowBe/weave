# GLiNER2.5-Decide local classification probe

Status: **experimental measurement**. No judgment site, inference gateway route,
or capability is admitted by this run. Predictions are observations only.

## Contract tested

`fastino/GLiNER2.5-Decide` accepts text plus a runtime-defined set of labels.
It performs single-label classification, with optional descriptions and a
question prompt. It does not generate reasoning or explanations. The model card
also demonstrates multi-label tags and ordinal labels; ordinal output remains a
class, not a continuous Jev weight. The published 340M parameter count should
be treated cautiously: the pinned Hub metadata reports 486,444,053 F32
parameters, its weight file is about 1.9 GB, and the downloaded config declares
`architecture: span` even though the checkpoint name says 2.5. These are
checkpoint facts, not assertions about other GLiNER2.5 models.

For the paired probe, a `choice` question becomes one classification over its
described options; a `noul` question becomes yes/no with the source question as
the classifier prompt; a `score` question becomes classification over its
described ordinal levels. The state is rendered identically to the existing
OpenJev transfer probe. This is a tested *mapping*, not native Jev protocol
support. The top class score is retained but is not calibrated confidence.

## Reproduce

The checkpoint is pinned to
`7ee5da4c2415e32259bcdc0b1a7367c32ce8d6f6`. Model files and the venv
live in ignored `.local/gliner-decide/` and are not needed to score the saved
result. From the repository root, with network access for preparation:

```bash
UV_CACHE_DIR=/tmp/weave-uv-cache uv venv --python 3.12 .local/gliner-decide/venv
UV_CACHE_DIR=/tmp/weave-uv-cache uv pip install --python .local/gliner-decide/venv/bin/python 'gliner2[local]' --extra-index-url https://download.pytorch.org/whl/cpu
.local/gliner-decide/venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("fastino/GLiNER2.5-Decide", revision="7ee5da4c2415e32259bcdc0b1a7367c32ce8d6f6", local_dir=".local/gliner-decide/model", ignore_patterns=["*.png", "*.md"])'
python3 -m unittest discover -s benchmarks/inference/gliner-decide -p 'test_*.py'
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/run.py
```

The input is the 125 IDs in the existing
[`Jev transfer run`](../jev/transfer-results.json), resolved from Kev's
`transfer-v4/development.jsonl`. It is an existing evaluation split and
provides a paired comparison, but is not known to be held out from this
checkpoint's training. Results and per-record predictions are in
[`results.json`](results.json).

## Observed on this host

CPU, float32, two Torch threads, batch one, one warmup call, Python 3.12,
`gliner2==2.0.0`, `torch==2.14.0+cpu`. State inputs were 6–306 tokenizer
tokens before schema labels and prompt. The process did not run a sustained
clock warmup, so latency is an exploratory local measurement. The host has 31
GiB RAM.

| outcome | GLiNER2.5-Decide | paired reference |
| --- | ---: | ---: |
| accuracy | **61/125 = 48.8%** | Jev 104/125 = 83.2%; Kev 97/125 = 77.6% |
| per-source majority-class baseline | 66/125 = 52.8% | same labels |
| median / p95 local inference | 640 ms / 1,533 ms | not a like-for-like endpoint latency |
| peak process RSS | 4.07 GiB | — |

Against Jev on the same IDs, both were right on 54; GLiNER alone was right on
7; Jev alone was right on 50; both missed 14. Against Kev, those cells are
55 / 6 / 42 / 22. The differences are large enough that no overall parity
claim is plausible on this sample, independent of small-sample uncertainty.

| source | n | GLiNER correct | majority floor | interpretation |
| --- | ---: | ---: | ---: | --- |
| SciQ science choices | 18 | 17 | 8 | clear narrow signal; Jev and Kev each got 18 |
| PAWS paraphrase | 13 | 8 | 7 | modest, too small to select a route |
| QNLI answer presence | 13 | 5 | 8 | below floor |
| emotion | 18 | 4 | 8 | below floor; 13 predictions were `love` |
| offensive text | 13 | 8 | 10 | below floor |
| MMLU choices | 20 | 6 | 7 | below floor |
| held `and/or` policy | 8 | 4 | 5 | below floor |
| held `or/not` policy | 8 | 5 | 6 | below floor |
| authorization | 4 | 2 | 2 | at floor |
| deadline ordinal score | 10 | 2 | 5 | below floor; every prediction was level `1` |

The result suggests a possible fit for **small, closed-label classification
sites** such as triage or semantic matching where the labels have good
descriptions and a separate held-out Weave corpus proves quality. The 17/18
SciQ result is evidence that the mapping can work, but that source is already
solved by both reference models. The current evidence does not support using
this checkpoint for `frontier.weigh`, goal completion, authority assessment,
policy interpretation, or as an automatic fallback for Jev's boolean, choice,
and score contract. Any use must stay inside deterministic policy and explicit
authority.

## Focused profile: `capability.match` / `choice`

The broad transfer score mixes unrelated tasks. To test the narrower
checkpoint-per-purpose idea, [`capability-match-cases.json`](capability-match-cases.json)
defines **36 cases in 12 three-arm contrast groups** for one proposed judgment
site. Every case asks which described operation, if any, matches a desired
operation. These are illustrative catalogue entries, not capabilities admitted
to Weave. The model returns one opaque candidate ID or `none`; the runtime
would still validate any proposed binding and enforce policy separately.

Each group has a base request, a relevant change that must change the answer,
and an irrelevant change that must preserve it. The six semantic catalogue
families are divided by whole family: documents, text, and tables in
`development`; calendar, code, and messages in `test`. Both splits are
human-authored exploratory data. The test results have now been inspected,
so a future fine-tune needs a fresh, independently labeled promotion set.

| split and candidate order | correct | relevant flips | irrelevant holds | false matches on `none` |
| --- | ---: | ---: | ---: | ---: |
| development, original | 15/18 | 4/6 | 6/6 | 3/3 |
| development, reversed | 15/18 | 4/6 | 6/6 | 3/3 |
| test, original | 17/18 | 6/6 | 6/6 | 1/3 |
| test, reversed | 16/18 | 6/6 | 6/6 | 2/3 |

The uniform four-label floor is 25%; the best fixed opaque label scores 6/18
(33.3%) on either split. The base checkpoint clearly reads the described
operation in this small corpus. Its recurring error is **false match**: on an
unsupported requested operation it may select the nearest available operation.
Reversing candidate presentation changed one of the 36 predictions, also a
false match. The top softmax score does not resolve this: one unsupported
transcription request was matched to translation at 0.991. The 36 rows have
only 12 independent scenario groups; these percentages are not production
reliability estimates.

Reproduce the four local CPU runs after preparing the pinned checkpoint:

```bash
python3 -m unittest discover -s benchmarks/inference/gliner-decide -p 'test_*.py'
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/capability_match.py --split development
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/capability_match.py --split development --order reverse
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/capability_match.py --split test
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/capability_match.py --split test --order reverse
```

The four `capability-match-*.json` files retain per-case labels, predictions,
scores, latency, checkpoint revision, and corpus digest. On the original
presentation, local median inference was 676 ms on development and 669 ms on
test, excluding model loading. No hosted Jev run has been made on this new
corpus, so there is no paired superiority claim.

### Site-specific fine-tune boundary

This experiment supports treating a **judgment site plus answer shape** as the
unit of specialization: `capability.match` at `choice`, with a versioned state
view, question wording, label schema, and checkpoint forming one routed unit.
It does not imply that a checkpoint good here is good at every `choice` site.
The first training objective should distinguish a real semantic match from
the nearest unsupported operation, including effect and output-shape near
misses. Training examples must be separate from both saved splits; future
validation should include new catalogue families, `none` prevalence that
reflects real requests, reversed option order, counterfactual pairs, latency,
memory, and a paired strong-route baseline. Any abstention or fallback rule
must be fitted on development data and tested on a fresh promotion set.

No threshold was fitted or used. The top softmax score cannot be treated as
calibrated confidence. The next experiment should collect a substantially
larger, independently labeled `capability.match` corpus with separate training,
validation, and protected promotion splits before fine-tuning or choosing a
fallback threshold. The present corpus is a useful contract and smoke test,
not enough evidence to route live work.

Sources: [checkpoint card](https://huggingface.co/fastino/GLiNER2.5-Decide),
[GLiNER2 classification API](https://github.com/fastino-ai/GLiNER2/blob/main/tutorial/1-classification.md).

## Two-purpose fine-tuning seed

[`collection-match.json`](collection-match.json) and
[`collection-evaluate.json`](collection-evaluate.json) are authored **synthetic
seeds**, grounded in the repo's `source.inspect`, `report.assemble`,
`report.publish`, `text.normalize`, and `report.fold` contracts. They contain
no production traces or independently adjudicated human labels. The source
contract paths are recorded in each file. A contract example in this corpus
does not admit a capability or grant it authority.

The two proposed checkpoint targets are `capability.match` / `choice` and
`result.evaluate` / `choice`. For the latter, `met`, `partial`, `unmet`, and
`unknown` keep insufficient evidence separate from a known failure. This is
an experimental answer shape; the runtime has not adopted it. Each group has
a base case, a relevant change that changes the expected answer, and an
irrelevant change that holds it. Two wording variants are correlated examples
of one scenario, so group counts are the useful measure of diversity.

| purpose | train | validation | test | independent scenario groups |
| --- | ---: | ---: | ---: | ---: |
| `capability.match` | 60 | 18 | 18 | 10 / 3 / 3 |
| `result.evaluate` | 60 | 18 | 24 | 10 / 3 / 4 |

The match set includes near misses in output, input, effects, and multi-step
requests, with an explicit `none` answer. The evaluation set covers source
identity and revisions, partial coverage, unsupported claims, evidence gaps,
publication effects, and uncertain outcomes. `collect.py` checks labels,
contrasts, unique rendered inputs, source pointers, and split boundaries. It
exports GLiNER JSONL and a separate provenance index under ignored `.local/`.
Candidate IDs in matching rows are opaque and their presentation order varies
by wording variant. The existing 36-case match probe has **zero exact input
overlap** with this seed.

```bash
python3 benchmarks/inference/gliner-decide/collect.py
python3 -m unittest discover -s benchmarks/inference/gliner-decide -p 'test_*.py'
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/probe_collection.py
```

The pinned `gliner2` loader accepts all six exported split files. The baseline
script reads validation rows only and writes per-case predictions to
[`collection-validation-baseline.json`](collection-validation-baseline.json).
On this host, the untuned checkpoint got **14/18** match rows and **16/18**
evaluation rows, across only three scenario groups each. The fixed-label
floors are 8/18 and 6/18. All four match errors were false matches on
unsupported OCR or combined inspect-and-assemble requests; their top scores
were 0.972–0.992, again showing that top score is not a safe abstention rule.
Both evaluation errors were the same partial-progress case under two surface
variants, labeled `unmet` by the checkpoint. Irrelevant changes held in all
12 group-variant pairs; relevant changes produced 2/6 match and 4/6
evaluation prediction flips. Median inference was 992 ms and 770 ms,
respectively, with 4.07 GiB peak RSS for the combined CPU process. These
validation results are a model-behavior check on authored examples, not a
quality estimate for deployed work.

The test rows were probed once after the pilot recipe was fixed, with no
subsequent tuning. These seed splits have related language
and only 16–17 independent scenarios per purpose; they are suitable for a
local fine-tuning pilot, **not** a route-quality estimate. Promotion will need
fresh, independently labeled traces or cases, a representative prevalence of
`none` and `unknown`, and paired strong-route measurements of accuracy,
abstention, latency, and memory.

### Fresh-checkpoint CPU pilot

[`finetune_seed.py`](finetune_seed.py) starts a new process and loads the
unmodified pinned base for **each** purpose. The fixed pilot recipe is one
epoch of 60 single-row steps, seed 42, float32, two CPU threads, and rank-8
LoRA on encoder query and value projections. Only each purpose's training
JSONL is passed to the trainer. The saved adapters and training reports live
under ignored `.local/gliner-decide/pilot/<purpose>/`; neither adapter changes
the checkpoint used by the other purpose.

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/finetune_seed.py --site capability.match
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/finetune_seed.py --site result.evaluate
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/probe_collection.py --site capability.match --adapter .local/gliner-decide/pilot/capability.match/final
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/probe_collection.py --site result.evaluate --adapter .local/gliner-decide/pilot/result.evaluate/final
# Once, after fixing the recipe:
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/probe_collection.py --split test
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/probe_collection.py --site capability.match --adapter .local/gliner-decide/pilot/capability.match/final --split test
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .local/gliner-decide/venv/bin/python benchmarks/inference/gliner-decide/probe_collection.py --site result.evaluate --adapter .local/gliner-decide/pilot/result.evaluate/final --split test
```

The paired results and exact changed predictions are in
[`pilot-results.json`](pilot-results.json); per-row outcomes are retained in
the `collection-*-adapter-*.json` files. Both adapters were loaded from disk
into a fresh base model for measurement.

| purpose | validation base → adapter | test base → adapter | changed predictions |
| --- | ---: | ---: | --- |
| `capability.match` | 14/18 → 14/18 | 16/18 → 16/18 | 0 across both splits |
| `result.evaluate` | 16/18 → 17/18 | 18/24 → 20/24 | 1 validation, 4 test |

For matching, the adapter changed scores but **no answers**; every unsupported
OCR, composed operation, and destination-creation error remained. For result
evaluation, it corrected one of two surface versions of a partial-progress
validation case and both surface versions of a partially completed fold in
test. It also changed two wrong `unknown` answers to wrong `met` answers in a
single multi-stage test group. The 20/24 test result is therefore a gain in
one independent test scenario, not two independent wins. Training took about
139–141 seconds per adapter while both processes contended for CPU; each
peaked near 4.07 GiB RSS and saved a 3.16 MB adapter. The measured median
inference times stayed close to the base runs, with normal run-to-run CPU
variation.

This is a training-feasibility experiment on a small synthetic seed. The
pilot supports further `result.evaluate` data collection, while the match
corpus needs more unsupported-operation examples before another tuning pass.
Fresh independently labeled cases and paired strong-route measurements are
needed before any claim that either fine-tune improves a live judgment site.
The test splits have now been inspected and must not guide another recipe
that is scored on them as though they were held out.
