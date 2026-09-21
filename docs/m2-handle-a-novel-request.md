# M2 — Handle a novel request

This is the behavioral contract for the third milestone in
[ARCHITECTURE.md §10](../ARCHITECTURE.md). It extends
[M0](m0-inspect-and-report.md) by routing one model through the bounded
inference gateway already in `packages/gateway`. Terms follow
[CONTEXT.md](../CONTEXT.md). The checks below are requirements, not claims of
implemented behavior. Demonstrate red before implementation and retain M0 and
M1's checks when proving green.

## 1. Outcome and scope

A variant of the inspect-and-report goal cannot form its inspect bindings from
the established procedure alone. Weave renders one bounded state view, asks the
gateway to propose those bindings, validates the proposal into action
candidates, weighs eligible candidates, and produces the same checked report as
M0.

M2 proves:

- An action proposal is an observation. Validation, not the model, creates
  action candidates. Unauthorized or ill-typed bindings never dispatch.
- Frontier weighing may use the gateway. Scripted and gateway weights that
  preserve ordinal order produce the same dispatch.
- One versioned state view records its selection manifest, source revisions,
  and disclosed omissions. Unauthorized slices do not appear in what a model
  is sent.
- Policy names permitted data destinations. A hosted route is excluded when
  the request does not permit that destination.
- Budget is reserved before a gateway call. Every attempt is accounted,
  including malformed responses and failures, whether or not the judgment is
  accepted.
- Slow inference cannot block control-plane observations. A judgment bound to
  a superseded state or candidate revision cannot authorize dispatch.
- An unaccepted or blocked judgment does not recursively request another
  frontier judgment. The cycle records an explicit blocked or waiting outcome.
- Historical replay reconstructs the novel run from the log without calling
  the gateway or the decision layer.
- A contract may declare inference as a dependency with enforceable limits.
  The resolver context supplies the gateway; exceeding those limits is
  refused. AgentSOP still does not import the gateway.

No multi-provider empirical router, live paid model, generated-capability
admission, or untrusted isolation is required to prove this milestone. Fixture
adapters are models for the gating suite.

## 2. Fixture

Keep M0's in-memory sources and report shape. Gamma remains registered and
prohibited. Publication, approvals, and crash recovery stay M1's.

### Novel goal

```text
Goal {
  goal_id:           "g-report-variant"
  purpose:           "Produce a checked report over the listed sources"
  sources:           [source:alpha, source:beta]
  authority:         { read: [source:alpha, source:beta] }
  framing:           true
  budget:            { actions: 8, judgments: 8, cost: 1_000_000 }
  success_evidence:  (same as M0)
}
```

`framing: true` selects procedure `frame_and_report@1`. The established
`inspect_and_report@1` enumerator does not walk `goal.sources` for this
procedure. Inspect candidates appear only after a validated proposal names
them. `cost` is an accounting unit of 1e-6 of a currency unit (micros), shared
with the gateway. M0 goals omit `framing` and `cost`; their procedure and
budget are unchanged.

### Runtime actions

M0's `frontier.weigh` and `goal.complete` remain. M2 adds:

- `goal.frame` — scheduled goal-level inference. It reserves one `actions`
  unit, renders the framing state view, and calls `gateway.generate` under
  declared terms. Its output is a proposal observation, not a grant of
  authority. Scripted weight: `0.85`.

Frontier weighing remains a bounded control request: policy reserves one
`judgments` unit (and, when the gateway is used, a cost envelope) without
requiring another frontier judgment to authorize it.

### Proposal

```text
Proposal {
  bindings:  [{ operation, inputs }]
  rejected:  [{ operation, inputs, reason }]
}
```

A generated proposal is sufficient when every goal source has exactly one
accepted `source.inspect` binding. Extra bindings are validated individually:
unauthorized resources, unknown operations, and ill-typed inputs are recorded
in `rejected` and do not become candidates. A missing goal source is
insufficient; inspect candidates are not formed from a partial proposal.

The fixture generator returns JSON of the form
`{"bindings":[{"operation":"source.inspect","inputs":{"source":"source:alpha"}}, ...]}`.
Malformed text is an unaccepted generation, not a proposal.

### Gateway fixture

One generation route (`goal.frame`, kind `transform`) and one evaluation route
(`frontier.weigh`, kind `score`) are enough. Destinations used in checks:

| Destination | Role |
| --- | --- |
| `local` | Permitted fixture destination |
| `hosted.vendor` | Disallowed unless `terms.destinations` names it |

Time for the gateway is an injected clock that reads `clock.tick`. Deadlines
are tick values, not wall time. Tests hold a deferred adapter to prove
responsive control; they do not sleep.

## 3. State view

A state view is a typed, versioned rendering of authorized slices for one
context profile. It is not an independent source of truth.

```text
StateView {
  profile:           string
  profile_version:   integer
  state_revision:    seq
  content:           the payload actually sent to the model
  manifest: {
    slices: [{
      name: string
      revisions: [seq]
      truncated: boolean
      omitted: [{ name, reason }]
    }]
  }
}
```

Two profiles:

| Profile | Consumer | Slices | Must omit |
| --- | --- | --- | --- |
| `profile.frame@1` | `goal.frame` | goal purpose, sources, authority ids, catalogue operation ids and input shapes, registered source ids and revisions the goal may read | gamma content and id-as-content, locators, prohibited candidate payloads, source bodies |
| `profile.frontier-weigh@1` | `frontier.weigh` | goal purpose, eligible candidates (id, operation, input summary) | prohibited candidates, unauthorized source content |

A profile is a versioned record the runtime selects: `id`, `version`, and
`catalogue_budget`. The renderer does not own a private budget.
`profile.frame@1` has `catalogue_budget: 32` and discloses every operation the
host lists. That list is the host catalogue, not a fixed set of operation ids
in the runtime. A profile whose budget is smaller than the catalogue truncates
with `truncated: true` and omission reason `budget`. Policy, not the model,
chooses the profile and filters disclosure. The view's `content` is what the
gateway may send; a test may inspect `content` and the manifest to prove
omissions.

Replay reconstructs the framing catalogue from recorded `capability.described`
observations that precede the framing request. It does not consult the host
catalogue supplied to replay, and it must be given the same profile record
that produced the view.

## 4. Inference records

Every gateway call is preceded by a reservation in the log and followed by an
accounting record, independently of acceptance.

```text
inference.requested {
  request_id
  site:            "frontier.weigh" | "goal.frame"
  role:            framing | working
  kind
  view:            StateView            # manifest required; content may be present
  state_revision
  candidate_set:   digest | null        # weighing only
  terms:           { quality, destinations, max_context_tokens, deadline, cost_ceiling, max_attempts }
  reservation:     { judgments, cost }
}

inference.recorded {
  request_id
  attempts:        [{ attempt, routed_unit_id, cost, cost_is_upper_bound, disposition }]
  spent:           micros
  status:          accepted | unaccepted | blocked
  reason:          string | null
}
```

`inference.requested` is `source.kind = runtime`. It reserves `judgments` and
`cost` from the remaining budget before the gateway is invoked. If the
remaining cost cannot cover `terms.cost_ceiling` for a gateway weigh, the
cycle ends `blocked { "cost budget exhausted" }` with no call.

`inference.recorded` is `source.kind = judgment`. It spends the matching
reservation (actual `spent` against cost; the reserved judgment unit in full)
whether the outcome is accepted, unaccepted, or blocked after attempts. A
blocked `no_route` / `invalid_request` / `deadline_passed` with zero attempts
still spends the reserved judgment unit; cost spent is zero.

Successful gateway weighing then appends `weights.recorded` with
`implementation` naming the routed unit, `state_revision` equal to the
revision after `inference.requested`, and the existing candidate-set digest
rule. That observation does not spend a second judgment unit. Scripted
weighing is unchanged: it does not append `inference.*` records and still
spends one judgment unit on `weights.recorded`.

A `weights.recorded` payload is accepted only when its `state_revision` is
current and its `candidate_set` is the digest of exactly the candidate ids it
weighs. Intervening accepted observations, including `clock.tick`, make a
late judgment stale. Stale weights are retained as rejected and cannot
authorize dispatch. Their `inference.recorded` sibling is still accepted.

## 5. The cycle under framing

Procedure `frame_and_report@1`:

1. **Form candidates.** If no sufficient proposal is in state, form
   `goal.frame` (one action unit, no effects) unless an in-flight `goal.frame`
   already represents it. If a sufficient proposal exists, form `source.inspect`
   candidates from its accepted bindings only, then `report.assemble` and
   `goal.complete` as in M0 once inspections and the report exist.
2. **Check eligibility.** Unchanged: inspect is prohibited when the source is
   not in `goal.authority.read`. Proposed gamma never becomes `allowed`.
3. **Weigh.** If any candidate is `allowed`, request `frontier.weigh`. When
   the decision layer returns weights synchronously, the M0 path applies. When
   it returns a thenable, append `inference.requested`, start the gateway call
   without waiting, and end the cycle `waiting`. A (state_revision,
   candidate_set) pair is weighed at most once; in-flight or already-failed
   gateway weighing is not retried until those identities change. Unaccepted
   or blocked gateway weighing does not start another frontier judgment in
   the same handling; the cycle records `blocked` with the recorded reason.
4. **Select and dispatch.** Unchanged once accepted, current weights exist.
   `goal.frame` is a runtime action: `action.started` then the gateway
   generate. Its `action.result` output is the validated `Proposal`. A failed
   or unaccepted generation is `failed`; no proposal is folded into state.

Control-plane observations (clock ticks, cancellation, operator ingress, host
results) are admitted and may run a cycle while gateway work is in flight.
They must not wait for the model. Cancellation of `goal.frame` aborts the
in-flight generate when a signal is available; already-started attempts remain
accounted.

Replay resolves `inference.requested`, `inference.recorded`, and
`weights.recorded` from the log. Invoking the gateway or the decision layer in
replay is an error.

## 6. Inference as a contract dependency

AgentSOP remains independent of `@weave/gateway`. A contract may declare:

```text
inference?: {
  kind:          string
  role:          framing | working | extension
  max_cost:      integer micros
  destinations:  [string]
  max_attempts:  integer
}
```

Catalogue validation rejects a malformed `inference` object. Declaring
inference is not a `depends_on` edge and does not grant a generate-anything
capability.

The resolver context may include an `infer` port. The host supplies it only
when the contract declared `inference` and a gateway is configured. The port
enforces the contract's cost, destination, attempt, kind, and role limits; a
call that would exceed them is refused without reaching the provider.
`max_cost` is cumulative: each admitted call reserves its `cost_ceiling`
against the remaining contract budget. The caller supplies a finite tick
deadline, which the port forwards; an open deadline is refused rather than
replaced. The kind routed is the declared generation kind and is not rewritten
to another kind. A kind that is not a generation kind is refused. Absence of
a gateway while `inference` is declared yields `RESOLVER_UNAVAILABLE` at the
port, not silent ambient model access. Resource operations on a context that
is not bound to an invocation grant are denied and do not read or write.

Weave's `goal.frame` and `frontier.weigh` call the gateway directly. They are
not AgentFabric capabilities. The host-level port exists so a later generative
implementation can use the same bounded interface.

## 7. Required deterministic checks

Use fixture adapters, injected ticks, and deferred promises. Do not sleep on
the wall clock. Retain every M0 and M1 check.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| M2-T01 | Novel goal with a valid framing proposal | Procedure is `frame_and_report@1`; cycle 1 forms `goal.frame` and not inspects; after an accepted proposal covering alpha and beta, inspects dispatch, the report completes, success evidence matches M0. |
| M2-T02 | Proposal names gamma, an unknown operation, and the two authorized inspects | Gamma and the unknown operation are in `rejected`; neither is a candidate nor an `action.started`; alpha and beta inspects still form from the accepted bindings. |
| M2-T03 | Same inspect candidate set weighed by scripted@1 and by the gateway | Ordinal selection (weight desc, candidate_id asc) matches; gateway `weights.recorded.implementation` is not `scripted@1`; both traces dispatch the same operations in the same order. |
| M2-T04 | Framing state view | A tight profile (`profile.frame.tight@1`, catalogue budget 1) names that profile, records revisions, and discloses omissions; `content` and the manifest contain no gamma body and no prohibited payload; the catalogue slice sets `truncated` and reason `budget`. The default `profile.frame@1` discloses `source.inspect` and is not truncated. |
| M2-T05 | Weigh terms permit only `local` while the table also has `hosted.vendor` | The hosted route is not attempted; any accepted attempt names `local`. A request that permits no remaining route records `blocked / no_route` with zero provider attempts. |
| M2-T06 | Malformed then failed provider attempts for weighing | `inference.requested` precedes the call; `inference.recorded.attempts` includes both; `spent` is positive; the reserved judgment unit is spent; no `weights.recorded` is accepted. |
| M2-T07 | Weigh adapter is held open | A `clock.tick` and a cancellation still append and run a cycle; the cycle outcome is `waiting`; the adapter has not yet resolved. |
| M2-T08 | Tick advances while weighing is held, then the adapter resolves | `weights.recorded` is rejected as stale; no dispatch is authorized from it; `inference.recorded` is accepted and the reservation is spent. |
| M2-T09 | Unaccepted gateway weigh | No second `frontier.weigh` starts for the same state_revision and candidate_set; the cycle is `blocked` with an explicit reason; the goal stays `active`. |
| M2-T10 | Replay the completed novel run | Replayed cycles and observations match; the gateway and decision layer are not invoked; the host invocation count is zero during replay. |
| M2-T11 | Contract declares inference limits | Resolver context exposes `infer` for that contract; a call within limits reaches the gateway; a call that exceeds remaining cost, destinations, attempts, kind, or role is refused; a passed deadline is `blocked / deadline_passed` without a provider call; an open deadline is refused; an `extract` contract is routed to an `extract` unit and does not call a `transform` adapter; a declared-inference contract with no gateway configured is `RESOLVER_UNAVAILABLE`. |

Package-direction checks keep AgentSOP independent of the gateway, AgentFabric
able to import the gateway, and Weave able to import both. Record demonstrated
red and green against the exact contract, tests and implementation revisions.

## 8. Assumptions recorded

- Inference request and response types live in `@weave/gateway`. AgentSOP
  describes inference limits and a structural `infer` port without importing
  that package. This closes the open choice in ARCHITECTURE.md §11.
- Fixture adapters are the gating-suite "one model." Live provider examples
  remain non-gating.
- Scripted weighing stays synchronous so M0 traces and budget accounting are
  unchanged. Gateway weighing is the asynchronous path this milestone adds.
- `goal.frame` is a runtime action, not a capability. A generative
  implementation of a capability is proven only at the host port (M2-T11);
  crystallization remains M3.
- Cost units are micros. M0 goals without `budget.cost` have a cost limit of
  zero and never reserve cost.
- `profile.frame@1` is data with catalogue budget 32. Truncation is proved
  with a separate tight profile, so the default view can show the operation a
  proposal must name.
- A contract's `max_cost` bounds the sum of admitted `cost_ceiling` values.
  The port charges that ceiling when the call is admitted, including when the
  gateway then blocks on a passed deadline.
