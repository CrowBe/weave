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

Text is bounded by UTF-8 bytes without splitting a code point. Goal and criterion
statements, plan intents, and open-issue text retain a prefix of at most 4096
bytes each. Decision `site`, `question_id`, and non-null `choice` fields retain
at most 240 bytes each, matching the artifact summary cap. Empty strings and
null choices are preserved. Items and their order are preserved; identifier
fields and probability-map keys are retained unchanged. Each shortened field
records `goal:statement_cap`, `criterion:<id>:statement_cap`,
`plan:<step_id>:intent_cap`, `decision:<zero-based-index>:<field>_cap`, or
`issue:<id>:text_cap`, respectively. Omission markers are sorted and
de-duplicated. The digest is computed after all text bounds and omissions.

## Context compaction port

`compactContext` uses an explicit token sequence and context capacity supplied by
its caller; it does not tokenize or infer. At 80% capacity it asks an optional
summarizer port to summarize the prefix, capped at 10% of capacity, retaining
the last 5% of capacity as exact ordered token strings. Without a summarizer it
returns `summary_needed` with the retained tail and prefix, so composition can
persist and schedule summarization. Below the threshold no summarizer runs.
An oversized summary is rejected instead of truncated through a token boundary.
The caller owns crash-safe persistence before replacing original context.
