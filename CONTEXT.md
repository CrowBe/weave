# Context

This file defines Weave's ubiquitous language. Use these terms consistently in code, tests, issues, and discussion. If the model changes, update the language here before introducing competing names.

## Core model

### Weave

The goal-directed runtime. Weave assembles state, assembles the available capabilities, submits that structure to the decision layer, and acts on the weighted frontier. Given a goal, it identifies capability gaps, constructs and validates candidates, and crystallizes accepted work. Do not use *Weave* to mean a model, agent persona, AgentFabric, or an individual capability.

### Goal

The outcome Weave is currently authorized to pursue. A goal includes its scope, principal, and authority; it is not merely the latest user message.

### State

The explicit, evolving representation of what matters to the goal: known facts, open questions, active work, capabilities, constraints, approvals, budgets, risks, and relevant evidence.

### Observation

Anything that updates state: user input, a capability result, an inference result, an approval, an error, a timeout, or an environmental change. Model output is an observation, not a command.

### Cycle

One passage through observing state, weighing actions, applying policy, executing viable actions, and incorporating resulting observations. Avoid *turn* unless referring specifically to a conversational interface.

### Action

A typed operation Weave may execute to advance a goal. Retrieval, invocation, inference, checks, evaluation, crystallization, clarification, approval, communication, waiting, and completion are all actions.

### Action space

The typed set of actions that could be considered from the current state before weighing and policy. Distinct from the action frontier, which is the viable weighted subset.

### Action frontier

The currently viable set of weighted actions. It may contain several independent actions that can execute concurrently. Avoid *next action* when multiple actions may be viable.

### Thread

A causally related sequence of actions and observations within a goal. Threads may run concurrently, join, be superseded, or be cancelled. A thread is not an operating-system thread.

### Cycle record

The inspectable explanation of one cycle: observations applied, considered actions, weights, policy decisions, executed and cancelled actions, and resulting observations.

## Intelligence and control

### Decision layer

The fast, typed, uncertainty-aware mechanism that weighs assembled state and capabilities against possible actions, and that evaluates check evidence when a candidate is proposed for crystallization. Jev is the initial implementation. The decision layer proposes weights and expansion evaluations; it does not generate documents, corpora, or resolvers, override policy, waive failed checks, or replace AgentFabric grants.

### Weight

A decision-layer estimate associated with a candidate action or bounded semantic claim. A weight is evidence for routing, not authorization or proof.

### Inference

Requested model work such as reasoning, synthesis, classification, transformation, language generation, or proposing an AgentSOP document, a test corpus, a resolver, or an escalated expansion evaluation. Inference is an action available to Weave, not the owner of the loop. Its output is an observation that must still fit AgentFabric's requested shape. Construction of new capabilities is inference; checking them is not.

### Inference router

The deterministic component that selects a model and configuration for a requested kind of inference using eval results, quality requirements, cost, latency, privacy, context, and escalation risk.

### Policy

Deterministic rules that bound Weave actions: inference budgets, when to check, when evaluation may proceed, when to crystallize, communication, and completion. Policy always outranks a probabilistic recommendation and always outranks a decision-layer evaluation. Failed checks cannot be waived. AgentFabric grants remain a separate authority boundary for invocation.

### Authority

The explicit permissions attached to a goal: which principal Weave invokes as, whether it may check or crystallize, spend inference, communicate, and complete. Authority is granted. Evidence is not authorization. Crystallizing a resolver does not grant permission to invoke it.

### Evidence

Recorded support for a claim or transition: traces, test results, static analysis, observed effects, approvals, or model judgments. Evidence does not itself grant authority.

## AgentSOP and AgentFabric

### AgentSOP

The semantic contract for operations an agent may request. It names what is being done, to which resource, with which effects, and what success looks like. It does not name filesystems, APIs, programming languages, harnesses, or Weave. A capability document matching AgentSOP is the capability's stable identity.

### Capability

A named semantic operation with typed input and output, declared effects, authority selectors, and declared dependencies. The AgentSOP document is the capability; resolvers are replaceable.

### Capability document

The JSON statement of an AgentSOP capability: `id`, `title`, `description`, `input`, `output`, `effects`, `idempotent`, `authority`, and `depends_on`. Resolution status is not part of the document.

### Resource

A thing in the environment that an operation may act on.

### ResourceRef

An opaque, fabric-managed handle to a Resource. Not a path, URL, or bearer token. Knowing a locator is not possessing a ResourceRef. Possessing a ResourceRef is not having authority to act on it.

### Effect

A declared consequence of invocation from the closed AgentSOP vocabulary: `discover`, `read`, `create`, `write`, `append`, `delete`. Pure transformations declare no effects.

### Principal

An identity that may be granted authority to invoke capabilities or to use control-plane privileges such as crystallize.

### Grant

Authority for a Principal to invoke a Capability, optionally limited to Resources and Effects.

### Resolution

Binding a Capability to a Resolver. A capability may exist in the catalogue and still be unresolved, unavailable, or blocked on a dependency.

### Resolver

Trusted code that satisfies a Capability. Contracts are durable; resolvers are disposable. AgentFabric treats a crystallized resolver as bound, not as proven.

### Invocation

A Principal requesting a Capability with an input. The Result is typed success or a failure with a stable AgentSOP code.

### AgentFabric

The architecturally independent runtime that honours AgentSOP: catalogue, ResourceRefs, principals, grants, invocation, audit, and crystallization as binding a resolver. It ships with Weave behind a clean boundary so other harnesses can reuse it. AgentFabric does not schedule goals, choose actions, check generated resolvers, or evaluate whether they should be bound.

### Catalogue

The live set of AgentSOP documents known to a Fabric, together with each name's resolution status. Do not call this Weave, and do not call AgentSOP the catalogue.

### Composition

A capability whose resolver may invoke only the capabilities listed in `depends_on`. Nested invocation uses the same Principal and does not widen grants or mint ResourceRefs to skip discovery.

### Crystallization

The act of binding a resolver to a named AgentSOP capability. Crystallization begins with the document, not saved code. Who may crystallize is a Fabric privilege. Whether a generated resolver should be bound requires passed checks and an accept evaluation. Crystallization is acceptance into the catalogue, not a grant to invoke.

## Capability expansion

### Capability gap

A semantic operation required to advance the goal that the current catalogue cannot adequately perform through invocation or composition. Identification compares a stated need to the catalogue. Deriving that need from unstructured goal text is inference, not identification.

### Identify

The deterministic comparison of a stated need to assembled capabilities. A need is unnamed when the catalogue has no document, unresolved when a document exists but no resolver is bound. Identification does not author a document or a resolver.

### Construct

Generative inference that proposes an AgentSOP document, a test corpus, or a resolver. Construction is untrusted. The decision layer does not construct.

### Check

Deterministic execution of a test corpus against a candidate resolver. Weave checks; AgentFabric only provides trial invocation. A check is not a model judgment and not a decision-layer evaluation.

### Check evidence

The recorded result of a check: demonstrated red, proven green, and held-out outcome. Check evidence may pass or fail. Passing is not acceptance.

### Evaluate

The decision layer's typed judgment of check evidence: accept, reject, or uncertain. Evaluation may escalate to inference when uncertain. Evaluation cannot generate a candidate and cannot waive failed checks.

### Expansion evaluation

The structured result of evaluate: a decision, a weight with uncertainty, and reasons. It is evidence for crystallization, not authorization.

### Acceptance

The expansion evaluation that a checked candidate may be crystallized. Acceptance is not a grant and cannot replace failed checks. Construction, checks, evaluation, crystallization, and invocation remain separate gates.

### Established capability

A named capability whose resolver is bound and whose grants match the work the goal is allowed to invoke.

### Frontier capability

A needed capability that is unnamed, unresolved, or not yet accepted for crystallization.

## Check evidence details

### Test corpus

Versioned executable examples and counterexamples Weave uses to check a resolver. It is not part of the AgentSOP document. It includes visible development cases and may include held-out cases. Generated corpora remain untrusted until their execution produces check evidence.

### Demonstrated red

Evidence that the test corpus rejects a placeholder, known-invalid resolver, or useful mutation before a candidate is accepted.

### Proven green

Evidence that a candidate satisfies the development corpus inside the capability's declared schema and effects.

### Provenance

The record of where a document, corpus, or resolver came from, including source traces, generators, revisions, check evidence, and expansion evaluations.

## Language constraints

- Say **runtime**, not *LLM agent*, when referring to Weave as a whole.
- Say **observation**, not *message*, for a general state input.
- Say **action space**, not *action frontier*, for the unfiltered set of possible actions.
- Say **action frontier**, not *next action*, when concurrency is possible.
- Say **authority**, not *implied permission*, for what a goal is allowed to do.
- Say **AgentSOP**, not *Weave contract*, for the capability document.
- Say **capability**, not *tool*, for an operation governed by AgentSOP.
- Say **resolver**, not *capability*, for replaceable executable code bound by AgentFabric.
- Say **crystallize**, not *learn* or *save*, for binding a resolver.
- Say **identify**, not *discover*, for comparing a stated need to the catalogue.
- Say **construct**, not *learn*, for proposing documents, tests, and resolvers.
- Say **check** / **check evidence**, not *classify* or *trust*, for corpus execution against a candidate.
- Say **evaluate** / **accept**, not *classify* or *trust*, for the decision layer's judgment of check evidence.
- Say **classify** only as a kind of requested inference, never as the expansion trust layer.
- Say **invoke**, not *execute tool*, for calling a named capability through AgentFabric.
- Say **weight**, not *confidence*, unless the value is explicitly calibrated as confidence.
- Never use **deterministic** to describe generated tests; their execution is deterministic, while their authorship and correctness require evidence.
- Never describe Jev or the decision layer as generating capabilities, authoring tests, or waiving failed checks.
