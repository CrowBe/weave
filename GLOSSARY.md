# Context

This file defines Weave's ubiquitous language. Use these terms consistently in code, tests, issues, and discussion. If the model changes, update the language here before introducing competing names.

## Core model

### Weave

The composable system. Loom, Fabric, and Tapestry are its reference runtime, capability subsystem, and presentation layer; a composition may replace any of them through a bounded interface. Do not use *Weave* to mean the runtime, a model, an agent persona, or an individual capability.

### Loom

The goal-directed runtime, namespaced Weave Loom. Loom owns state transitions, scheduling, policy enforcement, evidence capture, and the action loop. The package is `packages/weave` until a later rename. A model is not Loom.

### Goal

The outcome Loom is currently authorized to pursue. A goal includes its scope and authority; it is not merely the latest operator observation.

### State

The explicit, evolving representation of what matters to the goal: known facts, open questions, active work, capabilities, constraints, approvals, budgets, risks, and relevant evidence.

### Observation

A recorded input that may support a state transition: operator input, a capability result, an inference result, an approval, an error, a timeout, or an environmental change. Its provenance establishes what was observed, not that every claim in its payload is true or authorized.

### Slice

A named, versioned, budgeted query over state. Views — state views, context bundles, typed capability inputs — are composed from slices, with deterministic selection, disclosed truncation, and a manifest recording what actually filled each one so a recorded judgment can be reproduced.

### Slice assembly

The recorded fill of one or more slices at one state revision. Every view that uses those slices cites the same assembly. Its cost is counted once. An assembly does not grant disclosure; each consumer still receives its own view.

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

Restoring unfinished work from durable records, preserving reservations and reconciling external outcomes under current authority before continuation or retry. Recovery is distinct from historical replay and does not renew an approval or resource budget. Each lookup attempt is a recorded observation that counts against a finite allowance reconstructed after restart; a zero allowance is exhaustion, not an unbounded budget.

### Reconciliation

Authorized, resource-bounded gathering of evidence about an existing invocation's external outcome without blindly repeating its effect. It may confirm a committed effect, confirm stopped execution without that effect, or leave uncertainty explicit.

### Action

A typed operation Loom may execute to advance a goal. Retrieval, execution, inference, clarification, approval, communication, waiting, and completion are all actions.

### Action frontier

The currently viable set of weighted actions. It may contain several independent actions that can execute concurrently. Avoid *next action* when multiple actions may be viable.

### Thread

A causally related sequence of actions and observations within a goal. Threads may run concurrently, join, be superseded, or be cancelled. A thread is not an operating-system thread.

## Intelligence and control

### State view

A bounded, typed, versioned rendering of authorized state for a particular consumer. It carries source revisions and disclosed omissions rather than serving as an independent source of truth.

### Intake classification

The channel-agnostic `intake.classify` judgment site proposes how an inbound
message relates to summaries of running threads: `new_thread`,
`continue_thread`, `queue`, `steer`, `interrupt`, or `stop`. A deterministic
confidence rule records the observation and returns `ask_user` / `needs_human`
when uncertain. Classification grants no authority to execute or interrupt.

### Judgment site

A named place where bounded judgment is requested for a specific purpose, with typed inputs and outputs and its own evaluation history. Weighing, semantic matching, and response evaluation are distinct sites; a model such as Jev may serve more than one.

### Decision layer

The judgment site that evaluates state against possible actions and returns weights. Jev is the initial model type behind it. The decision layer proposes weights; it does not select models and it does not override policy.

### Acceptance line

A proposed statement that a task is done. It names one fact, the artifact or command output that can show it, and an escape for when that state cannot show the fact. Under `acceptance.line@2` the fact is either free text or an acceptance predicate, never both. A proposal is an observation. It does not change the goal and it does not grant execution.

### Acceptance fact

An acceptance line that code has admitted. It is one observable fact. A count, a date, a total, or a taste judgment is not an acceptance fact. A free-text acceptance fact is one boolean question — a Noul on the System One wire — and nothing else. A predicate acceptance fact is decided by code and is never asked. Each recorded fact says which: `decided_by: code` or `noul`.

### Acceptance predicate

A closed property on an acceptance line that code can decide from its named evidence: `exit_status` (a command's recorded exit status equals an integer) or `contains_literal` (an artifact body or command output contains an exact literal). There is no regex and no arithmetic. Code renders the fact text from the predicate, admits it only on a fitting evidence kind, and decides it without the criteria gate or task validation. A failed predicate fails the fact; missing evidence, including an unrecorded exit status, escapes. A predicate establishes only its literal property: "the README contains `--dry-run`" may be a predicate, while "the README documents `--dry-run`" stays free text. It is not a completion predicate for a goal and grants nothing.

### Criteria gate

The judgment site `task.criteria`. Before a run it asks whether each proposed free-text line is one property and observable from the named evidence. An acceptance predicate is not asked; code checks that it fits its evidence kind. Low confidence is an explicit revise or reject. The site does not write a plan, select an action, do arithmetic, or grant execution. It is not the decision layer and it is not `frontier.weigh`.

### Task validation

The judgment site `task.validate`. It asks one boolean question per free-text acceptance fact about a state built from that fact and its artifact or command output. Predicate facts are decided in code from the same evidence and combine with the Noul verdicts under the same dispositions; a task whose facts are all predicates sends no request. Code decides done from thresholds declared before the run, and from the constraints and authority declared for that task. A constraint such as do-not-send is not a ban on every task: it fails a command only when this task declares it and this task's authority does not permit the effect. An ask permits a smaller consequential command when that constraint is declared; it does not authorize send or delete. Those constraints are not Noul questions. A write-up is not part of the validation state and cannot override a failed fact. The site grants nothing and executes nothing. It is not `frontier.weigh`.

### Action proposal

A suggested operation, binding, or dependency structure recorded as an observation. It can inform candidate formation but carries no authority to execute.

### Action candidate

A typed, bound action produced by validating an established procedure or a recorded proposal, with supporting evidence, dependencies, read set, effects, and resource needs. Being a candidate does not grant authority to execute.

### Effect lock

A reservation over canonical resources and effect scopes that constrains concurrent execution. Its safety depends on enforced access to those scopes, including nested work and collection effects.

### Weight

A decision-layer estimate associated with a candidate action or bounded semantic claim. A weight is evidence for routing, not authorization or proof.

### Inference

Requested model work such as reasoning, synthesis, classification, transformation, or language generation. Inference is an action available to Loom, not the owner of the loop.

### Inference role

Why an inference was requested: framing proposes subgoals, success criteria, and desired operations; working performs a scoped operation; extension authors contracts, corpora, or implementations. Proposals do not change the authorized goal or its completion bar by themselves.

### Inference kind

What is being asked of a model — classify, extract, transform, draft-contract, judge. A kind carries a context profile, prompt template versions, acceptance defaults, a default tier, and the statistics routing reads. Kinds belong to the gateway's vocabulary, not to the capability catalogue: a capability is named for its semantic operation, and its generative implementation declares the kind.

### Context profile

A versioned declaration of the state slices an inference kind requests, their depth and budget, and disclosure constraints. It describes context needs without granting access to the requested data.

### Desired operation

An operation a goal appears to need, described by semantic purpose, expected effects, and rough input and output shape. It is a proposal to assess against existing capabilities and compositions, not an executable contract or proof of a capability gap.

### Inference gateway

The module that performs bounded model work under explicit scope, acceptance, authority, and resource limits. It owns routing, attempts, and evaluation, while goal scheduling and state transitions remain Loom’s responsibility.

### Routed unit

A versioned context profile, prompt template, model, and settings selected together for inference. Evaluation evidence attaches to that combination.

### Training-allowed destination

A data destination whose provider may train on disclosed content. A routed unit marks it with `destination_training_allowed: true`; the mark applies to every unit sharing that destination. Routing excludes it unless the caller explicitly classifies the request as `public` or `non_sensitive`, even when the destination is otherwise permitted. Before routing the gateway screens content for the repository's credential markers at token starts. A match excludes every unit at that destination with reason `credential_content`, also recorded as a content-free note in outcome `uncertainty`, without consuming attempts. A permitted non-training destination may still receive the original content. When only excluded training destinations remain, the outcome is blocked with `no_route` and nothing is dispatched. Screening is a final safeguard, not permission to send sensitive or private material.

### Free-model allowlist

The fixed default list of provider model IDs that a free-only adapter may call, each verified with every pricing field exactly the string `"0"` and no overrides in the provider's live catalogue on a recorded date. Nous Portal's default list is `NOUS_PORTAL_FREE_MODELS`; `isNousPortalFreeModel` tests only this list. Route-config parsing rejects a unit that names any other ID or declares a non-zero price. The adapter refuses an ID outside the default list before any request unless it meets the separate promotional free model contract below. A paid twin, the same name without `:free`, is never on either list. Being listed is not evidence that a model is still free; the catalogue price check and the response cost decide that.

### Catalogue price check

The adapter's check of the provider's live model catalogue before its first request for a model. The model must be listed, and every scalar pricing field, including nested fields and override-tier prices, must be the number `0` (including numeric `-0`) or an unsigned decimal string with an all-zero mantissa matching `^0+(\.0+)?([eE][+-]?[0-9]+)?$`, such as `"0.0000000000"` or `"0e0"`. Nonzero mantissas fail closed even when `Number(value)` underflows to zero. Leading signs, whitespace, nonzero or non-numeric values, missing prices and empty price objects fail closed. An unlisted model fails as retryable unavailable so routing can escalate. A non-zero or unreadable price refuses the model for that adapter instance. A failed or abandoned check sends no request and is never kept as a pass. Concurrent first calls share one check. A price pass lasts for the adapter instance, independently of promotional expiry. A refusal that suggests the model changed (402, 404, "no longer free", "requires available credits") discards the pass. A reported response `usage.cost` that is not exactly the number `0` also refuses the model. The check is a price safeguard, not authority to send content: privacy routing still decides that.

### Promotional free model

A model admitted under a bounded zero-price promotion. For Vercel, its caller-supplied provider catalogue must establish an unconditional zero input and output price before each attempt, with no additional pricing fields, provider-dependent price, or expired deprecation boundary. Vercel promotional free models use the training-allowed destination `vercel-ai-gateway-free`. Catalogue evidence and caller time are injected; snapshot freshness belongs to the caller. Missing or invalid evidence refuses dispatch. Acceptance also requires a reported zero response cost; missing, invalid or nonzero cost records a nonretryable failure. The largest positive charge reported in `cost`, `marketCost`, or `gatewayCost` is converted to micros and metered on that failed attempt; these potentially overlapping figures are not summed. A verified zero stays zero regardless of declared token prices. The promotional adapter opts into settlement after abort: cancellation or deadline fixes the failure disposition, while the gateway allows final usage up to a 100 ms grace period through its injected Timer before recording the attempt. Usage arriving within the grace is metered; on expiry the interrupted failure retains default unknown usage, so a transport that ignores abort cannot prevent the outcome from settling. The grace is independent of the aborted caller signal and its timer is cancelled when settlement arrives promptly. This check can detect a price change after dispatch but cannot undo a provider charge. It grants neither disclosure permission nor authority to execute.

For Nous Portal, `NOUS_PORTAL_PROMO_MODELS` holds LongCat 2.5 Preview and Beam with `id` and `expires_at` (epoch milliseconds), separate from the default free-model allowlist. Both expire at 2026-10-23T10:30:00+11:00. They require explicit adapter `promoModels: true` and an injected `now: () => number`. Missing, invalid or throwing time fails closed. At/after expiry the adapter sends no request, including catalogue lookup, and that model stays refused for the instance even if time regresses. Before expiry, the existing catalogue price check and response `usage.cost` guard still apply; a price pass cannot extend expiry. The adapter checks time again after catalogue resolution before chat dispatch. Route-file parsing remains scoped to the default allowlist; opting in uses programmatic routed units. Privacy, cancellation and authority boundaries still apply.

### Content class

The caller's classification of all request content: `public` is publicly shareable, `non_sensitive` contains no confidential material, `sensitive` requires protection, and `private` includes private repository and operator data. Inference terms carry it as `content_class`. An absent class is treated as sensitive for training disclosure; classification does not add a permitted destination. Private repository or captain data must never be classified as public or non-sensitive.

### Tier

A configured routed-unit attribute: `decision`, `flash`, `standard`, or `strong`. A tier identifies the role and resource class requested for a step; it is not a quality bar. Routing still enforces quality, destinations, context, and budget independently of tier. It is a routing attribute and is unrelated to execution tier.

### Decision provider

An evaluation adapter serving judgment sites in the decision-model loop, selected by configuration. `decision.provider` names the default, which must be `typesafe-jev` (TypeSafe Jev); OpenAI Decisions may be described under `decision.providers` but cannot yet be selected. `decision.sites` overrides the provider for `intake.classify` and `loop.preselect` only, with `typesafe-jev` or `amos`. Amos is a local, loopback-only provider with no credentials at destination `local`; an override to it needs an Amos evaluate unit of that site's kind (choice for intake, boolean for preselect). Selection is exclusive: a site never retries against another provider, and an Amos outage is `provider_unavailable`. Its typed answers are observations; deterministic policy decides transitions and authority to execute.

### Preselect policy

The deterministic rule for D3 `loop.preselect`. It keeps the top k disclosed catalogue entries by p(true), applies an optional probability floor, and always keeps entries the guardrails require. It narrows only when that kept slice clears a margin: the best excluded p(true) is at most `max_excluded` (default .4) and the gap below the highest kept non-required p(true) is at least `min_margin` (default .3). Nothing excluded means there is nothing to gate for the margin or for a low confidence. A missing confidence is unknown. A published confidence below .75 blocks only on the boundary of that slice. A published confidence that is not a finite number from 0 to 1 fails safe and returns the full index. A floor that keeps no non-required entry returns the full index with reason `no_candidate`. k is an integer from 1 to 8 and defaults to 3. The floor defaults to 0, which leaves it off. The cap of 8 bounds k and does not drop required entries. The selection record (`preselect-selection@2`) is evidence of that rule, including the caller-supplied policy provider and the routed unit that answered. A model answer does not choose k, and the record confers no grant.

### Wire profile

Pure request and response translation for one provider's protocol, carried by a shared transport. A wire profile maps the gateway's typed questions and answers to and from the provider's shapes; it does not own routing, policy, credentials, or runtime state.

### Tidy state

The `view.audit@1` state view handed to the audit tier. It assembles the goal, criteria, plan, recorded decisions, artifacts, checks, evaluations, open issues, and budget from authorized slices, with omissions, source revisions, and a digest. It preserves evidence rather than replacing state with a transcript summary.

Audit evaluations carry their producing audit iteration when known. Completion
uses only evaluations matching the tidy state's current iteration; historical
or unknown iterations cannot supply a current pass. An implementation retry
attempt is not an audit iteration.

### Audit tier

The review stage that requests a `strong` routed unit to examine tidy state for gaps, defects, regressions, and scope creep. It is a stage that requests tier `strong` and is not a member of the tier vocabulary. An audit report is an observation; its claim that the goal is met cannot replace deterministic success evidence or grant execution authority. Budget pressure pauses this stage rather than weakening its requested tier.

### Decision outage pause

An audit round's resumable `decision_unavailable` outcome when dispatch needs D4
and decisions are unavailable. Explicit resumption observes availability again;
the pause grants no authority and cannot bypass D4 or D7.

### Implementation step

One generate call at a routed tier, followed by the configured repo checks and D5 output evaluation of the criteria whose criterion proof is `judgment`. Retries and a single tier escalation stay inside the step and share one execution id. Each check on each attempt uses a fresh grant of equal scope from the composition root. The step records artifact refs, check outcomes, and criterion verdicts. It cannot mint a grant, pass the D2 ceiling, or complete the goal. A decision answer cannot mint one either.

### Criterion proof

How a success criterion is proven: `check` or `judgment`. Decomposition proposes it. Code admits `check` only when every bound check takes its verdict from an oracle that the check's grant may read and that the implementation step's generation cannot write, compared by the host's canonical resource identity. Anything else is `judgment`. A `check` criterion is settled by green runs of its bound checks in the current audit iteration and needs no D5 pass; a `judgment` criterion keeps D5. A criterion proof grants nothing and leaves every other completion gate in place.

### Progress delta

The `progress.delta@1` comparison of two consecutive tidy states that comes before D8. For each criterion it records whether the criterion was settled before and after, plus one digest over each state's checks, evals and artifacts. A settled criterion has green bound checks and no current failing D5 eval, and a `judgment` criterion also has a current confident D5 pass. A deterministic rule reads the delta: unchanged evidence is `stalled`, criteria only gained is `progressing`, and criteria only lost is `regressing`. Anything else asks D8. The `progress.record@1` names which path decided, and replay reads that record. The rule chooses only among D8's options, adds no stop condition, and grants nothing.

### Open issue

A blocker recorded when an implementation step stops after retries and one escalation, when that escalation is blocked by the ceiling or the budget gate, or when an audit finding receives `fix_now`. It carries the affected criterion ids; an audit issue has a stable finding identity for repeated-fix detection. Raising an open issue does not dispatch work, mint a grant, or complete the goal.

### Routing

The deterministic selection step inside the gateway. It minimizes expected total cost of reaching the declared quality bar — retries and escalation included — using recorded per-site success rates, cost, latency, privacy, and context limits. When a prefix cache is supplied, that cost includes a hit discount or one reload.

### Prefix cache

A recorded match between one routed unit and the digest of a view's stable prefix, together with a cached token count. A matching digest discounts that unit's input cost. A different unit or digest is one reload at the selected unit's input price. With no record, input cost stays the cold window. A prefix cache is not a cached conclusion, a provider bill, or authority.

### Generative implementation

An implementation of a capability contract that depends on inference. Its admission requires applicable deterministic checks and versioned evaluation evidence; its maturity and execution scope are limited by that evidence and policy.

### Quota snapshot

An injected observation of whole-account quota-axi provider totals, with collection time, provider status, quota windows, reset times and pace. It is data for deterministic budget policy, not authority to execute. A routed unit's `quota_provider` names the account provider independently of adapter and destination.

### Budget gate

The deterministic `budget.policy@1` filter applied before every routed dispatch. Known weekly usage at ≥80% excludes the provider; five-hour pressure prefers another provider or pauses; ahead pace downgrades strong work to standard while audit pauses. Unknown quota fails closed for strong, while decision and flash remain bounded by the gateway cost ceiling.

### Loop pause record

Persisted `loop.paused` evidence that budget policy stopped dispatch, carrying the reason and a known reset time (`until`), or null when a new observation is required. It does not schedule resumption or confer authority at reset.

### Policy

Deterministic rules that bound action: permissions, approvals, spending limits, data boundaries, and destructive-operation controls. Policy always outranks a probabilistic recommendation.

### Evidence

Recorded support for a claim or transition: traces, test results, static analysis, observed effects, approvals, or model judgments. Evidence does not itself grant authority.

## Capability system

### Capability

A typed, invocable unit of software that satisfies a capability contract. The contract is the capability's stable identity; implementations are replaceable.

### Capability gap

A semantic operation required to advance the goal that the current capability set cannot adequately perform through execution or composition.

A capability gap may also be recorded for a check capability when D5 or the audit catches the same finding in a declared number of executions. Its recurrence key is the finding kind, criterion and check-relevant evidence, never free text or the execution id. The record cites those executions and names a desired operation. It grants nothing: it reaches crystallization only as the `gap` of an operator goal, through the gap search and every later gate, and the audit keeps running however many checks are admitted.

### Capability contract

The standardized statement of a capability's purpose, inputs, outputs, invariants, failures, effects, permissions, success evidence, and execution constraints.

### AgentSOP

The contract layer within Fabric, defining capability meaning, typed inputs and outputs, effects, authority, references, and failures. It has no dependency on either runtime. The package is `packages/agentsop`. The external AgentFabric repository is a conceptual reference only.

### Fabric

The reference capability subsystem, namespaced Weave Fabric. It owns contracts through AgentSOP and governs construction evidence, invocation, admission, revocation, and audit. It ships with the reference Weave stack and stays independent of Loom’s goals, state, and scheduling. The package is `packages/agentfabric`. Say *Fabric* in architecture vocabulary. *AgentFabric* names that package and the external conceptual reference, not a second subsystem.

### Resource reference

An opaque, host-issued handle to a resource, carrying a coarse kind and never a locator. Knowing a locator is not possessing a reference, and possessing a reference is not having authority to act on it.

### Effect

A declared consequence of invoking a capability, drawn from a closed, versioned vocabulary (`discover`, `read`, `create`, `write`, `append`, `delete`). Pure transformations declare none. Adding an effect is a contract revision. Process shell-out adds a second closed vocabulary beside those modes: `process.spawn` and `fs.write:<resource reference>`. A grant for that work matches the bound set exactly. `env_allow` names variables; the host injects the values, and those values are not arguments, logs, traces, or observations.

### Principal

An identity to which authority can be granted. Loom, a goal, or an external caller may be a principal; a model is not.

### Grant

Authority for a principal to invoke a capability, scoped to resources and effects. Loom's policy issues an execution grant per action at dispatch; the host checks it at invocation. Admission does not issue one.

### Approval

An authenticated decision by an entitled principal on a bound request, within that principal's authority and the goal's ceiling. Its scope and validity inform policy without replacing execution grants or enforcement; payload claims, retained history and silence do not establish approval.

### Trusted ingress

A handle created by trusted bootstrap that may submit observations with a privileged provenance (operator, host, or clock). Untrusted observation payloads cannot choose those identities. Possession of a provenance string is not ingress.

### Resolver context

The interface through which an implementation reaches its environment: nested invocation limited to declared dependencies, and reference-scoped resource operations. It contains no locators or substrate types, so it can be brokered across an isolation boundary. An unbound context grants no resource access.

### Execution tier

Where an implementation or generated test runs. The `trusted` tier is host-owned code. The `untrusted` tier is generated code and generated tests, which run only under enforced isolation. Missing isolation blocks execution; it does not fall back to the trusted tier.

### Held-out report

The only result returned from protected admission tests to an implementer or corpus author: how many cases passed, how many failed, and the failure codes. It does not include inputs, expected outputs, artifact bodies, or which case failed. One report is available per implementation revision; requesting another spends that held-out split.

### Resolution status

The runtime fact of whether a contract currently has an implementation that can run: `resolved`, `unresolved`, `unavailable`, or `blocked` by a dependency. It is not part of the contract document.

### Implementation

One executable realization of a capability contract. Local code, a remote service adapter, a composition, or a generative fallback may each be implementations of the same capability.

### Capability host

The interface through which a runtime accesses capability discovery, invocation, and lifecycle operations. Fabric supplies the reference implementation without exposing Loom to its internals. Another provider may satisfy the interface.

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

An evidence-backed change that improves how Loom achieves authorized outcomes for a declared workload while preserving protected constraints. It can change capabilities, operating strategies, or the harness implementation without expanding authority.

### Operating strategy

A versioned way of choosing or performing work, such as decomposition, composition, context selection, routing, scheduling, or information gathering. It operates within policy and does not define its own authority or success criteria.

### Experiment

A bounded comparison between a versioned baseline and a candidate change for a declared workload. It records the intended benefit, protected constraints, evaluation method, budget, promotion conditions, evidence, and rollback target.

### Promotion

The governed decision to make an evaluated change active within a specified scope. It is distinct from capability admission and does not grant authority to execute or relax policy.

### Milestone

One vertical increment of the build plan (M0, M1, …): a demonstrable goal outcome with checks across every module it touches. A milestone is a unit of delivery; it is not a *slice*, which is a query over state.

## Tracing and evaluation

### Weft

The tracing package, namespaced Weave Weft. It validates and stores Weft records emitted by Loom, Fabric, the inference gateway or an outside composition through a port, and imports none of them. It also reads the P9 `weave.trace@1` envelope as a supported version, without converting it into Weft records. The package is `packages/weft`; its contract is `packages/weft/src/WEFT-CONTRACT.md`.

### Weft trace

The Weft records sharing one `trace_id`, a correlation scope chosen by the composition root (in Loom, one goal). It is a projection for inspection, attribution, debugging and evaluation. It is not the observation log and not Loom's cycle trace, replay and recovery never read it, and no transition, grant or completion may be derived from it. Emitting to it never changes state or scheduling.

### Weft record

One closed, versioned entry in a Weft trace: an envelope, a kind, links to other records, evidence references and kind-specific fields. Content appears as a content class and digest. It appears as text only where an inline content policy for that trace permits its class. A record that fails validation is not stored.

### Disclosure class

What a Weft record field can reveal: `metric` (a count, measure, ratio or flag), `reference` (an id, code or digest naming something held elsewhere) or `content` (goal content). Every field has exactly one. A content field holds a content class, a digest and optionally a reference, and never text unless an inline content policy permits it. A disclosure class is not a content class, which says how sensitive the content itself is.

### Inline content policy

The composition root's permission to record content text inline in one Weft trace, for the content classes it names. It is never the default and permits nothing in any other trace. It grants no access, and no disclosure beyond that trace. Inline text must still match its digest and pass the credential screen. A malformed policy is a configuration error, not a rejected record.

### Weft redactor

The function the composition root must supply before Weft serializes a record. It removes secrets and any content the trace may not hold. Weft validates its output and writes nothing it rejects. A redactor does not grant disclosure, and passing it is not evidence that a record is safe to show anyone.

### Gauge

The evaluation package, namespaced Weave Gauge. It turns Weft traces and other recorded evidence into evaluation results, comparisons and failure attributions. It produces evidence; promotion, admission and authority to execute remain separate decisions. It depends on the Weft contract only. The package is `packages/gauge`; its contract is `packages/gauge/src/GAUGE-CONTRACT.md`.

### Criteria set

A governed, versioned record of what counts as success for a workload: measures, quality-bar and protected constraints, and a deterministic statistical method. Its revision cites the authority that issued it. The subject under evaluation cannot author or govern it.

### Case set

A governed, versioned record naming a workload's cases by digest, split into a tune split and a holdout.

### Evaluation result

Gauge's record of one subject on one split of a case set under one criteria set, bound to their revisions and its evidence. Its constraint statuses and verdict are recomputed from its measures, never asserted. A holdout result discloses only held-out reports. A replay result does not measure outcomes of actions that were not taken.

### Comparison

Gauge's recomputed verdict on a baseline and a candidate evaluation result for the same criteria set, case set, split and mode. A candidate that misses its bar is never better. A comparison is evidence an experiment may cite; it is not a promotion.

### Failure attribution

A claim about why one case failed: capability gap, implementation, routing or orchestration, with a deterministic signal or a recorded judgment and its confidence. *Unattributed* is a valid result. An attribution never names a holdout case.

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

### Opportunity notice

An operator observation that a lifecycle fact is ready for a decision: admission decided, an implementation revoked, or evidence invalidated. The notice records the fact. It does not issue an execution grant and does not itself dispatch work.

### Maturity

The trust stage of an implementation, such as proposed, provisional, established, deprecated, or revoked. Maturity is evidence-based and may regress.

### Provenance

The record of where a contract, test, or implementation came from, including source traces, generators, revisions, evals, and validation evidence.

## Tapestry

### Tapestry

The visual presentation layer, namespaced Weave Tapestry. It paints a workspace for an operator and submits that operator's observations through a narrow runtime-facing binding. It holds no goal state or project record, schedules no action, and issues no grant. Its core imports no runtime and no capability host. Loom supplies the reference binding; another runtime can supply one. The shell, theme, built-in view handlers, and session record belong to Tapestry. The project record does not. In this repository the core is `packages/tapestry`, the web renderer is `packages/tapestry-web`, and the reference binding is `packages/loom-binding`.

### Operator

The principal that configures Weave locally, opens goals, and decides requests the runtime records as pending. Authority comes from configured entitlement within the goal's ceiling. Attending an operator surface grants nothing. Operator observations enter only through trusted ingress.

### Project

The durable, presentation-independent record of what may be relevant to Loom: repositories, documents, artifacts, capability availability, history references, and goals over time. Loom holds it, so a headless invocation has it when Tapestry is absent. Availability is not a grant, not a slice fill, not disclosure, and not a reason to show the resource. A project is not an npm workspace, and it is not itself a goal.

### Operator surface

A Tapestry presentation of runtime state for the operator: the setup surface or a workspace. It reads a workspace view and submits operator observations through the attached runtime's ingress. It holds no goal state, schedules no action, and issues no grant.

### Setup surface

The deterministic terminal operator surface that writes local configuration before any workspace exists. It requests no inference and begins no session.

### Local configuration

The versioned local record the setup surface writes: the operator principal, the initial theme, the arrangement allowance, the per-key request cap, and the destinations permitted to `workspace.arrange`. A session cites the digest of that record apart from the theme. It is not goal state and not a project. The principal must be one the runtime is configured to accept. The record itself grants nothing.

### Session

The attachment of one workspace to one project through the runtime-facing binding. It fixes the component vocabulary version and the arrangement allowance. The current theme is paint state on the session record and may change without ending the session. A session may begin before a goal is open and may continue after a goal closes. It ends when the operator detaches or the runtime stops. Ending a session detaches the workspace. It does not complete, pause, or cancel a goal, release a reservation, or write to the observation log. A new session starts clear of the previous session's placements and pins. Recovery does not restore a session.

### Session record

The append-only record one workspace keeps for one session: attachment, surfaced components, placements, pins, collapsed state, active selection, arrangement requests and their reservations, attempts, outcomes, and detachment. It cites goal state revisions and does not advance them. It is ephemeral workspace state. It is not the observation log and not project policy.

### Workspace

The adaptive operator surface for one session of a project. It paints a shell and a component tree from the workspace view, starting from the default tree. A fresh session shows navigation and a conversational surface. Richer components appear as they become useful. The workspace has no mode.

### Workspace view

The state view rendered for the operator principal at one revision. Components bind slices of this view. An omitted slice stays omitted. Project availability is not part of the view unless a slice selects it.

### Shell

The deterministic structure of a workspace: navigation, a main surface, an optional drawer, and a cut-through for blocking requests. The component vocabulary version fixes the shell's regions. A judgment does not add, remove, or reorder a region.

### Region

A named semantic place in the shell, such as `nav`, `main.primary`, `main.bottom`, `right.drawer`, or `cut-through`. Placement names a region. It does not name pixel coordinates. An execution slot is scheduler capacity, not a region.

### Cut-through

The shell region that shows a pending authority request until the operator places that request elsewhere or decides it. Arrangement cannot assign this region, and a pin elsewhere cannot dismiss it.

### Placement

An operator assignment of one surfaced component to one region for the current session. Arrangement works around placements. A placement does not decide an approval, grant authority, or survive into the next session.

### Pin

A placement the operator marks as a hard constraint for the session. A pin occupies its region until the operator clears it or the session ends. Arrangement cannot move or replace a pinned component.

### Theme

A versioned record of token values, covering every role in a versioned token role set. Components name token roles. The current theme resolves every paint. Changing it repaints and does not detach the session. A judgment does not see or set it. Renderers bind the same roles to their own media.

### Component

Trusted presentation code in the component vocabulary, identified by a versioned id. It declares the slices it binds, the operator observation types it may submit, the regions that may hold it, and its interaction states. It is not a capability: it has no contract, no admission, and no grant. The vocabulary does not name a toolkit.

### Component vocabulary

The closed, versioned set of components, regions, offers, applicability conditions, and the criterion texts a judgment may be shown. Adding a component, a region, or an offer is a vocabulary revision shipped as trusted code. No judgment extends it.

### Conversational surface

The component that presents disclosed operator observations and accepts operator input. It is the usual occupant of the main surface when nothing richer is useful. It is not a mode, and it is not the state of the runtime.

### Artifact

A versioned product the workspace can open: source, prose, a report, a publication, or anything an action emits. The workspace binds its identity, kind, and revision. A body is shown only when the workspace view discloses it. A locator is not an artifact.

### Editor

The workspace component that opens any artifact. It holds the surrounding workspace semantics while a compatible view handler presents the disclosed artifact through a runner. It is agent-first: it shows what work produced, and operator correction goes through an existing observation or grant. It is not a mode, a second runtime, or a capability.

### View contract

The semantic requirements for presenting or editing an artifact kind, including the disclosed data and narrowed operator interactions. It names no renderer or external program and grants no access by itself.

### View handler

A Tapestry presentation binding that declares which view contracts it can satisfy and what disclosed data and narrowed interactions it needs. A built-in handler is a default, not a privileged kind. Configured external and custom handlers are possible. A handler is not a capability or a second source of goal state.

### Runner

The implementation used by a view handler to present an artifact: a built-in renderer, web or native surface, terminal program, or existing desktop application. Runner-specific integration stays at the edge. The runner does not gain authority merely because the editor opens an artifact. A reusable check remains a separate capability under the attached runtime's authority; the editor may show its recorded result without dispatching it.

### Component tree

The shell's regions with the components bound in each, resolved against one workspace view revision, one theme record, and the session's placements and pins. It records ids, regions, and slice names. It carries no markup, pixel coordinates, or token values.

### Default tree

The component tree a pure function computes from the workspace view, the component vocabulary, and the session's placements and pins. It needs no judgment. The workspace paints it wherever no pin, placement, cut-through rule, or admitted arrangement applies.

### Arrangement

An assignment of offered components to adaptive regions that the operator has not pinned or placed, admitted from a `workspace.arrange` answer after deterministic validation. It binds to the state revision its request evaluated and holds while its arrangement key is unchanged. The chosen component still reads current content from the workspace view.

### `workspace.arrange`

The judgment site that proposes an arrangement. It is one evaluation request of kind `choice` and role `working`, with one question per contested adaptive region. Navigation, cut-through, pins, and placements are settled before the request and are not questions. Attempts draw on the session's arrangement allowance, which is separate from the goal budget. The site makes a useful deterministic workspace more specific. It does not invent the workspace.

## Language constraints

- Say **Loom**, not *runtime* as a product name and not *LLM agent*, for the goal-directed loop. *Runtime* remains the ordinary word for that loop. Weave is the system, not the runtime.
- Say **Fabric**, not *AgentFabric*, in architecture vocabulary. *AgentFabric* is the package name `packages/agentfabric` and the external conceptual reference.
- Say **Tapestry** for the visual presentation layer. The package, when it exists, is `packages/tapestry`.
- Say **observation**, not *message*, for a general state input.
- Say **action frontier**, not *next action*, when concurrency is possible.
- Say **capability**, not *tool*, for an operation governed by a Fabric contract.
- Say **implementation**, not *capability*, for replaceable executable code.
- Say **implementation**, not *resolver*, for code that satisfies a contract; *resolver context* remains the name of the interface it receives.
- Say **resource reference**, not *path*, *URL*, or *locator*, for what a capability input names. Locators stay inside the host.
- Say **crystallization**, not *learning*, for the admission of new executable capability.
- Say **weight**, not *confidence*, unless the value is explicitly calibrated as confidence.
- Say **admit**, not *save*, when a capability passes into the registry.
- Say **opportunity notice**, not *alert* or *notification*, for an operator observation that a lifecycle fact is ready for a decision.
- Say **state view**, not *prompt* or *context*, for what the decision layer receives.
- Say **judgment site**, not *Jev*, for a place the runtime asks for judgment. Jev is a model type.
- Say **routed unit**, not *model*, for what routing selects.
- Say **prefix cache**, not *KV cache* or *cached conclusion*, for recorded reuse of a view prefix by one routed unit.
- Say **slice assembly**, not *shared context*, for one recorded fill of slices at a revision.
- Say **inference role** for why an inference was requested, and **inference kind** for what was asked of the model. They are not interchangeable.
- Name a capability for its operation, never for the inference kind behind it: `text.classify`, not `request_text_classification`.
- Say **action candidate**, not *option*, for a validated, bound action.
- Say **milestone**, not *slice*, for an M-numbered increment of the plan. A slice is a query over state.
- Say **trusted ingress**, not *authenticated client*, for the in-process handle that may submit privileged observations.
- Say **execution tier**, not *sandbox*, for where an implementation runs. A label is not containment.
- Say **tier** for the routed-unit class; say **execution tier** for trusted/untrusted placement.
- Say **held-out report**, not *test output*, for what protected evaluation returns to an implementer.
- Never use **deterministic** to describe generated tests; their execution is deterministic, while their authorship and correctness require evidence.
- Say **operator**, not *user*, for the principal that configures Weave and decides pending requests through an operator surface.
- Say **Weave** for the system. Say **Loom** for its runtime, **Fabric** for its capability subsystem, and **Tapestry** for its presentation layer. A project record belongs to Loom. A session record belongs to Tapestry.
- Say **operator surface**, not *client* or *UI*, for a Tapestry presentation over runtime state.
- Say **project** for the durable container. A repository may be attached to a project. The npm workspace is the package layout, not a project.
- Say **workspace**, not *dashboard* or *mode*, for the adaptive operator surface. There is no chat, code, research, or agent mode.
- Say **shell**, not *frame* or *chrome*, for the fixed structure of a workspace. *Frame* remains the name of framing: `profile.frame@1`, the `goal.frame` site, and the `framing` role.
- Say **region**, not *slot* or *coordinate*, for a semantic place in the shell. An execution slot is scheduler capacity.
- Say **placement** for an operator's session-scoped assignment of a component to a region, and **pin** when that assignment is a hard constraint.
- Say **cut-through**, not *modal*, for the region where a pending authority request stays visible.
- Say **arrangement**, not *composition* or *layout*, for an admitted assignment of components to adaptive regions. A composition is a capability assembled from capabilities.
- Say **component**, not *widget* or *capability*, for trusted presentation code in the component vocabulary.
- Say **conversational surface**, not *chat*, for the component that presents and accepts operator input.
- Say **artifact**, not *file*, for what the editor opens. A locator stays in the host.
- Say **editor**, not *IDE* or *mode*, for the workspace component that opens an artifact. The editor is not a capability.
- Say **view contract**, **view handler**, and **runner** for the semantic presentation requirement, its binding, and its implementation. A view handler is not a capability.
- Say **session** for a workspace's attachment to a project on a running runtime. A session is not a transcript, a compaction unit, a scheduler lane, or a restart boundary.
- Say **session record**, not *journal* or *log*, for the workspace's ephemeral record. The journal is the observation log.
- Say **workspace view**, not *screen* or *prompt*, for the state view a workspace renders.
- Say **indicator**, not *notice* or *alert*, for a shell status mark. An opportunity notice is an operator observation.
- Say **`workspace.arrange`**, not *Jev*, for the judgment site that proposes an arrangement. Jev is a model type that may answer `choice`.
- Say **acceptance line** for a proposal and **acceptance fact** for a line code has admitted. On the System One wire a boolean question is a Noul. The request kind remains `boolean`.
- Say **criteria gate** for `task.criteria` and **task validation** for `task.validate`. Jev may answer either site. Neither site is the decision layer, and neither is `frontier.weigh`.
- Say **confidence** for the provider statistic published beside a typed evaluation answer. It is not a weight and not a quality score.
- Say **Weft trace**, not *trace*, when the observation log or Loom's cycle trace could be meant. Neither is a Weft trace.
- Say **disclosure class** for what a Weft field can reveal and **content class** for how sensitive content is. They are not interchangeable.
- Say **experiment**, not *swatch*, for a comparison of a baseline with a candidate.
- Say **constraint** in a criteria set or **test corpus** case, not *pattern*, for an expected behaviour.
- Say **evaluation result**, not *score*, for what Gauge records about a subject. A measure is one value within it.

### Tune split

The frozen, scenario-disjoint portion of a benchmark used to select descriptive
thresholds. It supplies no runtime authority and cannot read holdout labels.

### Holdout

The frozen portion reserved for reporting after thresholds are selected on the
tune split. Scenarios cannot cross between those portions.

### Competitor harness

A generic inference application evaluated using the same disclosed state and
production questions as a judgment site, without becoming a decision provider.
Competitor benchmarks report self-reported confidence separately from probability
calibration and do not tune thresholds.
