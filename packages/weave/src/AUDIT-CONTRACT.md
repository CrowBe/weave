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
