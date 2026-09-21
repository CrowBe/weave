# Local inference experiments

## Retired generative setup — 2026-09-20

Host: Intel i7-1355U, 32 GB RAM, Iris Xe, Fedora 44. PrismML runtime
`prism-b10709-9a9394a`.

An independent short CPU benchmark of Bonsai 2 27B PQ2_0 (8 threads,
16 prompt tokens, 8 generated tokens, one repetition) measured 1.24 prompt
tokens/s and 0.99 generated tokens/s, with about 7 GiB peak process RSS.
This confirms execution is possible; it is too slow for this interactive
development workload. It is not a systematic hardware or kernel profile.

The earlier experiment recorded 0.91 generated tokens/s for PQ2_0 on CPU,
and 0.31–0.40 for PTQ1_0 across CPU/Vulkan. These are prior experiment notes,
not independently repeated here. Throughput alone does not establish the
precise kernel bottleneck or prove an unavailable GPU implementation.

Qwen3-4B answered a live local arithmetic probe in 0.577 seconds, with server
decode timing around 10.94 tokens/s on that very short response. The user
rejected its quality for the intended work; the previous redaction example
also reportedly left identifiers behind. Fast execution is not task success.

At the user's request, the dedicated service, runtime, Qwen 4B/8B and both
Bonsai weight files, local credential, installer, adapter and example were
removed. Hosted gateway work remains. Source was backed up under
`/tmp/weave-local-cleanup-backup/` before cleanup; that is a temporary recovery
copy, not a maintained alternative implementation.

## OpenJev direction

Test `text.assess-entailment` as a distinct candidate semantic operation.
Do not substitute it for arbitrary Jev judgments after an API failure.
Privacy is a destination constraint; measured latency and quality determine
where the implementation is usable. See `benchmarks/inference/openjev/README.md` for the
contract, pinned checkpoint and evaluation procedure.

### OpenJev CPU result — 2026-09-20

OpenJev 4B v2, pinned revision
`4b5f9a67fa2ebe77466bce0656ce350effc3148c`, ran offline with native
Transformers 5.15.0 and PyTorch 2.14.0+cpu. The downloaded weight file's SHA256
was verified against its Hugging Face metadata. No custom remote model code
was loaded.

With bfloat16, eight CPU threads and batch size one, all **12/12** hand-labeled
exploratory cases matched their expected label. Median judgment latency was
**4.86 seconds**, ranging from **3.52 to 7.30 seconds**, for 20–38 input tokens.
Reported model loading took 1.14 seconds, but lazy weight paging means that is
not a cold-ready latency guarantee. The full run includes the first inference.

Cases include missing evidence, negation, possibility versus certainty,
exclusive versus nonexclusive approval statements, quoted instructions,
numeric comparison and conjunction. Approval examples test textual entailment
only; the model does not issue or validate execution authority. The quoted
instruction case passing once does not prove general injection resistance.

Disposition: **promising for occasional private entailment checks; remains
experimental**. The corpus is small, short and hand-authored, with no held-out
admission set or calibration study. Multi-hypothesis ranking would multiply
the inference work and requires its own evaluation. No gateway route or
automatic Jev fallback has been installed.

Raw measurements: [openjev/cpu-results.json](openjev/cpu-results.json).
Model files and the isolated environment remain under ignored `.local/openjev/`
for further experiments. There is no resident process or auto-start service.

Validation after removing the generative setup: repository structural checks,
TypeScript build and example typecheck passed; 100 remaining repository tests
and five entailment contract checks passed. Unrelated pre-existing source was
compared against the pre-cleanup archive and preserved.

## Kev direction

Test `decision.typed` as a second candidate semantic operation, distinct from
OpenJev's entailment: a shared state view plus typed `noul` / `choice` /
`score` questions, answered as probability distributions from one forward
pass. Kev's interest to Weave is that it serves TypeSafe's public
`/v1/systemone`, which is the contract
`packages/gateway/src/adapters/typesafe-ai.ts` already speaks. See
[kev/model-selection.md](kev/model-selection.md) for the family comparison that
selected 4B, and `benchmarks/inference/kev/README.md` for the contract, pins and procedure.

### Kev 4B CPU result — 2026-09-20

Kev 4B (`jaredpalmer/kev-4b` at `2bd3bb9a9957aff9a4803be7ce91a521cdff0a31`, a
LoRA r=16 adapter and pointer head over `Qwen/Qwen3-4B-Base` at
`906bfd4b4dc7f14ee4320094d8b41684abff8539`) ran offline on CPU against the
author's own `evals/v4/decision-v4` development split, scored by upstream's
`kev.benchmark` called as a library. The backbone revision is pinned three
ways that agree: the adapter's `head.pt`, the suite manifest, and the Hub.

**Precision is not a free choice on this machine, and the obvious saving is
backwards.** The i7-1355U reports `AVX2` and carries no `avx512_bf16` and no
AMX, so PyTorch has no vectorised bf16 GEMM and emulates it in scalar code. A
1024-cube matmul on four idle threads: fp32 17.8 ms (120.4 GFLOP/s), bf16
2596.4 ms (0.8 GFLOP/s), fp16 2703.8 ms (0.8 GFLOP/s) — a 146x penalty. End
to end on one 703-token record, bf16 took 191 s and fp32 30 s. Halving weight
memory costs four to six times the time, so **fp32 is the only workable
precision here** and the full ~16 GB of weights has to fit. bf16 also loads in
1.7 s against fp32's 6-12 s, which is not a speed advantage but lazy mmap: the
bf16 weights fault in during the first forward pass, while fp32 must
materialise the upcast from the bf16 checkpoint at load.

This also put an asterisk on the OpenJev result above. That run used bfloat16
on the same CPU, so its 4.86 s median carried the same penalty. It has since
been re-measured at fp32 — see
[OpenJev re-measurement and transfer result](#openjev-re-measurement-and-transfer-result--2026-09-20)
below, which also shows the 4.86 s figure was too optimistic for a second and
independent reason.

**Resident memory leaves no headroom.** fp32 peaks at 19.3 GB RSS against
31 GB total, which fits only with the desktop quiet. During the run swap
stayed near full at roughly 8.0 GB of 8.2 GB, but that is idle desktop
applications correctly paged out, not the model thrashing: `vmstat` showed
`so=0` and 1% IO wait against 61% user time. Kev's own `VmSwap` was zero.

**A constant predictor fails the corpus, as required.** Two stubs that read
neither the state nor the question were scored on the same sample before the
checkpoint was trusted. Both are well-formed — they return distributions over
exactly the declared option keys and pass upstream's own
`prediction_rows` validation — so they fail on accuracy rather than by being
unscorable. Both scored 0.370 accuracy against the reference checkpoint's
0.854, and both scored a **paired flip rate of 0.0 and 0.0 both-correct on
contrastive pairs**, against the reference's 0.8875. That last metric is the
sharpest control: a model that ignores the state cannot flip its answer when
the state changes, by construction. Their accuracies are identical to each
other only because `argmax` breaks the uniform stub's ties at index 0, so the
uniform stub is not a chance baseline. Note also that the uniform stub's ECE
of 0.067 nearly matches the reference checkpoint's 0.065 — calibration error
alone does not distinguish a real model from one that reads nothing.

**Which suite the number comes from decides what it means.** The pinned
adapter is checkpoint `v7-rc3/01-trial-1` (`training_config.json`), and two
v4 suites ship with the upstream source. `decision-v4`'s manifest lists
twelve `trainable_sources` and an empty `holdout_sources`: every source in
that split is one the checkpoint was trained on, and the model card labels
the figure "in-distribution accuracy" (0.854). `transfer-v4` declares
`trainable_sources: []`, `eval_only: true`, and nine holdout sources —
mmlu, emotion, tweet_offensive, qnli, paws, sciq, contrastive,
legacy_holdout, composition_holdout — where the card reports 0.790 accuracy
and a 0.328 Brier score. Weave's judgment sites are unseen content, so the
transfer figure is the one that bears on fitness; the in-distribution figure
mainly confirms the install is correct. Both were run here.

One discrepancy is worth recording rather than resolving: the card's training
section names `evals/v4/decision-v4` as the frozen training suite, while the
adapter's own `training_config.json` names `/root/evals/v7/decision-v7`. The
two disagree about which suite version supplied the training records. It does
not change the reading above, because the source-level split is what matters
and `decision-v4`'s manifest marks all of its own sources trainable either way.

**The constant-predictor floor moves with the suite, so the two accuracies
are not comparable to each other.** On `decision-v4`, dominated by wide choice
questions (banking77 alone has 77 options), the always-first stub scores 0.370.
On `transfer-v4`, which carries many binary questions (paws, qnli, contrastive),
the same stub scores 0.490. So 0.854 sits 0.48 above its floor while 0.790 sits
0.30 above its own. Comparing the two raw numbers mostly compares option counts.

**Every one of these numbers is measured on states of at most 384 tokens.**
The benchmark path encodes with `strict=True` at the default `max_state=384`,
which the suite manifest also declares, and a 401-token state raises
`state exceeds 384 tokens: 401` rather than being truncated. The HTTP server
raises the same limit to 8192 and drops strictness, so it will answer a
2000-token state without complaint — five times outside the envelope anything
here was measured in. That is a measurement gap rather than a safety hole, but
it means a Weave site with a large state view needs its own measurement before
any of this transfers. Details and the reproduced boundary table are in
`benchmarks/inference/kev/README.md`.

#### Result: decision-v4 (in-distribution), 129 records / 138 clean questions

Ran offline, fp32, 8 threads, 1629 s of wall clock for 129 records.

| metric | this run | always-first stub | uniform stub | author, full split |
| --- | ---: | ---: | ---: | ---: |
| accuracy | **0.884** | 0.370 | 0.370 | 0.854 |
| ECE | 0.082 | 0.630 | 0.067 | 0.065 |
| Brier | 0.199 | 1.261 | 0.668 | 0.213 |
| NLL | 0.387 | 13.065 | 1.380 | 0.471 |
| confident error rate | 0.058 | 0.630 | 0.000 | 0.042 |
| score MAE | 0.406 | 2.292 | 1.375 | 0.454 |

The accuracy is **consistent with, not better than**, the author's published
figure. On 138 questions the binomial standard error is 0.027, so the 95%
interval is roughly [0.831, 0.937] and the +0.030 gap to 0.854 is 1.1 standard
errors. The sample can separate a working checkpoint from a broken one; it
cannot resolve a few points of accuracy, and no claim here should rest on the
difference. Both constant predictors sit at 0.370, and on the eight contrastive
pairs in the sample the checkpoint flips 0.75 of them with both answers correct
against the stubs' 0.0 — the control that a state-blind predictor cannot pass
by construction. The author reports 0.8875 on 80 pairs; eight pairs is too few
to compare against that.

**The weakest cell is the one Weave cares most about.** Per source, boolq
scores 0.500 accuracy with an ECE of 0.464 — at chance, and confidently so.
boolq is yes/no reading comprehension over a passage, which is exactly the
shape of a `noul` question against a state view. The other yes/no sources did
fine (agnews_yn 0.909 on 22, yelp_yn 1.000 on 8), so this is about passage
difficulty rather than the question type, and eight questions is weak evidence.
It is still the first thing to measure properly before any boolean judgment
site is routed here.

| slowest sources | acc | ECE |
| --- | ---: | ---: |
| boolq (n=8) | 0.500 | 0.464 |
| amazon (n=8) | 0.750 | 0.077 |
| sst5 (n=8) | 0.750 | 0.300 |
| yelp (n=8) | 0.750 | 0.240 |

**Latency is the finding that decides deployment.** Per record: median 8.9 s,
p90 19.0 s, p95 52.4 s, max 57.8 s, at 14.0 tokens/second of prefill across
22,773 tokens. Input tokens were median 107, p90 314, max 826. The author
records a 51.8 ms median for the same checkpoint on accelerated hardware. This
machine is roughly 170x slower, and that gap is not a tuning problem — it is
fp32 on a 15 W AVX2 CPU with no vector path for anything narrower. A judgment
site that can wait tens of seconds can use this; an interactive one cannot.

**Two-decimal wire rounding costs no decisions but damages the likelihood.**
Replaying every full-precision row through the server's `r2()` and rescoring:
accuracy is unchanged at 0.884, argmax changed on **zero** of 138 questions,
and Brier (0.1992 to 0.1993) and ECE (0.0818 to 0.0828) barely move. NLL
degrades from 0.387 to 0.492, entirely because one true label fell below 0.005
and rounded to exactly zero. Splitting by option count, the wide questions are
not where the damage is — 6-20 options and 21+ options both round losslessly
in this sample, and the single zeroed label is in a 2-5 option question where
the model was confidently wrong. So Weave can consume a rounded argmax and its
confidence safely, but must not treat a rounded distribution as a likelihood.

#### Result: transfer-v4 (out-of-domain), 125 records / 104 clean questions

Same checkpoint, same machine, same settings; nine holdout sources the model
was never trained on. 978 s of wall clock for 125 records.

| metric | this run | always-first stub | uniform stub | author card |
| --- | ---: | ---: | ---: | ---: |
| accuracy | **0.808** | 0.490 | 0.490 | 0.790 |
| ECE | 0.081 | 0.510 | 0.098 | — |
| Brier | 0.291 | 1.019 | 0.607 | 0.328 |
| NLL | 0.644 | 10.561 | 1.000 | — |
| confident error rate | 0.077 | 0.510 | 0.000 | — |

Again consistent with the author rather than better: 104 questions give a
standard error of 0.039, so the 95% interval is [0.732, 0.883] and the +0.018
gap to 0.790 is 0.46 standard errors. Against its own constant-predictor floor
of 0.490 the checkpoint is 8.2 standard errors clear, so it is unambiguously
reading the state on content it has never seen.

**The honest comparison between the two suites is the margin over each floor,
not the raw accuracies.** In distribution the checkpoint scores 0.884 against a
0.370 floor, a margin of 0.51. Out of domain it scores 0.808 against a 0.490
floor, a margin of 0.32. The raw accuracy drops 7.6 points; the margin over
chance drops 19 points. The smaller-looking gap between 0.884 and 0.808 mostly
reflects transfer-v4 having more binary questions, not the model holding up
better than it does.

Two other things degrade out of domain, both relevant to Weave:

- **Confident errors nearly double**, 0.058 to 0.077, and mean confidence only
  falls from 0.932 to 0.882. The model does not become appreciably more
  cautious on unfamiliar content; it becomes more often confidently wrong.
- **Invariance breaks.** On contrastive pairs the checkpoint flips 0.833 of the
  pairs that should flip, which is good. But of the three pairs whose answer
  should *not* change, it changed one — an invariance rate of 0.667 against
  1.000 in distribution. Three pairs is far too few to size the effect, and it
  is the measurement to repeat first on a larger sample.

Weakest sources: contrastive_deadline 0.600 with ECE 0.343, mmlu 0.636,
tweet_offensive 0.692, paws 0.769. Strongest: sciq 1.000 (ECE 0.003),
composition_held_or_not 1.000, qnli 0.846. The deadline result matches a
weakness the 0.6B card already documents for date arithmetic, so it appears to
survive the scale-up to 4B.

Latency was lower than in distribution only because the records are shorter:
median 6.4 s, p90 11.4 s, p95 21.0 s, max 24.3 s, at 14.3 tokens/second across
13,976 tokens with a median of 95 input tokens. Throughput is the same 14
tok/s; the suite is just smaller per question.

Wire rounding behaves the same way and slightly worse: argmax changed on
**zero** of 104 questions and accuracy is unchanged, but three true labels
rounded to zero instead of one, and NLL degrades from 0.644 to 1.016. More
confident errors out of domain means more labels below the 0.005 floor. The
conclusion is unchanged and now holds on both suites: the rounded argmax and
confidence are safe to consume, the rounded distribution is not a likelihood.

Raw figures for both suites, including per-source breakdowns and the full
environment record, are in
[`kev/results.json`](kev/results.json).

## OpenJev re-measurement and transfer result — 2026-09-20

Two questions were outstanding for OpenJev: whether its recorded latency was
an artefact of bfloat16, and whether 12/12 on a hand-written corpus meant
anything. Both were answered. Raw figures, including per-source breakdowns and
the rejected measurements, are in
[`openjev/transfer-results.json`](openjev/transfer-results.json).

### A cold process on this machine is not measuring its sustained speed

This turned up while re-timing the dtypes and it invalidates several earlier
numbers, so it comes first. A freshly started process runs well above the rate
it can hold. Timing a 128-token forward continuously for 200 s, the same call
goes from 6.12 s to 10.37 s — **69% slower** — and then holds there. Package
temperature *falls* from 85 °C to 67 °C across that window, so this is the
package settling from burst to sustained power, not the machine overheating.

A convergence test is not enough to detect it. The burst plateau is itself
flat, so "stop when two consecutive blocks agree" settles inside the burst and
reports the fast number. The protocol that works is a fixed-duration warmup
(200 s) followed by re-timing a reference forward at the end and rejecting the
run if it drifted more than 5%.

Consequences: the previously recorded **4.86 s** OpenJev median is wrong twice
over — bf16 rather than fp32, and cold rather than sustained. The first fp32
re-run reported 1.25 s for the same reason and is also discarded. Kev's
recorded latencies are unaffected: those runs were 978 s and 1629 s long, so
the burst window is a small leading fraction and the medians are sustained.

### fp32 is roughly 3.7x faster, and the two dtypes want opposite thread counts

At sustained clock on a 128-token pair, best configuration each:

| dtype | best threads | 128-token pair | 12-case corpus median | peak RSS |
| ----- | -----------: | -------------: | --------------------: | -------: |
| float32  | 2 | 8.83 s  | 2.23 s | 22.1 GiB |
| bfloat16 | 8 | 33.02 s | 7.26 s |  7.3 GiB |

fp32 wins by 3.7x, confirming the AVX2 dtype trap end to end. The ratio is
3.2-4.4x depending on length and thread count, not the 146x measured on a
compute-bound 1024-cube matmul — at batch one the forward pass is largely
memory-bandwidth-bound, where fp32's doubled weight traffic works against it.
This is consistent with the 4-6x already recorded for Kev. The bf16 run's
end-of-run drift was -6.5%, just outside the 5% gate, so its numbers carry a
caveat; the effect is far larger than the drift.

The opposite thread preferences are the interesting part. bf16 is compute-bound
under scalar emulation and scales onto the E-cores; fp32 is bandwidth-bound and
is actively hurt by them.

**More threads is slower at fp32.** The 128-token reference, by thread count:

| threads | 1 | 2 | 4 | 8 | 12 |
| ------- | -: | -: | -: | -: | -: |
| seconds | 12.69 | **8.83** | 12.22 | 10.32 | 11.64 |

Two threads wins, and the non-monotonic dip at 4 reproduced across two
independent runs (12.21 s and 12.22 s), so it is a real effect rather than
noise. The likely mechanism is that OpenMP splits each GEMM evenly across
threads while this part has 2 fast P-cores and 8 slow E-cores, so every
operation waits on the slowest worker. `--threads 2` is the operating setting
for fp32, which contradicts the `-t 8` that is correct for llama.cpp here.

### Latency scales linearly with premise length, and that is the binding limit

Measured at 8 threads, three repeats each:

| input tokens | 75 | 137 | 261 | 540 | 1036 |
| ------------ | -: | --: | --: | --: | ---: |
| seconds      | 7.25 | 10.44 | 18.88 | 37.90 | 74.51 |

Sustained throughput is a flat 13.1-14.2 tokens/second across a 7.5x span.
A 1000-token premise costs **75 seconds**, so the 20-38 token exploratory
corpus said nothing about realistic inputs. The checkpoint was trained at
`max_len` 1024 even though its config advertises 262144 positions, so longer
premises are extrapolating as well as slow. This curve was not re-measured at
the faster 2-thread setting.

### Scores are reproducible

The same pair run three times returns bit-identical probabilities. Useful for
the contract: a cached result cannot silently disagree with a recomputed one.

### 12/12 was a smoke test; on held-out records it scores 0.655

The hand-written corpus is 12 cases the harness author wrote, so it measures
almost nothing. OpenJev was instead run over Kev's `transfer-v4` development
split — the same held-out suite, so the two local candidates are measured on
identical records. `trainable_sources` is empty and `eval_only` is set, and the
model card confirms `transfer-v4` is out of domain for OpenJev too, since the
card's own headline is "same MNLI (0.91)" — MNLI is in-distribution and
therefore useless as evidence here. State text is rendered with Kev's own
`render()` so both models read the same premise.

OpenJev has one primitive, so only two of the three question types map. A
`choice` becomes the card's `rerank`: each option is a hypothesis against the
state, and the answer is the highest P(entailment). A `noul` is a single pair,
true when the argmax is entailment. `score` has no mapping and 18 questions
were skipped.

**0.655 over 307 tasks**, 95% Wilson [0.600, 0.706], against a majority-class
floor of 0.502 and a uniform-chance floor of 0.386. That clears the stronger
floor by 5.6 standard errors, so the model is doing real work — but the two
floors differ by 12 points here, and quoting the raw accuracy against neither
would be meaningless.

(This figure was 0.670 over 267 tasks when first written, with `emotion`
excluded for a harness defect. That source was re-run on 2026-09-21 after the
fix and scores 0.550, which pulls the headline down 1.6 points. The margin
over the floor is unchanged at 5.6 SE, because emotion's floor is low too.)

Reweighted to Kev's source counts, so the same blend of sources is being
compared rather than two different subsamples:

| | OpenJev | Kev |
| --- | ---: | ---: |
| transfer-v4, 8 shared sources | 0.727 | **0.835** |

The per-source split matters more than the headline:

| source | kind | OpenJev | n | Kev | uniform | majority |
| ------ | ---- | ------: | -: | --: | ------: | -------: |
| qnli | noul | **0.950** | 40 | 0.846 | 0.500 | 0.550 |
| sciq | choice | 0.952 | 42 | 1.000 | 0.245 | 0.333 |
| composition_held_and_or | choice | 0.875 | 16 | 0.875 | 0.500 | 0.750 |
| composition_held_or_not | choice | 0.750 | 12 | 1.000 | 0.500 | 0.583 |
| paws | noul | 0.650 | 40 | 0.769 | 0.500 | 0.625 |
| tweet_offensive | noul | 0.625 | 40 | 0.692 | 0.500 | 0.625 |
| contrastive_authorization | noul | 0.500 | 22 | 1.000 | 0.500 | 0.500 |
| mmlu | choice | 0.326 | 43 | 0.636 | 0.243 | 0.326 |
| composition_held_conditional | choice | 0.167 | 12 | — | 0.500 | 0.583 |

OpenJev **beats Kev on qnli**, the one source that is literally an entailment
task, and matches it on sciq. It sits exactly on its majority-class floor for
`tweet_offensive` (0.625) and `mmlu` (0.326), exactly on its floor for
`contrastive_authorization` (0.500), and *below* chance on
`composition_held_conditional` — 2 correct out of 12 (`reject` predicted as
`accept` 6 times, `accept` as `reject` 4 times).

Two readings I drew from this table were wrong, and the scores already
recorded were enough to show it. I read the 0.500 as chance; it is a
constant-true predictor on a balanced set, and underneath it the model
separates the classes perfectly — see [on one source the signal is perfect and
the decision rule discards it](#on-one-source-the-signal-is-perfect-and-the-decision-rule-discards-it).
I read the 0.167 as a near-total inversion; the contrast arms show a model
that fails to move rather than one that answers backwards — see [the answer
holds still when it should, and fails to move when it should
not](#the-answer-holds-still-when-it-should-and-fails-to-move-when-it-should-not).
Both corrections point the same way: accuracy against a floor is too coarse to
say what this model is doing.

The pattern is that OpenJev is competitive where the question is an entailment
question and at or below its floor where answering requires following an
instruction. That is the same conclusion the contract already asserts —
entailment does not by itself satisfy general `noul`/`choice`/`score` requests
— now with numbers behind it rather than an argument.

I tested and discarded one explanation for this. The obvious story is that
bare category labels ("joy", "accept") carry no propositional content while
sciq-style options are declarative. The data refutes it: the correlation
between median option length and margin over chance is **negative**
(r = -0.559 across 6 choice sources). sciq's one-word options score 0.952 and
`composition_held_conditional`'s six-word declaratives score 0.167. Whatever
drives the split, it is not option phrasing.

### MMLU rerank: 0.53 not reproduced

The card claims MMLU rerank 0.53. This sample gives 0.326. Before treating
that as a model result I checked whether the harness caused it, by re-running
with the bare question text as the premise instead of the rendered
`subject`/`question` dict: **0.372** (n=43, 95% [0.244, 0.521]). The two
renderings differ by less than one standard error, so the premise format is
not the cause. 0.53 was not reproduced on this held-out sample under either
format. The card's figure may be over the full MMLU test set or a different
harness; the discrepancy is recorded, not resolved.

### One source was excluded, and has since been re-run

`emotion` was left out of the first run. Its `criteria` values are null — the
option name is the dict key — and the harness passed the null through as the
hypothesis, so on 34 of its 40 tasks every option received an identical empty
hypothesis and the comparison was vacuous. That was a defect in the harness,
not a property of the model, and it was found only because a separate
hypothesis of mine about option phrasing failed to replicate.

Re-run on 2026-09-21 with the fix, `emotion` scores **0.550** (22/40, Wilson
[0.398, 0.693]) against a majority floor of 0.425 and a uniform floor of
0.165 — six options, so the uniform floor is the low one. It is above both
but only +1.6 SE over the majority floor, which for a single 40-record source
is weak evidence of anything beyond "not broken". It is included in the
headline above.

### The scores are uncalibrated, and worst just below certainty

Everything below is post-processing of per-record scores already recorded —
no new inference — by `benchmarks/inference/openjev/analyse.py`.

Confidence has to be defined before it can be scored. For a choice task it is
the entailment probability of the chosen option renormalised across the
options, because the per-option scores are independent softmaxes and do not
sum to one. For a boolean task the decision collapses `contradiction` and
`neutral` into false, so the confidence in a false answer is their sum.

| set | n | accuracy | mean confidence | ECE (10 bin) | Brier |
| --- | --: | --: | --: | --: | --: |
| all | 307 | 0.655 | 0.760 | 0.146 | 0.212 |
| choice | 165 | 0.612 | 0.648 | 0.089 | 0.194 |
| boolean | 142 | 0.704 | 0.891 | 0.213 | 0.233 |

The model is overconfident by 10.5 points overall, and the boolean half is
two and a half times as miscalibrated as the choice half. The shape matters more than the
scalar. The boolean reliability table:

| confidence | n | mean confidence | accuracy | gap |
| --- | --: | --: | --: | --: |
| 0.5-0.6 | 4 | 0.550 | 1.000 | -0.450 |
| 0.6-0.7 | 4 | 0.644 | 0.500 | +0.144 |
| 0.7-0.8 | 9 | 0.750 | 0.556 | +0.195 |
| 0.8-0.9 | 41 | 0.866 | 0.488 | +0.378 |
| 0.9-1.0 | 82 | 0.958 | 0.829 | +0.129 |

The 0.8-0.9 band is the problem: 41 tasks, stated confidence 0.866, actual
accuracy 0.488. That is a coin flip wearing an 87% label, and it is the band a
naive router would admit. A threshold has to be set above it, not near it.

### The answer holds still when it should, and fails to move when it should not

The composition sources are built as contrast groups: `<scenario>/<arm>/<a|b>`,
where the `relevant` arm perturbs a field the policy depends on and the
`irrelevant` arm perturbs one the policy explicitly says does not affect
eligibility. Scoring the arms separately asks a sharper question than accuracy.

| behaviour | result |
| --- | --: |
| irrelevant change, answer must hold | 10/10 |
| relevant change, answer must move | 5/10 |

OpenJev is stable and not discriminating. It is never distracted by the
routing reference, and half the time changing the value the policy actually
tests does not change its answer. The 0.167 on `composition_held_conditional`
is this, not a logical inversion — I checked the confusion matrix expecting an
inverted `accept`/`reject` mapping and that is not what the records show.

Ten records appear in both arms with byte-identical state. All ten returned
bit-identical scores, which corroborates the determinism result above on real
records rather than on a deliberate repeat.

### On one source the signal is perfect and the decision rule discards it

The harness answers true only when `entailment` is the strict argmax of the
three labels. That boundary is a property of the checkpoint's head, not of the
question being asked, so a source can carry a clean signal and still score at
its floor. AUC tests for that: it asks whether `p_entailment` ranks true above
false at all, independent of any threshold.

| source | n | argmax | floor | AUC | 95% CI | perm. p |
| --- | --: | --: | --: | --: | --- | --: |
| qnli | 40 | 0.950 | 0.550 | 0.990 | [0.960, 1.000] | 0.00005 |
| contrastive_authorization | 22 | 0.500 | 0.500 | **1.000** | [1.000, 1.000] | 0.00005 |
| paws | 40 | 0.650 | 0.625 | 0.803 | [0.648, 0.927] | 0.0005 |
| tweet_offensive | 40 | 0.625 | 0.625 | 0.619 | [0.438, 0.786] | 0.114 |
| all boolean | 142 | 0.704 | 0.556 | 0.817 | [0.741, 0.885] | 0.00005 |

`contrastive_authorization` is the result worth reading twice. Under the argmax
rule it scores 0.500 — exactly its floor — because the model answers true to
all 22 records; it never says no. I had recorded that as "chance". It is not
chance. `p_entailment` separates the two classes **perfectly**: every one of
the 11 contrast pairs ranks its true member above its false member, and no
false record outscores any true record. The exact one-sided probability of
that under random ranking is 1/C(22,11) = 1.4e-6. The model sees the
difference — 0.988 against 0.869 for the first pair — and the fixed threshold
sits above both, so the distinction never reaches the output.

I originally wrote that this was not a blanket rescue, and offered
`tweet_offensive` as the contrasting case: AUC 0.619 at permutation p 0.114,
consistent with no signal at all. **That was wrong, and the next section is
how it came apart.** The argmax-versus-AUC distinction itself stands — it is a
fact about the decision rule — but my example of a source with genuinely no
signal was an artifact of how I had phrased the question.

Every threshold here is fitted on the same records it is scored on, so the
recovered accuracies are upper bounds, not results. What is not fitted, and
therefore stands, is the AUC.

### How the question is phrased moves the signal more than anything else here

A `noul` question can be rendered two ways. The interrogative `instructions`
("Is this post offensive?") or the declarative `criteria.true` ("Contains
insults, threats, profanity directed at someone, or hateful content"). The
first run used the instructions everywhere. Only `tweet_offensive` and `paws`
carry a `criteria.true`; `qnli` and `contrastive_authorization` have none and
are unaffected. Re-run on 2026-09-21 with `--noul-from-criteria`:

| source | rendering | argmax | floor | AUC | perm. p |
| --- | --- | --: | --: | --: | --: |
| tweet_offensive | instructions | 0.625 | 0.625 | 0.619 | 0.114 |
| tweet_offensive | criteria.true | 0.675 | 0.625 | **0.827** | 0.0003 |
| paws | instructions | 0.650 | 0.625 | 0.803 | 0.0005 |
| paws | criteria.true | 0.625 | 0.625 | 0.661 | 0.045 |

In aggregate this is one task in eighty — a null result. Split by source it is
two large shifts in opposite directions, and one rule explains both: **an NLI
hypothesis has to be declarative and has to carry the content being
asserted.** Entailment is a relation between a premise and a proposition; a
question is not a proposition, and a generic phrase asserts nothing about the
case at hand.

- `tweet_offensive` puts the whole post in the premise, so its instruction is
  a contentless question. Replacing it with a declarative description of the
  class is a pure upgrade, and the AUC moves from indistinguishable-from-noise
  to 0.827.
- `paws` puts the *second sentence* — the thing being compared — inside the
  instruction, and its `criteria.true` is generic boilerplate. Switching
  deletes the content the question is about, leaving the model to compare a
  sentence against "Same meaning, possibly reworded". The AUC falls.

I checked this by reading the records, not by reasoning backwards from the
scores. `tweet_offensive` was the only source whose hypothesis was both
interrogative and contentless, and it was the only source with no ranking
signal — which is why it was the wrong choice of counter-example in the
previous section.

Two limits. Both renderings were scored on the same 40 records per source, so
choosing the better one per source is in-sample selection; at n=40 the
standard error on accuracy is about 0.077, and the argmax differences here are
well inside it. The AUC shift on `tweet_offensive` is the part large enough to
survive that. And neither rendering is correct in general — a harness has to
decide per source by where the suite puts the content, which means this is a
property of the suite as much as of the model.

### Disposition

The model evidence remains **experimental, with no admitted judgment site**.
The repository now contains an opt-in Kev adapter and external-service
lifecycle module, but no route is enabled by default. OpenJev is
genuinely good at entailment-shaped questions — better than Kev on qnli — and
its scores are reproducible. But on the contract Weave actually needs it is
0.727 against Kev's 0.835 on identical records, it has no `score` primitive at
all, and a 1000-token premise costs 75 seconds against Kev's ability to serve
the same contract directly. Kev is the bounded local fallback candidate; OpenJev
remains a candidate for a narrow `text.assess-entailment` operation only.

One thing did change, and it is a constraint on how such an operation could be
built rather than on whether it should be. The three-label argmax is not a
safe default decision rule: it discarded a perfect signal on
`contrastive_authorization` and returns an uncalibrated confidence whose
0.8-0.9 band is at chance. If `text.assess-entailment` is ever admitted it
should expose the scores and leave the boundary to the caller, which is what
the contract at the top of `benchmarks/inference/openjev/README.md` already requires — all
three scores preserved, neutral not false. That requirement was written on
principle. It now has a measurement behind it.

A second constraint landed with the re-runs: the score depends on how the
question is phrased about as much as on the model. Rendering one boolean
source's hypothesis declaratively instead of interrogatively moved its AUC
from 0.619 to 0.827, and doing the same to another source moved it the other
way because the rendering dropped the content. Any adapter over this
checkpoint has to own that rendering explicitly and measure it, rather than
inheriting whatever the suite happens to put in `instructions`.

Three things this does not license. The recovered accuracy is fitted
in-sample, so the next step for anyone pursuing it is a threshold chosen on
one split and tested on another, not a claim that authorization works. The
same applies to picking a hypothesis rendering per source. And an AUC of 1.000
on 22 records from one generator is a property of that generator's contrast
pairs, not a general capability.
