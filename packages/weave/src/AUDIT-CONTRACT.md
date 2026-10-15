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

## Context compaction port

`compactContext` uses an explicit token sequence and context capacity supplied by
its caller; it does not tokenize or infer. At 80% capacity it asks an optional
summarizer port to summarize the prefix, capped at 10% of capacity, retaining
the last 5% of capacity as exact ordered token strings. Without a summarizer it
returns `summary_needed` with the retained tail and prefix, so composition can
persist and schedule summarization. Below the threshold no summarizer runs.
An oversized summary is rejected instead of truncated through a token boundary.
The caller owns crash-safe persistence before replacing original context.
