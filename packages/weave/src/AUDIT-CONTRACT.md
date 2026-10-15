# P9 audit contract

## Tidy state

`assembleAuditState` constructs `view.audit@1` (`audit-state@1`) only from
explicitly authorized named slices. Omitted slices use empty values and record
`slice:authority`; their source revisions are excluded. Goal and iteration are
required authorized slices. Criteria bind deterministic evidence by check id.
Artifacts retain reference, digest, size and a bounded summary; a body is optional
and disclosed only within the configured UTF-8 byte cap (default 4096).
Oversized bodies record `artifact:<id>:size_cap`. Unauthorized artifact references
record an authority omission and disclose no metadata. Source revisions are
sorted. JSON keys are canonical and the SHA-256 digest covers all disclosed
fields except the digest itself. Assembly performs no IO or inference. Inputs
are already disclosed, secret-free slices supplied by policy, not general runtime
state; this function is not a secret classifier or grant issuer.

## Context compaction port

`compactContext` uses an explicit token sequence and context capacity supplied by
its caller; it does not tokenize or infer. At 80% capacity it asks an optional
summarizer port to summarize the prefix, capped at 10% of capacity, retaining
the last 5% of capacity as exact ordered token strings. Without a summarizer it
returns `summary_needed` with the retained tail and prefix, so composition can
persist and schedule summarization. Below the threshold no summarizer runs.
An oversized summary is rejected instead of truncated through a token boundary.
The caller owns crash-safe persistence before replacing original context.

## Audit finding identity

Audit issue ids hash only `(criterion_id, kind, evidence_ref)`; rewording
`proposed_fix` preserves identity. A report keeps the first finding per key
before D6, preserving first-occurrence order. Recovery normalizes checkpointed
reports the same way. Replay preserves historical records and ids unchanged.
For repeated-fix detection, historical full-finding ids are aliases of the new
key when the recorded report and open issue establish that link. Attempt counts
across aliases use the maximum, never the sum; recurrence alone is not an attempt.

## Decision outage pause

Before a dispatch needing D4, `needs_dispatch && decision_unavailable` records
an audit round with outcome `decision_unavailable`, using the existing decision
outage reason vocabulary. It is a pause, resumable only with `resume: true` in
the same round. Resumption observes availability again before proceeding. Authority blocks remain terminal and no
pause confers a grant or bypasses D4/D7. D6 outage retains its `needs_human` fallback.

## Resume and recovery

Every explicit resume of a persisted pause captures live state, revision, and
budget before proceeding; it replaces the paused observation. A checkpoint's
optional `resume_from` binds that capture to the pause entry. Recovery of that
same resumption reuses its durable capture, accepted report, and D6 disposal,
so a crash before round append does not repeat completed inference. A previous
report may be retained only when both the disclosed-state digest and revision
are unchanged. Changed inputs receive a distinct request id; recovery keeps it
stable. Legacy checkpoints without `resume_from` are refreshed on resume.
An unpaused mid-round revision change still stops as `needs_human`.

Cancellation writes only the cancelled round once observed, with no subsequent
checkpoint, inference, or D6 dispatch. Ordinary replay of that outcome writes
nothing. Resuming a terminal result is also read-only.

The composition root must hold exclusive ownership for the whole execution,
including observation, checkpoints and append: two concurrent resumes must be
serialized before entering `runAuditLoop`, then reload the journal. There is no
lock or compare-and-swap in `AuditJournal`; `MemoryAuditJournal` is not a
cross-process lock. Production journals must commit checkpoints and appends
atomically and durably, deduplicate ids, and recover torn storage before append.
The audit loop has no grants and dispatches no fixes; the observation owner must
reconcile fix effects and never replay a single-use grant. Inference ports must
reconcile an interrupted request by its stable request id if a crash occurs
between provider completion and checkpoint commit; this in-flight window cannot
be made exactly-once by the synchronous journal interface alone.

## Pause precedence

After generation, cancellation takes precedence, followed by gateway or live
budget pauses, then the live-revision guard. A budget pause coinciding with a
state change stays resumable; the next resume captures fresh input. Without a
pause, a revision change still stops as `needs_human` before D6. The final
revision guard after D6 remains unchanged.
