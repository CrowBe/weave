# Vision

Weave exists to build software that expands what it can reliably do in pursuit of a goal.

Most agent systems place a generative model at the centre of a loop: the model receives a message, decides what to do, calls tools, and speaks again. Weave treats that as an implementation accident. A user message, a tool result, an inference result, an approval, an error, and a change in the environment are all observations that update state. From that state, Weave continuously weighs the actions available to it, executes the viable frontier—concurrently when it can—and evaluates the state that follows.

Generative intelligence is part of this system, but it is not the system. It is invoked when the current software cannot adequately advance the goal. When that exploration produces a safe, repeatable solution, Weave can crystallize it into a capability that future runs can execute directly. Reasoning moves toward the frontier; proven work becomes software.

Weave aims to make this cycle understandable, controllable, and empirically improvable:

> observe → weigh → act → evaluate → crystallize → expand

## The runtime is the agent

No model owns the loop. Models provide judgments, plans, transformations, or language when asked; their outputs return as evidence for the runtime to evaluate like any other observation. A fluent completion does not gain executive authority merely because it sounds intelligent.

Weave maintains an explicit representation of the current goal, relevant state, known facts, open questions, active work, available capabilities, constraints, approvals, budgets, and risks. Conversation history remains evidence, not the sole state of the system. The runtime decides what happens next from the current state rather than reenacting agency inside a prompt.

This makes inference a capability, not a throne. `request_inference` is one possible action among retrieval, execution, clarification, approval, communication, waiting, and completion.

## Decisions produce an action frontier

Weave does not reduce agency to a single generated “next action.” Its control layer weighs the actions that could advance the goal from the current state. The runtime then applies hard policy, confidence thresholds, dependencies, permissions, and resource constraints before anything executes.

Independent actions should proceed concurrently. Their results arrive as events and may change the value of work still in flight. Weave can continue, join, cancel, supersede, or open new threads as the frontier changes; it does not wait for an artificial conversational turn or batch boundary when useful state is already available.

The decision mechanism may begin with Jev, but Weave is not a Jev wrapper. Jev is a fast, typed, uncertainty-aware evaluator: it can weigh an action space and judge bounded claims such as whether check evidence supports crystallization. It is not a generator of contracts, tests, or resolvers, and it cannot waive a failed check. The durable contract is typed evaluation of state against an available action space. Models and providers may change without changing what Weave is.

## Deterministic policy bounds probabilistic judgment

Probabilistic decisions operate only inside deterministic boundaries. Authentication, permissions, spending limits, data boundaries, destructive actions, required approvals, and other hard invariants remain executable policy. A model may identify risk, recommend escalation, or express uncertainty; it cannot waive a boundary. Neither can the decision layer.

Human authority is explicit. Weave may pursue a goal autonomously only within the authority granted for that goal. Evidence is not authorization, inferred intent is not consent, and acquiring a new capability does not grant permission to use it. When intent or authority is insufficient, asking is progress.

Uncertainty is a first-class result. Weave prefers an honest request for clarification, another observation, or a stronger inference path over disguising uncertainty as action.

## Inference is routed by evidence

Weave asks for a kind of inference, not a particular model. A separate router selects among available models using deterministic policy, eval-derived preferences, required quality, latency, cost, privacy, context needs, and expected escalation cost.

The most capable model is not the default; the least expensive path that reliably meets the required quality is. A cheaper model may get first refusal where evidence supports it. A stronger model may be required immediately where risk or difficulty warrants it. Routing changes when evals change, not because a provider occupies a privileged place in the architecture.

Caching is part of state and routing, not an afterthought. Stable facts and validated results should not be rediscovered through inference. Cached conclusions retain their evidence, dependencies, and invalidation conditions so reuse never turns stale belief into hidden truth.

## Intent becomes AgentSOP; expansion is a mixed pipeline

Weave distinguishes three forms of capability:

- **Established capability** is versioned, constrained, evaluated software already available to the runtime.
- **Composed capability** emerges by combining established actions for the current goal without adding new machinery.
- **Frontier capability** is work the current action space cannot adequately perform and therefore requires exploration, often through generative inference.

The frontier is where models improvise: reasoning about an unfamiliar problem, composing a novel procedure, or writing an action the system does not yet possess. Successful exploration is not automatically learning. It becomes learning only when Weave can name the work as an AgentSOP capability and AgentFabric can bind a resolver that later invocations use directly.

AgentSOP is that naming. It is a semantic contract: what is being done, to which resource, with which effects, and what success looks like. It does not mention Weave, models, filesystems, or a resolver language. A capability document is durable; a resolver is disposable.

AgentFabric honours AgentSOP. It holds the catalogue of semantically named capabilities, issues ResourceRefs, evaluates grants, invokes resolvers, and crystallizes by binding a resolver to a name. A capability may exist and still be unresolved. AgentFabric does not schedule goals, choose the next action, or claim that generated code is trustworthy.

Weave is the minimally functional harness around that catalogue. Given a goal, it identifies gaps in what the catalogue can do, constructs candidates, validates them, and only then pushes the inference frontier forward by binding a new capability. Its runtime stays small: assemble state, assemble the live capabilities, submit that structure to the decision layer, and act on the weighted frontier. Domain behaviour belongs in capabilities, not in the loop.

Capability expansion is not one judgment and not one model. It is a mix of mechanisms, each doing only the work it can honestly do:

1. **Identify.** Compare a stated need to the catalogue. Unnamed or unresolved work is a gap. Deriving the need from unstructured goal text is inference, not identification.
2. **Construct.** Classic generative inference proposes an AgentSOP document, a test corpus, and a resolver in the shape AgentFabric requests. Construction is untrusted.
3. **Check.** Deterministic execution of the corpus: demonstrate red against a placeholder, prove green, and guard with held-out cases. Checks are evidence. They are not Jev and not a model.
4. **Evaluate.** The decision layer (Jev-shaped) makes a typed, uncertainty-aware judgment of that evidence: accept, reject, or uncertain. High uncertainty may escalate to generative inference. Evaluation cannot generate a candidate and cannot waive failed checks.
5. **Accept.** AgentFabric crystallizes by binding the resolver. Crystallization still does not grant the principal permission to invoke.

The lifecycle is:

> identify gap → construct document, corpus, and resolver → check (red, green, held-out) → evaluate (decision layer; escalate if uncertain) → AgentFabric crystallizes → grants permit invocation

The document is the stable identity. Resolvers are replaceable. Naming a capability, checking a resolver, evaluating the evidence, binding it, and authorizing invocation remain separate gates.

## Improvement must be measurable

Weave improves through traces, evals, and changes to its executable action space—not through the claim that a growing transcript is learning.

Every consequential cycle should be explainable after the fact: what state was known, which actions were considered, how they were weighted, which policies filtered them, what executed, what changed, and why the goal was considered advanced or complete. This record exists for evaluation and accountability, not as an ever-growing prompt.

Production outcomes feed evaluation. Evaluation informs routing, thresholds, composition, and whether an improvised procedure deserves crystallization. A new model or capability enters the system by demonstrating where it improves the frontier; it does not require the runtime to be redesigned around it.

Progress is not measured by eliminating inference. It is measured by expanding the goals Weave can advance safely and reliably, while moving familiar work from expensive exploration into established software and freeing inference for problems that remain genuinely new.

## The system stays legible as it grows

Self-building software must not become self-obscuring software. State, policy, action contracts, routing rules, provenance, and capability code remain inspectable and replaceable. Hidden prompts, vendor-specific behavior, and irreproducible model intuition must not become the only explanation for important behavior.

The core should remain small enough to trust: state assembly, capability assembly, decision, policy, scheduling, and evidence capture. AgentSOP and AgentFabric sit beside that core. Domain knowledge belongs in capabilities. Weave should grow outward through its action vocabulary, not inward through an increasingly magical runtime.

## Scope

Weave is a goal-directed runtime for selecting, parallelizing, evaluating, and expanding software capabilities over evolving state.

It is not a chatbot framework with a more elaborate tool loop. Conversation is one interface and responding is one action.

It is not a model-training system. Weave improves the software and policy surrounding models; it does not claim that the models themselves learn through use.

It is not permissionless self-modifying software. Naming a capability, checking a resolver, evaluating the evidence, crystallizing it, and authorizing invocation are separate gates.

It is not a replacement for deterministic application logic. Its purpose is to discover, compose, and extend reliable logic where goals encounter an incomplete action space.

It is not defined by Jev, any generative model, any provider, or any tool protocol. Those are replaceable participants in the architecture. Jev is the initial decision layer, not the constructor of new capabilities.

A change aligns with Weave when it makes evolving state more explicit; improves action weighting or parallel execution; preserves deterministic authority boundaries; makes inference more interchangeable and empirically routed; turns semantic intent into an AgentSOP document; keeps AgentFabric as the invocation runtime; keeps construction, checks, evaluation, and crystallization as separate expansion gates; turns repeated reasoning into a named, grant-bounded capability; strengthens provenance, observability, rollback, or evaluation; or expands the reliable action frontier without hiding how.

A change should be resisted when it gives a model implicit control of the loop; treats conversation history as the only state; serializes independent work around artificial turns; lets probabilistic judgment or decision-layer evaluation override hard policy or failed checks; equates generated code or generated tests with trusted evidence; crystallizes a resolver without an AgentSOP document, passed checks, and an accept evaluation; couples the runtime's identity to one model or vendor; treats Jev as a generator of capabilities; optimizes cost at the expense of the required quality; mistakes activity for progress; or makes the system more capable by making it less legible.
