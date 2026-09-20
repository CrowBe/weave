# Kev as a local decision-inference fallback

Research date: 2026-09-20. Read against `VISION.md` and `CONTEXT.md`.
This is source research and a hardware-fit assessment, not a Kev inference benchmark.
No model weights were downloaded and no runtime configuration was changed.

## Conclusion

**Kev 4B is the strongest candidate to evaluate on this PC.** Use 0.6B only as a
small, fast comparison baseline; 0.5B adds little and 8B does not justify its memory
cost on the published evidence. The 4B recommendation is conditional on a bounded
CPU experiment establishing latency, peak memory, and quality on Weave's own
judgment sites. It is not yet an admitted automatic fallback.

Kev is Jared Palmer's independent, open-weight reconstruction of a Jev-style
decision model, not a TypeSafe release. Its adapter and pointer head sit on a Qwen
backbone; it returns distributions from a forward pass rather than generating an
answer token by token. Its advertised compatibility is with TypeSafe's public
`/v1/systemone` interface. [Original model card](https://huggingface.co/jaredpalmer/kev-0.5b)

## Family comparison

Values below are the author's evaluations, not independently reproduced results.
Development and locked-test accuracy are deliberately separate. The current 4B
and 8B model cards describe newer v7 checkpoints than the older overview table and
search snippets; this table uses the individual cards' current checkpoint results.

| Candidate | Backbone | Transfer accuracy, development / locked test | Approximate base-weight storage at fp32 / bf16 | Assessment for this PC |
| --- | --- | --- | --- | --- |
| 0.5B | Qwen2.5-0.5B | 57.5% / not reported on this common locked suite | 2 / 1 GB | Historical prototype; skip initially |
| 0.6B | Qwen3-0.6B-Base | 59.8% / 63.1% | 2.4 / 1.2 GB | Useful performance baseline; weak general fallback |
| 4B, `v7-rc3/01-trial-1` | Qwen3-4B-Base | 79.0% / 80.6% | 16 / 8 GB | Preferred quality/memory tradeoff |
| 8B, `v7-final/00-trial-0` | Qwen3-8B-Base | 79.6% / 78.0% | 32 / 16 GB | Little development gain, lower locked-test score; defer |
| Hosted Jev reference | undisclosed | 85.7% / not reported here | remote | Reference, not demonstrated equivalent |

Sources: [0.6B card](https://huggingface.co/jaredpalmer/kev-0.6b),
[4B card](https://github.com/jaredpalmer/kev/blob/main/docs/model-cards/kev-4b.md),
[8B card](https://huggingface.co/jaredpalmer/kev-8b).
Weight figures are rough arithmetic from nominal parameter counts, in decimal GB;
they exclude adapters, activations, attention masks, temporary loading copies,
Python/PyTorch, and the desktop. They are not measured resident memory.

The 4B checkpoint's held-out policy-pair development score is 73%, but companion
seeds score 62% and 67%; the author's release rule requires every seed to reach
70%. Its locked-test policy-pair score is 66%. It remains a research preview.
Its development out-of-domain Brier score is 0.328 versus Jev's 0.211; 8.2% of
predictions are wrong with model probability at least 0.9. Raw out-of-domain ECE
is 0.096. These weights are not calibrated confidence for Weave.
[4B card](https://github.com/jaredpalmer/kev/blob/main/docs/model-cards/kev-4b.md)

The 8B checkpoint also remains a preview: policy-pair development score 69%,
locked-test 62%. Its locked-test Brier score is 0.327 versus 4B's 0.294.
The authors estimate approximately 33 GB at fp32 and 17 GB at bf16.
[8B card](https://huggingface.co/jaredpalmer/kev-8b)

The 0.6B model's unseen-policy paired accuracy is only 6–11%; it also tends to
choose the middle ordinal level on date arithmetic. Its locked-test accuracy is
25% on 36 none-of-the-above cases where a correct substantive answer is present.
Small size is useful for a smoke test, but does not establish a dependable fallback.
[0.6B card](https://huggingface.co/jaredpalmer/kev-0.6b)

## Hardware and execution path

The target is an i7-1355U with 32 GB system RAM and Iris Xe on Fedora 44.
The parent investigation's live hardware check found about 31 GiB total and
18 GiB available, no CUDA device, and no `avx512_bf16` CPU flag. CUDA therefore
cannot accelerate Kev on this machine. Published Mac latency is not a prediction
for this CPU.

Upstream explicitly reports serving tested on Apple MPS, and training/evaluation
tested on CUDA H100 and MPS. Thus “CUDA untested” needs that distinction; it does
not mean no CUDA execution has occurred anywhere in the project.
[Upstream README](https://github.com/jaredpalmer/kev/blob/main/README.md)

**Inference:** 4B fp32 is plausible on 32 GB when other memory-heavy workloads are
closed, but current available memory leaves limited margin. bf16 roughly halves
weight memory without proving a speedup on this CPU. Start short, one request at
a time, with one local model resident. Do not assume OpenJev and Kev can remain
resident together comfortably. Neither shared RAM nor the Iris Xe name proves a
working acceleration path for this particular implementation.

## Complementing OpenJev

Keep semantic operations distinct. OpenJev's existing experiment assesses a
premise/hypothesis relationship: entailment, contradiction, or neutral. Kev can
serve typed yes/no questions, finite choices, and ordered scores. Its shared state
prefix and isolated question branches make it a closer interface match for
Jev-style multi-question judgment sites.
[Kev architecture and API](https://github.com/jaredpalmer/kev/blob/main/README.md)

API compatibility does not establish quality parity or identical probability
semantics. The original card explicitly describes Score confidence as a surrogate
because TypeSafe's formula is unpublished. It also documents option-order
sensitivity and the limits of calibration measured on familiar distributions.
[Original model card](https://huggingface.co/jaredpalmer/kev-0.5b)

**Recommendation:** route by the semantic operation and its measured acceptance
bar. Evaluate Kev 4B for bounded choice/yes-no/ordinal judgment sites; retain
OpenJev for its entailment operation. A Jev outage may select Kev only for sites
where the pinned routed unit meets the declared quality and resource limits.
A privacy requirement must fail closed if no acceptable local implementation is
available; it must not cause a hosted escalation. Model observations remain
evidence, with deterministic policy retaining authority.

## Bounded next experiment

1. Pin source, adapter, base-model revisions, precision, and tokenizer. Start with
   short single-question cases, then realistic state views and packed questions.
2. Measure cold load, warm p50/p95 latency, peak RSS, token counts, thread count,
   and swap activity. Repeat with the desktop in normal use. Do not estimate Kev
   latency by copying OpenJev's short-pair result.
3. Use held-out Weave examples with known outcomes: negation, distractors,
   option reordering, missing evidence, none-of-the-above, and ordinal boundaries.
   Compare hosted Jev on nonprivate fixtures, and OpenJev only on shared NLI tasks.
4. Verify the actual API boundary, error responses, oversized-input handling,
   cancellation/timeouts, and privacy behavior. Record weights without treating
   them as calibrated confidence.
5. Promote only the specific judgment sites that meet an agreed quality and
   latency bar. Otherwise retain Kev as an explicit private/offline experiment.

**Disposition at research time:** 4B was ready for bounded CPU evaluation. That
evaluation is now recorded in [`results.json`](results.json), and an opt-in
baseline-quality fallback adapter exists. Site-specific admission remains
separate and must use the measured limits in [`README.md`](README.md).
