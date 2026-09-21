# M3 — Fill one capability gap

This is the behavioral contract for the milestone in
[ARCHITECTURE.md §10](../ARCHITECTURE.md). It extends
[M2](m2-handle-a-novel-request.md). Terms follow
[CONTEXT.md](../CONTEXT.md). The checks below are requirements, not claims of
implemented behavior. Demonstrate red before implementation and retain the
M0–M2 checks when proving green.

## 1. Outcome and scope

The fixture report needs one pure transformation the catalogue cannot supply.
Weave searches the catalogue for reuse or composition, records a capability
gap when none fits, and crystallizes `text.normalize` through contract,
validated corpus, demonstrated red, isolated execution, proven green, and
explicit human admission. A separate execution grant then lets the goal finish
the report. Admission does not publish and does not authorize execution.

M3 proves:

- Composition is considered before a gap is declared. A type match alone does
  not establish usefulness; the fixture search is an exact purpose, closed
  shapes, and an empty effect set, so the check is deterministic.
- Crystallization begins with the contract. No corpus, test, or implementation
  artifact is accepted before that contract observation.
- Demonstrated red is recorded before implementation generation is requested.
- Generated tests and generated implementations run only on the untrusted
  execution tier. A function supplied to the host is not an implementation.
  Missing isolation is `RESOLVER_UNAVAILABLE`, not trusted execution.
- A held-out report returns counts and failure codes only. One report is
  available per implementation revision; another request spends the split.
- Proven green is bound to the contract, corpus, implementation, and
  isolation-report revisions. Changing any of them invalidates it.
- Admission, the execution grant, and authority to publish remain separate.
  Revocation stops further invocation and does not open a fresh gap for the
  same operation while its contract still exists.
- A retained procedure may be cited by a proposal. It is not admission
  evidence and cannot skip red or green.

No general experiment platform, multi-implementation router, or control-core
release is required. Fixture generators are enough for the gating suite.

## 2. Fixture

Keep the M0 sources and the M1 publication path. Gamma stays prohibited.
`text.normalize` collapses internal whitespace and trims. Its contract:

```text
CapabilityContract {
  id:          "text.normalize"
  revision:    "r1"
  purpose:     "Collapse whitespace in one text value"
  input:       { text: string }
  output:      { text: string }
  effects:     []
  permissions: []
  failures:    []
  depends_on:  []
}
```

No fixture contract's purpose and shapes compose into that operation.
`source.inspect` still reports the raw source. The normalized report is a
recorded composition — inspect, then `text.normalize` on each inspection's
text, then assemble — selected as data. Adding an arm to the runtime's
procedure union is a control-core edit and does not satisfy this milestone.

A retained procedure is a text artifact in state. It may name
`text.normalize`. It has no resolution status and no execution grant.

## 3. Gates

The gates stay in this order. Independent corpus cases may be authored
concurrently. Implementation generation may propose more than one candidate
concurrently after red. None of that reorders the gates.

1. Search reuse and composition. Record either a match or a capability gap.
2. Establish the contract. Later artifacts name its revision.
3. Validate the corpus against the contract and known examples. Contradictions
   reject the corpus rather than instructing an implementer.
4. Demonstrate red on a placeholder or known-invalid implementation. Record it
   before any implementation generation request.
5. Produce an isolation report. Without one, do not start a generated test or
   implementation.
6. Prove green inside that isolation, including the held-out split.
7. Request admission. An operator ingress observation admits; a model
   judgment does not.
8. Issue an execution grant for the goal's use of the admitted implementation.
   The grant is not part of the admission record.

## 4. Held-out report

Visible development tests are what an implementer may read. The protected
split is not. After the split is drawn, corpus authors do not receive its
cases either.

```text
HeldOutReport {
  passed:  integer
  failed:  integer
  codes:   [FailureCode]
}
```

The report has no case identity, input, expected output, diff, or artifact
body. One report is returned per corpus revision and implementation revision.
A second request for that pair records the split as spent, refuses further
implementation generation for that corpus revision, and cannot be cited as
admission evidence. A new corpus revision draws a new split; it does not
refresh a spent one.

## 5. Execution tier

Trusted fixture operations remain host-owned. Generated tests and generated
implementations are untrusted. The host already discards a function passed to
`registerImplementation` and leaves a non-builtin contract unresolved; M3
keeps that refusal.

An untrusted run requires an isolation report recorded before the process
starts:

```text
IsolationReport {
  tier:              untrusted
  network:           none
  filesystem:        none
  credentials:       none
  held_out_mounted:  false
  broker:            resolver-context
  limits:            { memory_bytes, cpu_ms }
}
```

The child receives a broker, not the host's in-process resolver context.
Resource operations are checked against the invocation grant. An unbound
context does not read or write. If the host cannot produce the report, it
does not start the child and the attempt is `RESOLVER_UNAVAILABLE`.

## 6. Evidence and revocation

Admission evidence names the contract revision, corpus revision, red
observation, green observation, isolation report, approver, and provenance.
Green evidence does not survive a change to any of those revisions.

Revocation sets resolution to `unavailable`, retains the contract for
historical inspection, and rejects invocation. Candidate formation treats it
as unavailable. It does not describe the operation as unknown and does not
open a second gap for the same id.

Replay reconstructs the milestone from the log. It does not run generated
code, the gateway, or admission.

## 7. Required deterministic checks

Use fixture generators, an isolation double that can withhold its report, and
injected ticks. Do not sleep on the wall clock. Retain every M0–M2 check.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| M3-T01 | Catalogue already contains an exact `text.normalize` contract that is resolved | No gap is recorded; no contract, corpus, or implementation generation starts; the goal uses the existing implementation under an execution grant. |
| M3-T02 | No contract composes into `text.normalize` | A capability gap is recorded only after the search; the contract observation precedes every corpus, test, and implementation artifact. |
| M3-T03 | Corpus validation, then a placeholder implementation | Red is recorded before any implementation generation request. A contradictory corpus is rejected and does not become instructions. |
| M3-T04 | Generated test and implementation offered as host functions, with and without an isolation report | The function is never called. Without a report the result is `RESOLVER_UNAVAILABLE`. With a report, the child runs and the report shows no network, filesystem, credentials, or held-out mount. |
| M3-T05 | Implementer requests held-out results twice for one implementation revision | The first response is a held-out report with counts and codes only. The second spends the split, refuses further generation for that corpus revision, and cannot support admission. |
| M3-T06 | Green evidence, then a contract or corpus revision change | The recorded green evidence no longer admits the implementation. A new green run is required. |
| M3-T07 | Human admission, then the goal's use of `text.normalize` | Admission does not include an execution grant. The goal's invocation carries a separate grant. A revoked implementation is refused, remains historically describable, and does not open a new gap. |
| M3-T08 | Retained procedure text names `text.normalize` before admission | The proposal may cite it. It is not `resolved`, not invocable, and does not skip red or green. |
| M3-T09 | Two corpus cases authored concurrently, and two implementation candidates after red | Their observations may interleave. Implementation generation requested before red is rejected. Admission requested before green is rejected. |
| M3-T10 | Replay the crystallized run | Replayed observations match. Generated code, the gateway, and the host invocation count stay at zero during replay. |

Package-direction checks stay as in M2. Record demonstrated red and green
against the exact contract, tests, and implementation revisions.

## 8. Assumptions recorded

- The fixture search is exact, so M3 does not need a semantic-matching
  judgment site. A later milestone may add one; its output remains an
  observation.
- The composition that uses `text.normalize` is a recorded procedure, not a
  new `ProcedureId` in the runtime.
- One held-out report per implementation revision is the whole iteration
  budget. There is no second, richer disclosure.
- The isolation double in the gating suite must be able to fail closed. A
  passing label without the report fields does not count.
