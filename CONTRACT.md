# Contract index

Weave's contracts live beside their owning subsystem. The architecture and
milestone documents explain how those contracts compose; they do not authorize
execution or replace deterministic evidence.

- [Audit state and bounded compaction policy](packages/weave/src/AUDIT-CONTRACT.md):
  `view.audit@1`, authorized slices, omissions and digest.
- [Decision sites and audit loop](packages/weave/src/sites/CONTRACT.md):
  D1–D8 observation admission, D6 disposition and deterministic stop outcomes.
  D3 `decision.preselect` policies accept only configured `typesafe-jev` or
  `amos` ids; other ids, including `openai-decisions`, are config errors.
- [Weft records](packages/weft/src/WEFT-CONTRACT.md): `weft.record@1`
  envelope, kinds, links, evidence and fail-closed validation
  (`@weave/weft`, `validateRecord`), and the `weave.trace@1` JSONL tree
  envelope it still supports: redaction and idempotent importer port
  (`validateTrace`, `serializeTrace`, `importTraceLines`).
- [Gauge evaluation](packages/gauge/src/GAUGE-CONTRACT.md): criteria sets,
  case sets, evaluation results, comparisons and failure attributions with
  recomputed verdicts (`@weave/gauge`, `validate`).
- [M7 decision loop](docs/m7-decision-loop.md): audit report, loop-back,
  deterministic completion evidence, budget and authority boundaries.

An `AuditReport.goal_met_claim` is an observation only. Completing a goal
requires deterministic evidence for every success criterion, green checks,
passing D5 evaluations and an audit with no `fix_now` disposition. A decision
answer cannot mint a grant or override the routed tier ceiling.
