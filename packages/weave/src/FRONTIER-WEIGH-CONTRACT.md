# `frontier.weigh@1` — one typed judgment site for frontier weighing

Status: contract and deterministic checks (issue #24). The site contract lives
in `frontier-weigh.ts`; the view renderer in `views.ts` (`renderWeighView`);
the gateway route in `gateway-decision.ts` (`GatewayDecisionLayer`). The paired
evaluation is `benchmarks/frontier-weigh/`. Terms follow
[GLOSSARY.md](../../../GLOSSARY.md).

This contract is local to the `frontier.weigh` judgment site. It is not a
general judgment-site framework, it adds no authority path, and it does not
touch Fabric admission or capability contracts.

## 1. Scope

Weave builds a deterministic state view and the eligible action candidates for
one report goal (M2's `g-report-variant` family: `frame_and_report@1`). A
routed unit answers one typed score question per eligible candidate. Weave
validates the answers into weights, defers candidates below the defer floor,
and selects and dispatches the action frontier with the ordinary scheduler.

The scripted decision layer (`scripted@1`) remains the baseline and the
default. Nothing in this contract promotes a routed unit; promotion is the
governed decision described in `benchmarks/frontier-weigh/README.md`.

## 2. Input: the state view `profile.frontier-weigh@2`

`renderWeighView(state, eligible, formed)` renders four slices. `content` is
exactly what the gateway sends as the evaluation state.

| Slice        | `content`                                                                                                                                                                      | Manifest revisions                                                               | Disclosed omissions                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`       | `goal: { purpose, success_evidence, sources, review_requested }`. `sources` lists goal sources the goal may read.                                                              | `goal.opened` seq                                                                | goal sources without read authority, reason `authority`                                                                                                                               |
| `budget`     | `budget: { actions_remaining }` = limit − reserved − spent                                                                                                                     | `goal.opened` seq and every action's start and finish seq                        | none                                                                                                                                                                                  |
| `progress`   | `progress: { sources: [{ source, revision, inspected_revision }], in_flight: [{ operation, inputs }], report: null \| { covers_sources, current } }` for readable goal sources | each listed source's and inspection's seq, in-flight start seqs, report evidence | every other registered source: reason `authority` when unreadable, `profile` when readable but not a goal source                                                                      |
| `candidates` | `candidates: [{ candidate_id, operation, inputs }]`, eligible candidates only                                                                                                  | union of the candidates' evidence                                                | each non-eligible formed candidate, reason = its eligibility status (`prohibited`, `approval_required`); each non-scalar input key as `<candidate_id>.inputs.<key>`, reason `profile` |

Inputs are summarised to top-level string, number and boolean fields. Source
bodies never enter this profile. Prohibited and approval-required candidates
never reach the site; their ids appear only in the manifest, which is not sent.

`profile.frontier-weigh@1` (M2) disclosed purpose and full candidate inputs
only. It is superseded by @2 for gateway weighing; scripted weighing renders no
view.

## 3. Eligible candidate set

The site receives the candidates whose eligibility is `allowed`, formed by the
established procedure from state and validated proposals. `candidate_set` is
`candidateSetDigest` of their ids. The site cannot add, remove or rebind a
candidate.

## 4. Question and criteria

One request of kind `score`, role `working`, site `frontier.weigh`. One
question per eligible candidate, keyed by candidate id:

- `instructions`: `Candidate <candidate_id> is listed in candidates. If Weave
  dispatched it now, how directly would it move this goal toward its success
  evidence, given the progress shown and the actions remaining?`
- `criteria`, in level order (`FRONTIER_WEIGH_CRITERIA`): 0. `defer: do not dispatch it now. It does not contribute to the success
     evidence, what it would produce is already current or in flight, or the
     actions remaining cannot cover the work still needed to complete the goal.`
  1. `consider: it contributes to the success evidence, but it is not among the
     most direct steps from this state.`
  2. `dispatch: it is among the most direct steps from this state toward the
     success evidence, and the actions remaining still cover completing the
     goal.`

The exact strings are in `frontier-weigh.ts`. Changing a word is a new
contract version.

## 5. Valid output

Exactly one `score` answer per eligible candidate and none for any other id.
Each score is a finite fractional position in `[0, 2]`. The weight is that
position, unchanged. Anything else is unusable: the gateway's acceptance check
rejects the attempt (`missing weight`, `invalid weight`, `answer for unknown
candidate`), no `weights.recorded` is appended and the weighing is recorded
`unaccepted`.

Weights are ordinal evidence within this site. They are compared only with the
other weights of the same `weights.recorded`; no calibration, confidence or
cross-site scale is inferred. A provider's published confidence is not read.

## 6. Selection

`selectFrontier(weighed, state, contract)`:

1. A weight below `FRONTIER_WEIGH_DEFER_BELOW` (0.5, nearer `defer` than
   `consider`) is **deferred**: recorded in the cycle's `not_selected` with
   reason `deferred` and never offered to the scheduler.
2. The rest go through the M0 scheduler unchanged: weight descending,
   candidate id ascending, then dependencies, effect conflicts, read-set
   revisions and the remaining budget.

Weights without the `frontier.weigh@1` tag (scripted weighing) have no floor.

## 7. Recorded observations and revisions

| Record                          | Carries                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inference.requested` (runtime) | `request_id`, the full `view` (profile, version, `state_revision`, content, manifest), `candidate_set`, terms, reservation                                  |
| `weights.recorded` (gateway)    | `contract: "frontier.weigh@1"`, `implementation` = routed unit, `request_id`, `state_revision` = seq of its `inference.requested`, `candidate_set`, weights |
| `inference.recorded` (gateway)  | attempts, spent, status, reason                                                                                                                             |

To reproduce a weight: follow `weights.recorded.request_id` to its
`inference.requested`; its `view` is what the routed unit saw and its
`candidate_set` names the candidates. `view.state_revision` is the revision the
view was rendered at, before the request was appended.

Admission (`validation.ts`) rejects a `weights.recorded` with an unknown
`contract`, or a `frontier.weigh@1` weight outside `[0, 2]`.

## 8. Failure, abstention, staleness and replay

- **One weighing at a time.** While any `frontier.weigh` request is in flight,
  a cycle waits instead of starting another; a second would make the first
  stale on arrival.
- **Unusable** (failed, unaccepted, blocked, malformed or out of range): no
  weights; the cycle is `blocked` with the recorded reason; the candidate set
  is not weighed again (M2-T09).
- **Abstention.** When every weight is below the floor, nothing dispatches.
  The cycle is `blocked` with `frontier deferred by frontier.weigh@1 weights`,
  or `waiting` while other work runs. The deferral stands until new evidence
  arrives: an accepted observation other than `clock.tick`, `action.started`,
  `action.queued` or a weighing record. Then the set is weighed once more.
- **Stale.** A result bound to a superseded revision is rejected and cannot
  authorize dispatch (M2-T08). The set is weighed again only after new
  evidence, by the same rule; a clock tick alone leaves it `blocked` with
  `stale judgment`.
- **Replay** resolves `inference.requested`, `weights.recorded` and
  `inference.recorded` from the log. Invoking the decision layer in replay is
  an error. A log that ends with a `frontier.weigh` request and no
  `inference.recorded` for it is an unfinished replay, reported like a missing
  `action.result`: `ok: false`, `at_seq` = the request's seq, reason
  `missing recorded inference.recorded for <request_id>` (FW-T12).
- **Recovery.** Reconciliation records every inference requested before the
  restart that has no `inference.recorded` and no live call in this process,
  at any site (`frontier.weigh` or `goal.frame`), as `inference.recorded`
  with status `unaccepted`, reason `abandoned at recovery: no
  inference.recorded before the restart`, and `spent` = the whole cost
  reservation, since the provider may have spent it. Its slot and reservation
  are freed (FW-T08, FW-T13). An abandoned weighing is not re-sent and, unlike
  an unusable result, does not finish its candidate set: the set is weighed
  once more (FW-T08). A framing action's own outcome is reconciled separately.
- **Recovered numbering and order.** A loaded journal must have strictly
  increasing seqs, past anything already logged; otherwise `load` throws and
  loads nothing (FW-T11). New observations continue past the loaded
  high-water mark, so evidence after recovery can lift a deferral (FW-T09).
  A recovered run has no cycle records; its next cycle number follows the
  highest one named by a dispatched action (`a:<N>:<i>`) or a weighing id
  (`weights:c<N>`, `inference:inf:c<N>:weigh`), so a scripted weighing that
  dispatched nothing is never re-appended as a duplicate (FW-T10). Whether a
  deferral stands is read from the seq of the latest evidence, not by
  scanning the ticks since the weighing (FW-T14).

There is no fallback to scripted weighing inside a run. An unusable judgment
is an explicit blocked outcome, never permission to execute.

## 9. Control boundary

Weights cannot create candidates (a `candidate_set` that is not the current
eligible set is ignored), leave their range (rejected at admission), widen
disclosure (the view is rendered before the request), change destinations
(terms come from configuration), pass policy (budget, dependencies, conflicts
and read sets are the scheduler's) or reach a prohibited or
approval-required candidate (never in the request, never weighted).

## 10. Required deterministic checks

`packages/weave/test/frontier-weigh.test.ts`, with fixture adapters and
injected ticks. The fixture judge is a stand-in, not evidence about a model.

| ID     | Scenario                                                                                 | Evidence                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FW-T01 | Report goal weighed end to end                                                           | Every accepted weight carries the contract, binds to its `inference.requested` seq and candidate set, and was produced from exactly the recorded view content and questions; content holds no gamma id or body; omissions are disclosed. |
| FW-T02 | Proposal adds an authorized source the goal does not list (`source:delta`), five actions | Typed weights defer delta, Weave dispatches the rest and the goal completes. `scripted@1` on the same state dispatches delta and ends `blocked / actions budget exhausted`.                                                              |
| FW-T03 | Every weight `defer`                                                                     | No dispatch; `blocked` with the deferral reason; one weighing; a tick does not re-weigh; a source change re-weighs once.                                                                                                                 |
| FW-T04 | Scores out of range                                                                      | Unaccepted, no weights, explicit `blocked`, no second weighing.                                                                                                                                                                          |
| FW-T05 | Tick while weighing is held                                                              | The late weight is rejected as stale; nothing dispatches; `blocked / stale judgment`.                                                                                                                                                    |
| FW-T06 | Forged and policy-bound weights                                                          | A weight set naming a non-candidate is ignored; an out-of-range weight is rejected; `dispatch` on every candidate still leaves one `budget` exclusion; a prohibited candidate is never weighed, sent or dispatched.                      |
| FW-T07 | Replay of FW-T02's weighed run                                                           | Replay succeeds with a decision layer that throws; zero host invocations; identical cycle records.                                                                                                                                       |
| FW-T08 | Crash while a gateway weighing is in flight, then recovery                               | The abandoned request is recorded `unaccepted` once; the same candidate set is weighed exactly once more; never two weighings in flight; the abandoned one is not re-sent; no judgment stays reserved; the goal completes.               |
| FW-T09 | Recovery over a journal with seq gaps left by rejected observations                      | Recovery alone does not re-weigh; new evidence takes a seq past the loaded high-water mark; seqs stay strictly increasing and unique; the evidence earns one more weighing.                                                              |
| FW-T10 | Recovery after a scripted weighing that dispatched nothing                               | Every recovered cycle numbers past the last recorded one and is weighed; no observation is rejected as a duplicate.                                                                                                                      |
| FW-T11 | Journal whose seqs swap or repeat                                                        | `load` throws `journal seq … does not follow seq …` and loads nothing; an ordered journal loads; a second load cannot rewind the log.                                                                                                    |
| FW-T12 | Replay of a log ending in an unrecorded weighing                                         | `ok: false` with `missing recorded inference.recorded for <request_id>`; zero host invocations.                                                                                                                                          |
| FW-T13 | Crash while framing inference is in flight, then recovery                                | The framing request is recorded `unaccepted`, abandoned at recovery, charged its whole reservation; no cost stays reserved.                                                                                                              |
| FW-T14 | 512 ticks during a deferral                                                              | The deferral stands, and deciding so reads at most 8 log entries.                                                                                                                                                                        |

M0–M2 checks, including M2-T03 and M2-T05–T10, stay green.

### Demonstrated red

Red was observed with this contract module, the type additions and the tests
in place, before the view, gateway, runtime and admission changes: 7 of 7
failed (FW-T01 and FW-T05: no `contract` on weights; FW-T02 and FW-T07: delta
dispatched and the goal did not complete; FW-T03 and FW-T04: deferred or
out-of-range weights still dispatched; FW-T06: an out-of-range weight was
admitted). FW-T07's red was the incomplete run, not replay itself.

A first green attempt then failed FW-T02, FW-T06 and FW-T07: two gateway
weighings in flight made each other stale, and a stale result blocked its
candidate set for good. §8's one-at-a-time and new-evidence rules are that
fix. The full package suite is green with them.

FW-T10–T14 (#256) were red on main before their fixes: FW-T10 at its second
recovered revision with `weights rejected: duplicate`; FW-T11 loaded both
journals; FW-T12 replayed `ok: true`; FW-T13 left the framing request
unrecorded; FW-T14 read 515 log entries.

## 11. Assumptions

- The cases where this site faces a real choice inside M2 are narrow: the
  established procedure already orders inspect → assemble → complete. The
  choices that remain are proposal over-reach, an optional review, and budget
  shortfall. The case set in `benchmarks/frontier-weigh/` is built from those.
- `GatewayDecisionLayer` sends an open deadline and its configured
  destinations; the runtime records `deadline: tick + 100` and `local` in
  `inference.requested`. That mismatch predates this contract and is not
  changed here.
- Weft's `cycle.weighed` disposition list has no `deferred`; a future Loom
  emitter must map it (to `not_reached`) or Weft must add it.
