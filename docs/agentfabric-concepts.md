# AgentFabric: concepts to carry, surface to build

Weave is not constrained to the existing
[CrowBe/AgentFabric](https://github.com/CrowBe/AgentFabric) repository. That
repository is a conceptual reference: it worked out a set of ideas about
governed capabilities that support Weave's goals, and it worked them out in a
form (trusted local Python, a `.fabric/` directory, CLI and MCP bindings) that
Weave does not need. This document records which ideas carry over, which do
not, what Weave adds, and how the result becomes an in-repo surface.

The decision: **reimplement the useful parts as `agentsop` and `agentfabric`
packages in this repository, in Weave's toolchain, from the contract outward.**
No code is vendored. The external repository's contract text and tests remain
useful as behavioral references to read, not sources to port.

## 1. Why these ideas matter to Weave

[VISION.md](../VISION.md) asks for capabilities that carry a stable contract,
declared effects, explicit authority, and evidence-based trust, so that
generated software can be admitted without the runtime having to trust it. The
external AgentFabric was built for a different loop (a model-centred harness
calling named operations) but arrived at the same boundary conditions. Its
useful content is a set of invariants about what a capability contract says and
what a runtime must check before, during, and after invocation. Those invariants
are what [ARCHITECTURE.md §7](../ARCHITECTURE.md) needs the capability host to
enforce.

## 2. Concepts to carry

Each entry names the concept, why it supports Weave, and where it lands.

### Contract and identity

- **The contract is durable; the implementation is disposable.** A capability
  document has a stable id and meaning; the code behind it can be replaced
  freely. This is CONTEXT's *capability* / *implementation* split and the basis
  for several implementations per contract. → `agentsop`
- **Name the operation, never the implementation.** `text.word_count`, not
  `run_wc`. Weave already requires this for inference-backed capabilities
  (`text.classify`, not `request_text_classification`). → `agentsop`
- **Typed, closed input and output.** Schemas reject unexpected fields rather
  than ignoring them; unexpected keys on any surface are rejected. Closed shapes
  are what make generated tests and static checks meaningful. → `agentsop`
- **Resolution status is not part of the document.** A contract can exist with
  no implementation; whether one is bound is a runtime fact. This is exactly the
  state Weave needs for "contract established, red demonstrated, implementation
  pending". → status lives in `agentfabric`; the rule that it is not a document
  field lives in `agentsop`
- **Change a document only when meaning changes; a breaking change is a new
  id.** Contract revisions are how Weave binds evidence; silent drift would
  invalidate evidence without saying so. → `agentsop`

### References, locators, and authority

- **Knowing a locator ≠ possessing a reference ≠ having authority.** Resources
  are referred to by opaque, host-issued handles with a coarse `kind`. Paths,
  URLs, and tokens never appear in contract inputs or outputs. This is the
  mechanism behind ARCHITECTURE §7's "no ambient session or state access" and
  the reason a brokered resolver context can be serialisable. → shape in
  `agentsop`; issuance and the locator table in `agentfabric`
- **Introducing a reference is a distinct effect.** Only `discover` and
  `create` bring a resource into a caller's reachable world; a transformation
  cannot mint a reference from something it learned internally. Output
  references are validated as issued and kind-correct, else the implementation
  has failed. → `agentsop` rule; `agentfabric` check
- **Authority selectors on the contract.** The document names which input
  fields are references the caller must be authorized on, and which effects must
  be granted. A write-declaring capability cannot authorize as read-only: the
  declared effect set and the authorized effect set must be equal. → `agentsop`
- **Grants are principal × capability × resource × effects.** Wildcards are
  explicit authority, not defaults. A grant is checked at invocation, not only
  at registration. → grant shape and matching in `agentsop`; host-side validation
  and enforcement in `agentfabric`; goal policy, approval and per-action execution
  grant issuance in Weave
- **Failure precedence protects existence.** Reference well-formedness is
  checked first, then authority, then existence and kind. An unauthorized caller
  sees the same `DENIED` for an issued and an unknown handle, so references are
  not an existence oracle. → `agentsop` (the order is contract)

### Effects

- **A closed, versioned effect vocabulary.** `discover`, `read`, `create`,
  `write`, `append`, `delete`; pure transformations declare `[]`. Adding an
  effect is a contract revision, not an ad hoc string. Weave's effect locks and
  reservations (ARCHITECTURE §5) depend on effects being enumerable. → `agentsop`
- **Delete is not write.** Deletion cannot masquerade as replacement; after
  delete the handle is unknown and the capability returns a receipt, not the
  retired handle. → `agentsop`
- **Idempotent is a semantic property, not a replay promise.** The document may
  say repeating equivalent input has the same kind of result; that does not
  commit the runtime to a replay cache. ARCHITECTURE §5 keeps the same
  separation between declared guarantees and mechanisms the adapter actually
  supports. → `agentsop`

### Invocation pipeline

The external runtime checks, in order: contract exists → input validates →
references extracted → grants match → references exist and kinds match →
resolution status is `resolved` → implementation runs with a bounded context →
output validates → output references are issued. Every step has a stable
failure code. Weave keeps this pipeline and adds an execution grant check ahead
of it (§4). → `agentfabric`

- **Failure codes are contract; messages are not.** `UNKNOWN_CAPABILITY`,
  `UNRESOLVED`, `RESOLVER_UNAVAILABLE`, `DEPENDENCY_BLOCKED`, `DENIED`,
  `UNKNOWN_RESOURCE`, `INVALID_INPUT`, `INVALID_REF`, `KIND_MISMATCH`,
  `DEPENDENCY_FAILED`, `UNDECLARED_DEPENDENCY`, `RESOLVER_ERROR`,
  `INVALID_CATALOGUE`. Callers branch on codes, never on text. Weave's action
  records need exactly this to classify failures deterministically. → `agentsop`
- **Resolution states align with failure codes.** `resolved`, `unresolved`,
  `unavailable` (was bound, cannot run), `blocked` (a dependency is not
  resolved). Distinguishing "never implemented" from "implementation broke"
  from "dependency missing" is what maturity regression and revocation report
  on. → `agentfabric`, codes in `agentsop`

### Composition

- **Declared dependencies are an allow-list.** An implementation may invoke
  only the capabilities its contract lists in `depends_on`; anything else is
  `UNDECLARED_DEPENDENCY`. Nested invocations run as the same principal and
  cannot widen authority or mint references. This is ARCHITECTURE §7's "nested
  work is bounded by the goal, caller, contract, and granted resources". →
  rule in `agentsop`; enforcement in `agentfabric`
- **The catalogue graph is validated at load.** Every dependency exists and the
  graph is acyclic; an invalid catalogue fails before use. → `agentsop` rules;
  `agentfabric` load

### Observability and gap evidence

- **Audit is protected data, separate from the result.** Invocation records are
  not capability output and are not exposed through capability grants; a
  failure to persist audit does not alter a determined result. In Weave the
  record becomes an observation with provenance, and the disclosure rule
  survives as policy on state views. Required execution evidence must be durable
  before new consequential dispatch; failure to record a committed outcome requires
  reconciliation, not repetition of its effect. → `agentfabric`
- **Machine-readable opportunity notices.** Unresolved invocations, fallback
  use, and repeated implementation-level work are recorded with a stable
  signature, deduplicated, and closed when the capability resolves. This is the
  seed of Weave's *capability gap* records: evidence of recurring need that the
  extension workflow consumes rather than rediscovers. → `agentfabric`
- **Capability / skill / fallback is a useful triage.** "If deciding the output
  needs a paragraph of reasoning, it is not a capability." Weave keeps the
  distinction as established capability, operating strategy, and frontier
  inference, and keeps the fallback outside the contract system entirely.

## 3. Concepts not carried

These are implementation choices of the external repository, or assumptions
Weave's vision rejects. They are recorded so nobody reintroduces them by habit.

- **Trusted local Python loaded with `exec`.** Weave generates implementations;
  generated code cannot run with the host process's ambient authority.
- **A resolver context that exposes `locator(ref) -> Path` and `workspace`.**
  Any implementation holding a real path has ambient authority and the contract
  is no longer substrate-neutral. The context narrows to operations in contract
  vocabulary (§4).
- **One binding per capability, bound in a single privileged `crystallise`
  step.** Weave needs proposed / attached / admitted / revoked as distinct
  states with evidence at each, and several implementations per contract.
- **Principal privileges (`inspect`, `crystallise`, `fallback`) as the trust
  model.** Authority in Weave is per goal and per action, issued by policy at
  dispatch, not a static privilege list on a principal.
- **`.fabric/` layout, overlays, origin pins, and `sync`.** Local-vs-upstream
  ownership was a solution to distributing one catalogue to many clones. Weave's
  registry records provenance and maturity per contract and implementation
  instead.
- **CLI, MCP binding, Cursor hooks, and skills.** Bindings to external harnesses
  are not part of Weave's runtime. If Weave exposes capabilities externally
  later, that is an adapter over the capability host, not a concern of it.
- **The shell fallback.** A privileged escape hatch has no place inside the
  capability subsystem. Weave's equivalent is a frontier inference action under
  policy and budget, scheduled by Weave, not offered by the host.
- **The demo catalogue and `journal` domain.** Fixture capabilities live with
  the milestone that needs them.
- **Wall-clock timestamps in audit records.** Weave orders by sequence number
  and treats time as an observation.
- **A boolean `ok` result.** Weave's terminal outcomes include `uncertain`, and
  the host must be able to report an unknown effect outcome.
- **The JSON-Schema-specific subset.** Whether contracts are expressed in JSON
  Schema, the toolchain's native types, or both is decided with the toolchain.
  The rules (closed shapes, reference typing, selector validity) carry; the
  syntax does not.

## 4. What Weave adds

These were identified as missing when the external repository was assessed and
are required by ARCHITECTURE §7–§8. They belong in `agentfabric`, not in the
Weave loop.

1. **A narrow, brokered resolver context.** Operations only in contract
   vocabulary: `invoke(capability, input)` limited to `depends_on`, and
   `read`/`write`/`create`/`discover` over references. Because nothing in it is
   a path or handle to the host process, the context is serialisable and an
   implementation can run out of process while the host answers its calls.
2. **Execution grants issued per action.** Weave's policy issues a grant at
   dispatch naming the action, operation, contract revision, permissions, and
   effects; the host refuses an invocation whose grant is absent or does not
   match. The host validates trusted issuance and binding, not just serialized
   field equality; copied records do not convey authority. Admission never issues
   this grant. M0 checks shape; M1 proves trusted issuance and effect enforcement.
3. **An untrusted execution tier.** Process separation with no network, no
   filesystem, no credentials, resource and time limits, and no access to
   held-out artifacts, with context calls brokered. Unsupported isolation blocks
   untrusted execution rather than degrading to trusted.
4. **A lifecycle with evidence.** `propose(contract)`, `attach(implementation)`,
   `admit(evidence)`, `revoke(reason)`, with maturity that can regress. Evidence
   binds corpus revision, demonstrated red, proven green, isolation report,
   approver, and provenance to the exact contract and implementation revisions.
5. **Several implementations per contract.** Routing among them is Weave's
   choice, informed by recorded reliability and cost; the host reports which
   implementation ran.
6. **Inference as a declared dependency.** A generative implementation names
   inference in its contract with enforceable spending and disclosure limits;
   the gateway is supplied through the resolver context, so `agentfabric` never
   imports Weave.
7. **Revocation surfaced to the runtime.** Revoking an implementation blocks
   further invocation and is reported for pending and running work.
8. **Uncertain outcomes.** An interrupted effectful invocation reports
   `uncertain` with what is known, rather than success or failure.
9. **Stable invocation identity and reconciliation.** The host supports bounded,
   authorized cancellation and outcome lookup without repeating the effect. It
   normalizes transport and implementation failures and records late receipts.
   Weave retains unresolved effect reservations and owns recovery scheduling;
   AgentFabric reports execution facts without importing that scheduler.
10. **Historical contracts remain inspectable.** Retain immutable contract and
    implementation revision evidence needed for replay separately from current
    invocation eligibility. Historical access remains permission-scoped; retaining
    a revoked definition does not authorize its execution.

## 5. The in-repo surface

```text
packages/
  agentsop/     contract layer: no dependency on Weave or agentfabric
  agentfabric/  capability host: depends on agentsop only
  weave/        the runtime: uses agentsop types; reaches agentfabric only
                through the capability host interface
```

An import-direction check enforces these edges from the first commit that
creates the packages (M0-C1).

### `agentsop` owns

- Capability document shape: id, purpose, typed input and output, effects,
  authority selectors, dependencies, revision.
- Reference shape and well-formedness; the rule that outputs may only carry
  issued references.
- Effect vocabulary and its revision rule; effect-set equality between declared
  and authorized effects.
- Grant shape and matching; failure codes and their precedence.
- Resolver context shape (operations only, no substrate types).
- Catalogue graph rules: existence and acyclicity.
- Later, when a corpus is authored: the test-case shape (typed input, expected
  output or expected failure code).

### `agentfabric` owns

- Registry: contracts, implementations, maturity, provenance, reliability.
- Resolution status and the invocation pipeline with grant checks.
- Reference issuance and the locator table; the resource registry.
- Execution tiers: trusted in-process and untrusted isolated, behind one
  resolver context.
- Lifecycle operations and admission evidence; revocation.
- Audit records and opportunity notices, emitted to the runtime as
  observations.
- The capability host interface Weave consumes.

### What the external repository remains useful for

- `agentsop/EXPERIMENTAL-0.1.md` as a statement of the contract invariants in
  §2, to check the in-repo contract against.
- Its tests (`test_authority.py`, `test_composition.py`, `test_invoke.py`,
  `test_validation.py`) as behavioral specifications of failure precedence,
  dependency enforcement, output-reference validation, and closed shapes. Read
  them as specifications; write Weave's checks fresh in Weave's toolchain.

## 6. Milestone mapping

| Milestone | `agentsop` | `agentfabric` |
| --- | --- | --- |
| M0 | Capability document, reference and effect shapes, grant shape, failure codes, host interface | None. The fake host in Weave's tests satisfies the interface. |
| M1 | Authority selectors, effect-set equality, failure precedence, catalogue graph rules; invocation outcome/cancellation/reconciliation contract | Registry, resolution status, trusted grant validation, reference issuance, enforcing trusted tier, durable invocation identity and receipts, bounded outcome lookup, historical contract access, `uncertain` outcome |
| M2 | Inference declared as a dependency with limits | Resolver context supplies the gateway ([contract](m2-handle-a-novel-request.md)) |
| M3 | Test-case shape; contract revision rules; held-out report | Lifecycle with evidence, untrusted tier, held-out access separation, revocation, opportunity notices. The host store is the single writer of admission. [Contract](m3-fill-a-capability-gap.md). |
| M4 | — | Several implementations per contract; reliability and cost recorded per implementation. [Contract](m4-measure-reuse.md). |
| M5 | — | — (promotion is Weave's; the host reports which implementation ran). [Contract](m5-improve-an-operating-strategy.md). |
| H1 | — | Refuse a second runtime attaching to the same store. The log bound itself is Weave's. [Contract](h1-bound-the-log.md). |

[M1's contract](m1-publish-under-authority.md) fixes the publication adapter and
authority fixture. Its lookup/receipt support is distinct from Weave's recovery
policy. M1 needs current invocation eligibility checks; the generated-capability
admission and revocation workflow remains M3.

## 7. Assumptions recorded

- The external repository is not fetched, vendored, or depended on by any
  build step. If a concept here is later found to have been mis-stated, correct
  this document against the external contract text rather than importing code.
- The toolchain is TypeScript in an npm workspace. The package layout above is
  realised as `packages/agentsop` (`@weave/agentsop`) and `packages/weave`
  (`@weave/weave`); `packages/agentfabric` is created with M1.
- M0's `ResourceId` plays the role of a reference. Issuance and the separation
  of references from locators become enforceable in M1 when the host owns the
  locator table.
