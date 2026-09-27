# Decision Index and BEV Decision Mix review — 2026-09-25

Sources: [Decision Index 0.2](https://huggingface.co/spaces/multimodalart/jev-decision-index),
its [methodology](https://multimodalart-jev-decision-index.static.hf.space/methodology.html),
and the [BEV 150K dataset card](https://huggingface.co/datasets/avbiswas/bev-decision-150K).
The index is a third-party evaluation, not local Weave results. Figures below
are its displayed point estimates on 2026-09-25 and may change.

## Candidate models

The index asks each entrant for 121,057 decisions over a 43-benchmark frozen
suite. Its headline averages 40 static benchmarks across five equal-weight
areas, after chance correction and counting unanswered decisions as wrong.
It omits six unrun interactive environments. Jev is a hosted HTTP reference;
entrant latency is local GPU time on one RTX PRO 6000 and is not comparable to
this machine's CPU. Treat model scores as discovery evidence, then test the
particular Weave judgment purpose on a protected local set.

| Candidate | Index / Jev 51.7 | Size shown | Reason to inspect |
| --- | ---: | ---: | --- |
| AutoJev-27B | 50.9 | 28B | Strongest open overall; full fine-tune, impractical for routine local use here. |
| Winnow-12B | 45.0 | 12B | Best smaller-than-27B headline, but Q8 format and RAM/runtime need checking. |
| Decision 1.0 Lux | 39.0 | 9.7B | Trained head/adapter with 99.6% answer coverage. |
| Hopper | 37.0 | 4.7B | 100% answer coverage; good small-model follow-up. |
| Decider 4B | 36.6 | 4.7B | Same family as our 2B run; distinct checkpoint, worth paired local testing. |
| Kev 4B | 31.3 | 4.7B | Already measured locally; helps anchor site versus Weave-specific results. |
| Decider 2B | 26.1 | 2.3B | Site agrees that size trades away broad decision quality. |
| GLiNER2.5-Decide | 10.0 | 486M | Likely purpose-specific after tuning; not a broad Jev substitute. |

The index's reported `Decider 2B` is a Qwen3.5-2B-base FP8 checkpoint, while
our paired local test used `Mapika/decider-2b` v11 at 1.9B. Do not equate those
scores or revisions. Its listed 27B-class rows include decoding techniques
and full fine-tunes, so an index score does not imply an obtainable checkpoint
or a format usable by our local runtime.

## Fit of a 27B model on this machine

Observed host: 31 GiB RAM, 8 GiB swap, Intel Iris Xe, no discrete GPU.
Dense 27B weights alone require about 50.3 GiB at 16-bit, 25.1 GiB at 8-bit,
or 12.6 GiB at theoretical 4-bit, before quantization metadata, runtime,
context/KV cache, and OS memory. Thus 16-bit will not fit; 8-bit is too close
to physical RAM for a reliable resident service; a supported 4-bit GGUF
could load but would run on CPU and is unlikely to be pleasant interactively.
This is a capacity estimate, not a run of any index model. The existing Bonsai
27B PQ2_0 local probe in the inference README did load in about 7 GiB RSS but
generated around one token/second, confirming that “fits” and “useful locally”
are separate questions. Mixture-of-experts models still store all experts, even
when only a few are active per token.

## BEV 150K as a data source

The dataset card describes 150,000 rows: 125,614 train and 24,386 test,
296,582 questions, with 120,842 `choice`, 118,265 `noul`, and 57,475 `score`
questions. Columns are `state`, `questions_json`, `domain`, `question_types`,
and `question_count`; `questions_json` contains bounded criteria and a label.
The [pinned row-level audit](bev-decision-150k-audit.md) records injection-like
source text, split overlap, label balance, and privacy review candidates.
This is directly useful for typed parser/inference harness development and for
domain-stratified exploratory probes. Relevant domains include support and
intent routing (12,656 rows), tool/workflow decisions (10,224), response quality
(8,693), and software engineering (8,186). It is **not** automatically an
independent Jev benchmark for `capability.match` or `result.evaluate`:
upstream tasks and labels have different meanings from those contracts.

The card says the test split is held out from this mixture, but not an
independent benchmark; some public benchmark families recur in model training.
The release has no row-level source IDs, raw source downloads, or generation
scripts, so overlap auditing and source-family blocking are limited. Some
question wording was rewritten by GPT-6 Luna while source-backed labels were
retained, and some upstream data is itself synthetic. A sampled label audit
should check cases with constructed alternatives, ordinal anchors, and long
context before using scores for a model decision. Its `score` is an ordinal
label, not a calibrated probability. The Hub reports `license: unknown` and
the author asserts no blanket license, so source-specific terms need review
before redistribution or commercial use.

Recommended next slice: keep our purpose-specific validation/test cases
protected; use a small, pinned, domain-stratified BEV subset for exploratory
coverage and error analysis. Separate any BEV-derived training data by source
family and input state from evaluation, and do not relabel a BEV upstream
outcome as Weave execution authority or real-world task success.
