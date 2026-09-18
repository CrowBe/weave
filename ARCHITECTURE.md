# Architecture

This is the high-level plan: the decisions that shape Weave, at the altitude where
they can be argued with. It is not a specification, and it deliberately stops
short of interfaces, schemas, and file layouts — those belong to the code that
proves them.

It uses the terms in [CONTEXT.md](./CONTEXT.md) exactly, and assumes
[VISION.md](./VISION.md).

Nothing here is built yet. The point is that M0 is a narrowing of a decided
architecture rather than an invention.

## 1. Three layers

```
AgentSOP      contract: what a capability means, what a resolver must look like
   ↑
AgentFabric   capability runtime: catalogue, references, grants, resolution, admission
   ↑
Weave         goal runtime: state, cycle, action frontier, policy, evidence
```

Arrows are dependency directions. AgentSOP depends on neither of the others.
AgentFabric never imports goals, cycles, or state. Weave uses AgentSOP's types
directly and reaches AgentFabric through a **capability host** port, so the loop
never depends on one capability runtime's internals.

All three are packages in this repository, not separate repositories. The
boundary is enforced by per-package dependencies, an import-direction check in
CI, and test suites that run without the layer above them. If a package's tests
need the layer above, the boundary has already leaked.

**The model is inherited unconditionally; the code is a separate decision.**
What Weave depends on is AgentSOP's model: a durable contract with typed input,
output, declared effects and declared authority; a disposable resolver; a
reference that is not a locator and does not carry authority; a capability that
may exist unresolved; failure codes that are contract while messages are not.
Whether `packages/agentfabric` starts as the existing AgentFabric code or as a
fresh implementation of that model is a decision due at M3, when there is first
something real to put behind the port. Until then the loop builds against a fake
host, and nothing blocks on the answer.

One constraint carries over regardless of that decision: **the resolver context
must be substrate-neutral.** The existing implementation hands resolvers
filesystem paths, which forces every resolver to be trusted in-process code and
keeps the resolver shape out of the contract layer. Expressed only in contract
vocabulary — invoke a declared dependency, read, write, create, discover over
references — the context becomes something that can be served over a pipe, and
running untrusted code in a sandbox stops being a subsystem to build and becomes
a deployment choice. Weave generates implementations, so this is a precondition,
not a refinement.

## 2. The cycle

```
enumerate → weigh → filter → schedule → execute → integrate
```

**Enumerate** is deterministic. Candidate generators read state and produce
typed, bound action candidates: capabilities whose inputs can be filled,
inference requests for open questions, clarifications, joins on in-flight work,
extension actions for recorded gaps, and completion when success may have been
reached.

**Weigh** is the only probabilistic step. The decision layer receives a state
view and the candidates and returns weights with uncertainty. It does not author
actions, and it never sees a candidate policy would refuse — an action policy
forbids is enumerated instead as a request for approval, so the decision layer
can advocate escalation without being handed the boundary.

**Filter** is deterministic policy: permissions, budgets, data boundaries,
destructive-action rules, approval requirements, dependency readiness,
thresholds. It runs after weighing so refusals are recorded against weighted
candidates, which is what makes a trace explainable.

**Schedule** picks the frontier: the highest-weighted mutually compatible set
within concurrency and budget limits. Compatibility is computed, not guessed —
each candidate's declared effects and the references they land on give it a lock
set before it runs, so reads and discoveries parallelize freely while writes,
appends and deletes exclude on the reference they touch. The contract's effect
vocabulary is the scheduler's lock table, which is the practical return on having
contracts at all.

**Execute** runs the frontier concurrently. Every result, including every
failure, becomes an observation.

**Integrate** applies observations, reconciles superseded work, updates budgets,
and re-enters the cycle. There is no conversational turn boundary.

## 3. State

State is an engine, not a structure, because it carries an open-ended set of
payload types and serves consumers that need very different renderings of it.

```
observations  →  interpretation  →  views
   (fact)          (entities)       (rendering)
```

- **Observations are fact and never change.** An append-only log with a small
  fixed envelope and a payload validated against a registered, versioned type —
  the same move AgentSOP makes for invocations, and the reason new kinds of
  input extend the system without touching its core. An unrecognised type is
  still captured, with the failure to interpret it recorded rather than silent.
- **Entities are interpretation and can be rebuilt.** Goals, threads, facts,
  open questions, desired operations, gaps, action records, approvals, budgets,
  risks, artifacts — each typed, with a lifecycle, under one rule: no entity
  field without a citing observation. Interpretation is pure and applied in
  order by a single writer, so replay is exact.
- **Views are rendering and are never stored as truth.** Every view — the
  decision layer's state view, an inference's context, a capability's typed state
  input — is composed from budgeted slices with deterministic selection, states
  what it dropped, and carries a manifest of what filled it. There is no "full
  session context" object anywhere in this architecture.

Actions never write state; they emit observations. That is the structural reason
a model cannot mutate state.

Concurrency needs both halves: effect locks say what an action will write, and a
candidate's declared read set says what its binding assumed. When a result lands
against state that has moved, the two make staleness computable, and the action
kind's policy — apply, recompute, supersede, cancel — decides explicitly rather
than applying stale work silently.

State has two tiers. **Goal state** ends with the goal. **Durable knowledge**
crosses goals: the capability registry, observed reliability and cost, routing
statistics, the gap ledger, eval history. The boundary is an authority boundary:
content learned under one goal's authority does not become available to another
by being written down, so durable knowledge holds facts about the system's own
behaviour rather than the content that produced them.

## 4. Judgment and inference

**Jev is a model type, not a role.** Fast typed judgment is useful in several
places, and each is a distinct **judgment site** with its own contract, eval set,
and default model tier: weighing the frontier, classifying an inference request,
evaluating a response, classifying a validation failure, resolving an ambiguous
capability match, estimating whether a gap is worth extending. "Jev said so" is
never an explanation; a named site with a recorded input is.

All model work goes through one action and one **inference gateway** module,
which classifies the request, routes it, executes it, evaluates the response, and
then accepts, retries, escalates, or fails. Three callers share it: the loop's
own inference action, a capability whose implementation is generative, and a
privileged fallback for novel judgment.

What keeps the gateway from being a second agent loop is structural, not
stylistic: a fixed attempt ceiling and the request's own cost and deadline
limits; it may re-prompt but never re-scope, because changing what is being asked
is the loop's business; it grades against acceptance terms supplied by the
caller, so success is not self-defined; it fails loudly rather than returning the
best of a bad set; and the classifier itself is fixed-route, so the regress has a
bottom.

Routing minimizes the expected total cost of reaching the declared quality bar,
retries and escalation included — not token price. What it selects is a routed
unit: a context profile, a prompt template, a model, and its settings, versioned
together, because a profile or prompt change moves success rates exactly as a
model change does. Two signals tune it: immediate evaluation of each response,
and delayed outcome feedback — did the consuming action succeed, did the drafted
contract validate, did the implementation go green — joined by a correlation id
and worth more than the immediate one.

Classification also decides what the request gets to *see*. Each inference kind
carries a context profile declaring which slices it needs, at what depth, under
what budget, with what excluded and at what data class. The gateway declares the
requirement; only Weave can read state, so Weave composes it; a missing slice
fails the request rather than sending the gateway looking. Data class is a
routing input, because a cheaper model that would carry data somewhere it may not
go is not a candidate at any price. A classification and a goal decomposition are
the same machinery at different settings on a declared dial.

## 5. Capabilities

The contract is the identity; implementations are replaceable. Weave prefers
composing established capabilities over minting new ones, and prefers extending
an existing contract over adding a synonym.

**A capability's context is its input.** A resolver receives its typed input and
nothing else — no session, no transcript, no ambient projection, no way to reach
back for more. A capability that needs state declares it in its contract, where
it is visible, validated, and fixed by its tests. This is what lets even large
cognitive steps be contracts: `goal.decompose` takes a goal and a state view and
returns subgoals, success criteria and desired operations, and the loop decides
what goes in.

Capabilities are named for their semantic operation, never for the model call
behind them. A generic `inference.request(kind, payload)` is the wrong shape for
a catalogue: an opaque payload cannot be validated at the boundary where
untrusted code meets the host, a grant on a dispatch capability grants everything
it dispatches to, and no set of cases says what it means. That last point
generalizes: **if you cannot write cases for it, it is not a capability yet.**
Generality is fine when types are concrete; untyped dispatch is not.

An implementation may be deterministic code, a composition, or generative — a
prompt and a gateway call. Generative implementations are legal and are admitted
on distributional evidence, capped at lower maturity, and preferred against when
a deterministic implementation of the same contract meets the bar. That is the
real shape of the ladder: frontier work runs as raw inference; the recurring part
earns a contract and a corpus; the first admitted implementation may well be
generative; a deterministic one replaces it under the same contract, inheriting
the same evidence.

Model-backed capabilities declare their dependency on inference rather than
hiding it in resolver code, which makes "which capabilities are non-deterministic"
a query rather than an audit. Because spending inference is a consequence the
0.1 effect vocabulary does not describe — it costs money, leaves a provider
trace, and can carry data across a privacy boundary — this argues for an `infer`
effect in a later contract revision, so inference spend sits under grants rather
than under code.

## 6. Extension

Crystallization runs as ordinary actions on a thread in the same loop, not as a
sub-routine with its own scheduler. It is therefore interleavable with goal work,
parallelizable within a stage, abandonable, and subject to the same policy,
budget and evidence machinery as everything else.

The stages: name the operation, after a near-duplicate search; define the
contract; author a test corpus from the contract alone; observe red against a
placeholder; generate implementations in parallel; validate deterministically;
request admission; capture. Admitting a capability changes what the next cycle
can enumerate, which is the entire expansion mechanism — the action space grows
because the registry grew.

One rule holds throughout: **inference authors, determinism admits.** Every stage
pairs a generator with a checker that is not itself. Three independence
invariants make the evidence worth having: corpus authors never see an
implementation, implementers never see the held-out split, and the failure
classifier may redirect work but never edit the corpus. Probabilistic evaluation
can direct the next iteration; it can never turn a red run green.

Extension is expensive, so it is gated rather than reflexive. A gap is recorded
from evidence — the decision layer finding no adequate candidate, a repeated
inference scope signature, recurring fallback use — and becomes a thread only
when recurrence crosses a threshold or a user asks, with an estimated payoff that
is later checked against what the capability actually cost and saved. A loop that
crystallizes every gap spends its life building tools it uses once.

Abandonment keeps its artifacts. A validated contract with a demonstrated-red
corpus and no implementation is a legal registry state and a far better start
next time that gap recurs.

This applies to Weave's own cognition too. Framing starts as an unnamed inference
through the fallback door and is observed; when its shape recurs it becomes a
named contract with a corpus and a routing choice. The loop's own thinking rides
the same ladder it applies to everything else.

## 7. Authority and trust

Deterministic policy bounds probabilistic judgment, always in that order. A
weight is evidence for routing, never authorization.

Three gates stay distinct: generating a capability, admitting it, and being
authorized to execute it. Admission grants no grant.

Authority is layered. Weave enforces goal-level policy — budgets, approvals,
destructive-action rules, data boundaries — and the capability host enforces
contract-level authority through grants on principals, capabilities, references
and effects. A goal runs as a principal whose grants derive from the authority
granted for that goal, so a denial at the lower layer is the last line rather
than the only one.

Untrusted code never runs with ambient authority. Generated implementations
execute out of process, reaching the environment only through the resolver
context the host answers, which is what §1's neutrality constraint buys.

## 8. Evidence and evaluation

Every consequential cycle is replayable: the view that was composed, the
candidates, the weights, the policy decisions, the frontier, the results, and the
state delta. Two uses, both load-bearing:

- **Judgment evaluation.** Replay recorded views against a changed decision layer
  or a changed routed unit and score against known outcomes. Without this, a
  weighted frontier is a guess with extra structure.
- **Capability evaluation.** Observed reliability, cost and latency per
  implementation drive routing between implementations of one contract, and drive
  maturity regression when an admitted capability degrades.

This record exists for evaluation and accountability. It is not a growing prompt.

## 9. Milestones

- **M0 — loop.** State engine first: log, interpretation, views, replay tests.
  Then deterministic enumeration over a fixed catalogue behind a fake capability
  host, a scripted decision layer, three action kinds, evidence written. No
  inference, no extension.
- **M1 — judgment.** Jev behind the decision layer port, real weights, the replay
  eval harness, the inference action behind a single-model gateway that already
  records attempts and evaluations, concurrent frontier with effect locks.
  Routing arrives when there is history to route on.
- **M2 — gaps.** Framing inference and its gate, desired operations, the
  deterministic registry diff, gap detection and the recurrence threshold. No
  generation yet.
- **M3 — extension.** Name, contract, corpus, demonstrated red. Ends with a red
  capability in the registry and no implementation. The capability host decision
  (§1) settles here, because this is where generated artifacts first reach a
  registry.
- **M4 — crystallization.** Generation, sandboxed validation, explicit human
  admission. One capability end to end, from gap to admitted.

## 10. Open questions

- **Composition versus extension.** Whether finding that existing capabilities
  compose to fill a gap is a deterministic type-and-effect search, a judgment, or
  both.
- **Contract revision.** Changing an admitted contract invalidates corpora and
  implementations downstream. Versioning exists; the migration path does not.
- **View schema change.** Contracts that consume state pin the view version, which
  makes drift visible and may make improving state itself expensive. Whether
  views need additive-slice and deprecation discipline is unsettled.
- **How closed the inference kind vocabulary should be.** Routing statistics are
  only comparable while a kind means the same thing across runs, so a kind
  appearing casually resets them silently.
- **Goal-scoped authority over time.** Grant lifetime across threads, across
  extension, and across promotion of anything from goal state into durable
  knowledge.
- **Fact contradiction.** When an observation contradicts an asserted fact,
  whether the survivor is chosen by a recency rule or by a judgment site.
