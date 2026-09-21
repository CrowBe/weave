# M3 — Fill one capability gap

This is the behavioral contract for the fourth milestone in
[ARCHITECTURE.md §10](../ARCHITECTURE.md). It extends
[M0](m0-inspect-and-report.md) with one transformation the catalogue cannot
supply. Terms follow [CONTEXT.md](../CONTEXT.md). The checks below are
transcribed as `packages/weave/test/m3.test.ts` and
`packages/agentfabric/test/lifecycle.test.ts`. An offline run of the same
fixture is `npm run example:crystallize`.

## 1. Outcome and scope

The inspect-and-report goal needs a fold of inspection digests. No admitted
capability performs that operation, and none produces the same output type.
Weave searches, establishes a contract, validates a corpus, demonstrates red
against a placeholder, generates implementations only after that red, proves
green inside isolation, and requests admission. A person admits. A later cycle
issues a separate execution grant and finishes the report.

M3 proves:

- Search distinguishes reuse, composition, and a gap. A retained procedure may
  inform the search. It is not an implementation and cannot admit or dispatch.
- Contract establishment, corpus validation, demonstrated red, implementation
  generation, proven green, and admission stay in that order. Visible and
  held-out corpus proposals run concurrently. Implementation proposals run
  concurrently. Later gates do not.
- Generated source runs only after an isolation probe. Unsupported isolation
  blocks red and leaves execution counts at zero.
- Held-out cases stay out of the implementer view and out of green
  observations. A green observation carries pass and fail counts only.
- The held-out split is spent when the first prove-green starts. A later
  implementation cannot attach. An implementation already attached may still
  be scored. There are no feedback rounds.
- Admission installs the capability and does not issue an execution grant.
  Forged or untrusted admission observations are rejected. The fold runs only
  under a grant issued at dispatch.
- A contract revision invalidates corpus, red, green, and a pending admission.
  Revocation makes an in-flight fold fail and leaves the goal incomplete.
- Replay reconstructs the run from the log without the author, the lifecycle,
  the decision layer, or the host.

No live model is required. The extension author and the decision layer are
scripted. Isolation is a real child process.

## 2. Fixture

M0's in-memory sources stay. Gamma remains registered and prohibited.
Publication stays M1's. Framing stays M2's. A goal with `gap` selects
`crystallize_and_report@1` ahead of framing or a destination.

### Goal

```text
Goal {
  goal_id:           "g-report-fold"
  purpose:           "Produce a checked report that includes a fold of the inspections"
  sources:           [source:alpha, source:beta]
  authority:         { read: [source:alpha, source:beta] }
  gap:               report.fold, output { fold: string }, variants [direct, aliased]
  retained_procedure: "Sort inspection rows by source … This text is not an implementation."
  budget:            { actions: 32, judgments: 32 }
  success_evidence:  a report covering every goal source and a fold bound to those inspections
}
```

### Capability

`report.fold` revision `r1` takes inspection rows and returns one string.
Effects and permissions are empty. Failures are `empty_input` and
`invalid_inspection`. The canonical digest sorts `source=digest` lines, joins
them with `|`, and prefixes `fold`. Example:
`fold|source:alpha=a|source:beta=b`.

`report.assemble` is unchanged. The fold is a separate artifact bound to the
current inspection source, revision, and digest. Success evidence requires
that binding plus M0's report.

### Author

The scripted author proposes the contract, the visible cases, the held-out
cases, and two source strings (`direct` and `aliased`) that compute the same
digest under different names. Corpus expectations are derived from the
canonical function. The implementation strings are separate and run only
inside isolation. Held-out inputs include the marker `held-digest-unique`.

## 3. Gates

Cycle 1 forms both inspects and `gap.search`. Scripted weights keep inspects
ahead of search and keep the crystallization steps ordered.

| Step | When it becomes a candidate | Concurrency |
| --- | --- | --- |
| `gap.search` | No search result yet | With the inspects |
| `contract.establish` | Search status is `gap` | Alone |
| `corpus.propose` | Contract exists and that split is empty | Visible and held-out together |
| `corpus.validate` | Both splits exist | After both proposals |
| `red.demonstrate` | Corpus is validated and red is not demonstrated | After validation |
| `implementation.generate` | Red is demonstrated and the variant is not attached | Variants together, until held-out is spent |
| `green.prove` | That variant is attached and not yet scored | Per attached variant |
| `admission.request` | Some variant is proven and admission is absent | Prefers `direct` |
| `report.fold` | Admission is `admitted`, or search is `reusable`, and inspections are current | After the grant |
| `report.assemble` | The fold is bound | After the fold |
| `goal.complete` | The report covers the sources and the fold is bound | After assemble |

Search status `composed` records the match and forms no contract. Search
status `reusable` skips contract, corpus, red, and the author, then folds
under a grant. A revoked capability forms no further fold.

Sync lifecycle results are queued as host-sourced `action.result` observations
and pumped one per microtask, so the next cycle sees one result. Async red,
green, and fold complete through the host ingress. Replay feeds those results
and does not re-execute them.

While admission is `requested` and nothing is running, the cycle outcome is
blocked with reason `awaiting admission`.

## 4. Isolation

Before any generated source runs, the lifecycle probes a child process:

```text
node --permission --allow-fs-read=<isolate-worker>
env: {}
```

The probe must observe filesystem `ERR_ACCESS_DENIED`, child-process spawn
denied, canary `WEAVE_ISOLATION_CANARY` absent, and `process`, `require`, and
`fetch` undefined inside the `vm` context. User source is compiled with
`codeGeneration: { strings: false, wasm: false }`. Case input is injected with
`JSON.parse` inside that context. The child receives `{ id, input }` only.
Expected outputs are not sent. The worker exits through the `process.send`
callback so the report flushes before exit.

`isolation: 'unsupported'` returns the probe as unsupported and never falls
back to in-process evaluation. `execute_runs` and `probe_runs` stay 0.

The Node permission model on this toolchain does not expose a network deny
flag. The evaluated context has no network API. That is the network boundary
this milestone claims.

## 5. Held-out evidence

Validation rejects contradictory cases for the same input, a dropped held-out
case, and a rewritten held-out expectation. The implementer view returns
visible cases and the retained procedure text.

Green observations expose `{ passed, failed }` for each split. They have no
`cases` key and no held-out marker. The lifecycle audit retains held-out ids
and the execution count.

The split is spent synchronously when the first `proveGreen` starts.
`attachImplementation` after that returns `held-out evidence spent` unless
that implementation id was already attached.

## 6. Admission, invalidation, and revocation

`requestAdmission` records a pending request bound to the implementation id
and evidence digest. Evidence binds contract revision, corpus revision, source
digest, isolation report id, pass and fail counts, and demonstrated red.

`admit` installs the contract through the host and does not put a grant in
its output. Operator provenance for `admission.decided`,
`implementation.revoked`, and `evidence.invalidated` is an opportunity notice.
An observation that claims operator origin through ordinary `observe` is
rejected. A test-sourced admission is rejected. The runtime methods
`admitCapability`, `revokeCapability`, and `invalidateEvidence` are the
operator path.

A semantic change at the same revision is rejected. A new revision revokes a
previously resolved capability and clears corpus, red, green, and admission.
The fold is not dispatched.

`revoke` deletes the live contract and implementation and sets resolution
`unavailable`. An in-flight invocation finishes `UNRESOLVED`. The goal stays
`active`. A historical contract remains inspectable and does not authorize
execution.

`report.fold` is described for prefetch only when admission is `admitted` or
search is `reusable`. Describing it earlier would make replay diverge.

Grants are identity-checked. A traced grant is a clone, so issuance is shown
by the host invocation record for that action, not by asking whether the
clone is still in the authority set. The host rejects a copied grant.

## 7. Required deterministic checks

| ID | Scenario | Required evidence |
| --- | --- | --- |
| M3-T01 | Full gap path with two corpus splits and two implementations | Procedure `crystallize_and_report@1`; inspects and search in cycle 1; corpus proposals share a cycle; implementation proposals share a later cycle; red precedes generation; placeholder digest differs from both sources; admission precedes the fold; the fold grant names `report.fold` `r1` with empty permissions; the host invocation matches that action; `admission.decided` contains no grant; the goal completes with a bound fold. |
| M3-T02 | Stop at admission requested | Search status is `gap` and `informed_by` says the retained text is not an implementation; no fold starts; resolution is `unresolved`; `invoke` without a grant is rejected; invocation count is the inspects only. |
| M3-T03 | Held-out protection | Implementer views omit `held-digest-unique`; green outputs omit it and have no `cases` key; audit ids are `hold-three`, `hold-one`, `hold-blank`; held-out executions are 6. |
| M3-T04 | Unsupported isolation | Red fails with isolation unsupported; no implementation is generated; `execute_runs` is 0; the goal stays active. |
| M3-T05 | Red before generation | No `implementation.generate` candidate exists in a cycle whose state revision is before the red result. |
| M3-T06 | Admission is not a grant | Forged operator observe and test-sourced admission are rejected; `admitCapability` resolves the capability; the later fold grant is a different object from the decision payload. |
| M3-T07 | Revision invalidates evidence | `r2` clears contract and admission; no accepted `admission.decided`; a stale admit is rejected; no fold starts. |
| M3-T08 | Revoke an in-flight fold | After admit, revoke, release, and settle: the fold action is failed, the goal stays active, resolution is `unavailable`, and a later invoke is rejected. |
| M3-T09 | Lifecycle corpus, isolation, and revision rules | Contradictory cases fail validation; dropped or rewritten held-out cases are rejected; the probe blocks filesystem, child process, and credentials and does not mount held-out expectations; green counts have no case bodies; a late attach is spent; unsupported mode does not run; admission output has no grant and `invoke(null)` does not increment invocations; a same-revision semantic change is rejected; `r2` invalidates a pending admit. |
| M3-T10 | Held-out spent | Both attached variants are scored; a third attach is refused as spent; only two generations started. |
| M3-T11 | Replay | Replayed goal completes with the same fold; replay host invocations stay 0; author call count and `execute_runs` do not change. |
| M3-T12 | Reuse | An established `report.fold` makes search `reusable`; contract, corpus, and red do not start; the author is not called; the fold still receives a grant. |
| M3-T13 | Composition | An established `digest.pack` with the same output type makes search `composed` naming `digest.pack`; no contract and no fold start; `report.fold` stays unresolved; the goal stays active. |

## 8. Assumptions recorded

- The extension author is scripted. A model-proposed contract or
  implementation would enter through the same lifecycle gates; this milestone
  does not add that generator.
- Isolation is a Node permission-constrained child plus `vm`. Hosts without
  that permission model must select `unsupported` and block execution. Network
  denial is the absence of network APIs in the evaluated context.
- Held-out feedback is closed for this milestone: counts only, zero rounds,
  split spent once scoring starts.
- Opportunity notices are the operator observations `admission.decided`,
  `implementation.revoked`, and `evidence.invalidated`. They are not a fourth
  payload type.
- Composition records a type match. It does not authorize the other capability
  to stand in for `report.fold`.
