# M0 — Inspect and report

This is the behavioral contract for the first milestone in
[ARCHITECTURE.md §10](../ARCHITECTURE.md). It fixes the fixture, the records the
runtime produces, and the checks that must be red before implementation begins
and green before M0 is complete. Terms follow [CONTEXT.md](../CONTEXT.md).

Everything here is in-memory and deterministic. There is no inference, no
effectful capability, no approval, no persistence beyond the in-memory log, and
no real AgentFabric: the capability host is a test double that satisfies the
host interface. The checks are written in a toolchain-neutral form; the
toolchain is open (§11) and the checks become executable tests once it is chosen.

## 1. What M0 proves

- Observations are recorded with provenance and validation before they change
  state, and a payload's claim does not become truth or authority.
- Candidates are formed deterministically from state, filtered by policy, and
  weighed by a judgment site whose result is itself an observation.
- Independent read-only actions dispatch in one cycle and run concurrently.
- Budget is reserved before dispatch; exhaustion yields an explicit blocked
  outcome, never implicit permission.
- Rejected access is rejected twice: policy never dispatches it, and the host
  refuses an invocation without a matching grant.
- Completion requires the goal's recorded success evidence.
- The trace explains every dispatch, and replay of the observation log
  reproduces the trace without invoking the host or a judgment site.

## 2. Fixture

### Resources

Three in-memory text sources exist in the fixture environment. Each has a
canonical `ResourceId` and a monotonically increasing `revision`.

| ResourceId | Initial revision | Content |
| --- | --- | --- |
| `source:alpha` | 1 | three lines of text |
| `source:beta` | 1 | five lines of text |
| `source:gamma` | 1 | one line of text |

### Goal

```text
Goal {
  goal_id:           "g-report"
  purpose:           "Produce a checked report over the listed sources"
  sources:           [ResourceId]              # base scenario: alpha, beta
  authority:         { read: [ResourceId] }    # base scenario: alpha, beta
  budget:            { actions: 6, judgments: 6 }
  success_evidence:  "a Report artifact covering every goal source whose read set
                      matches the current revision of each source"
}
```

Authority is part of the goal, not derived from its inputs. A source listed in
`sources` but absent from `authority.read` is a prohibited inspection.

### Capabilities

Two fixed, read-only capabilities are registered in the fake host. Both are
named for their operation.

```text
source.inspect @ contract r1
  input:        { source: ResourceId }
  output:       InspectionResult { source, revision, line_count, digest }
  effects:      [ { resource: source, mode: read } ]
  permissions:  read(source)
  failures:     not_found, access_denied

report.assemble @ contract r1
  input:        { inspections: [InspectionResult] }
  output:       Report { entries: [InspectionResult], read_set: [{resource, revision}] }
  effects:      []                                # pure transformation
  permissions:  none
  failures:     empty_input
```

`report.assemble` does not check freshness; the runtime does, through the
candidate's read set (§7). The report records the read set it was assembled
under so that the evidence is inspectable afterwards.

### Runtime actions

Two actions are provided by the runtime, not by a capability:

- `frontier.weigh` — the bounded control request to the decision-layer judgment
  site. Policy reserves one `judgments` unit for it directly.
- `goal.complete` — records completion when success evidence is present.
  Reserves one `actions` unit.

## 3. Observation envelope

Every input to state is an observation. The sequencer assigns `seq`; nothing
else in the runtime reads a wall clock.

```text
Observation {
  seq:              integer, dense from 1, assigned on append
  observation_id:   string, unique, supplied by the source
  source:           Provenance { kind: runtime | host | judgment | clock | operator | test,
                                 id: string }
  caused_by:        ActionId | seq | null
  payload_type:     string
  payload_version:  integer
  payload:          typed record for payload_type
  validation:       accepted
                  | rejected { reason }
                  | unknown_type
}
```

Rules:

- `validation` is determined by deterministic checks at append time. Only
  `accepted` observations may participate in a transition. Rejected and
  unknown-type observations are retained with their `seq`.
- `source.kind = operator` observations are not authenticated in M0. Approval
  and the authority channel arrive in M1; M0 has no transition that requires
  them.
- Time enters only as `clock.tick`. No M0 transition depends on it; the kind
  exists so that the log shape does not change when deadlines arrive in M1.

### Payload types used in M0

| `payload_type` | Source kind | Payload |
| --- | --- | --- |
| `goal.opened` | operator | `Goal` |
| `source.registered` | test | `{ resource, revision, content }` |
| `source.changed` | test | `{ resource, revision, content }` |
| `clock.tick` | clock | `{ tick: integer }` |
| `weights.recorded` | judgment | `{ site: "frontier.weigh", implementation: "scripted@1", state_revision, candidate_set: digest, weights: [{ candidate_id, weight }] }` |
| `action.started` | runtime | `{ action_id, candidate_id, operation, inputs, reservation }` |
| `action.result` | host or runtime | `{ action_id, outcome: succeeded { output } | failed { failure } | uncertain { reason } }` |
| `action.cancel_requested` | operator or runtime | `{ action_id, reason }` (defined; unused in M0) |

Any other `payload_type` is `unknown_type`.

## 4. Derived state

State is a deterministic fold over accepted observations in `seq` order.
`state_revision` is the `seq` of the last accepted observation.

```text
State {
  state_revision:  seq
  goal:            Goal + { status: active | complete }
  sources:         map ResourceId -> { revision, content }
  actions:         map ActionId -> ActionRecord
  inspections:     map ResourceId -> { result: InspectionResult, evidence: seq }
  report:          { report: Report, evidence: [seq] } | null
  budget:          { actions: { limit, reserved, spent }, judgments: { limit, reserved, spent } }
}
```

Transition rules that matter for M0:

- `goal.opened` sets `goal` with `status: active`. Waiting and blocked are cycle
  outcomes (§9), not goal state: state is a fold over observations only, and a
  blocked goal becomes unblocked by a new observation, not by a status flip.
- `source.changed` bumps `sources[resource].revision`. It does not remove a
  recorded inspection; the inspection simply no longer matches the current
  revision, which the read-set check detects.
- `action.started` creates an `ActionRecord` in `running` and moves the
  reservation from available to `reserved`.
- `action.result` moves the record to its terminal state, converts `reserved`
  to `spent`, and for `source.inspect` records `inspections[source]` with the
  result's `seq` as evidence.
- `goal.status = complete` is set only by a succeeded `goal.complete` action. No
  observation payload can set it directly (check M0-T11).

## 5. Action lifecycle

```text
pending ──dispatch──▶ running ──result──▶ succeeded
                        │                 failed
                        │                 uncertain
                        └─cancel_requested (flag, separate from outcome)──▶ cancelled
```

```text
ActionRecord {
  action_id:        "a:<cycle_no>:<index>"
  candidate_id:     CandidateId
  operation:        string           # capability id or runtime action
  contract_rev:     string | null
  inputs:           typed record
  read_set:         [{ resource | state_field, revision }]
  effects:          [{ resource, mode: read | write }]
  reservation:      { actions: n, judgments: n }
  state:            pending | running | succeeded | failed | uncertain | cancelled
  cancel_requested: boolean
  started_at:       seq | null
  finished_at:      seq | null
  grant:            Grant | null     # present only for capability invocations
}
```

`uncertain` and `cancelled` are defined now so that M1 adds behavior, not
shape. M0 exercises `pending`, `running`, `succeeded`, and `failed`.

## 6. Action candidate

```text
Candidate {
  candidate_id:   deterministic function of (operation, contract_rev, inputs)
  operation:      string
  contract_rev:   string | null
  inputs:         typed record
  evidence:       [seq]                            # observations that justify the binding
  read_set:       [{ resource | state_field, revision }]
  dependencies:   [ActionId | Condition]
  effects:        [{ resource, mode }]
  resources:      { actions: n, judgments: n }
  eligibility:    allowed
                | approval_required { policy }     # defined; no M0 policy produces it
                | prohibited { reason }
  weight:         number | null                    # null until weighed; never for prohibited
}
```

A candidate is not an action. It becomes one only when the scheduler selects
it, reserves its resources, and records `action.started`.

## 7. The M0 cycle

Each cycle is a pure function of `State` plus the log, and it appends to the
log. While a goal is open, a cycle runs after each accepted observation that the
cycle did not append itself (host results, operator, test, and clock
observations); `goal.opened` triggers cycle 1. The
`weights.recorded` and `action.started` observations a cycle appends advance
`state_revision` but do not trigger another cycle, so cycle numbers in the
checks below count external arrivals.

1. **Form candidates** using the single established procedure
   `inspect_and_report@1`. No candidates form once `goal.status = complete`.
   - For each `goal.sources[s]` with no `inspections[s]` whose revision equals
     `sources[s].revision`: candidate `source.inspect { source: s }` with
     `read_set = [{ s, sources[s].revision }]`, `effects = [{ s, read }]`.
   - If every goal source has a matching inspection and `report` is null or its
     read set no longer matches: candidate `report.assemble` with all matching
     inspections, `read_set` = each source's current revision, no effects, and
     `dependencies` = the action ids that produced those inspections.
   - If `report` is non-null and its read set matches every source's current
     revision: candidate `goal.complete`.
   - A candidate whose `candidate_id` matches a `pending` or `running` action is
     not re-formed; the in-flight action already represents it.
2. **Check eligibility.** `source.inspect { s }` is `prohibited { "no read
   authority for s" }` when `s ∉ goal.authority.read`. Everything else in M0 is
   `allowed`. Prohibited candidates are recorded in the cycle record and never
   weighed or dispatched. They are not converted into approval candidates.
3. **Weigh.** If any candidate is `allowed`, request `frontier.weigh`. Policy
   reserves one `judgments` unit. If none is available, the cycle ends
   `blocked { "judgments budget exhausted" }` with no dispatch. Otherwise the
   scripted decision layer returns weights, recorded as a `weights.recorded`
   observation. Scripted weights for M0:

   | operation | weight |
   | --- | --- |
   | `goal.complete` | 1.0 |
   | `report.assemble` | 0.9 |
   | `source.inspect` | 0.8 |

4. **Select.** Order eligible candidates by `(weight desc, candidate_id asc)`.
   Walk the order; select a candidate when its dependencies are satisfied, its
   effects do not conflict with any running action or with an already selected
   candidate in this cycle (two `read` effects on the same resource do not
   conflict), its read set matches current state, and its resources fit the
   remaining budget. Record every non-selected eligible candidate with the
   reason: `dependency`, `conflict`, `stale_read_set`, or `budget`.
5. **Dispatch.** For each selected candidate, reserve resources, issue a `Grant`
   for capability invocations, append `action.started`, and invoke the host.
   Invocation is asynchronous; results arrive as `action.result` observations.
6. **Record the cycle outcome:** `dispatched` if anything started; `complete`
   if `goal.complete` succeeded; `waiting` if nothing was selected but actions
   are running; otherwise `blocked { reason }`, where the reason is the dominant
   non-selection reason or the prohibited candidate that leaves the goal
   unachievable.

Weights are compared only within a single `weights.recorded` observation. The
selection rule is ordinal and site-specific; it makes no claim about calibration.

## 8. Fake host

The fake host is Weave's test double for the capability host interface. It
lives in Weave's test code and must not be mistaken for AgentFabric.

```text
Grant {
  action_id, operation, contract_rev, permissions, effects, issued_at: seq
}

CapabilityHost {
  describe(operation) -> Contract | unknown_operation
  invoke(grant: Grant, operation, inputs) -> InvocationHandle | rejected { reason }
}
```

Behavior:

- `invoke` is rejected when `grant` is absent, when `grant.operation` or
  `grant.contract_rev` differ from the request, or when the operation's declared
  permissions are not covered by `grant.permissions`. Rejection is recorded by
  the host and is observable to the test.
- Invocations are held open until the test releases them. Tests control the
  completion order and can hold two invocations open simultaneously.
- The host counts invocations and rejections. Replay asserts on the count.
- `source.inspect` reads from the fixture environment, not from Weave state.

## 9. Trace

The trace is the ordered sequence of observations and cycle records. It is the
oracle for every check below.

```text
CycleRecord {
  cycle_no:        integer, dense from 1
  state_revision:  seq
  procedure:       "inspect_and_report@1"
  candidates:      [Candidate]                          # including prohibited ones
  weights_ref:     seq | null                           # the weights.recorded observation
  selected:        [{ candidate_id, action_id, reservation }]
  not_selected:    [{ candidate_id, reason: dependency | conflict | stale_read_set | budget }]
  outcome:         dispatched | waiting | blocked { reason } | complete
}
```

Completeness requirement: for every `action.started` observation there is
exactly one `CycleRecord` whose `selected` names its `action_id`, and that
record contains the candidate, its eligibility, and its weight.

## 10. Replay

Replay takes the observation log — accepted, rejected, and unknown-type
envelopes in `seq` order — and re-runs the cycle. In replay mode the runtime
resolves `frontier.weigh` and capability invocations by looking up the recorded
`weights.recorded` and `action.result` observations for the same
`state_revision`, `candidate_set`, and `action_id`. Invoking the host or the
decision layer in replay is an error, and a missing recorded result is a
replay failure, not a reason to execute.

## 11. Checks

Each check is red until the runtime exists. Structural checks (`C`) are
enforced by the build; trace assertions (`T`) are deterministic tests.

### Structural

- **M0-C1 Package direction.** AgentSOP imports neither Weave nor AgentFabric.
  AgentFabric does not import Weave. The fake host is Weave test code that
  depends only on the host interface. The check runs without Weave's tests.
- **M0-C2 No ambient clock.** Runtime code paths that produce `CycleRecord`,
  `Candidate`, or `ActionRecord` do not call a wall-clock or monotonic-clock
  API. Time is available only as `clock.tick` observations.
- **M0-C3 Trace completeness.** Every `action.started` in the log is explained
  by exactly one `CycleRecord` per §9.

### Base scenario

Setup: register alpha, beta, gamma at revision 1; open the base goal (sources
alpha, beta; authority alpha, beta; budget 6/6); hold host completions.

- **M0-T01 Goal opens without acting.** After `goal.opened` and before the
  first cycle, state has the goal in `active`, no actions, and budget fully
  available.
- **M0-T02 Both inspections form as candidates.** Cycle 1 contains exactly two
  candidates: `source.inspect alpha` and `source.inspect beta`, both `allowed`,
  each with `read_set = [{ source, 1 }]` and `effects = [{ source, read }]`.
  No `report.assemble` candidate exists.
- **M0-T03 Weights are an observation.** Cycle 1's `weights_ref` points to a
  `weights.recorded` observation with `source.kind = judgment`,
  `implementation = scripted@1`, and `state_revision` equal to the cycle's, and
  the `judgments` budget shows one unit reserved then spent.
- **M0-T04 Independent reads dispatch together.** Cycle 1 selects both
  inspections; two `action.started` observations follow with distinct
  `action_id`s and reservations totalling `actions: 2`.
- **M0-T05 Independent reads run concurrently.** While completions are held,
  the fake host reports two invocations open at once, and both `ActionRecord`s
  are `running` with no `action.result` in the log.
- **M0-T06 Results integrate in arrival order.** Release beta, then alpha. The
  log contains beta's `action.result` before alpha's; `inspections[beta]` is
  recorded with evidence equal to that `seq`; cycle 2 (after beta) forms no
  `report.assemble` candidate and ends `waiting`.
- **M0-T07 Assembly depends on all inspections.** After alpha's result, the
  next cycle forms `report.assemble` with both inspections, `read_set =
  [{ alpha, 1 }, { beta, 1 }]`, no effects, and dispatches it.
- **M0-T08 Report carries evidence.** On `report.assemble` success, `state.report`
  holds the `Report`, its `read_set` equals the candidate's, and `evidence`
  lists the `seq` of both inspection results and the assemble result.
- **M0-T09 Completion needs success evidence.** The cycle after the report
  forms `goal.complete`, dispatches it, and on its result `goal.status` is
  `complete` and the final `CycleRecord.outcome` is `complete`. Total spend is
  `actions: 4, judgments: 3` (cycles with no eligible candidate do not weigh).
- **M0-T10 The trace is deterministic.** Running the base scenario twice with
  the same completion order produces byte-identical traces, including when the
  process wall clock differs between runs.

### Authority

- **M0-T11 A claimed completion is not completion.** Append an observation with
  `payload_type = goal.completed` from `source.kind = test`. It is retained with
  `validation = unknown_type`, `state_revision` advances by zero accepted
  observations, `goal.status` is unchanged, and the next cycle's candidates are
  unchanged.
- **M0-T12 Prohibited access is excluded before weighing.** Open a variant goal
  with sources alpha, beta, gamma and authority alpha, beta. Cycle 1's
  `candidates` contains `source.inspect gamma` with `eligibility = prohibited`,
  `weight = null`; the `weights.recorded` payload lists only alpha and beta; no
  `action.started` names gamma; no `approval_required` candidate exists.
- **M0-T13 Prohibition blocks honestly.** In the same variant, after alpha and
  beta are inspected, no `report.assemble` candidate forms (gamma has no
  inspection) and the cycle ends `blocked { reason mentions source:gamma }`.
  `goal.status` remains `active`; no approval candidate was ever formed.
- **M0-T14 The host rejects an ungranted invocation.** Call
  `host.invoke(null, "source.inspect", { source: gamma })` and
  `host.invoke(grant_for_alpha, "source.inspect", { source: gamma })` directly.
  Both are rejected; the host's rejection count is 2 and its invocation count
  is unchanged.

### Budget

- **M0-T15 Actions are reserved before dispatch.** Open the base goal with
  `budget.actions = 2`. Cycle 1 dispatches both inspections and the budget
  shows `reserved: 2`. After both results, the assemble candidate is
  `allowed` but `not_selected` with `reason = budget`, and the cycle ends
  `blocked { "actions budget exhausted" }`.
- **M0-T16 No judgment budget means no dispatch.** Open the base goal with
  `budget.judgments = 0`. Cycle 1 forms two `allowed` candidates, has
  `weights_ref = null`, selects nothing, and ends `blocked { "judgments budget
  exhausted" }`. No `action.started` exists.

### Malformed input

- **M0-T17 Malformed observations cannot transition.** Append a
  `source.changed` observation whose payload lacks `revision`. It is retained
  with `validation = rejected`, `sources` is unchanged, and the next cycle's
  candidates are unchanged.

### Replay

- **M0-T18 Replay reproduces the trace without executing.** Take the log from
  M0-T09. Replay it with a fresh fake host and a decision layer that fails if
  called. The resulting cycle records are identical to the live run's, the host
  reports zero invocations, and the goal is `complete`.
- **M0-T19 Replay fails closed on missing results.** Remove the final
  `action.result` from the M0-T09 log and replay. Replay stops with an explicit
  replay failure at that action; the host reports zero invocations and no
  synthetic result is recorded.

## 12. Deferred to later milestones

- Publication, any `write` effect, effect conflicts, and grant enforcement
  against a real host — M1.
- Authenticated approvals, forged-approval rejection, `source.changed`
  invalidating an in-flight report, cancellation, crash reconciliation, and
  `uncertain` outcomes — M1. The fields exist in M0 so M1 changes behavior only.
- Any model-backed judgment site, the inference gateway, and context profiles — M2.

## 13. Assumptions recorded

- The toolchain is undecided (§11). This document fixes behavior, not syntax;
  the checks are to be transcribed into executable tests as the first commit of
  the chosen toolchain, and must be observed red before runtime code is written.
- The fake host is sufficient for M0 because both capabilities are read-only on
  fixture memory. Nothing here is evidence that AgentFabric enforces anything.
- `budget.actions` and `budget.judgments` count units, not cost. Cost units are
  introduced when the gateway arrives in M2.
