# Hosted Jev judgment sites

Status: experimental. No admitted judgment site, no default route, no
capability. Everything here is measurement.

## What is under test

CONTEXT.md defines a **judgment site** as "a named place where bounded judgment
is requested for a specific purpose, with typed inputs and outputs and its own
evaluation history." The repository has the first three. Nothing yet produces
the fourth. This directory produces it for hosted Jev.

Three questions, in the order they gate each other:

1. **Which decision shape carries a site's question.** Jev answers `choice`,
   `score` and `boolean`. They are not interchangeable and, per
   `packages/gateway/src/types.ts`, a routed unit earns accept-rate evidence at
   one shape without earning it at another. A site has to pick one, and that
   pick should follow measurement rather than whichever shape reads best.
2. **How much state a site can afford to assemble.** A context profile declares
   slices; a state view records what filled them. Latency, cost and answer
   quality all move with state size, and none of that is measured for hosted
   Jev at Weave's state sizes.
3. **Whether a site's answers are reliable enough to route.** Accuracy against
   an explicit floor, calibration, determinism, and behaviour under throttling.

## The prior that shaped this

`benchmarks/inference/README.md` records the local Kev and OpenJev
measurements. Three of its findings are load-bearing here and are treated as
hypotheses to re-test against the hosted checkpoint, not as settled facts:

- **Binary questions are the weak cell.** Kev 4B scored 0.500 accuracy with
  0.464 ECE on `boolq` — yes/no reading comprehension over a passage, which is
  structurally what a `boolean` question against a state view is. Other yes/no
  sources did fine, so this is about passage difficulty rather than the shape
  as such, and n=8 is weak. It is still the first thing to check.
- **Accuracy against a floor is too coarse to say what a model is doing.** A
  source scored exactly at its floor while separating the classes perfectly
  underneath the decision rule (`contrastive_authorization`, AUC 1.000 at
  argmax 0.500). Any shape comparison here reports AUC and contrast-pair
  behaviour alongside accuracy, or it will draw the same wrong conclusion.
- **The 0.8-0.9 confidence band is where a naive router gets burned.** On
  OpenJev's boolean half that band stated 0.866 confidence and delivered 0.488
  accuracy. A confidence threshold has to be set above such a band, not near
  it, and only after measuring where it sits for this checkpoint.

Two constant predictors are scored on every corpus before any Jev number is
quoted, because a floor moves with option count and the raw accuracies of two
suites are not comparable to each other.

## The eval layer, and the circularity it must avoid

The goal is a judgment site's **evaluation history**. Scoring is deterministic
throughout: a labeled corpus, explicit floors, calibration and contrast arms.

Jev is not used to score Jev. Asking a model whether another model's answer was
good measures agreement, not accuracy, and `packages/gateway/src/types.ts`
already states the repository's position for the generation path — "a model
judge is another fallible observation and does not belong here." The same
holds for evaluation.

A reviewing judgment site (`judgment.review`: given a state, a question and an
answer, is the answer defensible?) is a legitimate **subject** of measurement
and is listed among the candidate sites below. It is not the measuring
instrument, and it earns trust only the same way any other site does — against
labels, with a floor. Until then, what the eval layer records is Jev's own
answers against human labels.

## Candidate judgment sites

Proposals, not commitments. Each names the purpose, the shape it plausibly
wants, and what it gates. Priority is the open question this directory exists
to inform.

| site | purpose | plausible shape | gates |
| --- | --- | --- | --- |
| `frontier.weigh` | how far each candidate advances the goal | `score` | every dispatch; highest volume |
| `capability.match` | which established capability or composition serves a desired operation | `choice` | whether a gap is declared |
| `gap.confirm` | is this genuinely a capability gap | `boolean` | entry to crystallization |
| `result.evaluate` | did this result satisfy the goal's success criteria | `score` | completion and retry |
| `clarification.needed` | is intent or authority insufficient to proceed | `boolean` | autonomous action |
| `risk.flag` | does this candidate warrant escalation to approval | `boolean` | routing to approval, never policy itself |
| `completion.check` | is the goal complete | `boolean` | goal closure |
| `judgment.review` | is a recorded answer defensible on its state | `boolean` | nothing yet; a measurement subject |

`risk.flag` is bounded by VISION.md: a model "may identify risk, recommend
escalation, or express uncertainty; it cannot waive a boundary." The site
routes a candidate toward deterministic approval. It never decides policy, and
a low weight from it cannot clear a hard prohibition.

## Experiments

Each writes raw per-record results, and scoring is a separate offline pass over
that file so a rerun of the analysis costs no inference.

### E1 — shape comparison

The same labeled decision asked three ways over byte-identical state:

- `score`, one question per candidate, ranked by score;
- `choice`, one question over all candidates;
- `boolean`, one question per candidate, ranked by P(true).

All three yield a ranking, so all three are scored against the same label on
the same records. Reported against both constant-predictor floors, with AUC
and per-shape calibration. **Acceptance:** a shape is preferred for a site only
if its margin over floor beats the alternatives by more than the binomial
standard error on the corpus size actually run.

### E2 — determinism and reliability

The same request repeated. Local OpenJev returned bit-identical scores; a
hosted route has no such guarantee, and everything downstream — cached
conclusions, replay, contrast arms — depends on knowing which it is.
Records answer variance across repeats, latency distribution, which routed unit
answered, escalation rate and throttling behaviour.
**Acceptance:** report the observed spread. A site whose answers move across
repeats by more than the margin separating its candidates is not routable at
that shape regardless of its mean accuracy.

### E3 — state size

> Needs revision against the framing profile. `renderFrameView` now takes a
> versioned `FrameProfile` whose `catalogue_budget` replaced a hardcoded
> budget of 1, and excess operations are disclosed as omissions with reason
> `budget`. The sharper experiment is whether the model reasons correctly
> about *disclosed omissions*, which no case in this corpus currently carries,
> rather than whether accuracy decays under irrelevant padding.

Latency, cost and accuracy against state size, padded with authorized but
irrelevant content. Local Kev's numbers were all measured at or below 384
tokens while its server accepts 8192, and that gap was recorded as a
measurement gap rather than a result. The same gap exists here and is the
reason this experiment is not optional.
**Acceptance:** a per-site state budget stated in tokens, with the measured
latency and accuracy at that budget.

## Route

Vercel AI Gateway first, TypeSafe direct second, both destinations named in the
request terms — which is what permits the escalation at all. A timer is
supplied, so a throttle that names a delay is waited out and recorded in
`waited_ms` rather than escalating silently. Which unit answered is recorded
per request, so fallback frequency is data rather than an impression.

Jev is free through the Vercel AI Gateway during the measurement window, which
is why the volume experiments run there and now.

## Limits

These bind every number this directory produces.

- Labels are authored in-repo by the harness author. That is the same weakness
  recorded for OpenJev's 12-case corpus, which scored 12/12 and then 0.655 on
  held-out records. A corpus authored alongside the harness measures the
  author's expectations as much as the model.
- Hosted latency is a network measurement and carries the path, not just the
  model.
- Cost is the gateway's accounting at the configured price. During a free
  window it is an accounting figure, not a bill.
- Choosing a shape per site on the same records that scored it is in-sample
  selection. A shape preference has to survive a split before it is a result.
- **Nothing here is a gating check, and nothing here is admission evidence.**
  These are non-gating evaluations of a hosted model against live routes.
  ARCHITECTURE.md still lists the relationship between the gating suite and
  real providers as open. No judgment site is admitted by anything in this
  directory, and a number here must not be cited as a held-out report.
- **These runs measure the model, not the judgment site.** The corpus hands
  the model a `DecisionState` authored here. The decision layer receives a
  `StateView` from `renderFrameView`, carrying a manifest, a state revision,
  and omissions with `reason: 'budget'`. This harness imports `@weave/gateway`
  only and never renders a view, so the accuracy above characterises Jev on
  our cases — not what a judgment site would score on the state it is
  actually given. Closing that gap means rendering corpus state through the
  view renderer, which the import-direction check explicitly permits.
- **Do not author corpus cases from `transfer-v4`.** Its manifest declares
  `in_distribution: false` with every source in `holdout_sources`. CONTEXT.md
  defines a *held-out report* as counts and failure codes only, and states
  that once a split is drawn, corpus authors do not receive its cases either.
  Borrowing transfer-v4 records to de-saturate the Weave corpus — considered
  here while E1 was saturating — is therefore ruled out. De-saturation has to
  come from newly authored adversarial cases.

---

# Results — 2026-09-21

Hosted Jev through the Vercel AI Gateway (`typesafe-ai/jev`), with TypeSafe
direct (`jev-latest`) as the fallback route. Raw records, one JSON object per
request, replayable with `--from`:

| file | corpus | model | orderings |
| --- | --- | --- | --: |
| [`results.json`](results.json) | Weave | Jev | 1 |
| [`transfer-results.json`](transfer-results.json) | transfer-v4 | Jev | 1 |
| [`permutation-results.json`](permutation-results.json) | Weave | Jev | 4 |
| [`transfer-permutation-results.json`](transfer-permutation-results.json) | transfer-v4 | Jev | 4 |
| [`kev-permutation-results.json`](kev-permutation-results.json) | Weave | Kev 4B | 4 |

Every number below was derived from these files rather than copied from a run
log, and four errors were caught that way — see the note at the end.

## E1 — shape comparison: the corpus saturated, and the experiment failed

18 Weave-domain cases × 3 shapes × 3 repeats, 162 requests. **All three shapes
scored 54/54.** The corpus does not discriminate, so it cannot rank the shapes,
and no shape preference is claimed from it.

This is the failure the README's own prior warned about and it was not avoided:
OpenJev scored 12/12 on a hand-written corpus and 0.655 on held-out records. A
corpus authored alongside the harness measures the author's expectations. The
finding is recorded rather than deleted because the saturation is the result.

What the run does establish, since it holds regardless of difficulty:

| | choice | score | boolean |
| --- | ---: | ---: | ---: |
| clean single-attempt latency (median) | 397 ms | 396 ms | 425 ms |
| clean single-attempt requests | 29/54 | 22/54 | 12/54 |
| input tokens per attempt | 568 | 733 | 725 |
| argmax unanimous across 3 repeats | 18/18 | 18/18 | 18/18 |
| largest top-value drift across repeats | 0.060 | 0.017 | 0.040 |

**Latency is shape-independent.** An earlier reading that `choice` was faster
was an artefact of counting escalated retries in the wall clock; on
single-attempt requests the three shapes are within 28 ms of each other.
Those medians rest on 29, 22 and 12 requests respectively — the throttle ate
most of boolean's clean sample, so its 425 ms is the softest of the three.

**The argmax is stable, the underlying value is not.** Every case chose the
same candidate on all three repeats, while the winning value moved by up to
0.060. A cached conclusion keyed on the decision is safe; one keyed on the
score is not.

## E2 — the free route is throttled hard, and waiting is the whole difference

First run, no declared rate limit: **187 refusals on the Vercel route and zero
on TypeSafe direct**, and 88 of 162 requests (54%) escalated to the billed
route. The fallback worked exactly as designed, which is also how the free
window gets spent.

The gateway recorded **zero waits** on that run. It escalated instead, because
the route declared no `rate_limits` and the provider sent no `Retry-After` —
`retryDelayMs` then returns zero and the per-route attempt bound of 2 escalates
almost at once. Declaring a limit and raising `max_attempts_per_route` reverses
it: on the transfer run, **121 of 125 requests stayed on the free route**, at a
cost of 141 seconds of waiting across 141 throttled attempts.

So the trade is explicit: wall clock buys the free route. Median latency rises
from ~400 ms to 1651 ms (p90 3034, p95 4351, max 8838) with waits included.

One confound in the first run's per-shape refusal counts: shapes always ran in
the order choice → score → boolean, so boolean always met the most depleted
minute budget. Its higher retry count is ordering, not shape.

## E1 (retry) — transfer-v4, paired against local Kev

125 held-out records, the same records Kev 4B fp32 was scored on, read from
Kev's own `predictions.jsonl` so the comparison is paired rather than across
two subsamples.

| | hosted Jev | local Kev (same 125) |
| --- | ---: | ---: |
| accuracy | **0.832** | 0.776 |
| 95% Wilson | [0.757, 0.887] | — |
| median latency | 1651 ms (411 ms unthrottled) | 6373 ms |

Floors on these records: uniform 0.360, majority-class 0.208. The margin over
the stronger floor is 0.472, or 14.1 standard errors, so the model is
unambiguously reading the state.

**Against Kev the difference is not significant.** They disagree on 21 of 125
records, 14 to Jev and 7 to Kev; McNemar z = 1.53, p ≈ 0.13. On this sample
hosted Jev and the local 4B checkpoint are statistically indistinguishable in
accuracy. What separates them is latency — 4x with throttle waits included,
15x without — and where the content goes.

By question type, and by source:

| type | n | accuracy | uniform | majority | ECE |
| --- | --: | --: | --: | --: | --: |
| choice | 72 | 0.819 | 0.281 | 0.194 | 0.152 |
| noul (boolean) | 43 | 0.837 | 0.500 | 0.605 | 0.067 |
| score | 10 | 0.900 | 0.333 | 0.500 | 0.061 |

| source | n | Jev | Kev | uniform | majority |
| --- | --: | --: | --: | --: | --: |
| sciq | 18 | 1.000 | 1.000 | 0.247 | 0.444 |
| composition_held_or_not | 8 | 1.000 | 1.000 | 0.500 | 0.750 |
| contrastive_authorization | 4 | 1.000 | 1.000 | 0.500 | 0.500 |
| paws | 13 | 0.923 | 0.769 | 0.500 | 0.538 |
| contrastive_deadline | 10 | 0.900 | 0.600 | 0.333 | 0.500 |
| composition_held_and_or | 8 | 0.875 | 0.875 | 0.500 | 0.625 |
| qnli | 13 | 0.846 | 0.846 | 0.500 | 0.615 |
| mmlu | 20 | 0.800 | 0.500 | 0.243 | 0.350 |
| tweet_offensive | 13 | 0.692 | 0.692 | 0.500 | **0.769** |
| emotion | 18 | 0.556 | 0.778 | 0.163 | 0.444 |

Two cells deserve naming. **`tweet_offensive` sits below its own majority-class
floor** — 0.692 against 0.769, for both models, so "always answer offensive"
beats either on these 13 records. And **`emotion` is the one source where local
Kev clearly beats hosted Jev**, 0.778 to 0.556.

The `noul` result is worth recording against the prior that prompted it. Kev's
`boolq` cell scored 0.500 at ECE 0.464 and was flagged as the shape Weave most
depends on. Hosted Jev's boolean half scores 0.837 at ECE 0.067 — the best
calibrated of the three types here. **The binary-questions-are-weak hypothesis
does not reproduce for this checkpoint on these records.** It scores only 0.232
over its majority floor, though, against choice's 0.625 over its own, so the
raw accuracies of the two types are not comparable to each other.

## Contamination: the hypothesis was tested and refuted

`transfer-v4` is a certified holdout for Kev — `trainable_sources: []`,
`eval_only: true`. **It cannot be established as a holdout for hosted Jev**,
whose training data is not published, and six of its ten sources here are
public benchmarks that any modern checkpoint may have seen.

If Jev's advantage were memorisation, it should concentrate in those public
sources and disappear on the suite's own generated ones. It does the opposite:

| | n | Jev | Kev | delta |
| --- | --: | --: | --: | --: |
| synthetic (suite-generated; in no training set) | 30 | 0.933 | 0.833 | **+10.0 pp** |
| public benchmark | 95 | 0.800 | 0.758 | +4.2 pp |

The margin is larger where contamination is impossible, which is evidence
against the memorisation story rather than for it. Two limits keep this from
being a result: n=30 on the synthetic side, and the entire delta is one source
(`contrastive_deadline`, 9 correct against 6). The other three synthetic
sources are exact ties. Treat it as a hypothesis that failed its first test,
not as a clearance.

## Calibration: a usable gate at 0.9, fitted in sample

> Superseded in part: the held-out fit below ("The two gates, applied")
> confirms 0.9 and measures the optimism at 0.3 points. The cautions about
> band sizes and the confident-error rate still stand.

| confidence band | n | mean confidence | accuracy | gap |
| --- | --: | --: | --: | --: |
| below 0.5 | 1 | 0.090 | 0.000 | +0.090 |
| 0.5–0.6 | 7 | 0.529 | 0.286 | +0.243 |
| 0.6–0.7 | 7 | 0.659 | 0.714 | −0.056 |
| 0.7–0.8 | 7 | 0.746 | 0.143 | +0.603 |
| 0.8–0.9 | 8 | 0.862 | 1.000 | −0.138 |
| 0.9–1.0 | 95 | 0.983 | 0.926 | +0.057 |

Overall ECE 0.103, Brier 0.108, mean confidence 0.911 against 0.832 accuracy —
overconfident by 7.9 points, which is mild next to OpenJev's 10.5.

The shape is what matters. **Splitting at 0.9 separates 95 records at 0.926
from 30 records at 0.533.** That is a routing rule Weave could actually use:
accept above the gate, escalate or ask below it. Three cautions before anyone
relies on it. The threshold is fitted on the same records that score it, so
0.926 is an upper bound, not a result — it needs a threshold chosen on one
split and tested on another. That has since been done, and the penalty was
0.3 points. The middle bands hold 7 to 8 records each and
their gaps are noise at that size; the 0.7–0.8 row reading 0.143 is four wrong
answers, not a measured property. And 7 of the 95 high-confidence answers are
still wrong, a 7.4% confident-error rate that no gate removes.

## Presentation order: Jev reads the state, and two metrics had to be fixed first

Repeating a prompt measures whether the provider is deterministic. It does not
measure whether the answer came from the state, because a predictor locked to
the first position returns the same candidate every time and looks perfectly
stable. Order was varied as an independent variable: identity, reverse, then
seeded shuffles, clamped to the permutations that exist.

Two metrics in the first cut were wrong, both in the direction that flattered
Jev, and both are now caught by tests.

- **Stability counted cases that were never permuted.** A two-option question
  yields two orderings, a one-option question yields one, and `noul` and
  `score` are not permutable at all — their arms are fixed wire slots and their
  criteria are an ordered scale. On transfer-v4 that meant 53 of 125 records
  were stable by construction. The denominator is now cases actually presented
  more than one way, and a run with no permuted case reports 0, not 1.0.
- **Per-ordering accuracy compared different populations.** Ordering 0 held all
  125 records, ordering 3 only the 56 four-candidate ones. The reported spread
  of 80.4% to 85.6% measured which cases are hard, not what order does.
  Accuracy is now taken on the balanced panel — cases answered under *every*
  ordering index.

Corrected, on transfer-v4 (309 records, 125 cases, 4 orderings):

| metric | value |
| --- | --- |
| cases actually permuted | 72 of 125 |
| stable across every ordering | 72 of 72 (100.0%) |
| balanced panel | 56 cases |
| accuracy, worst ordering | 80.4% |
| accuracy, best ordering | 80.4% |
| position bias (stratified TV distance) | 0.061 |

Worst and best are identical because every case on the balanced panel answered
the same way under all four orderings. The 5.2-point spread in the first cut
was the population artifact, not an order effect.

Position bias is a total-variation distance between where the answer landed and
where the label sat, computed **within each candidate-count stratum** and then
weighted. Stratification is load-bearing: a stub locked to the *last* position
smears across absolute indices 1–3 when the corpus mixes 2-, 3- and
4-candidate cases and scored 0.446, under the same threshold that catches a
first-position lock at 0.732. Within a stratum it concentrates again — 0.696.
A failing test found that, not a review.

Jev at 0.061 is not reading position. On the Weave corpus it is 0.000 exactly.

## Kev head-to-head on the Weave corpus: strictly dominated

Both models answered the identical 168 records — 56 cases × 3 shapes, same
orderings, same state, same seed.

| | hosted Jev | local Kev 4B |
| --- | --: | --: |
| overall | **168/168 (100.0%)** | 140/168 (83.3%) |
| choice | 100.0% | 83.9% |
| boolean | 100.0% | 87.5% |
| score | 100.0% | 78.6% |
| order-stable (permuted choice) | 18/18 (100.0%) | 15/18 (83.3%) |
| position bias | 0.000 | 0.107 |

Paired on the 168 identical records: both right 140, **Jev only 28, Kev only
0**, neither 0. McNemar z = 5.10, significant at 0.05. Kev did not answer a
single record correctly that Jev got wrong — this is strict domination, not an
average advantage, so the usual caution about a mean hiding a trade-off does
not apply here.

The Weave corpus is saturated for Jev, so this measures Kev's distance from a
ceiling rather than ranking two models on a discriminating corpus. It does
discriminate Kev cleanly. Its six failing cases:

| case | wrong records |
| --- | --: |
| `waiting.dependency-in-flight` | 10 |
| `complete.published-and-checked` | 7 |
| `approval.absent` | 6 |
| `waiting.nothing-in-flight` | 3 |
| `blocked.unapproved-publish` | 1 |
| `distractor.more-documentation` | 1 |

Four of the six are the state-transition cases — whether work is waiting on
something in flight, and whether it is finished. `blocked.unapproved-publish`
is the one that matters most: Kev proposed a publish without approval. It is a
single record, and one record is not a measured failure rate. It is still the
exact shape the runtime must not depend on a model to catch, which is why
approval is a deterministic gate and not a weight.

On transfer-v4, the un-saturated corpus, the gap narrows and reverses by
source: Jev 83.2% against Kev 77.0% overall (McNemar z = 2.71, significant),
but Kev leads on `emotion` (77.8% against 61.1%) while Jev leads hugely on
`mmlu` (80.0% against 50.0%). "Better model" is the wrong summary; the two
fail on different things.

## The two gates, applied

Both gates were built and tested before being run on any record. Neither asks a
model anything: the stability gate compares the runtime's own reduced answers
across presentations, which is a measurement, not a judgment.

**The stability gate buys nothing on Jev and is not worth its cost.** Jev is
100% order-stable on both corpora, so the gate accepts everything and defers
nothing — zero wrong answers caught, at three to four times the calls. It is a
real tool pointed at a problem this model does not have.

On Kev it does work, on 18 permuted choice cases:

| | coverage | accuracy covered | accuracy deferred | caught | lost |
| --- | --: | --: | --: | --: | --: |
| Kev, stability gate | 83.3% | 93.3% | 66.7% | 1 wrong | 2 right |

83.9% to 93.3% is the right direction, but 18 cases and a single caught error
is an observation, not a rate. The honest reading is that the gate is worth
testing on a weaker model and worth nothing on Jev.

**The confidence threshold works, and it generalises.** The README recorded
twice that the 0.9 gate was fitted in sample and was therefore an upper bound.
Fitting on a deterministic interleaved half of the 309 transfer records and
reporting on the other half closes that:

| | n | coverage | accuracy covered | accuracy deferred |
| --- | --: | --: | --: | --: |
| ungated | 309 | 100% | 83.2% | — |
| threshold fitted on train half | 155 | 78.1% | 91.7% | 50.0% |
| **same threshold, held-out half** | **154** | **80.5%** | **91.1%** | **53.3%** |
| fitted and scored in sample | 309 | 79.3% | 91.4% | 51.6% |

The threshold chosen on the training half is 0.9, the same value the in-sample
reading suggested. **Optimism is 0.3 points** — in-sample 91.4% against
held-out 91.1%. The earlier caution was right to state but the penalty turned
out to be negligible, and the gate is now a measured result rather than a
bound.

What it costs is visible: on the held-out half the gate catches 14 wrong
answers and throws away 16 right ones. It is not free accuracy, it is a trade
of coverage for reliability, and the deferred set at 53.3% is close to a coin
flip on this corpus — which is the correct place to escalate.

The same fit on Kev is much weaker: coverage 47.6%, held-out accuracy 87.5%,
and optimism 4.6 points. Kev's confidence is less informative and its threshold
does overfit, so the in-sample caution that turned out not to bite on Jev does
bite here. Calibration is model-specific and does not transfer.

Combining both gates on the 72 permuted transfer cases — accept only when
stable *and* above 0.9 — covers 87.5% at 90.5%. That is no better than the
confidence gate alone, because stability is adding no information on this
model.

## What these numbers do not establish

- No judgment site is admitted, no route is enabled by default, and no
  capability was created.
- The Weave corpus result is a saturation finding, not a shape ranking.
- Accuracy here is transfer-v4's mix of sources, which is not Weave's workload.
  Weave's judgment sites read state views, not tweets and MMLU stems.
- Every record is at or below the suite's 384-token state bound. E3 (state
  size) has not been run, so nothing here transfers to a large state view.
- The hosted checkpoint's holdout status is unknown, as recorded above.
- Order-stability is measured over 4 orderings, not all of them. A four-option
  case has 24; a model stable across the 4 tested could still move on a 5th.
- The Kev stability-gate result rests on 18 cases and one caught error.
- `noul` and `score` were never permuted, so nothing here says whether those
  two shapes are order-stable. Only `choice` was tested.
- The confidence gate is fitted on transfer-v4's source mix. Weave's judgment
  sites are not that mix, and the threshold would need refitting on real state
  views before any runtime relies on it.

## How these numbers were checked

Every figure above was re-derived from the raw record files rather than copied
from a run log. That caught six errors, all of which had made Jev look better
or the evidence look stronger than it was:

1. A confidence-band table built from 0.1-wide bins silently dropped a record
   at 0.090, reporting the low side of the 0.9 gate as n=29 at 55.2%. It is
   n=30 at 53.3%, and a `below 0.5` row was added.
2. Two clean-sample latency figures were stale (393→396 ms, 417→425 ms).
3. Clean-sample sizes were quoted without their n.
4. An ad-hoc Jev/Kev join read 100% agreement everywhere because
   `o.correct ?? (o.predicted === o.label)` evaluates `undefined === undefined`
   to `true` for records that carry neither field. Replaced with the harness's
   own `loadKevOutcomes()`.
5. Order-stability counted cases that were never permuted (see above).
6. Per-ordering accuracy compared different populations (see above).

Errors 5 and 6 were found by tests written before the metric, not by review:
the load-bearing case is a stub locked to a fixed position, which must fail
stability and bias by construction whatever its accuracy. A third such test
caught a subtler defect during development — a *last*-position lock scored
0.446 bias, under the threshold that catches a first-position lock, because
absolute position smears across a corpus mixing 2-, 3- and 4-candidate cases.
That is why position bias is stratified by candidate count.

Two claims in this file are verifiable directly:

```
node benchmarks/inference/jev/probe.ts --from benchmarks/inference/jev/permutation-results.json
node benchmarks/inference/jev/transfer-probe.ts --from benchmarks/inference/jev/transfer-permutation-results.json
```

Both rescore recorded records and issue no inference.
