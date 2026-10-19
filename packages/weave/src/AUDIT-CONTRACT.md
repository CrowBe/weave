# P9 audit contract

## Tidy state

`assembleAuditState` constructs `view.audit@1` (`audit-state@1`) only from
explicitly authorized named slices. Omitted slices use empty values and record
`slice:authority`; their source revisions are excluded. Goal and iteration are
required authorized slices. Criteria bind deterministic evidence by check id.
Artifacts retain reference, digest, size and a bounded summary; a body is optional
and disclosed only within the configured UTF-8 byte cap (default 4096).
Oversized bodies record `artifact:<id>:size_cap`. Unauthorized artifact references
record a single de-duplicated `artifact:authority` marker regardless of their
number or identities, and disclose no metadata, including ids. Source revisions are
sorted. JSON keys are canonical and the SHA-256 digest covers all disclosed
fields except the digest itself. Assembly performs no IO or inference. Inputs
are already disclosed, secret-free slices supplied by policy, not general runtime
state; this function is not a secret classifier or grant issuer.

Text is bounded by UTF-8 bytes without splitting a code point. Goal and criterion
statements, plan intents, and open-issue text retain a prefix of at most 4096
bytes each. Decision `site`, `question_id`, and non-null `choice` fields retain
at most 240 bytes each, matching the artifact summary cap. Empty strings and
null choices are preserved. Items and their order are preserved; other identifier
fields and probability-map keys are retained unchanged. Each shortened field
records `goal:statement_cap`, `criterion:<id>:statement_cap`,
`plan:<step_id>:intent_cap`, `decision:<zero-based-index>:<field>_cap`, or
`issue:<id>:text_cap`, respectively. Omission markers are sorted and
de-duplicated. The digest is computed after all text bounds and omissions.

Check tails retain the longest suffix of whole code points within 240 UTF-8
bytes, preserving the end of the output. Existing lone surrogates are replaced
with U+FFFD (three UTF-8 bytes) before measuring the retained suffix, so tails
never contain lone surrogates. Shortened or repaired tails record the existing
`check:<check_id>:tail_cap` marker. Exact-cap, well-formed tails are unchanged.

## Completion evidence

Each `AuditEval` may carry `iteration?: number | null`, identifying the audit
iteration that produced the D5 evidence. The observation owner attaches this
from the producing iteration when projecting implementation results into the
`evals` slice; implementation retry numbers are not audit iterations. D5 and
`flatEval` have no audit-loop iteration input. Retained evidence must never be
relabelled with the current iteration. Assembly preserves all supplied evals,
including historical and untagged entries; the canonical digest covers their
iteration fields when present. Missing fields stay absent for legacy states.

Per DEC-005, completion considers only evals whose iteration is a nonnegative
safe integer equal to the captured `AuditState.iteration`. Each criterion needs
a current pass with `verdict_probability >= .8` and `confidence >= .9`, and any
current failure for that criterion vetoes completion even alongside a pass.
Historical passes and failures, future evals, and unknown (absent, null or
invalid) iterations cannot supply current evidence. Without a current pass the
result remains `evidence_missing`, never `done`. Legacy checkpoints remain
readable without treating untagged evidence as current. Green checks bound to
each criterion and the audit disposition gates remain required.

A criterion may carry `proof: 'check' | 'judgment'`. Absent means `judgment`,
so legacy states assemble with the same digest; assembly rejects any other
value. A `check` criterion needs no D5 pass. Instead, every bound check id
needs at least one run in the current iteration, and every current run of it
must be green; a current failing eval still vetoes. Each `AuditCheck` may
therefore carry `iteration?: number | null`, with the same meaning, attachment
and scoping as `AuditEval.iteration`. Historical, future and unknown iterations
cannot settle a `check` criterion, so green checks retained from before an
audit fix cannot complete the goal. Untagged checks keep their existing role
for `judgment` criteria. Assembly does not admit
proofs. The goal slice is policy-supplied state like `check_ids`, and the
observation owner must copy the implementation step's admitted `proofs`
(`admitCriterionProof`), never a proposed value.

The current iteration is the one in the checkpointed observation, not the
audit round number. Iteration and evals are captured and recovered together;
explicit pause resumption captures a fresh observation. Existing live-revision
guards reject stale observations before completion.

## Inference terms

Audit generation always requests `tier:'strong', audit:true`. D6 requests
`tier:'decision'` and strips `audit` from caller terms, preserving every other
term apart from the tier override. The audit purpose applies only to generation.

## Request identity

Generation and D6 derive request ids from the execution id, round and purpose
(`audit` or `dispose`), plus the resumption entry number when resuming a pause.
Short ids are `<execution>:r<round>[:e<entry>]:<purpose>`. A fresh resumption
gets a distinct entry suffix; crash recovery within it keeps the same suffix.
When the full id would exceed 128 characters, the execution portion becomes a
bounded readable prefix plus the full SHA-256 digest of the execution id. The
round, resumption and purpose suffix remains readable. Both ids pass correlation
validation before dispatch. Shared execution prefixes cannot erase the remaining
identity, and exact replay derives the same ids.

Request ids are correlation labels, not gateway idempotency or outcome-cache
keys. Each gateway invocation executes a new bounded attempt loop. Reusing an
id with a different prefix digest or findings therefore requests a fresh
outcome. Prefix-cache metadata affects pricing only; it does not cache answers.
No state digest is added to request ids on this basis.

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
the same round. Resumption observes availability again before proceeding.
Authority blocks remain terminal and no pause confers a grant or bypasses D4/D7.
D6 outage retains its `needs_human` fallback.

## Resume and recovery

Every explicit resume of a persisted pause captures live state, revision, and
budget before proceeding, unless the live budget port still pauses the loop; it
replaces the paused observation. A checkpoint's optional `resume_from` binds
that capture to the pause entry. Recovery of that
same resumption reuses its durable capture, accepted report, and D6 disposal,
so a crash before round append does not repeat completed inference. A previous
report may be retained only when both the disclosed-state digest and revision
are unchanged. Changed inputs receive a distinct request id; recovery keeps it
stable. Legacy checkpoints without `resume_from` are refreshed on resume.
An unpaused mid-round revision change still stops as `needs_human`.

An aborted signal returns `cancelled` without further checkpoint or round
appends, inference, or D6 dispatch. The returned cancellation is not durable;
recovery starts from the last write completed before abort. A report or D6 result
durably checkpointed before abort is reused; an outcome received after abort is
not checkpointed. A gateway-reported cancellation without an aborted signal
remains a recorded pause requiring explicit resume. Terminal round replay calls
neither gateway port and writes nothing, including when `resume: true`.

The composition root must hold exclusive ownership for the whole execution,
including observation, checkpoints and append: two concurrent resumes must be
serialized before entering `runAuditLoop`, then reload the journal. There is no
lock or compare-and-swap in `AuditJournal`; `MemoryAuditJournal` is not a
cross-process lock. Production journals must commit checkpoints and appends
atomically and durably, deduplicate ids, and recover torn storage before append.
The audit loop has no grants and dispatches no fixes; the observation owner must
reconcile fix effects and never replay a single-use grant. There is no exactly-once
provider guarantee for a crash between provider completion and the durable
checkpoint: request-id reuse alone cannot prevent another charge. Any external
reconciliation belongs to the inference port; the current gateway does not
implement an outcome cache or idempotency protocol.

## Pause precedence

After generation, cancellation takes precedence, followed by gateway or live
budget pauses, then the live-revision guard. A budget pause coinciding with a
state change stays resumable; the next resume captures fresh input. Without a
pause, a revision change still stops as `needs_human` before D6. The final
revision guard after D6 remains unchanged.
