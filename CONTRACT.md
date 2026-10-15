# Contract index

Weave's contracts live beside their owning subsystem. The architecture and
milestone documents explain how those contracts compose; they do not authorize
execution or replace deterministic evidence.

- [Audit state and bounded compaction policy](packages/weave/src/AUDIT-CONTRACT.md):
  `view.audit@1`, authorized slices, omissions and digest.
- [Decision sites and audit loop](packages/weave/src/sites/CONTRACT.md):
  D1–D8 observation admission, D6 disposition and deterministic stop outcomes.
- [Versioned trace ingestion](packages/agentsop/src/TRACE-CONTRACT.md):
  JSONL tree schema, redaction and idempotent importer port.
- [M7 decision loop](docs/m7-decision-loop.md): audit report, loop-back,
  deterministic completion evidence, budget and authority boundaries.

An `AuditReport.goal_met_claim` is an observation only. Completing a goal
requires deterministic evidence for every success criterion, green checks,
passing D5 evaluations and an audit with no `fix_now` disposition. A decision
answer cannot mint a grant or override the routed tier ceiling.
