# FluidInference models relevant to small typed decisions

Checked 2026-09-26. This is a source review, not a local inference or benchmark
result. FluidInference publishes several different things: model conversions,
an Apple-Silicon app/runtime, and in a few cases a checkpoint from another
author. The strongest match to the GLiNER2.5-Decide question is **Laya**;
**NanoJev** is also relevant, but its published task distribution is game
actions.

## Findings

| Artifact | What it is | Fit and limits |
| --- | --- | --- |
| [Laya](https://huggingface.co/convaiinnovations/laya) / [FluidInference Core ML conversion](https://huggingface.co/FluidInference/laya-coreml) | A typed decision model family from Convai Innovations. Its multilingual checkpoint is a 322M-parameter mmBERT-base encoder with a trained decision head. It accepts text state and runtime-supplied `choice`, `score`, and `noul` questions, returning probabilities in one forward pass without token generation. Apache-2.0. | This is an architectural alternative to GLiNER2.5-Decide for Weave judgment sites: its native request/answer shape is much closer to Jev. The upstream PyTorch package can run outside Apple platforms; FluidInference's conversion and `FluidUse` integration are Core ML for macOS 14+/Apple Silicon. Its reported suite numbers are upstream/FluidInference reports, not measurements on our machine or Weave cases. |
| [NanoJev](https://huggingface.co/C-Tianyu/NanoJev) / [FluidInference conversion recipe](https://huggingface.co/FluidInference/nanojev-coreml) | 596,250,498 parameters including heads, based on Qwen3-0.6B, trained for action prediction in Maze, Snake, and ViZDoom tasks. Uses state-question-candidate inputs, a shared candidate encoder, and attention over the offered Choice set; also exposes Boolean and ordered Score paths. | The typed surface is promising, but available published evaluation is task-specific game control, not general `capability.match` or `result.evaluate`. FluidInference's Core ML repo is conversion source only and contains no converted weights. The NanoJev card identifies MIT source but does not state a trained-weight redistribution license; the conversion authors explicitly say weight redistribution permission is unresolved. Clarify the terms before repackaging or publishing weights. |
| [FluidUse](https://github.com/FluidInference/FluidUse) | Swift host application/runtime for local Mac computer use, plus Laya and GLiNER2 managers and demos. | It is not a single model or a general Linux runtime. Its Laya section exposes the typed API, while form filling is a separate 706K-parameter CUA-S1-FORMS specialist. |

## Laya details and comparison

The Laya model card describes a single-forward-pass, non-autoregressive
decision model trained with Reinforcement Learning for Calibrated Decisions
(RLCD), using strictly proper scoring rules to train probability outputs. Its
English checkpoint uses ModernBERT-large (421M total with the decision head);
the multilingual checkpoint uses mmBERT-base (322M total). The latter is the
relevant small candidate. It supports states up to 1,024 tokens by default
(with a documented 8,192-token option), and each question gets its own
caller-provided candidate set. See the [model card's architecture and API](https://huggingface.co/convaiinnovations/laya#architecture),
[typed question quickstart](https://huggingface.co/convaiinnovations/laya#quickstart),
and [license](https://huggingface.co/convaiinnovations/laya#license).

That contract contrasts with our [GLiNER2.5-Decide probe](../../benchmarks/inference/gliner-decide/README.md): GLiNER takes text and label candidates for single-label classification, and our Jev mapping is an experiment rather than a native protocol. On the existing 125-case transfer set, GLiNER reached 61/125 while Jev reached 104/125. Laya natively presents the `choice`/`score`/`noul` question forms discussed in `CONTEXT.md`'s **judgment site** and **action-weight judgment** terms. This makes it a much cleaner candidate to test at those contracts, but it is not evidence that it performs better on Weave data.

FluidInference's `laya-coreml` card says its conversion preserves the upstream
weights at revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`. It reports
16/16 fixture argmax parity with PyTorch and a separate 3,899-question suite
comparison on an Apple M5 Pro. These are conversion/suite claims from the
publisher, not our local measurements. The packages are complete Core ML
models (about 614 MB per FP16 bucket; int8-embedding `e8` buckets are about
448–453 MB) and need the matching `FluidUse` `LayaManager`; this artifact is
not directly loadable by our Linux/PyTorch GLiNER probe. For a fair local test,
use Convai's upstream PyTorch checkpoint/runtime, pin its revision and exact
variant, and report CPU results separately from FluidInference's Apple Neural
Engine timings.

FluidInference also lists a [System One Gemma Core ML artifact](https://huggingface.co/FluidInference/system-one-gemma-coreml)
and a [Kev 0.6B Core ML artifact](https://huggingface.co/FluidInference/kev-0.6b-coreml).
The former page was not retrievable in this review, so its model facts and
license remain unverified here. The latter is a Core ML conversion of Kev,
not a new architecture; it is useful only for an Apple-Silicon comparison.

## Prior local result and runtime caveat

The Claude session `c01d5cca-7bc0-4e8b-97fc-252b39ade22f` records a
2026-09-22 local benchmark of **Laya Typed Decisions 421M**, the English
ModernBERT-large checkpoint. On 168 paired records (18 cases, three shapes,
four option orderings), the session reported 46.4% Choice, 26.8% Score,
35.7% Boolean, and 2,199 ms median end-to-end latency on CPU. Its single
fp32 forward pass took 539 ms; the matching Kev 4B median was 13,472 ms.
The run checked for input truncation and bridge errors before concluding that
the zero-shot quality was at or below the constant-choice floor. The user
explicitly chose to drop Laya, and the session records removing its 808 MB
weights and bridge. The run's raw result file was removed and is not available
for independent re-scoring now; these numbers are from the session transcript
and its retained Claude project note, not this repository's benchmark artifacts.

That benchmark was **not** the 322M multilingual mmBERT checkpoint converted
by FluidInference. It establishes that Laya's typed architecture alone does
not make it a good zero-shot Weave model. It does not measure the multilingual
checkpoint or a purpose-specific fine-tune.

The broader PyTorch performance concern is real but dtype-specific: the
[Kev CPU probe](../../benchmarks/inference/kev/README.md) measured a 146x
slowdown for bf16 matrix multiplication versus fp32 on this AVX2 host, and the
[OpenJev probe](../../benchmarks/inference/openjev/README.md) measured fp32 as
3.7x faster than bf16 end to end. Conversely, the PyTorch fp32
[GLiNER2.5-Decide probe](../../benchmarks/inference/gliner-decide/README.md)
ran at 640 ms median CPU latency. PyTorch is not uniformly slow; size, dtype,
input length, and model implementation all matter on this machine.

## Practical next step

Do not repeat the 421M zero-shot test: it was already measured and deliberately
retired. The 322M multilingual checkpoint is distinct, but the earlier result
raises the bar for spending time on another zero-shot Laya run. Revisit it only
for a concrete fine-tuning plan at `capability.match` or `result.evaluate`, with
held-out quality and local fp32 runtime compared against current baselines.
NanoJev is a separate architecture study, but published evidence is tied to
games and its weight redistribution terms are unclear.

## First-party sources

- [FluidInference GitHub organization](https://github.com/FluidInference) and [Hugging Face organization](https://huggingface.co/FluidInference)
- [FluidUse README](https://github.com/FluidInference/FluidUse)
- [FluidInference Laya Core ML model card](https://huggingface.co/FluidInference/laya-coreml)
- [Convai Laya model card](https://huggingface.co/convaiinnovations/laya)
- [NanoJev model card](https://huggingface.co/C-Tianyu/NanoJev)
- [FluidInference NanoJev conversion source card](https://huggingface.co/FluidInference/nanojev-coreml)
