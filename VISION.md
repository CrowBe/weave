# Vision

Weave exists to build software that expands what it can reliably do and improves how it does it, through evidence-backed changes to its capabilities and operating strategies.

Weave is the composable system. Loom is its reference runtime, Fabric its reference capability subsystem, and Tapestry its reference presentation layer. A component can be replaced through a bounded interface without requiring its neighbours to adopt its internals. The names of the packages are unchanged: `packages/weave` is Loom, and `packages/agentfabric` is Fabric.

Most agent systems place a generative model at the centre of a loop: the model receives a message, decides what to do, calls tools, and speaks again. Weave treats that as an implementation accident. A user message, a tool result, an inference result, an approval, an error, and a change in the environment are all observations that update state. From that state, Weave continuously weighs the actions available to it, executes the viable frontier—concurrently when it can—and evaluates the state that follows.

Weave is System-1 first. Typed extraction and decision models turn observations into structured state and choose actions. Generative models are invoked only when a task node exceeds the decomposition frontier, and then with a pre-targeted brief.

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

The decision mechanism may begin with Jev, but Weave is not a Jev wrapper. The durable contract is typed, uncertainty-aware evaluation of state against an available action space. Models and providers may change without changing what Weave is.

## Decomposition frontier

Not every task reduces to one action, and not every task should reach a generative model. The decomposition frontier is the boundary between work Weave can carry by extracting, deciding, and splitting, and work that must escalate to generation. It is distinct from the action frontier: one bounds how far typed judgment carries a task, the other is the set of actions viable now.

> extract → check fidelity → decide band → decide action or spawn → act, ask, or escalate

Extraction fills a typed schema from an observation; the original remains authoritative. A fidelity check decides whether a decision uses the original only, uses the extracted hints, or extracts again. The first decision chooses a coarse band from a closed set—`tool_call`, `spawn_subtasks`, `escalate_gen`, or `ask_human`—without seeing the capability catalogue. Keeping the catalogue out bounds its output to that closed set; the aim is that its precision holds as the action vocabulary grows, and that precision is measured over time rather than assumed. Only after `tool_call` does a second decision choose the capability, and a targeted extraction fills that capability's arguments from the original and earlier extractions. A spawn produces child task nodes; a sequence is children joined by `depends_on`, not a separate kind of node.

Preflight is a spawn, not a bare escalation. When work must read before it generates—a coordinated code change, a document revision, a ticket—a decision over a closed set of candidate targets assigns each one a role: `edit`, `read`, `forbid`, or `skip`. Children gather the targets, concurrently where they can, and a single `escalate_gen` child depends on them, carrying a brief that names what may change and what must not.

A generative call reasons about what to produce; which capabilities to use and which resources to target are decided upstream wherever a judgment site exists. Its brief carries those targets, constraints, acceptance checks, and the chosen tier. Its output returns as an observation and passes through extraction and decision again—to be verified, applied, or split further.

Each task node is scored on measurable axes: residual ambiguity after extraction, coupling among artifacts that must change together, context span that cannot be reduced, irreversibility of the action, judgment-site confidence and margin, novelty relative to crystallized or verified paths, and expected generation size. The scores place the node in one band:

- **ACT** when no ambiguity remains, a single target is coupled, confidence and margin clear the site's thresholds, and the action is reversible or already approved.
- **SPLIT** when coupling or ambiguity remains and a split proposes children that each score better than the parent. Splitting recurses while it shows gain within the goal's cost budget, not to a fixed depth.
- **ESCALATE-GEN** when splitting yields no gain—the children are not simpler or the coupling is irreducible—or the output is inherently generative. A judgment site selects the tier from coupling, context span, and generation size.
- **ASK-HUMAN** only when an irreversible action falls below its confidence threshold, or when the ambiguity is one only the operator can resolve.

Thresholds are measured, not asserted. Escalation past the frontier is expected; it should happen because the work requires generation, not because Weave could not break the work down. The frontier is measured by the share of task nodes resolved below ESCALATE-GEN and by cost per resolved task, tracked over time.

`intake.classify`, D1 triage, and D2 route hold dispatch authority now, not as a later expansion of the frontier: when one of them clears its thresholds, its decision dispatches the chosen action, subject to deterministic policy and the grants already in force. It cannot mint a grant or waive a boundary. An advisory-only site, whose output is recorded but never dispatches, does not meet this requirement for these three. Beyond them, the frontier moves outward through better extraction schemas, judgment sites with dispatch authority, splits that prove their gain, and crystallization of proven paths into software.

## Deterministic policy bounds probabilistic judgment

Probabilistic decisions operate only inside deterministic boundaries. Authentication, permissions, spending limits, data boundaries, destructive actions, required approvals, and other hard invariants remain executable policy. A model may identify risk, recommend escalation, or express uncertainty; it cannot waive a boundary.

Human authority is explicit. Weave may pursue a goal autonomously only within the authority granted for that goal. Evidence is not authorization, inferred intent is not consent, and acquiring a new capability does not grant permission to use it. When intent or authority is insufficient, asking is progress.

Uncertainty is a first-class result. Weave prefers an honest request for clarification, another observation, or a stronger inference path over disguising uncertainty as action.

## Inference is routed by evidence

Weave asks for a kind of inference, not a particular model. A separate router selects among available models using deterministic policy, eval-derived preferences, required quality, latency, cost, privacy, context needs, and expected escalation cost.

The most capable model is not the default; the least expensive path that reliably meets the required quality is. A cheaper model may get first refusal where evidence supports it. A stronger model may be required immediately where risk or difficulty warrants it. Routing changes when evals change, not because a provider occupies a privileged place in the architecture.

Caching is part of state and routing, not an afterthought. Stable facts and validated results should not be rediscovered through inference. Cached conclusions retain their evidence, dependencies, and invalidation conditions so reuse never turns stale belief into hidden truth.

## Intent becomes contract; tests admit capability

Weave distinguishes three forms of capability:

- **Established capability** is versioned, constrained, evaluated software already available to the runtime.
- **Composed capability** emerges by combining established actions for the current goal without adding new machinery.
- **Frontier capability** is work the current action space cannot adequately perform and therefore requires exploration, often through generative inference.

The frontier is where models improvise: reasoning about an unfamiliar problem, composing a novel procedure, or writing an action the system does not yet possess. Successful exploration is not automatically learning. It becomes learning only when Weave can extract a reusable contract, test it against examples and counterexamples, constrain its effects, and admit a versioned capability to the registry.

Crystallization begins with the contract, not the implementation. When Weave identifies a recurring semantic purpose or a gap in its action space, it establishes the capability's inputs, outputs, invariants, failure modes, effects, permissions, success evidence, and execution constraints. That contract may be induced from successful traces or designed before implementation. Either direction must converge on the same thing: an independently testable statement of what the capability means.

Fabric provides the reference boundary between intelligence and software. It defines the capability contract and the lifecycle through which a proposed capability is tested, packaged, versioned, admitted, observed, and revoked. Loom uses its capability host through a narrow interface; another provider can satisfy that interface without adopting Fabric's internals. Weave does not hide capability semantics inside Loom's scheduler or prompts.

Once a contract is established, Weave generates executable tests before implementation. Independent inference can explore examples, boundaries, invariants, failures, permissions, side effects, retries, cancellation, and adversarial cases in parallel. Proposed tests must themselves earn trust: they are checked against known evidence, placeholder or invalid implementations, and mutations where useful. Contradictory tests expose an incomplete contract rather than becoming competing instructions to the implementer.

Only then does Weave ask suitable models to produce one or more implementations. Deterministic execution—type checking, tests, static analysis, effect controls, and resource limits—provides the admission evidence. Held-out tests guard against fitting only the visible examples. Probabilistic evaluation classifies unresolved semantic questions and directs the next iteration; it does not turn a failing implementation green.

The lifecycle is red-green in real time:

> identify opportunity → establish contract → generate and validate tests → observe red → generate implementation → prove green → admit capability

Implementation is replaceable; the contract is the stable identity. Several local, remote, composed, or generative implementations may satisfy one contract, and routing among them can be empirical. Capability creation, capability admission, and authority to execute remain separate gates.

Anything the system repeatedly has to reason through is a candidate for software, but not everything should crystallize. Contextual explanation, taste, ambiguity, and genuinely novel judgment may remain generative. Recurrent mechanics, transformations, lookups, and verifiable procedures should be pushed downward into cheaper, narrower, more reliable capabilities.

New capabilities earn trust. They carry provenance, permissions, version, dependencies, contract and test revisions, eval results, observed reliability, cost, and risk. They begin constrained, remain inspectable, and can be disabled or rolled back. Generated code is untrusted until the same evidence that would justify any other capability says otherwise.

## The harness extends and optimises itself

Extension expands what Weave can do. Optimisation improves how it achieves authorized outcomes. Crystallization can serve both: a new capability can enable a previously impossible goal or replace repeated inference with reliable software. Optimisation also improves existing implementations, prompts, context selection, routing, work strategies, scheduling, and information gathering without necessarily adding a capability.

Better means better outcomes under the goal's constraints: higher success rates, better results, less human correction, faster completion, or lower total cost. The preferred trade-offs must be explicit. A cheaper result that misses the required quality bar is not an improvement, and gains on one workload do not establish gains on every workload.

Weave improves through bounded experiments. Each experiment states the weakness being addressed, a versioned baseline and candidate change, its intended workload, the benefit sought, protected constraints, evaluation method, budget, promotion conditions, and rollback target. Evidence must support the comparison; uncertainty can justify further evaluation or retaining the baseline.

> observe outcomes → identify a weakness → propose a change → compare with a baseline → authorise promotion → monitor → retain or roll back

An optimiser cannot redefine success to make its candidate win. Evaluation criteria and protected checks remain independently governed; proposed changes to them require separate justification and authority. Replay can compare decisions on recorded inputs, but cannot establish the outcomes of actions that were never taken. Changes that alter execution require suitable isolated trials or limited authorised deployment before broader promotion.

The harness implementation is also eligible for improvement. Its state queries, scheduling implementation, and other mechanics may be replaced while preserving their contracts. Changes to the control core pass through a separately governed, versioned release path; the optimiser cannot relax authority boundaries, weaken admission checks, or rewrite the running core opportunistically. Capability admission, optimisation promotion, and authority to execute remain distinct decisions.

Experiments consume an explicit budget and compete with useful goal work. Failed trials, evaluation, human review, and rollout costs count toward their expected benefit. Optimisation is successful only when a scoped change earns continued use through measured outcomes; it is not a mandate for endless self-modification.

## Improvement must be measurable

Weave improves through traces, evals, and validated changes to its capabilities and operating strategies—not through the claim that a growing transcript is learning.

Every consequential cycle should be explainable after the fact: what state was known, which actions were considered, how they were weighted, which policies filtered them, what executed, what changed, and why the goal was considered advanced or complete. This record exists for evaluation and accountability, not as an ever-growing prompt.

Production outcomes feed evaluation. Evaluation informs routing, thresholds, composition, and whether an improvised procedure deserves crystallization. A new model or capability enters the system by demonstrating where it improves the frontier; it does not require the runtime to be redesigned around it.

Progress is not measured by eliminating inference. It is measured by expanding the goals Weave can advance safely and reliably, while moving familiar work from expensive exploration into established software and freeing inference for problems that remain genuinely new.

## The system stays legible as it grows

Self-building software must not become self-obscuring software. State, policy, action contracts, routing rules, provenance, and capability code remain inspectable and replaceable. Hidden prompts, vendor-specific behavior, and irreproducible model intuition must not become the only explanation for important behavior.

The core should remain small enough to trust: state transitions, policy enforcement, action scheduling, capability contracts, and evidence capture. Domain knowledge and task-specific machinery belong in capabilities around that core. Weave should grow outward through its action vocabulary, not inward through an increasingly magical runtime.

## Scope

Loom is the goal-directed runtime inside Weave: it selects, parallelizes, evaluates, expands, and optimises software capabilities and operating strategies over evolving state.

It is not a chatbot framework with a more elaborate tool loop. Conversation is one interface and responding is one action.

It is not a model-training system. Weave improves the software and policy surrounding models; it does not claim that the models themselves learn through use, and it does not train models in the near term. It measures per-site performance and, when thresholds are met, proposes fine-tunes of small decision models with a dataset manifest; training happens outside Weave.

It is not permissionless self-modifying software. Capability creation, capability admission, and authority to execute are separate gates.

It is not a replacement for deterministic application logic. Its purpose is to discover, compose, and extend reliable logic where goals encounter an incomplete action space.

It is not defined by Jev, any generative model, any provider, or any tool protocol. Those are replaceable participants in the architecture.

A change aligns with Weave when it makes evolving state more explicit; improves action weighting or parallel execution; preserves deterministic authority boundaries; makes inference more interchangeable and empirically routed; turns semantic intent into a testable Fabric contract; turns repeated reasoning into a constrained, evaluated capability; strengthens provenance, observability, rollback, or evaluation; demonstrates a scoped improvement against a versioned baseline without weakening protected constraints; or expands the reliable action frontier without hiding how.

A change should be resisted when it gives a model implicit control of the loop; treats conversation history as the only state; serializes independent work around artificial turns; lets probabilistic judgment override hard policy; equates generated code or generated tests with trusted evidence; crystallizes behavior without a reusable contract, demonstrated red, and deterministic validation; couples the runtime's identity to one model or vendor; optimizes cost at the expense of the required quality; mistakes activity for progress; lets an optimiser redefine success or promote its own changes without the required evidence and authority; or makes the system more capable by making it less legible.
