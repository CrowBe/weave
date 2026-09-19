# Context

This file defines Weave's ubiquitous language. Use these terms consistently in code, tests, issues, and discussion. If the model changes, update the language here before introducing competing names.

## Core model

### Weave

The goal-directed runtime. Weave owns state transitions, scheduling, policy enforcement, evidence capture, and the action loop. Do not use *Weave* to mean a model, agent persona, or individual capability.

### Goal

The outcome Weave is currently authorized to pursue. A goal includes its scope and authority; it is not merely the latest user message.

### State

The explicit, evolving representation of what matters to the goal: known facts, open questions, active work, capabilities, constraints, approvals, budgets, risks, and relevant evidence.

### Observation

A recorded input that may support a state transition: user input, a capability result, an inference result, an approval, an error, a timeout, or an environmental change. Its provenance establishes what was observed, not that every claim in its payload is true or authorized.

### Slice

A named, versioned, budgeted query over state. Views — state views, context bundles, typed capability inputs — are composed from slices, with deterministic selection, disclosed truncation, and a manifest recording what actually filled each one so a recorded judgment can be reproduced.

### Read set

The state or resource revisions on which an action candidate’s binding depends. Read sets support validity checks before dispatch, on result arrival, and when derived conclusions are reused.

### Cached conclusion

A reusable conclusion with supporting evidence, dependency revisions, invalidation conditions, and an authority scope. Reuse requires those conditions and access permissions to remain valid.

### Durable knowledge

Evidence and artifacts retained beyond a goal, including capabilities, reliability observations, gap records, and evaluation history. Retention does not grant permission for cross-goal access or disclosure.

### Cycle

One passage through observing state, weighing actions, applying policy, executing viable actions, and incorporating resulting observations. Avoid *turn* unless referring specifically to a conversational interface.

### Replay

Non-executing reconstruction from recorded observations and historical contract, procedure, policy and transition versions. Replay neither invokes capabilities nor reconciles effects; missing required evidence is a failure, not permission to execute.

### Recovery

Restoring unfinished work from durable records, preserving reservations and reconciling external outcomes under current authority before continuation or retry. Recovery is distinct from historical replay and does not renew an approval or resource budget.

### Reconciliation

Authorized, resource-bounded gathering of evidence about an existing invocation's external outcome without blindly repeating its effect. It may confirm a committed effect, confirm stopped execution without that effect, or leave uncertainty explicit.

### Action

A typed operation Weave may execute to advance a goal. Retrieval, execution, inference, clarification, approval, communication, waiting, and completion are all actions.

### Action frontier

The currently viable set of weighted actions. It may contain several independent actions that can execute concurrently. Avoid *next action* when multiple actions may be viable.

### Thread

A causally related sequence of actions and observations within a goal. Threads may run concurrently, join, be superseded, or be cancelled. A thread is not an operating-system thread.

## Intelligence and control

### State view

A bounded, typed, versioned rendering of authorized state for a particular consumer. It carries source revisions and disclosed omissions rather than serving as an independent source of truth.

### Judgment site

A named place where bounded judgment is requested for a specific purpose, with typed inputs and outputs and its own evaluation history. Weighing, semantic matching, and response evaluation are distinct sites; a model such as Jev may serve more than one.

### Decision layer

The judgment site that evaluates state against possible actions and returns weights. Jev is the initial model type behind it. The decision layer proposes weights; it does not select models and it does not override policy.

### Action proposal

A suggested operation, binding, or dependency structure recorded as an observation. It can inform candidate formation but carries no authority to execute.

### Action candidate

A typed, bound action produced by validating an established procedure or a recorded proposal, with supporting evidence, dependencies, read set, effects, and resource needs. Being a candidate does not grant authority to execute.

### Effect lock

A reservation over canonical resources and effect scopes that constrains concurrent execution. Its safety depends on enforced access to those scopes, including nested work and collection effects.

### Weight

A decision-layer estimate associated with a candidate action or bounded semantic claim. A weight is evidence for routing, not authorization or proof.

### Inference

Requested model work such as reasoning, synthesis, classification, transformation, or language generation. Inference is an action available to Weave, not the owner of the loop.

### Inference role

Why an inference was requested: framing proposes subgoals, success criteria, and desired operations; working performs a scoped operation; extension authors contracts, corpora, or implementations. Proposals do not change the authorized goal or its completion bar by themselves.

### Inference kind

What is being asked of a model — classify, extract, transform, draft-contract, judge. A kind carries a context profile, prompt template versions, acceptance defaults, a default tier, and the statistics routing reads. Kinds belong to the gateway's vocabulary, not to the capability catalogue: a capability is named for its semantic operation, and its generative implementation declares the kind.

### Context profile

A versioned declaration of the state slices an inference kind requests, their depth and budget, and disclosure constraints. It describes context needs without granting access to the requested data.

### Desired operation

An operation a goal appears to need, described by semantic purpose, expected effects, and rough input and output shape. It is a proposal to assess against existing capabilities and compositions, not an executable contract or proof of a capability gap.

### Inference gateway

The module that performs bounded model work under explicit scope, acceptance, authority, and resource limits. It owns routing, attempts, and evaluation, while goal scheduling and state transitions remain Weave’s responsibility.

### Routed unit

A versioned context profile, prompt template, model, and settings selected together for inference. Evaluation evidence attaches to that combination.

### Routing

The deterministic selection step inside the gateway. It minimizes expected total cost of reaching the declared quality bar — retries and escalation included — using recorded per-site success rates, cost, latency, privacy, and context limits.

### Generative implementation

An implementation of a capability contract that depends on inference. Its admission requires applicable deterministic checks and versioned evaluation evidence; its maturity and execution scope are limited by that evidence and policy.

### Policy

Deterministic rules that bound action: permissions, approvals, spending limits, data boundaries, and destructive-operation controls. Policy always outranks a probabilistic recommendation.

### Evidence

Recorded support for a claim or transition: traces, test results, static analysis, observed effects, approvals, or model judgments. Evidence does not itself grant authority.

## Capability system

### Capability

A typed, invocable unit of software that satisfies a capability contract. The contract is the capability's stable identity; implementations are replaceable.

### Capability gap

A semantic operation required to advance the goal that the current capability set cannot adequately perform through execution or composition.

### Capability contract

The standardized statement of a capability's purpose, inputs, outputs, invariants, failures, effects, permissions, success evidence, and execution constraints.

### AgentSOP

The contract layer within the AgentFabric subsystem, defining capability meaning, typed inputs and outputs, effects, authority, references, and failures. It has no dependency on either runtime. It is built in this repository; the external AgentFabric repository is a conceptual reference only.

### AgentFabric

The bounded capability subsystem that owns contracts through AgentSOP and governs construction evidence, invocation, admission, revocation, and audit. It ships with Weave while remaining independent of Weave’s goals, state, and scheduling. It is built in this repository, not imported from the external repository of the same name.

### Resource reference

An opaque, host-issued handle to a resource, carrying a coarse kind and never a locator. Knowing a locator is not possessing a reference, and possessing a reference is not having authority to act on it.

### Effect

A declared consequence of invoking a capability, drawn from a closed, versioned vocabulary (`discover`, `read`, `create`, `write`, `append`, `delete`). Pure transformations declare none. Adding an effect is a contract revision.

### Principal

An identity to which authority can be granted. Weave, a goal, or an external caller may be a principal; a model is not.

### Grant

Authority for a principal to invoke a capability, scoped to resources and effects. Weave's policy issues an execution grant per action at dispatch; the host checks it at invocation. Admission does not issue one.

### Approval

An authenticated decision by an entitled principal on a bound request, within that principal's authority and the goal's ceiling. Its scope and validity inform policy without replacing execution grants or enforcement; payload claims, retained history and silence do not establish approval.

### Trusted ingress

A handle created by trusted bootstrap that may submit observations with a privileged provenance (operator, host, or clock). Untrusted observation payloads cannot choose those identities. Possession of a provenance string is not ingress.

### Resolver context

The interface through which an implementation reaches its environment: nested invocation limited to declared dependencies, and reference-scoped resource operations. It contains no locators or substrate types, so it can be brokered across an isolation boundary.

### Resolution status

The runtime fact of whether a contract currently has an implementation that can run: `resolved`, `unresolved`, `unavailable`, or `blocked` by a dependency. It is not part of the contract document.

### Implementation

One executable realization of a capability contract. Local code, a remote service adapter, a composition, or a generative fallback may each be implementations of the same capability.

### Capability host

The interface through which a runtime accesses capability discovery, invocation, and lifecycle operations. AgentFabric supplies it without exposing Weave to its internal implementation.

### Capability registry

The catalogue of contracts, implementations, maturity, provenance, permissions, reliability, cost, and availability. Registry presence alone implies neither admission for invocation nor authority to execute.

### Composition

A capability assembled from existing capabilities whose types and effects connect safely. Deterministic checks establish compatibility; semantic evaluation establishes usefulness for the goal.

### Crystallization

The process of turning a recurring semantic purpose or successful frontier action into an admitted capability. Crystallization begins with a contract, not saved code.

### Established capability

A versioned capability admitted to the registry with sufficient evidence for its declared maturity and permissions.

### Composed capability

A capability produced by connecting established capabilities without inventing a new primitive implementation.

### Frontier capability

A needed capability that cannot yet be satisfied reliably and requires exploration or new implementation.

## Experiments and improvement

### Optimisation

An evidence-backed change that improves how Weave achieves authorized outcomes for a declared workload while preserving protected constraints. It can change capabilities, operating strategies, or the harness implementation without expanding authority.

### Operating strategy

A versioned way of choosing or performing work, such as decomposition, composition, context selection, routing, scheduling, or information gathering. It operates within policy and does not define its own authority or success criteria.

### Experiment

A bounded comparison between a versioned baseline and a candidate change for a declared workload. It records the intended benefit, protected constraints, evaluation method, budget, promotion conditions, evidence, and rollback target.

### Promotion

The governed decision to make an evaluated change active within a specified scope. It is distinct from capability admission and does not grant authority to execute or relax policy.

### Milestone

One vertical increment of the build plan (M0, M1, …): a demonstrable goal outcome with checks across every module it touches. A milestone is a unit of delivery; it is not a *slice*, which is a query over state.

## Real-time TDD

### Contract establishment

The point at which semantic purpose becomes an independently testable capability contract. A contract may be induced from traces or designed before implementation.

### Test corpus

The versioned executable evidence derived from a contract. It includes visible development tests and may include independently generated held-out admission tests.

### Demonstrated red

Recorded evidence that the validated test corpus rejects a placeholder, known-invalid implementation, or relevant mutation before candidate implementation generation. Red is observed, not assumed.

### Proven green

Evidence that a particular implementation passes the applicable deterministic checks and test corpus within its declared effect and resource limits. It is bound to the relevant revisions and does not waive admission policy or prove untested semantic claims.

### Admission

The governed transition by which a tested implementation becomes available through the capability registry. Generation, admission, and authorization to execute are separate events.

### Maturity

The trust stage of an implementation, such as proposed, provisional, established, deprecated, or revoked. Maturity is evidence-based and may regress.

### Provenance

The record of where a contract, test, or implementation came from, including source traces, generators, revisions, evals, and validation evidence.

## Language constraints

- Say **runtime**, not *LLM agent*, when referring to Weave as a whole.
- Say **observation**, not *message*, for a general state input.
- Say **action frontier**, not *next action*, when concurrency is possible.
- Say **capability**, not *tool*, for an operation governed by an AgentFabric contract.
- Say **implementation**, not *capability*, for replaceable executable code.
- Say **implementation**, not *resolver*, for code that satisfies a contract; *resolver context* remains the name of the interface it receives.
- Say **resource reference**, not *path*, *URL*, or *locator*, for what a capability input names. Locators stay inside the host.
- Say **crystallization**, not *learning*, for the admission of new executable capability.
- Say **weight**, not *confidence*, unless the value is explicitly calibrated as confidence.
- Say **admit**, not *save*, when a capability passes into the registry.
- Say **state view**, not *prompt* or *context*, for what the decision layer receives.
- Say **judgment site**, not *Jev*, for a place the runtime asks for judgment. Jev is a model type.
- Say **routed unit**, not *model*, for what routing selects.
- Say **inference role** for why an inference was requested, and **inference kind** for what was asked of the model. They are not interchangeable.
- Name a capability for its operation, never for the inference kind behind it: `text.classify`, not `request_text_classification`.
- Say **action candidate**, not *option*, for a validated, bound action.
- Say **milestone**, not *slice*, for an M-numbered increment of the plan. A slice is a query over state.
- Say **trusted ingress**, not *authenticated client*, for the in-process handle that may submit privileged observations.
- Never use **deterministic** to describe generated tests; their execution is deterministic, while their authorship and correctness require evidence.
