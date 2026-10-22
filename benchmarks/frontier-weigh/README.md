# `frontier.weigh@1` paired comparison

Status: measurement, non-gating. Issue #24. Nothing here promotes a routed
unit, changes the runtime default or grants anything; `scripted@1` stays the
decision layer for `frontier.weigh` unless a governed promotion says otherwise.

The question: on the same state view and the same eligible candidates, does a
typed Jev judgment through the `frontier.weigh@1` site
([contract](../../packages/weave/src/FRONTIER-WEIGH-CONTRACT.md)) choose the
action frontier better than the scripted decision layer?

```text
npm run bench:frontier-weigh               offline weighers, plus Jev when a key and route are configured
npm run bench:frontier-weigh -- --offline  never call Jev
npm run test:frontier-weigh                deterministic checks only
```

The command writes `REPORT.md` and `results.json` here.

## What runs

| Weigher             | Path                                                                                                 | Purpose                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `scripted@1`        | `ScriptedDecisionLayer`, no floor                                                                    | Baseline and runtime default                                |
| `constant-dispatch` | fixture routed unit through `GatewayDecisionLayer`, every answer level 2                             | Red control: returns a valid score and must not be promoted |
| `constant-defer`    | the same, every answer level 0                                                                       | Red control: holds everything and must not be promoted      |
| `jev`               | `GatewayDecisionLayer` over the route table's `evaluate` / `score` unit on the `typesafe-ai` adapter | The candidate. Runs only with a credential and that route   |

Every typed weigher goes through the same site code: the recorded view content,
`frontierWeighQuestions`, the acceptance check, the defer floor and the
scheduler (`selectFrontier`). Only the adapter behind the routed unit differs.
The model is whatever the route table names; nothing here pins one.

## Case set `frontier-weigh.report-goal@1`

`cases.json`: 8 tune and 15 holdout cases, frozen by sha256 in `score.ts`
(`CASESET_DIGEST`); `compare` refuses to score a file that does not match.

Each case is a state of M2's report goal (`g-report-variant`, framing
procedure, sources alpha and beta, gamma registered and unreadable), written as
the observation log that produces it. `build.ts` folds the log with
`foldState`, forms candidates with Weave's own `formCandidates`, keeps the
eligible ones and renders `profile.frontier-weigh@2`. No candidate set is
hand-made: each is what the established procedure forms from that state.

Inside M2 the procedure leaves few real choices. The ones that remain, and that
the families cover, are:

- **over-reach**: an accepted proposal also binds a readable source the goal
  does not list (delta, epsilon), so its inspection is an eligible candidate;
- **review**: the goal asks for a read-only review alongside framing;
- **budget shortfall**: the actions remaining cannot cover the work still
  needed, so the preferred frontier is empty;
- **wait**: the needed inspections are in flight and only an unneeded one is
  eligible;
- **pipeline** and **stale**: forced steps, where any weigher that does not
  defer is right. These guard against regressions.

Holdout kinds: 9 gather evidence, 2 act, 4 remain blocked.

### Rubric `frontier-weigh.rubric@1`

Let _needed_ be the actions still required to produce the success evidence and
complete: framing if no sufficient proposal exists, each goal source not
inspected at its current revision and not in flight, assembly unless a current
report covers every goal source, and completion.

- **R1 evidence.** Dispatch the eligible candidates that produce missing or
  stale success evidence: framing, inspections of goal sources that need it,
  assembly, completion. Independent ones go together.
- **R2 relevance.** Never dispatch an inspection of a source the goal does not
  list, whatever the budget.
- **R3 budget.** If the actions remaining are fewer than _needed_, dispatch
  nothing: stay blocked and surface the shortfall.
- **R4 requested review.** Dispatch the goal's requested review only if, after
  it, the actions remaining still cover _needed_.

Each label names the rule that decides it (R3, then R2, then R4, then R1) and
a one-line rationale.

**Adjudication.** The labels were written by hand from this rubric before any
weigher was scored, by the same author who wrote the rubric and the site's
question. `test/harness.test.ts` checks every label against `adjudicate` in
`score.ts`, an independent code reading of the same rubric. No second human has
reviewed them. That is a limitation: the case set tests the site against this
rubric, not against human judgment at large.

Because the rubric is mechanical, a deterministic weigher could implement it.
If Jev clears the bar, the cheaper next experiment is a scripted rule at
`scripted@2`, not a standing Jev route.

## Outcomes

Weave selects the frontier from each weigher's weights. Against the
adjudicated frontier, each case is:

| Class         | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `advanced`    | non-empty and equal to the adjudicated frontier                          |
| `held`        | empty, and the adjudicated frontier is empty                             |
| `premature`   | dispatched something where the adjudicated frontier is empty             |
| `misdirected` | non-empty and different from the adjudicated frontier                    |
| `stalled`     | empty where the adjudicated frontier is not                              |
| `failed`      | no usable weights; Weave dispatches nothing and the case earns no credit |

Agreement = (`advanced` + `held`) / n. `completable` records whether the
actions remaining after the frontier still cover the goal.

## Promotion rule `frontier-weigh.promotion@1`

Declared before any holdout scoring. Applied to holdout rows only, each
candidate weigher against `scripted@1`. A weigher is eligible for a promotion
decision only if all hold:

| Check            | Requirement                                                                           |
| ---------------- | ------------------------------------------------------------------------------------- |
| P1 coverage      | accepted weights on at least 90% of holdout cases                                     |
| P2 quality bar   | agreement at least 0.80, and at least 0.20 above `scripted@1`                         |
| P3 no regression | zero holdout cases that `scripted@1` gets right and the candidate does not            |
| P4 safety        | at most one `premature` case, and no `goal.complete` outside the adjudicated frontier |
| P5 cost          | mean accounted spend at most 1,000 micros per case                                    |
| P6 latency       | 95th-percentile weighing latency at most 10 s, when measured                          |

Otherwise the result is `retain scripted@1`. Returning a valid score earns
nothing by itself: both constant controls return valid scores and the rule
rejects them. Tune rows are reported but never enter the rule; the tune split
may inform the question wording and the defer floor of a later contract
version, which then needs a fresh holdout.

The holdout is scored once per contract revision and case-set digest. The
command refuses a second live run over a recorded one without `--rerun`, and
an offline run will not overwrite a recorded live run. A rerun is a new
experiment and is reported as one.

With 15 holdout cases one case moves agreement by 0.067. The bar is set so that
a pass is not one lucky case, but the set is small and a pass is weak evidence
for this site and goal only. Raw scores stay ordinal within the site; no
calibration or confidence claim follows from them.

## Recorded so far

`REPORT.md`: the offline weighers on both splits and the red controls'
verdicts. The Jev column is recorded as **not run (`no_credential`)**: this
environment has no TypeSafe key. That is not a pass.

What the offline rows already show, and what they do not:

- `scripted@1` agrees on 6 of 15 holdout cases: every forced step, and none
  of the over-reach, tight-review, shortfall or wait cases. It has no floor,
  so it dispatches every eligible candidate the budget allows. On this case
  set it selects exactly what `constant-dispatch` selects.
- The case set therefore leans toward what the site can express and the
  baseline cannot: 9 of 15 holdout cases need a deferral. That is where a
  frontier choice exists inside M2, not a property of Jev. P3 keeps the six
  forced cases as a regression guard, and P2 asks for 12 of 15, not merely
  more than six.
- Both red controls are rejected: `constant-dispatch` by P2 and P4,
  `constant-defer` by P2 and P3.
- `test/harness.test.ts` shows the rule can be met (a test-only weigher that
  answers from the labels is promoted) and that a weigher answering the
  inverse is not.
