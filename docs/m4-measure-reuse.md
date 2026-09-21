# M4 — Measure reuse

This is the behavioral contract for the milestone in
[ARCHITECTURE.md §10](../ARCHITECTURE.md). It extends
[M3](m3-fill-a-capability-gap.md). Terms follow
[CONTEXT.md](../CONTEXT.md). The checks below are requirements, not claims of
implemented behavior. Demonstrate red before implementation and retain the
M0–M3 checks when proving green.

## 1. Outcome and scope

Repeat the normalized report. The admitted `text.normalize` runs from the
recorded composition, and the framing inference that discovered the gap is
not repeated for that binding. Reuse of a cached conclusion is allowed only
while its read set, revision, and authority scope still hold. A second
implementation of the same contract starts with empty reliability and cost.
The run records the baseline an M5 experiment will have to beat.

M4 proves:

- The repeated goal forms `text.normalize` from the catalogue and the recorded
  composition. It does not add a procedure arm to the control core, and it
  does not call framing inference to rediscover the binding.
- A cached conclusion is reused only when its input digest, read set, and
  authority scope match. A stale dependency is not returned as the current
  result. A short output is not exempt.
- Reuse adds no second inference charge. The baseline counts each admitted
  cost once.
- Cross-goal access is denied unless an explicit policy record allows it.
  Registry presence is not that record.
- A replacement implementation does not inherit the first implementation's
  reliability, cost, or maturity.
- The baseline is recorded before any M5 candidate exists, and it counts
  failures as well as successes.

No optimiser, promotion, or second workload is required.

## 2. Cached conclusion

```text
CachedConclusion {
  conclusion_id
  operation
  contract_rev
  implementation_id
  input_digest
  output
  evidence:          [seq]
  read_set:          [{ resource, revision }]
  authority_scope:   { goal_id } | { policy_id }
  invalidation:      read_set | contract_rev | admission
}
```

Reuse returns the output only when the input digest matches, every read-set
revision is current, the contract revision matches, the implementation is
still admitted, and the caller's goal is inside the authority scope. Otherwise
the conclusion stays in the log as evidence and the operation runs again, or
the result is recorded as uncertain when the dependency cannot be checked.
Recency is not a reason to reuse. Length is not a reason to reuse. A
conclusion under any size threshold still requires a current read set, a
matching contract revision, an admitted implementation, and an authority
scope that covers the caller.

A conclusion scoped to one goal is invisible to another goal. An explicit
policy record may widen the scope; writing the conclusion into the registry
does not. A conclusion that has been reused is not copied back into the next
state view as a new slice. The view includes it only when the active profile
selects that slice, and the manifest records that inclusion once.

## 3. Replacement implementation

The second implementation of `text.normalize` passes the same contract and
must earn its own red, green, isolation report, and admission. Its
reliability and cost records start empty. Routing may not select it because
the first implementation measured well. Both may be admitted. The host
reports which implementation ran.

## 4. Baseline

Record this before any candidate operating strategy is proposed:

```text
Baseline {
  strategy:            "profile.frame@1"
  workload:            repeated normalized-report goals, including a failing case
  quality:             success evidence held or missed
  inference_requests:  integer
  latency_ticks:       integer   # clock.tick delta, not wall time
  cost_micros:         integer
  human_corrections:   integer
}
```

The failing case is part of the workload. A baseline built only from
successful traces does not satisfy the milestone.

`cost_micros` sums admitted inference reservations and host invocations
once each. A reused conclusion contributes no second inference cost. The
same attempt is not billed again because its result was short or because
its prefix was read from a cache. Token-level cache accounting for a live
provider is out of scope; the fixture's cost is the reservation the gateway
already recorded.

## 5. Required deterministic checks

Retain every M0–M3 check. Use the admitted fixture implementation and
injected ticks.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| M4-T01 | Repeat the normalized report | `text.normalize` is dispatched from the recorded composition. No framing inference is requested for that binding. The runtime procedure union is unchanged. |
| M4-T02 | Same input, current read set, same goal | The cached conclusion is reused. No second host invocation occurs. The trace cites the conclusion's evidence. |
| M4-T03 | Source revision changes after the conclusion, including when the cached output is under the byte bound | The stale output is not the action result. The operation runs again or the result is uncertain. The old conclusion remains in the log. |
| M4-T04 | A second goal requests the first goal's conclusion, with no policy record | Reuse is denied. A policy record that names both goals permits reuse. Registry presence alone does not. |
| M4-T05 | A second implementation of `text.normalize` is admitted | Its reliability and cost are empty. It is not selected on the first implementation's measurements. The host record names the implementation that ran. |
| M4-T06 | Baseline recorded from the repeated workload, including one failed goal | The record has quality, inference count, tick latency, cost, and human corrections. It exists before any M5 candidate observation. A reused conclusion does not increase `cost_micros` a second time. |

Replay of the repeated run does not invoke the host or the gateway. Record
demonstrated red and green against the exact contract revisions.

## 6. Assumptions recorded

- Latency in the baseline is a difference of recorded `clock.tick` values.
  Wall-clock measurements are not part of this milestone.
- "Human corrections" counts operator observations that change an action
  binding or reject an output. Silence is not a correction.
- Cross-goal policy is one explicit record in the fixture. M4 does not add a
  general disclosure language.
