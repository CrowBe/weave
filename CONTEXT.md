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

Anything that updates state: user input, a tool result, an inference result, an approval, an error, a timeout, or an environmental change. Model output is an observation, not a command.

### Cycle

One passage through observing state, weighing actions, applying policy, executing viable actions, and incorporating resulting observations. Avoid *turn* unless referring specifically to a conversational interface.

### Action

A typed operation Weave may execute to advance a goal. Retrieval, execution, inference, clarification, approval, communication, waiting, and completion are all actions.

### Action frontier

The currently viable set of weighted actions. It may contain several independent actions that can execute concurrently. Avoid *next action* when multiple actions may be viable.

### Thread

A causally related sequence of actions and observations within a goal. Threads may run concurrently, join, be superseded, or be cancelled. A thread is not an operating-system thread.

## Intelligence and control

### State view

The bounded, typed rendering of state handed to the decision layer for one cycle. A state view is derived from state; it is neither the observation log nor the projection, and it is budgeted so decision quality can be compared across models and across time.

### Decision layer

The fast, typed, uncertainty-aware mechanism that evaluates state against possible actions. Jev is the initial implementation. The decision layer proposes weights; it does not override policy.

### Action candidate

A typed, fully bound action the runtime has enumerated for the current cycle, including its cost class, reversibility, dependencies, and effect lock set. Candidates are enumerated deterministically by the runtime; the decision layer weighs them and does not author them.

### Effect lock

The set of resource references and declared effects an action candidate will touch, computed from its capability contract before execution. Effect locks determine which candidates may run concurrently.

### Weight

A decision-layer estimate associated with a candidate action or bounded semantic claim. A weight is evidence for routing, not authorization or proof.

### Inference

Requested model work such as reasoning, synthesis, classification, transformation, or language generation. Inference is an action available to Weave, not the owner of the loop.

### Inference router

The deterministic component that selects a model and configuration for a requested kind of inference using eval results, quality requirements, cost, latency, privacy, context, and escalation risk.

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

The semantic definition system: the capability contract schema, the effect vocabulary, the ResourceRef shape, the result and failure vocabulary, and the resolver contract shape. AgentSOP is a contract, not a runtime. It ships as its own package and knows nothing of Weave, AgentFabric, or any protocol.

### AgentFabric

The capability subsystem that honours AgentSOP: catalogue, resource references, grants, resolution, invocation, admission, revocation, and audit. It ships as its own package and Weave consumes it through a capability host port. AgentFabric does not schedule goals or choose actions, and it does not import Weave.

### Implementation

One executable realization of a capability contract. Local code, a remote service adapter, a composition, or a generative fallback may each be implementations of the same capability.

### Capability host

The port through which Weave reaches a capability subsystem: listing, describing, invoking, proposing, admitting, and revoking capabilities. AgentFabric is the first adapter. Weave depends on the port, not on AgentFabric internals.

### Capability registry

The runtime catalogue of contracts, implementations, maturity, provenance, permissions, reliability, cost, and availability. Do not shorten this to *AgentFabric*; AgentFabric defines the protocol, while the registry contains runtime instances.

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

## Real-time TDD

### Contract establishment

The point at which semantic purpose becomes an independently testable capability contract. A contract may be induced from traces or designed before implementation.

### Test corpus

The versioned executable evidence derived from a contract. It includes visible development tests and may include independently generated held-out admission tests.

### Demonstrated red

Evidence that the test corpus rejects a placeholder, known-invalid implementation, or useful mutation before implementation is accepted. Red is observed, not assumed.

### Proven green

Evidence that an implementation passes the applicable deterministic checks and test corpus within its declared effect and resource boundaries. Green does not waive admission policy.

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
- Say **crystallization**, not *learning*, for the admission of new executable capability.
- Say **weight**, not *confidence*, unless the value is explicitly calibrated as confidence.
- Say **admit**, not *save*, when a capability passes into the registry.
- Say **state view**, not *prompt* or *context*, for what the decision layer receives.
- Say **action candidate**, not *option*, for an enumerated, bound action.
- Never use **deterministic** to describe generated tests; their execution is deterministic, while their authorship and correctness require evidence.
