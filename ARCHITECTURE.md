# Architecture

This is a proposed architecture derived from [VISION.md](./VISION.md), using the
language in [CONTEXT.md](./CONTEXT.md). It assigns responsibilities, invariants,
and the evidence needed to proceed. Interfaces, storage choices, and schemas
remain to be proved by a small implementation. Nothing here claims those checks
already exist.

## 1. Derive the architecture from the goal

Weave must advance an authorized goal even when its present software is
incomplete. That creates two connected problems: choosing useful work under
uncertainty, and executing work without surrendering authority to that judgment.
Crystallization changes the software available for future choices; it must not
change the rules that authorize execution. Optimisation improves the capabilities
and operating strategies used within those rules, including the harness
implementation when a separately governed release can prove its contracts.

| Vision requirement | Architectural consequence |
| --- | --- |
| The runtime is the agent | Weave alone owns goal state, action lifecycle, and consequential state transitions. |
| Models provide observations | Proposals and judgments carry provenance; deterministic validation and policy decide which transitions they may support. |
| Independent work proceeds concurrently | Scheduling is driven by dependencies, resource conflicts, and arriving observations, not batches of model calls. |
| Familiar work becomes software | Capability contracts are reusable; candidate formation and task procedures can evolve without editing the control core. |
| Generation, admission, and execution differ | Each has its own evidence, authority check, and recorded outcome. |
| Improvement is empirical | Versioned experiments compare capabilities and operating strategies against a baseline before scoped promotion. |

The central design is a **small control core with replaceable ways of proposing
and performing work**. The core needs to understand authority, dependencies,
effects, evidence, and lifecycle. It should not understand email normalization,
travel planning, or the internal stages of a particular domain procedure.

## 2. Responsibilities and package ownership

These are logical modules, not a requirement for separate services or processes.
Start with one runtime. Keep AgentSOP and AgentFabric in separate packages to
enforce their ownership; the other modules need not become separate packages.

| Module | Owns | Must not own |
| --- | --- | --- |
| State | Observation history, validated transitions, derived entities, versioned views, conclusion validity | Provider calls or deciding that a model's claim is true |
| Decision layer | Weights and uncertainty for eligible action candidates | Grants, dispatch, or changes to goal success criteria |
| Policy and scheduler | Eligibility, approvals, budget reservations, dependencies, conflicts, dispatch and cancellation | Domain-specific planning or semantic truth |
| Inference gateway | Bounded provider execution, deterministic routing, attempt accounting and evaluation | Goal scheduling, ambient state access, or self-defined success |
| Capability host | Contract lookup, invocation, construction evidence, admission, revocation and execution enforcement | Weave goals, threads, or frontier selection |

Weave owns the first three modules and composes the inference gateway with the
capability host. The gateway has an explicit inference request interface usable
by both Weave and a generative implementation; it does not require importing
Weave state or its scheduler. Provider adapters implement that interface's
execution needs.

AgentFabric is the bounded capability subsystem that ships inside this
repository. AgentSOP is its contract layer: meaning, typed inputs and outputs,
effects, authority, references, and failures. AgentSOP imports neither runtime;
AgentFabric may depend on AgentSOP but never on Weave. Weave reaches AgentFabric
through the capability host interface and may use AgentSOP contract types.
Package checks and tests independent of Weave must enforce these directions.

Both packages are built in this repository as an npm workspace in TypeScript
(`packages/agentsop`, `packages/weave`; `packages/agentfabric` arrives with
M1). Package-direction and no-ambient-clock checks live under `checks/` and run
without Weave's tests. The external AgentFabric repository
is a conceptual reference, not a dependency or a code source: the contract
invariants it established (durable contracts, opaque references separated from
locators and from authority, a closed effect vocabulary, grant matching, failure
precedence, declared-dependency composition) carry over; its trusted-local
runtime, bindings, and filesystem layout do not.
[docs/agentfabric-concepts.md](./docs/agentfabric-concepts.md) records what is
carried, what is not, and what Weave adds. A fake host supports early
control-core tests; a real host must prove enforcement before untrusted
execution is enabled.

## 3. State records claims without granting them authority

An observation log records **that something was observed**, not that its payload
is true. A model saying an approval exists is evidence of that statement; it is
not an approval. Source identity, action identity, causal links, type version,
and validation outcome accompany the payload. Unknown or malformed observations
can be retained for diagnosis but cannot cause privileged transitions.

Derived entities include goals, threads, claims, questions, action records,
approvals, budgets, artifacts, and capability gaps. Every consequential field has
supporting observations and a transition rule. Approval transitions require an
authenticated authority channel; completion requires the goal's recorded success
evidence. A model may propose subgoals or revised success criteria, but cannot
silently broaden the authorized goal or lower its completion bar.

Ingress establishes identity independently of payload fields. Approval requests
and decisions bind to exact operations, inputs, effects and validity conditions;
queued work rechecks current authority at dispatch. Neither an asserted source
label nor a copied grant record establishes trusted issuance. M1 fixes a local
trusted-ingress model before an external transport is introduced.

State transitions are serialized and deterministic for a recorded order of
observations. Actions run concurrently and return observations. Semantic
interpretation that needs inference is explicit work whose result is recorded,
then integrated by deterministic rules. Contradictory claims retain provenance
and uncertainty; recency alone does not establish truth. Domain capabilities or
bounded judgment can propose resolutions without overriding authority records.

Replay uses recorded observations, immutable contract records and the applicable
procedure, policy and transition versions. It reconstructs state and decisions
without repeating external effects or expecting
fresh model calls to return identical output. It does not consult today's catalogue
as a substitute for historical definitions; missing history fails explicitly.
Recovery separately reconciles unfinished work under current authority. Historical
inspectability does not restore permission to execute a revoked implementation.
Begin with a small log and explicit transitions; a general query engine or
distributed event store is not a prerequisite.

Views are typed, versioned renderings composed from authorized state slices.
They record source revisions, deterministic selection, and omissions. A context
profile requests slices; policy controls what may actually be disclosed. Neither
a model-selected profile nor a capability input declaration grants access.

Load detail only where the consumer needs it. Stable prefixes can be cached, but
freshness and disclosure checks still apply to each use. A summary or retained
procedure is evidence for a proposal, not a replacement for authority records.

Cached conclusions retain evidence, dependencies, versions, invalidation
conditions, and an authority scope. State checks those conditions before reuse;
changed or unverifiable dependencies require refresh or explicit uncertainty.
This applies to later reuse as well as results arriving while work is in flight.

Goal state and durable knowledge have different lifetimes, not different privacy
rules. Contracts, corpora, traces, gap records, and even reliability statistics
can contain or reveal goal content. Promotion and cross-goal access require
explicit policy, provenance, and any necessary redaction. Writing something to
the registry does not make it globally available.

## 4. Form candidates, then authorize a frontier

```text
observe → integrate → form candidates → check eligibility → weigh
             ↑                                          ↓
             └──── results ← execute ← reserve and dispatch
```

Candidate formation combines established procedures, dependency readiness,
registry matches, compositions, and recorded proposals. A generative planning
capability can propose desired operations, bindings, or dependencies. Its output
is an observation; the runtime validates it into action candidates. This keeps
new strategies possible without giving generated plans executive authority or
requiring every task pattern to be hard-coded in an enumerator.

An action candidate identifies its operation, bound inputs, supporting evidence,
read set, dependencies, requested effects, applicable contract revision, and
resource needs. Candidates can include clarification, approval, waiting,
inference, communication, and completion. Invalid or insufficiently bound
proposals remain recorded with reasons; they are not executable candidates.

Deterministic checks establish structural validity and compatibility. Semantic
matching and usefulness may require judgment. A failed type match can reject a
composition; a successful type match alone cannot establish that it serves the
goal. Composition is considered before declaring a capability gap.

Eligibility distinguishes **allowed**, **approval required**, and **prohibited**.
Only policy-designated approval requirements produce approval actions; hard
prohibitions are not converted into requests to waive policy. The trace records
all exclusions, even when they were never sent for weighing. Sensitive candidate
content is filtered before any model receives it.

The decision layer weighs eligible candidates against the authorized goal,
expected progress, cost, risk, and uncertainty. Weights from different judgment
sites are not assumed to share a calibrated scale. The result is an observation tied
to the state and candidate revisions it evaluated. It cannot introduce executable
actions or change policy. Existing procedures may provide deterministic weights;
model judgment is used where it adds measured value.

The scheduler chooses a compatible frontier under dependency and resource limits.
It need not solve a globally optimal scheduling problem. A deterministic,
explainable selection rule with stable tie-breaking is sufficient initially.
Before dispatch, it rechecks authority and relevant revisions, reserves budget
and resources, and records the action start. Concurrent work cannot each spend
the same unreserved budget. Missing or expired evidence fails closed.

There is no wait-for-the-whole-frontier barrier: each arrival can unlock work or
invalidate pending choices. Control-plane transitions such as recording a result,
releasing a reservation, or honoring cancellation do not require model approval.
When no useful action is eligible, the runtime records whether it is waiting,
blocked, seeking clarification, or complete. Bounded attempts and no-progress
policy prevent repeated inference from masquerading as progress.

Execution capacity is distinct from budget and effect locks. Saturation cannot
prevent result integration, authority changes or cancellation. Bounded,
authorized reconciliation must not deadlock behind the work it needs to settle.
When nested execution is introduced, a waiting parent must not occupy all capacity
required by its children. These guarantees do not serialize independent actions.

## 5. Concurrency and external effects

Actions progress through explicit states: pending, running, and a terminal
outcome such as succeeded, failed, cancelled, or uncertain. Cancellation requests
and supersession are recorded separately from confirmed execution outcomes.
A thread organizes related work; dependencies determine what may proceed.

Effect locks are reservations over the resources an action may affect. They
must use canonical resource identity and cover aliases, collections, and nested
invocations. Discovery can conflict with creation or deletion in the collection
it reads. Read-only operations may run together, but reads do not automatically
commute with writes. If an effect scope cannot be bounded, execution needs a
conservative broader reservation or must remain blocked.

Declarations are useful only when execution enforces them. An implementation
cannot touch an undeclared resource and still claim the scheduler protected it.
An action's read set separately records the state revisions its binding assumed.
Relevant assumptions are checked before dispatch and before accepting results.
Stale results may be retained as evidence while their proposed state update is
rejected, recomputed, or superseded.

External effects require additional care: rejecting a stale result does not
undo a write. Where supported, execution uses resource version preconditions and
idempotency identifiers. Otherwise the contract declares the weaker guarantee
and policy constrains its use. An interrupted call with an unknown effect outcome
is reconciled before retry; it is not assumed safe to repeat.

Cancellation stops new dispatch and requests termination of running work. Locks
and reservations are not released merely because cancellation was requested.
Late results and effects remain recorded; irreversible work is not claimed to
have been rolled back. After a crash, recovery reconciles recorded starts with
actual outcomes before resuming execution or retrying effectful work. Historical
replay never executes or performs reconciliation lookups.

Durably record required starts and reservations before dispatch. Preserve a stable
invocation identity across recovery; a lost acknowledgement after commit must lead
to outcome lookup or uncertainty, not blind retry. Host throws, rejected promises,
timeouts and disconnects become observations without claiming that an effect did
not occur. Required evidence persistence failure blocks further consequential
dispatch; it does not change an already committed effect into a safe-to-repeat
failure. The first adapter must state and test its actual atomicity guarantees.

An uncertain attempt can be terminal while its external effects remain unresolved.
Charge consumed resources once and retain locks and any unsettled resource liability
until reconciled; cancellation does not refund consumed budget. Recovery attempts
have a finite allowance. Unresolved effects block conflicting work, not unrelated
resources. Report production, publication and eventual client delivery have separate
outcomes; retrying a notification must not repeat publication.

## 6. Inference is bounded work

Every model call uses the inference gateway, including frontier weighing,
framing, semantic evaluation, and generative implementations. Each judgment site
has a named purpose, typed input and output, acceptance terms, and evaluation
history. Jev is the initial decision-layer choice, not an architectural dependency.

Goal-level inference is scheduled work. Frontier weighing is a bounded control
request: policy authorizes and reserves its budget directly, without requiring
another frontier judgment to authorize it. Gateway routing and initial request
validation are deterministic. Optional classification or response judgment has
an explicit bounded route and cannot recursively request its own classification
or evaluator. No budget or unusable weights produces an explicit fallback or
blocked outcome, never implicit permission to execute.

The caller supplies scope, quality requirements, permitted data destinations,
context limits, deadline, and cost ceiling. The gateway may retry or escalate
within those terms; it cannot rescope the goal or relax acceptance. All attempts
and evaluation costs count against the enclosing reservation. Nested capability
calls share the same authority and budget limits rather than receiving fresh ones.

Record and account for every attempt, including malformed responses and failures,
independently of whether its judgment is accepted. Slow inference cannot block
control transitions. Its eventual observation is bound to the evaluated state and
candidate revisions; stale judgments cannot authorize dispatch.

Routing chooses a versioned routed unit: context profile, prompt template, model,
and settings. Deterministic policy filters by privacy and required quality, then
uses evaluation evidence to compare expected total cost, latency, and escalation.
Without enough evidence, use a conservative configured route and record the
uncertainty. A cheaper model is not presumed adequate.

Deterministic checks establish properties they can actually check. A model judge
may assess semantic quality, but its approval is another fallible observation.
Record immediate judgments and delayed task outcomes separately. No evaluator
can turn failed mandatory checks into success or redefine goal completion.

## 7. Capability execution and trust

A capability is named for its semantic operation. Its typed input supplies the
state content it needs; its resolver context supplies only granted environmental
operations and declared dependencies. It has no ambient session or state access.
A generic untyped model dispatch operation is not a substitute for contracts such
as classification, extraction, or goal decomposition.

AgentFabric checks invocation authority as well as admission. The effective
authority of nested work is bounded by the goal, caller, contract, and granted
resources and effects. Admission does not issue an execution grant. Revocation
prevents further invocation and is surfaced to Weave for pending and running
work; already completed external effects remain part of the record.

Generative implementations declare inference as a dependency with enforceable
spending and disclosure limits from their first use. The exact contract syntax
may evolve; enforcement cannot wait for a later effect-vocabulary revision.
A generative implementation must pass applicable deterministic checks and a
versioned evaluation policy that states its uncertainty and permitted maturity.
Distributional evidence supplements these gates; it cannot waive failing checks.
A deterministic replacement reuses the contract and applicable corpus, but earns
fresh admission, reliability, cost, and maturity evidence of its own.

Untrusted implementations **and generated tests** execute within enforced
isolation. A substrate-neutral resolver context makes brokered access possible;
process separation alone does not remove ambient authority. The execution host
must constrain filesystem, network, credentials, process creation, resources,
and access to held-out artifacts, and mediate declared operations. Unsupported
isolation blocks untrusted execution. The containment mechanism remains an
implementation choice to prove before use.

## 8. Crystallization is a governed workflow

Extension uses ordinary actions and dependencies on threads. AgentFabric owns
the reusable lifecycle and admission requirements; Weave schedules the work
without embedding a domain-specific pipeline in its core.

```text
identify gap or recurring operation → search for reuse or composition
  → establish contract → author and validate corpus → demonstrate red
  → generate implementations → prove green → request admission
```

A genuinely blocking gap may justify extension on its first occurrence if the
authorized goal, budget, and expected benefit support it. Recurrence is evidence
of payoff, not a mandatory gate that prevents solving novel goals. Alternatives
include bounded frontier inference, clarification, or explicitly remaining blocked.

The contract states purpose, types, invariants, failures, effects, permissions,
success evidence, and execution limits. Corpus authors work from that contract
and approved source evidence, independently of candidate implementation code.
The corpus is checked for agreement with the contract and known examples,
contradictions, and rejection of placeholders or relevant invalid behavior.
Demonstrated red is recorded **before implementation generation**; rejection of
one placeholder is not a claim that the corpus is complete.

Visible development tests and protected held-out tests have separate access.
Implementers cannot read the held-out split. Validation results are bound to the
contract, corpus, implementation, execution environment, and check versions.
Failure classification can recommend a next step; it cannot edit the corpus or
convert red to green. Contract or corpus revisions trigger revalidation of the
affected evidence. Admission records which policy accepted which evidence.

Abandoned attempts retain appropriately scoped artifacts without becoming
invocable implementations. Newly admitted implementations begin constrained;
observed failures can reduce maturity, revoke admission, or select a previously
validated implementation. None of these transitions grants additional authority.

Retained skill documents and procedures can inform proposed compositions, contracts
or operating strategies. Retention alone is not capability admission. Preserve
failed attempts as well as successes for evaluation, with the same data boundaries.

## 9. Optimisation is a governed experiment

Extension and optimisation use the same execution machinery. An optimisation
thread observes outcomes, proposes a change, gathers comparative evidence, and
requests promotion through ordinary capabilities and dependencies. It does not
introduce a second privileged agent loop. An authorised optimisation goal or
explicit allocation supplies its scope and budget; ordinary task authority does
not implicitly authorise experimenting on other goals or modifying the harness.

The change may target an implementation, a routed unit, a work strategy,
scheduling choices, or information gathering. It may also target the harness
implementation. Changes to the control core use a separately governed release
path with contract checks, versioned deployment, and recovery, rather than
mutating the running core. Optimisation capabilities cannot weaken the policy,
isolation, evidence, or admission mechanisms that evaluate their changes.

An experiment records:

- The observed weakness, proposed benefit, versioned baseline, and candidate.
- The workload and scope where the benefit is expected, including data authority.
- Success measures and trade-offs: quality, completion rate, human correction,
  latency, and total cost, with protected constraints that must remain satisfied.
- The evaluation protocol, protected cases, budget, uncertainty treatment, and
  promotion conditions established before comparative results are inspected.
- Evidence tied to the evaluated versions, authorised rollout scope, monitoring
  conditions, and an eligible rollback target.

Comparison includes failures and difficult cases, not only successful traces.
Relevant workload differences and concurrent changes are recorded so an apparent
improvement is not silently attributed to the wrong cause. Costs include failed
trials, inference, evaluation, human review, and rollout. Small or inconclusive
gains can leave the baseline in place; a candidate can improve one workload and
remain unsuitable for another.

The change author does not control protected evaluation or its acceptance bar.
Evaluation changes require separate justification and authority; candidate
failures cannot be repaired by deleting the cases that expose them. Development
feedback and protected evaluation access are separated, with repeated attempts
accounted for to avoid treating benchmark fitting as general improvement.
Code-producing experiments retain contract-first tests and demonstrated red
before implementation generation. A configuration experiment compares variants
under established checks; it does not fabricate a failing correctness test when
the baseline already satisfies its contract.

Replay compares recorded state interpretation or candidate decisions without
repeating effects. It cannot prove outcomes for different actions that were never
executed. Use isolated execution, suitable controlled comparisons, or limited
authorised deployment for those claims. A trial is still execution: permissions,
budgets, data boundaries, and effect controls apply in full. No publication or
other external effect is duplicated merely to obtain an experimental comparison.

Promotion checks version-bound evidence and current authority, then activates a
candidate only for its declared scope. AgentFabric admits new capability
implementations where necessary; Weave governs which operating strategy is active.
The release path owns deployment of control-core revisions. These are separate
operations, and none grants permission to execute a task. Experiments and active
versions are recorded in state so outcomes remain attributable. Pending or running
work keeps its recorded versions unless an explicit, compatible migration or
cancellation transition is authorised; promotion does not silently rewrite it.

Monitoring compares actual outcomes with the promotion conditions. Regression
stops further rollout and can revert future work to a still-admitted, authorised,
compatible baseline. If none is available, affected work pauses for reconciliation.
Rollback changes future selection or deployment; it does not undo completed
external effects. Changed models, contracts, workload, or evaluation rules can
invalidate the comparison and require renewed evidence.

## 10. Prove the design through vertical milestones

Use a fixture goal: inspect two independent source artifacts, produce a checked
report, and publish it only when explicitly authorized. One reusable transformation
is initially missing. The fixture's domain logic belongs in capabilities.

The trace must show both inspections running concurrently; a conflicting source
write waiting; a changed source invalidating a pending report; publication
remaining blocked without approval; and a capability gap advancing through
contract, validated corpus, red, implementation, green, and admission. Admission
alone must leave publication unauthorized. A cancellation or crash during
publication must produce an honest outcome, including uncertainty when required.

This is an architectural acceptance scenario, not a new product requirement.
Iterate through **thin vertical milestones**, each with a demonstrable goal
outcome and checks across the modules it touches. Build only the state, policy,
host, and inference support needed for that milestone; do not finish a
horizontal layer first. Keep earlier scenarios running as each milestone adds one
consequential behavior. (*Slice* is reserved for the state-query term in
[CONTEXT.md](./CONTEXT.md).)

- **M0 — inspect and report.** Run the fixture goal with two fixed, read-only
  capabilities and scripted weights. Observe inputs, form and authorize
  candidates, execute independent reads concurrently, and return an in-memory
  report with evidence. Prove rejected access stays rejected and replay does not
  repeat execution. A small log and fake host are sufficient; no general state
  engine is required. The fixture, records, and checks are fixed in
  [docs/m0-inspect-and-report.md](./docs/m0-inspect-and-report.md).
- **M1 — publish under authority.** Extend the same goal with one effectful
  capability and an enforcing host. Prove scoped approval, forged-approval
  rejection, conflicting access, stale input handling, and shared budget limits.
  Add cancellation and crash scenarios around that effect: the outcome must be
  confirmed or explicitly uncertain, and retries must not silently duplicate it.
  The deliverable is an authorized report publication with an honest trace.
  [docs/m1-publish-under-authority.md](./docs/m1-publish-under-authority.md) fixes
  the trusted ingress, adapter guarantees, persistence and recovery boundaries,
  and checks for lost acknowledgements, revoked queued approval, forged grants,
  capacity saturation and historical replay after catalogue change.
- **M2 — handle a novel request.** Add one model through a bounded gateway to
  propose a new binding or composition for a variant of the same goal. Validate
  its proposal, weigh eligible candidates, and produce the report. Compare with
  scripted judgments; verify disallowed data routes, all-attempt accounting,
  and bounded failure without recursive judgment. No multi-provider router is
  needed to prove this milestone. Prove responsive control during slow inference,
  stale-judgment rejection and charging of malformed or failed attempts. One
  bounded state view records its selection manifest, revisions and omissions.
- **M3 — fill one capability gap.** Give the report a transformation the existing
  capabilities cannot supply. Search reuse/composition, establish a contract,
  validate its corpus, and demonstrate red before generating its implementation.
  Prove isolation before running generated tests or code, validate green, request
  explicit human admission, and finish the report under a separate execution
  grant. This is one end-to-end milestone; its dependent gates stay sequential while
  independent test or implementation proposals may run concurrently. Verify
  held-out protection, evidence invalidation, and revocation along this path.
  A retained procedure may inform this work but cannot bypass admission.
- **M4 — measure reuse.** Repeat the goal using the admitted capability,
  validate cached conclusions and cross-goal access, and compare quality,
  inference use, latency, and total cost. A replacement implementation earns fresh
  evidence. Establish the baseline for an optimisation experiment.
- **M5 — improve one operating strategy.** From the report outcomes, identify one
  recurring inefficiency and propose a single change, such as a narrower context
  profile. Compare it with M4's versioned baseline on protected cases, including
  quality and human correction as well as latency and total cost. Authorise a
  limited promotion, complete reports with the new strategy, and monitor outcomes.
  Demonstrate rejection of a cheaper candidate that misses the quality bar and
  rollback after a detected regression. Use explicit human promotion initially;
  no general experiment platform or autonomous core release is a prerequisite.

Each milestone begins with its behavioral contract and failing deterministic
checks before implementation. The full available suite must remain green as
milestones accumulate. If a milestone is too large, split it into smaller
demonstrable outcomes through the same modules, rather than separate state,
scheduler, or host projects.

## 11. What remains open

- Exact contract and resolver-context interfaces for the in-repo `agentsop` and
  `agentfabric` packages, including how contracts are expressed (JSON Schema,
  native types, or both).
- Where the inference request and response types live. A generative
  implementation declares inference as a dependency (§7) and AgentFabric must not
  import Weave (§2), so those types belong in AgentSOP or a package neither
  runtime owns; the gateway implementation is then supplied through the resolver
  context. Decide before M2 introduces the gateway.
- How the scheduler combines weights, cost, and risk when weights from different
  judgment sites share no calibrated scale (§4). The initial rule must be ordinal
  or per-site; M0 fixes one such rule for scripted weights only.
- Whether every decision-relevant clock reading is a recorded observation. Replay
  (§3) requires it; M0 assumes it and injects time as `clock.tick` observations.
- Authentication for future external authority channels. M1 fixes trusted local
  ingress handles and principal scope in its contract; this does not establish
  authentication for an eventual network or multi-user deployment.
- What information a held-out failure may return to an implementer or corpus
  author, and how many iteration rounds are permitted before held-out evidence is
  considered spent (§8). Without this, iterative generation leaks the split.
- The relationship between the gating suite and real providers: which checks run
  only against recorded or scripted routed units, and how non-gating evaluations
  against live models are recorded and reported.
- Resource identity, effect scopes, and external preconditions supported by the
  first adapters; unsupported guarantees must be explicit.
- The isolation mechanism and its verified support on deployment hosts.
- Domain-specific success evidence and calibrated semantic evaluation thresholds.
- Ranking, no-progress, and extension-payoff policies beyond the first fixtures.
- Contract/view migration, persistence retention, and redaction mechanisms.
- Experiment protocols, evidence sufficiency, and rollout thresholds for each
  workload; the first milestone needs one declared protocol, not a universal score.
- The separately governed release and recovery mechanism for future control-core
  changes; M5 proves operating-strategy promotion without enabling core mutation.

The invariants above are the proposed architectural decisions. These open choices
are implementation or empirical questions; they must not silently weaken the
vision's authority, evidence, concurrency, or admission requirements.
