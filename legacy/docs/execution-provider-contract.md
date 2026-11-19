# Execution-provider seam v1 (WV-328)

Status: contract and test doubles only. This is the next step from
[#328](https://github.com/CrowBe/weave/issues/328) and the
[Monty research](research/monty-sandbox.md#recommended-next-slice-contract-first-not-implemented).
It specifies **one generated orchestration program against granted
capabilities**. It chooses no language, provider, dependency or deployment.
There is no production execution provider, Fabric adapter or program-run
action in this change. The checks below demonstrate red against invalid
doubles; green repository checks do not admit an implementation.

## Boundary and authority

| Participant                   | Owns                                                                                                                 | Does not receive or decide                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Execution provider            | Program execution, named call boundaries, limits, opaque dumps, isolation evidence, worker termination               | Grants, Fabric implementations, Loom state, approvals, scheduling |
| Fabric adapter                | Closed input conversion, host-bound authority, invocation identity, mapping outcomes to program values or exceptions | Goal selection, grant issuance, approval decisions                |
| Fabric capability host        | Contract validation, admission and authority checks on every invocation, effects, reservations, durable outcomes     | Loom goals, Threads, workstreams or scheduling                    |
| Loom and its composition root | Eligible offered set, program-run action and authority ceiling, approvals, budgets, snapshot custody, recovery       | Provider internals or implicit authority from generated output    |

A judgment site may propose a subset of the deterministic eligible set. Its
answer is an observation. Offering a name or stub grants nothing. Untrusted
code never supplies the grant, widens the offered set or reaches a host
implementation directly. Resource references remain opaque.

## Provider surface

The following notation defines values and obligations, not exported types.
Methods are asynchronous; `close` must remain callable while execution is
pending. Each handle represents one run. A fresh handle may either start or
restore, once. A provider-specific type never crosses the seam.

```ts
type Boundary =
  | { kind: 'suspended'; call_id: string; capability: string;
      input: Json; position: { start: number; end: number } }
  | { kind: 'completed'; output: Json }
  | { kind: 'failed'; code: ProviderFailure };
type CallOutcome =
  | { kind: 'value'; value: Json }
  | { kind: 'exception'; code: AgentSopFailureCode };

start(program: Program, offered: Offered[], limits: Limits): Promise<Boundary>
resume(call_id: string, outcome: CallOutcome): Promise<Boundary>
dump(): Promise<Uint8Array>
restore(bytes: Uint8Array): Promise<Boundary>
close(): Promise<void>
isolationReport(): Promise<ExecutionIsolationReport>
```

- `Program` is immutable source plus its digest and a versioned language
  identifier. The language and subset are unresolved. `Json` is bounded plain
  data: no functions, host objects, locators masquerading as references or
  provider wrappers. Data size and depth are bounded at the edge.
- An `Offered` entry names one capability id, exact contract revision and
  closed input/output stub. It contains no grant or executable host function.
  Duplicate names and malformed stubs are refused before execution. The set
  is fixed for the run and bound into snapshot custody. Expansion requires a
  new policy decision, new run and authority; it cannot mutate a paused run.
- `Limits` includes finite positive memory bytes, execution time, overall
  deadline (including host waits), suspension count, output/snapshot bytes,
  worker checkout deadline and termination grace. Clock and entropy inputs
  are explicit and recorded. A provider unable to enforce a required bound
  is unavailable; an allocator limit alone is not an RSS bound. Cumulative
  use is accounted outside the provider and cannot reset on restore.
- Source positions are half-open UTF-8 byte offsets into the digested source,
  with `0 <= start <= end <= source length`. They contain no source text.
  `call_id` is unique within the run, stable across dump/restore and never
  derived from capability/input alone: repeated equal calls are distinct.
- A suspension describes a request **before any host effect**. There is at
  most one outstanding call per handle. Resume accepts only that call id,
  once. Wrong, stale or duplicate resume, dump while running, a second start,
  restore on a used handle and execution methods after close are refused without
  advancing execution. Transport errors are recorded as provider faults;
  they cannot establish the outcome of an already dispatched capability.
- Un-offered names fail inside the program with `UNKNOWN_CAPABILITY`; no
  Fabric invocation occurs. The provider reports the attempted name and
  position as bounded gap evidence without a host callback that could invoke
  it. Loom records a stable signature over capability, argument shape and
  source/program revision, excluding volatile call ids and argument values.
- `dump` is permitted only at a suspension; it neither answers the call nor
  executes code. `restore` on a fresh, host-configured handle re-announces
  that exact pending call, with the same id, capability, input and position.
  The host compares its bound digests before dispatch or resume.
- `completed` and `failed` are terminal. Provider failure codes are separate
  from AgentSOP codes: `INVALID_PROGRAM`, `INVALID_STATE`, `LIMIT_EXCEEDED`,
  `ISOLATION_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`, `PROVIDER_FAULT` and
  `CANCELLED`. On a time or memory trip, discard and close the handle; it
  cannot be fed again even if a provider could otherwise recover its heap.
- `close` is idempotent and prevents subsequent resume/dispatch. At a
  suspension it releases the worker. During execution it terminates the
  worker within the configured grace, with independent host supervision;
  a mere request to close is not proof of termination. A provider that cannot
  prove termination is unavailable for this slice. Closing the interpreter
  cannot establish that a dispatched Fabric effect stopped.

## Isolation is a precondition

`ExecutionIsolationReport` is run-bound evidence naming provider/revision,
program and configuration digests, execution tier, enforced limits and the
explicit field `os_isolation: 'enforced' | 'unsupported' | 'unprobed'`.
It also reports filesystem, network, credentials, child-process and host-state
reach, and probe/evidence references. The host validates evidence from its
trusted supervisor before `start` or `restore`, and records the report digest
with the run. The provider also binds its run to that report. A label or a
self-asserted boolean is insufficient. This report does not replace or silently
extend AgentSOP's existing admission `IsolationReport`.

Missing, stale, incompatible or non-enforced OS isolation refuses an untrusted
program **before execution**, with `ISOLATION_UNAVAILABLE`. No fallback to
`trusted` is permitted. No mounts, `os` callback, host objects, ambient clock,
entropy, credentials or native process work are exposed. Trusted host
implementations still need Fabric checks. Generated implementations and
`shell.run@1`/repo build and test work retain their own OS-level execution tier.
Research E1, E5 and E6 show why language isolation, allocator limits and a
session's `close` method cannot alone establish these properties.

## Fabric adapter obligations

Every offered suspension passes closed decoding and contract validation, then
becomes `invoke(hostBoundGrant, capability, input, { invocation_id })` through
the capability host. Provider containers are converted to bounded plain data;
unknown fields are rejected. A grant-shaped control argument is ignored as
authority (and rejected as `INVALID_INPUT` if outside the input contract).
Never pass provider-supplied grant fields into the control argument to `invoke`.
Fabric rechecks admission, current authority, revision, resource permissions,
effects and reservations on **every** call. A valid offered call is the positive
control: it must actually reach Fabric and return its output.

Successful output resumes as a value. A rejected invocation resumes as an
exception with its exact AgentSOP failure code, including `DENIED`. A failed
invocation resumes with its declared failure code; an implementation fault is
`RESOLVER_ERROR`. Failure text is not parsed for authority or control flow.
`uncertain`, unresolved lookup, lost acknowledgements and persistence failure
stop continuation and retain applicable effect reservations. They are not
ordinary catchable failures that permit another attempt at the same effect.

**Blocked authority mapping:** today's `Grant` in
`packages/agentsop/src/grants.ts` names one operation/revision and is single-use.
It cannot be reused as a multi-capability program envelope. Before implementing
the program-run action, a separate recorded decision must choose between a
bounded envelope with validated per-call authority and ordinary per-call
actions/grants. Neither option may bypass Fabric or allow the provider or
adapter to mint grants. Doubles below bind synthetic host authority; they do
not demonstrate compatibility with today's grant API.

## Loom obligations and unresolved lifecycle binding

The intended program-run action records program, offered-contract and policy
revisions, authority binding and remaining budgets. It carries no implicit
authority from the source or generated output. Each boundary is an observation
to be admitted under deterministic policy.

At an approval-gated call, dispatch nothing. Bind the pending approval to run,
action, call id, capability/revision, input digest and snapshot digest. Persist
the suspension and close the provider so a paused run holds no worker.
Authenticated approval must still satisfy current authority, admission, read
sets and remaining budgets. It can authorize that bound call once. Refusal
resumes with `DENIED`, without invoking. Duplicate decisions cannot repeat the
effect; stale, altered or revoked decisions cannot authorize it.

Snapshot custody is host-owned. Authenticate an envelope containing the opaque
bytes' digest, run/action and call identities, program digest, offered-set and
contract revision digest, host authority binding, provider/version/configuration
digests, pending approval/input digest, remaining budgets, recorded clock/seed,
and a continuation generation. Use a MAC with a host-held key and versioned
canonical encoding. Verify MAC, all bindings, current eligibility and bounds
**before giving bytes to the provider**. Missing keys, edits, truncation,
cross-run substitution and incompatible versions fail closed. Keys never enter
argv, logs, observations or provider memory. A valid MAC does not renew a grant
or make an old continuation current. Claim a continuation once in durable host
state; concurrency and crash cannot fork an approved effect.

Before dispatch, durably bind `(run_id, call_id)` to an invocation identity and
its capability/revision/input digest, recording starts and reservations. After
a crash, a re-announced call uses outcome lookup by that identity under current
authority, never blind invocation. Committed/stopped outcomes can be recorded
and resumed once; unresolved effects remain uncertain with their holds until
bounded reconciliation. Identity/input mismatch refuses continuation. A crash
between identity persistence and dispatch also requires outcome evidence; an
absent result is not proof that an effect did not occur.

Cancellation at a suspension closes without resume and records `cancelled`.
During execution, stop new dispatch and terminate the worker within the bound.
Record `cancelled` only when stopped execution is confirmed; an already
dispatched effect with unknown outcome is `uncertain`. Retain effect locks
until the outcome is recorded, and retain uncertain writes until reconciliation.
Late results are recorded without a second continuation or effect.

Replay reads the recorded boundaries, outcomes, clock and seed. It calls no
provider method, Fabric invocation or reconciliation lookup. Missing replay
evidence fails; it does not start a provider. Independent Threads may progress
concurrently with distinct authority, offered sets, budgets and snapshots.
Worker capacity belongs to Loom scheduling, with finite checkout deadlines;
one paused run cannot hold another's worker slot.

**Still blocked:** #320 and its workstream follow-ups own lifecycle integration,
snapshot storage ownership, retention, deletion/key rotation, and how provider
boundaries map into operating processes. The existing
[workstream contract](../packages/weave/src/WORKSTREAM-CONTRACT.md) defines pure
operating-process transitions and a resume-point digest, but supplies no worker,
snapshot store, MAC or retention rule. This document adds no lifecycle states
or persistence implementation. A provider suspension does not itself transition
or pause an operating process. Tests model obligations, not a lifecycle decision.

The language subset, multi-call authority mapping, provider/dependency adoption,
worker jail, durable replay format, telemetry/disclosure policy and scheduler
capacity binding also require recorded decisions/evidence before integration.
Telemetry must preserve Weft's content-class/digest boundary; source, inputs,
outputs and dumps must not become implicit inline trace content.

## Red checks and evidence

IDs below preserve the
[research table](research/monty-sandbox.md#recommended-next-slice-contract-first-not-implemented).
`checks/fixtures/execution-provider/contract.mjs` runs behavioral scenarios
against test doubles. Each deliberate defect fails an assertion bearing its
ID; conforming scripted controls exercise the same assertions. No program text
is executed and no double proves isolation, durability, timing or real concurrency.

| ID    | Scenario and required observations                                                                                                  | Evidence limit / blocked integration                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| X-T01 | Un-offered call fails in the program; no invoke; repeat has the same gap signature                                                  | Scripted interpreter and gap record only                                  |
| X-T02 | Grant-shaped input cannot replace host-bound grant; offered valid input reaches Fabric; denied outcome resumes with exact code      | Synthetic authority, not production grant mapping                         |
| X-T03 | Approval pauses with zero workers and no invoke; duplicate approval invokes once; refusal raises `DENIED`                           | Lifecycle, durable approval binding and custody blocked                   |
| X-T04 | Edited dump and changed bindings refuse restore before provider access; valid envelope reaches provider                             | Real MAC/key/storage implementation blocked; E3b motivates the red double |
| X-T05 | Crash after dispatch, restore re-announces call; lookup by recorded identity; changed call refuses lookup; effect count remains one | Durable atomicity and unknown outcomes need a real host                   |
| X-T06 | Time/memory trip is bounded; terminal session is discarded and cannot resume                                                        | Injected ticks, no OS timing or RSS evidence                              |
| X-T07 | Missing OS isolation refuses untrusted start and restore; never changes tier                                                        | Report is synthetic, not containment evidence                             |
| X-T08 | Replay has identical observations, clock and seed; provider/invoke/lookup counts zero                                               | Durable replay format blocked                                             |
| X-T09 | Suspended cancellation never resumes; running cancellation kills; holds release only after recorded outcome; uncertain holds remain | No real worker kill or durable reservation evidence                       |
| X-T10 | Two Threads interleave progress with separate grants/sets; finite checkout deadline; paused workers released                        | Scripted interleaving only; scheduler resource integration blocked        |

Run raw demonstrated red (expected exit 1, ten contract assertion failures):

```sh
node checks/fixtures/execution-provider/red.mjs
```

The raw runner deliberately avoids Node's default test discovery names, so bare
`node --test` does not execute these expected failures.

Run the gating checks (expected exit 0):

```sh
node checks/test/execution-provider.test.mjs
npm run verify
```

The gating suite requires the exact assertion failure for each invalid double,
rejecting a missing module, unexpected exception or unexpectedly passing double.
It also runs the scripted positive controls. These implementer-authored checks
establish sensitivity to the named defects only. Seven additional independent
defects exercise duplicate approval (X-T03), lookup with the wrong invocation
identity and acceptance of a changed restored call (X-T05), late time and memory
termination separately (X-T06), a missed running-worker kill (X-T09), and an
infinite checkout deadline (X-T10). Each must fail its own observation without
the scenario's primary defect masking it. Recovery binds the re-announced call
id, capability and input to the recorded invocation before lookup. Timing,
termination and checkout observations remain injected test data; these checks
provide no real worker or scheduler evidence. Other observations exercised only
by healthy scripts are non-red positive controls. Before provider admission,
reserve independently authored adversarial and held-out cases and prove these
obligations against the real provider, adapter and durable host, including
malformed data, revoked approvals, persistence faults, crashes and concurrent
continuation claims. No benchmark, live provider or sandbox adoption is claimed.

Local evidence (2026-10-30, Node 22.23.4): before fixing the doubles and runner
name, the expanded gating suite failed nine checks. Afterward all 30 checks
passed with no skips or todos, and the raw runner produced ten expected assertion
failures. Bare `node --test` in the fixture directory discovered zero tests.
Build and repository static checks passed. `npm run verify` was attempted and
stopped in the existing `checks/test/checks.test.mjs` subprocess fixtures; an
independent Node subprocess probe reports `spawnSync EPERM` in this environment.
All remaining verification stages were attempted individually: `npm test`
failed in seven existing test files, and task-acceptance and decision-sites
CLI subprocess checks also failed. A direct loopback probe reports `EPERM`.
The other stages passed, including web build, typechecks, and offline suites.
Full verification remains unproven and must be rerun in a host that permits
the existing subprocess and loopback checks.
