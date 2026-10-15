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

## Inference terms

Audit generation always requests `tier:'strong', audit:true`. D6 requests
`tier:'decision'` and strips `audit` from caller terms, preserving every other
term apart from the tier override. The audit purpose applies only to generation.

## Request identity

Generation and D6 derive request ids from the execution id, round and purpose
(`audit` or `dispose`). Short ids remain `<execution>:r<round>:<purpose>`.
When that would exceed 128 characters, the execution portion becomes a bounded
readable prefix plus the full SHA-256 digest of the execution id. The round and
purpose suffix remains readable. Both ids pass correlation validation before
dispatch. Shared execution prefixes cannot erase the remaining identity, and
exact replay derives the same ids.

Request ids are correlation labels, not gateway idempotency or outcome-cache
keys. Each gateway invocation executes a new bounded attempt loop. Reusing an
id with a different prefix digest or findings therefore requests a fresh
outcome. Prefix-cache metadata affects pricing only; it does not cache answers.
No state digest is added to request ids on this basis.

## Recovery and cancellation

The audit journal keys phase checkpoints by execution and round. A checkpoint
pins the disclosed observation and, once accepted, its report. Recovery after
the report checkpoint and before D6 reuses that report without another paid
generation, and requests a fresh D6 disposition for those recorded findings.
It never substitutes current findings into an older checkpoint. If the live
revision has changed, admission stops as `needs_human` before D6. An observation
paused at its budget ceiling is not checkpointed; resume observes current state
and requests fresh outcomes. Terminal round replay calls neither gateway port.

An aborted signal returns `cancelled` without further checkpoint or round
appends. The returned cancellation is not durable; recovery starts from the
last write completed before abort. A report durably checkpointed before abort
is reused, while an outcome received after abort is not checkpointed. A
gateway-reported cancellation without an aborted signal remains a recorded
pause requiring explicit resume. The composition root owns durable storage and
one writer per execution. There is no exactly-once provider guarantee for a
crash between provider completion and the durable report checkpoint; request
id reuse alone cannot prevent another charge in that window.

## Context compaction port

`compactContext` uses an explicit token sequence and context capacity supplied by
its caller; it does not tokenize or infer. At 80% capacity it asks an optional
summarizer port to summarize the prefix, capped at 10% of capacity, retaining
the last 5% of capacity as exact ordered token strings. Without a summarizer it
returns `summary_needed` with the retained tail and prefix, so composition can
persist and schedule summarization. Below the threshold no summarizer runs.
An oversized summary is rejected instead of truncated through a token boundary.
The caller owns crash-safe persistence before replacing original context.
