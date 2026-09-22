# H1 — Bound the log

This is a follow-up hardening step after
[M5](m5-improve-an-operating-strategy.md). It is not a milestone: it adds no
goal outcome. It closes log-wide failure modes that M3 handles only for one
capability output. Terms follow [CONTEXT.md](../CONTEXT.md). The checks below
are requirements, not claims of implemented behavior. Demonstrate red before
implementation and retain the M0–M5 checks when proving green.

M3 bounds `text.normalize`. A source listing, a gateway payload, or any other
observation can still be large enough to wedge replay on every restart. H1
puts the bound on the log itself.

## 1. What this step proves

- An observation over the declared byte bound is rejected before it is
  durable. The raw bytes are not appended. The rejection is retained for
  diagnosis and causes no transition.
- Recovery and replay do not re-append a rejected observation and do not
  re-dispatch a candidate whose identical failure was already recorded.
- A second observation with an `observation_id` that is already in the log is
  rejected. Distinct ids are distinct. Nothing is dropped silently.
- Restart loads the durable log once. A second runtime cannot attach to the
  same host store.
- When trace retention exists, it keeps one record per attempt, under a byte
  budget. It does not write a record per token, and it does not evict under
  the lock that serializes state transitions.

Provider streaming, session compaction, and a second scheduler are not part
of this step. A keepalive remains liveness. It does not move a deadline.
That rule is already required of the M5 comparison.

## 2. Bound

```text
LogBound {
  max_observation_bytes: integer
}
```

The bound is measured on the canonical encoding of the observation payload.
Exceeding it rejects the observation with reason `budget`. Truncation inside
the log is not a second policy: a caller that can truncate on a value
boundary, as M3 does for capability output, does so before append. A payload
that arrives already cut mid-value is rejected, not repaired into an empty
success.

A rejected observation stays in the diagnostic record. Replay and recovery
skip it. They do not flush it again, and they do not form the candidate that
produced it when the log already holds the same failure for that candidate
identity.

## 3. Identity

`observation_id` is unique in a log. A later observation with the same id is
rejected with reason `duplicate`, whether or not its payload matches. Two ids
that differ by one character are two observations. A collision that the log
cannot store distinctly is a rejection, not a drop of the second.

## 4. One writer

The process that opened the host store owns it. A second runtime attaching to
that store is refused before it dispatches. Admission remains the host's
single-writer record from M3. H1 does not add another copy.

Trace retention, once present, stores one record per gateway attempt or
action result. Eviction runs outside the state-transition lock. A retained
trace over its byte budget drops the oldest retained records and records the
omission. It does not delete the observation log.

## 5. Required deterministic checks

Use an in-memory journal and an injected oversize payload. Do not allocate
multi-megabyte fixtures and do not sleep.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| H1-T01 | An observation exceeds `max_observation_bytes` | It is rejected with reason `budget` before it is durable. No transition follows. Replay and recovery do not re-append it. |
| H1-T02 | A payload is cut mid-value | It is rejected. It is not stored as a successful empty result. |
| H1-T03 | The same candidate has already failed with the same identity | Recovery does not dispatch it again. Effect reconciliation for an `uncertain` action is unchanged and still bounded. |
| H1-T04 | A second observation reuses an `observation_id`; another id differs by one character | The reuse is rejected with reason `duplicate`. The distinct id is kept. Neither is dropped silently. |
| H1-T05 | A second runtime opens the same host store | The attach is refused. The first runtime's admissions and invocations are unchanged. |
| H1-T06 | Trace retention is over its byte budget | One record exists per attempt. Eviction does not run under the state-transition lock. The observation log is intact. No per-token record is written. |

## 6. Assumptions recorded

- The fixture bound is a few kilobytes. The check uses a short repeated
  payload, not a large file.
- "The same failure" is the same candidate id and the same failure string.
  A changed input is a different candidate and may run.
- Trace retention can be a test double until a real retention policy exists.
  H1 does not choose the long-term retention period.
