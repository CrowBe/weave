# Architecture

This document turns [VISION.md](./VISION.md) into a component map, dependency
directions, and typed boundaries. It uses the terms in [CONTEXT.md](./CONTEXT.md)
exactly. Code shapes here are illustrative, not committed signatures.

Nothing in this document is built yet. It exists so the first milestone is a
narrowing of a decided architecture rather than an invention.

## 1. Three packages, one repository, one dependency direction

AgentSOP and AgentFabric are inherited as a model first and as code second.
What Weave depends on is the separation they describe: a durable contract layer
that says what a capability means, a replaceable runtime layer that honours it,
and a loop that owns neither. Whether the runtime package begins as the existing
AgentFabric code or as a fresh implementation of the same contract is a decision
for §13, and the architecture above it does not change either way.

Both are packages in this repository, not separate repositories and not separate
release cycles. The boundary is a package boundary, enforced by import discipline
rather than by a repository wall.

```
packages/agentsop     contract: what a capability means, what a resolver must look like
        ↑
packages/agentfabric  runtime: catalogue, resources, grants, resolution, admission, audit
        ↑
packages/weave        runtime: goal, state, cycle, action frontier, policy, evidence
```

Arrows are import directions. `agentsop` imports nothing of the other two.
`agentfabric` never imports Weave scheduling, goals, or state. Weave imports
`agentsop` types directly and reaches `agentfabric` only through a port
(§4), so a second capability host can be substituted without touching the loop.

One checkout, one test run, one version. Changes that cross the boundary land in
one commit, which is the point of folding it in: at this stage the contract and
the loop still teach each other, and a two-repository split would pay coordination
cost for an independence neither package has earned yet.

A package boundary is weaker than a repository boundary only if nothing enforces
it. What enforces it here:

- Separate `pyproject.toml` per package, declared dependencies, no path escapes.
- An import-direction check in CI. The wrong import fails the build, which is
  the same signal a repository split would give and arrives faster.
- Tests per package. `agentsop` tests run with no fabric installed; `agentfabric`
  tests run with no Weave runtime; Weave loop tests run against a fake
  capability host. If a package's suite needs a layer above it, the boundary has
  already leaked.
- No shared internal utility package. Duplication below the boundary beats a
  common module that quietly couples the layers.

Extraction stays available and cheap: both lower packages are publishable as-is
the day someone else needs them, because nothing in their code knows which
repository it sits in.

The split test for every symbol is one question:

> Would an independent runtime, written by someone else, need this to
> interoperate with capabilities authored here?

Yes → `agentsop`. No → `agentfabric`.

### agentsop

The semantic definition system and the resolver contract shape.

- Capability document schema and its validation rules — including the authority
  selector rules, the effect-set equality rule, and dependency-graph acyclicity.
  These are contract law, not runtime convenience.
- The closed effect vocabulary, the `ResourceRef` shape and well-formedness
  rules, the `Result` envelope, the failure-code enum and its precedence order.
- The resolver contract shape: the callable signature, the guarantees a resolver
  may rely on, and the obligations it carries (declared effects only, no
  locators, output validated against the contract).
- Version negotiation for the `agentsop` field on a document.

No file I/O, no registry, no process, no policy about who may register a
resolver. Pure data, validation, and protocol.

### agentfabric

One honouring runtime. Catalogue loading and overlays, `ResourceRef` issuance
and the locator table behind it, principals, grants, resolution status,
invocation, audit, crystallisation, admission, sync, and the CLI and MCP
bindings. Everything here is replaceable without breaking a capability document
authored against `agentsop`.

Living in this repository does not make it a Weave subsystem. It keeps its own
CLI, its own MCP binding, its own `.fabric/` state, and its own tests, and it
remains usable by a harness that has never heard of Weave. The day it imports a
goal, a cycle, or a state view, the fold-in has failed.

### weave

The loop. Goal, state, cycle, candidate enumeration, decision layer, policy,
scheduling, evidence, and the threads that extend the capability set.

## 2. The resolver context decides whether generated code is possible

This is a constraint on the contract Weave adopts, not a migration order. It is
stated early because it decides what Weave can do at M4, and because the
existing implementation is the cautionary example: AgentFabric's
`ResolverContext` exposes `locator(ref) -> Path` and `workspace -> Path`, and
that one choice forces two consequences.

1. The resolver shape cannot belong to the contract layer, because it names a
   filesystem. A contract that mentions `Path` is not substrate-neutral.
2. Resolvers must be trusted local code, because they hold real paths and the
   ambient authority of the host process.

Both dissolve together. If the context is expressed only in contract
vocabulary —

```python
class ResolverContext(Protocol):
    principal: str
    def invoke(self, capability_id: str, input: dict) -> dict: ...   # depends_on only
    def read(self, ref: ResourceRef) -> bytes: ...
    def write(self, ref: ResourceRef, data: bytes) -> None: ...
    def create(self, *, kind: str, label: str) -> ResourceRef: ...
    def discover(self, *, kind: str | None = None) -> list[ResourceRef]: ...
```

— then the context becomes a boundary that can be served over a pipe. Sandboxing
stops being a feature to build and becomes a deployment choice: run the resolver
in a subprocess with no network and no filesystem, and answer its context calls
from the host. The host mediates every effect because there is no other route
out of the process.

Weave generates implementations, and generated code cannot be admitted into a
process holding ambient authority. So whichever code the capability host is
built from, this is the shape it must present. Trusted built-in resolvers can
keep an in-process tier; the shape they are written against is still the narrow
one.

## 3. State

State carries an open-ended set of payload types and serves consumers with very
different needs, so it is an engine rather than a structure. The specification is
[docs/STATE-ENGINE.md](./docs/STATE-ENGINE.md); this is what the rest of this
document depends on.

```
observations  →  reducers  →  entities  →  slices  →  views + manifests
   (fact)        (pure)      (interpretation)      (rendering)
```

**Capture.** An append-only log of observations. Fixed envelope — seq, goal,
thread, type, caused_by with a watermark, principal, evidence, cost — and a
payload validated against a registered, versioned observation type. The same
move AgentSOP makes for invocations: a small fixed envelope the runtime can
always reason about, an open payload that extends without touching the core. An
unregistered type is still captured; the engine records that nothing interpreted
it. Capture never fails because interpretation lags.

**Mutate.** Reducers registered per observation type, pure and total, applied in
seq order by a single writer, emitting declared mutations rather than imperative
edits. Actions never write state; they emit observations. That is the structural
reason a model cannot write to state. The projection is a set of identified,
typed, provenanced entities — goals, threads, facts, open questions, desired
operations, gaps, action records, approvals, budgets, risks, artifacts — under
one rule: **no entity field without a citing observation.**

**Represent.** Slices are named, versioned, budgeted queries over entities.
Every view is built from slices, selection is deterministic, truncation is
disclosed, and every view carries a manifest of what filled it.

**Reconcile.** A cycle reads at a watermark; a candidate declares the entity
**read set** its binding depends on. When a result lands the engine compares the
read set against what changed and applies the action kind's policy — apply,
recompute, supersede, or cancel. Effect locks (§5) handle write conflicts; read
sets are their mirror image, and together they make staleness computable instead
of guessed.

### State view

A **state view** is the bounded, typed rendering of the projection composed for
one judgment site. It is not the projection and not the log. It exists so that
judgment quality can be evaluated: the same state view must produce comparable
answers across models and across time.

The decision layer's state view is the canonical one, because the loop cannot run
without it, and it is also just the first instance of a general mechanism — every
judgment site and every inference kind declares what it needs, and the projector
composes exactly that (§7). There is no "full session context" object anywhere in
this architecture. There is an observation log, which is evidence, and there are
composed views, which are inputs.

State views are budgeted. A capability digest is one compact line per capability
(id, title, effects, resolution status, cost class, observed reliability); full
input and output schemas travel only for shortlisted candidates. The stable
prefix — goal, authority, capability digest — is ordered first so it can be
cached across cycles, and what was dropped to fit is stated rather than silently
elided.

The state view schema is versioned, and anything that consumes one pins the
version it was written against. A view shape that drifts silently invalidates
every corpus and every recorded judgment that used it (§8).

## 4. Ports

Weave defines the interfaces; adapters implement them.

| Port | Responsibility | First adapter |
| --- | --- | --- |
| `CapabilityHost` | list, describe, invoke, propose, admit, revoke capabilities | `agentfabric` |
| `DecisionLayer` | weight candidates against a state view — one judgment site (§6) | Jev |
| `InferenceGateway` | classify, route, execute, evaluate, and retry or escalate one inference request (§7) | single-model stub |
| `ApprovalChannel` | request and receive human authority | CLI prompt |
| `EvidenceSink` | persist traces, weights, outcomes | JSONL |
| `StateStore` | persist the observation log, checkpoints, and entities | JSONL plus in-memory |
| `Clock` | time, timeouts, deadlines | system clock |

A scripted `DecisionLayer` returning fixed weights makes the whole loop
deterministically testable. That test is the reason the port exists.

## 5. The cycle

```
enumerate → weigh → filter → schedule → execute → integrate
```

**Enumerate** is deterministic. Candidate generators read the projection and
produce typed `ActionCandidate` values: resolved capabilities whose inputs can be
bound from state, inference requests for recorded open questions, clarification
requests for unresolved ambiguity, thread joins for in-flight work, extension
actions for recorded capability gaps, and completion when the goal's success
condition may be met.

**Weigh** is the only probabilistic step. The decision layer receives the state
view and the enumerated candidates and returns weights. It does not author
actions, and it never sees an action policy would refuse.

The escape from a closed candidate set is not free-form proposal. When the
decision layer finds no candidate adequate, it says so; the runtime records a
capability gap or enumerates `request_inference` for a plan. Planning is an
action that produces observations, which expand the next cycle's candidate set.
Planning is never a control mechanism.

**Filter** applies policy deterministically: permissions, budgets, data
boundaries, destructive-action rules, approval requirements, dependency
readiness, weight thresholds. Policy runs after weighting so that a refusal is
recorded against a weighted candidate — that pairing is what makes the trace
explainable. An action that policy would refuse but the goal may need is
enumerated as `request_approval(for=action)` instead, so the decision layer can
advocate escalation without ever being offered the boundary itself.

**Schedule** selects the frontier: the highest-weighted mutually compatible set
within the concurrency and budget limits.

**Execute** runs the frontier concurrently. Each action's result becomes an
observation. Failure is an observation too.

**Integrate** applies observations to the projection, reconciles superseded work,
updates budgets, and re-enters the cycle. There is no conversational turn
boundary.

### Compatibility is computed from effects

Two candidates conflict when their effect sets touch the same resource
incompatibly. AgentSOP already declares, per capability, both the effects and —
through `authority.resources` — the refs those effects land on. Binding a
candidate's input yields its lock set before anything runs:

| | discover | read | create | write | append | delete |
| --- | --- | --- | --- | --- | --- | --- |
| **discover** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **read** | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| **create** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **write** | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| **append** | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| **delete** | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |

`create` never conflicts because the fabric chooses the new locator and the ref
does not yet exist. Cells are per-ref; candidates touching disjoint refs are
always compatible. The declared effect vocabulary is the scheduler's lock table,
which is the practical return on having a contract at all.

## 6. Judgment sites and the decision layer

Jev is a model type, not a role. It is useful anywhere a fast, typed, bounded
judgment is worth more than a slow essay, and the loop's weigher is only the
most visible of those places. The runtime therefore has several **judgment
sites**, each with its own typed contract, its own eval set, and its own default
model tier:

| Site | Judgment | Consumer |
| --- | --- | --- |
| Frontier weighing | which candidates advance the goal | the cycle (§5) |
| Request classification | how hard is this inference, what does it need | the gateway (§7) |
| Response evaluation | does this output meet the declared bar | the gateway (§7) |
| Failure classification | contract ambiguity or implementation defect | extension stage 6 (§7) |
| Match residue | which capability a desired operation means, when the typed diff is ambiguous | framing (§7) |
| Payoff estimation | is this gap worth extending | the extension gate (§10) |

Keeping these distinct matters more than the fact that one model type serves
them. A site is a place where judgment is requested under a contract, scored
against its own eval set, and routed on its own history. "Jev said so" is never
an explanation; "the weighing site returned 0.8 with these candidates in view"
is.

The decision layer is the site the loop cannot run without, so its contract is
specified here. The rest follow the same pattern.

Typed in both directions, and stable across models.

```jsonc
// request
{
  "goal": { "statement": "…", "authority": ["…"], "deadline": null },
  "state_view": { "facts": [], "open_questions": [], "threads": [],
                  "capabilities": [], "budget": {}, "recent": [] },
  "candidates": [
    { "id": "c1", "kind": "invoke_capability", "summary": "…",
      "detail": {}, "cost_class": "cheap", "reversible": true,
      "depends_on": [], "locks": [{"ref": "rf_…", "effects": ["read"]}] }
  ]
}

// response
{
  "weights": [ { "id": "c1", "weight": 0.82, "uncertainty": 0.1,
                 "rationale": "…" } ],
  "inadequate": false,
  "missing": []
}
```

Rules that keep this a contract rather than a prompt:

- A weight is evidence for routing. It is never authorization.
- `inadequate: true` with `missing` naming what the action space lacks is the
  only path from the decision layer to capability extension. The decision layer
  cannot request a capability directly.
- Uncertainty is a returnable answer. An abstaining decision layer yields
  clarification or observation, not a coin flip.
- Every request, response, chosen frontier, and outcome is recorded. The record
  is the eval corpus (§11).

## 7. Inference flow

Four inference roles, separated by what they may author and what they cost.

| Role | Question it answers | When | May author |
| --- | --- | --- | --- |
| **Weighing** (the decision layer) | which of these candidates | every cycle | weights and uncertainty, nothing else |
| **Framing** | what is this goal made of | goal opening, impasse | observations: subgoals, success criteria, open questions, desired operations |
| **Working** | do this scoped thing | per action | the output its request declared |
| **Extension** | contract, corpus, implementation | inside an extension thread | artifacts, admitted only by §9 gates |

### The two obvious flows are one dial

A purely reactive flow — goal in, enumerate, weigh, act, repeat — is this machine
with framing never running. A decomposition-first flow — goal in, deconstruct,
describe the operations the goal wants, diff against the registry, crystallize
the gaps, then act — is this machine with framing always running first.

They are not competing architectures. **Framing is a candidate, not a stage.**
The runtime enumerates `request_inference(role=framing)` like anything else; the
decision layer weighs it against doing the work directly. Its weight should rise
when the candidate set is thin or uniformly low-weighted, and fall when a
capability already binds the goal. "Append this line to my journal" must not buy
a decomposition pass.

Hardcoding the decomposition-first pipeline costs three things:

- A mandatory planner ahead of the weigher is model control of the loop in a
  pipeline costume. Its place is predictable, which makes it feel safe, but the
  loop can no longer decline it.
- It pays for framing before knowing whether the goal is one invocation.
- "Return to step 2 for each subgoal" is a second scheduler inside the first.
  Subgoals are threads on the same frontier, flat, under one goal budget, with
  inherited authority that may be narrowed but never widened.

### What the decomposition-first flow is right about

Three mechanisms worth keeping, none of which requires a fixed pipeline.

**Thin state starves enumeration.** A one-line goal binds almost no capability
input, so the first cycle has nothing to weigh but clarification and framing.
Framing's real job is to deepen state until enumeration has something to bind —
not to produce a plan the runtime then executes.

**Describe the wanted operations before failing at them.** Anticipatory gap
detection beats discovering a gap by stalling on it.

**A gap known early can be extended in parallel** with the goal work that does
not depend on it.

### Mapping desired operations to capabilities is retrieval, not inference

Framing emits **desired operations** — a verb, expected effects, rough input and
output shape — never capability documents. Turning those into a capability
shortlist and a gap list is a typed diff against the registry: id and verb
proximity, effect-set compatibility, input and output shape compatibility. Run
it deterministically and hand the decision layer only the ambiguous residue.

Two reasons. It is cheap and stable across runs. And a registry whose names come
from free generation each time becomes a pile of synonyms — `text.summarise`,
`text.summarize`, `doc.condense` — which destroys the thing the contract exists
to provide. Near-duplicate search runs before any proposal, and extending an
existing contract beats minting a sibling.

### One action, one gateway

`request_inference` is a single action kind. Whatever the loop wants — framing,
working, extension drafting — it declares a request and the **inference gateway**
does the rest. The gateway is its own module behind a port, not part of the loop
and not part of the capability host.

Two words that are easy to confuse, kept apart deliberately:

- An **inference role** is why the loop is asking — framing, working, extension
  (§7). It decides who consumes the result.
- An **inference kind** is what is being asked for — classify, extract,
  transform, draft-contract, draft-implementation, judge. It is an entry in the
  gateway's **inference map**, and it carries the prompt template versions, the
  acceptance defaults, the default tier, and the accumulated statistics that
  routing reads.

The map is the gateway's vocabulary, not the catalogue's. It stays small and
mostly closed for the same reason the effect vocabulary does: routing statistics
are only meaningful if the same kind means the same thing across runs. Adding a
kind is a deliberate act, not a side effect of a caller inventing a string.

A request is typed and carries its own acceptance terms:

```jsonc
{
  "role": "framing",
  "kind": "decompose_goal",
  "output_schema": { },
  "quality_bar": "adequate",
  "acceptance": { "checks": ["schema", "cites_state_refs"], "dimensions": ["faithfulness"] },
  "constraints": { "privacy": "internal", "max_cost": 0.08, "deadline_ms": 4000 },
  "correlation": "thread:…/cycle:…"
}
```

Inside, the gateway runs a fixed pipeline:

1. **Classify.** How hard is this request, what capability does it need, what is
   the risk of a cheap attempt failing. A judgment site (§6).
2. **Route.** Deterministic policy turns (kind, class, quality bar, privacy,
   latency, budget) into a *routed unit* using recorded history.
3. **Execute.** A provider adapter. The only place a vendor SDK appears.
4. **Evaluate.** Deterministic checks first — schema, required fields, contract
   validation, corpus runs where one exists. Model evaluation only for the
   dimensions no deterministic check covers.
5. **Decide.** Accept, retry with a tuned prompt, escalate to a stronger routed
   unit, or fail. Failure is a legitimate return value.

The pipeline emits one observation with the result, plus an evidence record of
every attempt: routed units tried, evaluations, cost, latency, and why it
stopped.

### Context is composed per kind, not handed over

This is what classification buys beyond routing. Because the gateway knows the
kind, it knows what that kind needs to see — and a classification request should
not receive what a goal decomposition receives.

Each kind in the inference map carries a **context profile**: a declarative
statement of which state slices it needs, at what depth, under what budget, and
what must never appear.

```jsonc
{
  "kind": "decompose_goal",
  "requires": [
    { "slice": "goal",               "depth": "full" },
    { "slice": "capability_digest",  "depth": "titles+effects", "max_items": 200 },
    { "slice": "facts",              "select": "relevant_to_goal", "max_tokens": 2000 },
    { "slice": "open_questions",     "depth": "full" }
  ],
  "excludes": ["raw_observations", "other_goals", "secrets"],
  "data_class": "internal",
  "budget_tokens": 8000,
  "order": ["stable", "volatile"]
}
```

Ownership splits cleanly, and it has to, because the gateway must not be able to
read state:

- The **gateway declares the requirement**. It knows what the kind needs.
- The **loop composes it**. Only Weave can read the projection, so Weave's
  projector satisfies the profile and hands over a bundle.
- The **gateway never reaches back**. If a slice is missing, the request fails
  rather than the gateway going to look.

Three consequences worth stating:

- **Replay needs a manifest.** The bundle carries which items filled each slice,
  their ids, and a content hash. Without it, a recorded judgment cannot be
  reproduced, and the eval corpus (§11) is anecdote.
- **Privacy is a routing input.** `data_class` on the profile, redaction applied
  during composition, and routing filters the candidate units by what may see
  that class. A cheaper model that would carry the data somewhere it may not go
  is not a candidate at any price.
- **Ordering is cache design.** Stable slices first, volatile last, so the
  expensive prefix is reusable across cycles and across kinds that share it.

The routed unit therefore includes the profile version: **(context profile ×
prompt template × model × settings)**. A profile change moves success rates
exactly as a prompt change does, and attributing one to the other is the same
mistake in a different place.

Small kinds get tight profiles — often the payload and nothing else. Large kinds
get wide ones. Same machinery, one dial, and the dial is declared rather than
improvised per call site.

### What keeps the gateway from becoming a second loop

This is the real risk in putting retry and escalation behind one action. A
component that classifies, acts, evaluates its own work, and tries again is an
agent loop; the difference between it and Weave has to be structural, not
stylistic.

- **Bounded.** A fixed attempt ceiling and a fixed escalation ladder, plus the
  request's own cost and deadline limits. No open-ended iteration.
- **It may re-prompt, never re-scope.** Rewording, restructuring, or adding
  format guidance is the gateway's business. Changing what is being asked, or
  what would count as success, is the Weave loop's business and requires a new
  action.
- **Acceptance comes from the caller.** The gateway does not invent the bar it
  grades against. Otherwise "success likelihood" is self-graded, and the tuning
  loop optimizes for the grader rather than the goal.
- **It degrades loudly.** If the bar is unreachable within the budget, the
  gateway returns failure with its evidence. It never silently returns the best
  of a bad set as though it had succeeded.
- **The classifier is not itself classified.** Judgment sites declare a fixed
  default tier, or there is no bottom to the regress.

### Routing is an expected-cost decision

The objective is not the cheapest token price. It is the lowest expected total
cost of reaching the declared bar, retries and escalation included. A cheap unit
that meets the bar 40% of the time and escalates the rest is more expensive than
a mid unit that meets it 90% of the time — and the arithmetic is only available
if per-site success rates are recorded.

The routed unit is **(context profile × prompt template × model × settings)**,
not a model alone. Profile and prompt changes shift success rates as much as
model changes do, and a router that cannot see them will keep attributing one to
the other.

Two feedback channels tune it:

- **Live evaluation**, immediate, per response, from the gateway's own checks.
- **Outcome feedback**, delayed: did the action that consumed this inference
  succeed, did the contract it drafted validate, did the implementation it wrote
  go green. The correlation id on the request is what makes this joinable, and
  this is the signal worth more.

Two disciplines keep tuning honest. Prompt variants are promoted on a held-out
slice, never on the traffic that selected them — the same trap as tests grading
themselves. And classification is a gate, not a stage: skip it where a site has
stable statistics for this shape of request, and spend it on novelty or when
drift shows up in the live evaluations.

### Cost gate and how to settle the question

Framing is gated on enumeration coverage: run it when nothing binds above
threshold, or at an impasse, not on arrival by reflex. Whether
framing-on-arrival beats framing-on-demand is an empirical question, not an
architectural one. Both are the same gate at different settings, so the answer
comes from replay (§11) rather than from a rewrite.

### Inference inside crystallization

One rule holds across every stage: **inference authors, determinism admits.**
Each stage pairs a generator with a checker, and no stage's generator is its own
checker.

| Stage | Inference | Deterministic check | Escalation |
| --- | --- | --- | --- |
| 1 verb | names the operation only if near-duplicate search finds nothing | id and effect validity | cheapest tier; decision layer weighs extend-existing against mint-new |
| 2 contract | drafts the capability document | contract validation: schema, authority selectors, effect-set equality, acyclic dependencies | repair loop against the checker, cheap iterations, no human |
| 3 corpus | N independent authorings from the contract alone | cases must be executable and typed | diversity across models and seeds; contradiction between authorings means the contract is incomplete, so return to stage 2 — never a vote |
| 4 red | none | corpus must fail a placeholder implementation | a case that passes the placeholder tests nothing and is discarded |
| 5 implementation | K candidates in parallel | none yet | cheapest tier gets first refusal; escalate on repeated red |
| 6 validation | classifies failures only: contract ambiguity versus implementation defect | typecheck, corpus, held-out corpus, effect containment, resource limits | classification directs the next iteration; it can return work to stage 2 or 5 and can never turn a red run green |
| 7 admission | may draft the evidence summary for the approver | evidence completeness | human or policy decides; inference has no vote |
| 8 capture | none | registry write, digest change | next cycle enumerates differently |

Three independence invariants make the evidence worth having:

- Corpus authors never see an implementation.
- Implementers never see the held-out split.
- The classifier at stage 6 may redirect work but may not edit the corpus.

### Abandonment is a partial result

An extension thread can be abandoned at any stage — the goal completed another
way, the budget ran out, the gap turned out to be a one-off. Keep the artifacts.
A validated contract with a demonstrated-red corpus and no implementation is a
legal registry state and a far better starting point the next time that gap
recurs than nothing at all. Partial crystallization is a saving, not a waste.

## 8. Inference below the capability boundary

Judgment is not only the loop's business. A capability that classifies a
document, extracts fields from unstructured text, or grades a draft needs a model
inside its implementation. Three ways to allow that:

1. Forbid it — capabilities stay deterministic. Clean, and it makes any operation
   with a judgment step permanently uncrystallizable.
2. Give resolvers direct gateway access through their context. Works, and hides
   non-determinism inside implementation code where nothing declares it.
3. **Make judgment reachable through contracts.** A capability that needs
   judgment declares its dependency, and calls it through the host like any
   other dependency.

The third fits the contract model already inherited. Declared dependencies are
audited, typed, and rejected when undeclared, so a capability cannot quietly
acquire a model habit. Non-determinism becomes visible in the contract graph
instead of buried in a resolver, which makes "which capabilities are
model-backed" a query rather than an audit. And the composition rules that
already exist do the enforcement.

### The dependency is not a generic inference capability

`inference.request(kind, payload)` looks like the economical way to do this, and
it is the wrong shape for the catalogue. Three reasons, in increasing order of
how much they cost:

- **It cannot be validated.** `payload` varies by kind, so the document must
  type it as an opaque object. `INVALID_INPUT` — the check the contract layer
  exists to perform — stops meaning anything at exactly the boundary where
  untrusted generated code meets the host.
- **It cannot be granted.** A grant on a dispatch capability is a grant on
  everything it can dispatch to. Authority stops being about operations and
  starts being about a switch statement.
- **It cannot have a corpus.** There is no set of cases that says what
  `inference.request` means, so no admission evidence, no reliability history,
  nothing to regress against. That is the decision rule in general: **if you
  cannot write cases for it, it is not a capability yet.**

So capabilities are named semantically, as they would be if no model were
involved: `ticket.triage`, `invoice.extract_totals`, `text.classify` with a
caller-supplied label set. Generality is not the problem — `text.classify` is
general and perfectly typeable, because its input and output are concrete.
Untyped dispatch is the problem.

The inference kind then lives in the **implementation**, not in the contract. A
generative implementation of `ticket.triage` declares kind `classify`, a prompt
template version, and its acceptance terms; the registry sees a semantic
operation and the gateway sees a routing unit. Naming capabilities after
inference kinds would invert that — a catalogue describing how the model was
called rather than what the operation means, which is precisely the thing a
contract is supposed to outlive.

Follow the catalogue's naming convention while doing it: `domain.verb`, dotted
and lowercase. `text.classify`, not `request_text_classification` — "request"
describes the call, not the operation.

### Novel judgment still needs a door

Contract-first must not mean judgment is unavailable until someone writes a
contract for it. AgentFabric already solved the equivalent problem for execution:
`fallback_exec` sits outside the semantic catalogue, is privileged, and is
observed so that recurring use becomes a crystallization candidate.

Judgment gets the same treatment. A privileged fallback into the gateway,
outside the catalogue, available for novel work, recorded every time. When the
same shape of judgment recurs — same inputs, same expected output, same
acceptance — it is a capability gap with evidence attached (§10), and the
extension thread names it, types it, and gives it a corpus. The escape hatch is
how inference capabilities get discovered rather than guessed.

This needs one contract extension. The 0.1 effect vocabulary describes
consequences to resources — discover, read, create, write, append, delete —
and spending inference is none of those. It is a new kind of consequence: it
costs money, it leaves a provider trace, and it may carry data outside a privacy
boundary. That is exactly the condition 0.1 names for extending the contract
rather than a resolver, so a 0.2 revision should add an `infer` effect. Grants
then bound which principals may spend inference at all, and budget authority
attaches to the grant rather than to implementation code.

**One gateway, three doors.** The loop's `request_inference` action, a
generative implementation's call through the host, and the privileged fallback
all reach the same module. Routing statistics, evals,
budgets, and privacy rules are shared, and there is no second router living
below the capability boundary with its own opinions.

### Capabilities that consume state

The big cognitive steps are capabilities too: `goal.decompose`,
`request.classify`, `gap.assess`. They are larger and more expensive than
`ticket.triage`, and they need much more of the composed state — which is
exactly why they benefit from being contracts rather than ad-hoc prompts.

Nothing special is required to give them that state. A state view is a typed
structure, so it can be a typed capability input:

```
goal.decompose(goal, state_view, constraints)
  -> { subgoals[], success_criteria[], desired_operations[] }
```

That keeps the rule that makes this safe: **a capability's context is its
input.** A resolver receives its typed input and nothing else — no session, no
transcript, no ambient projection, no way to reach back for more. A capability
that wants more state must declare it in its contract, where it is visible,
validated, and part of what the corpus fixes. The loop decides what goes in, so
a capability can never widen its own view.

Two consequences of typing state into a contract:

- **Corpus cases carry state fixtures.** A case for `goal.decompose` is a goal
  plus a state view plus the expected decomposition, which makes cases larger
  and makes them real. A contract that consumes state and is tested only on
  toy inputs has not been tested.
- **The contract pins the state view version.** When the view schema changes,
  every state-consuming contract is a revision candidate, its corpus needs
  re-fixturing, and its admitted implementations need re-validation. That cost
  is the price of letting judgment see state at all; the alternative — an
  unversioned blob — pays it silently and continuously instead.

### The loop's own cognition crystallizes too

This closes a loop that was left open in §7. Framing started as
`request_inference`, the unnamed door. When a framing shape recurs — same
inputs, same expected output, same acceptance — it is a capability gap like any
other, and the extension thread names it, types it, gives it a corpus, and
admits an implementation. `goal.decompose` is what framing looks like after it
has been through that.

So the same action kind covers both ends. Novel judgment goes through
`request_inference` and is observed. Matured judgment is `invoke_capability` on
a named contract with recorded reliability, a corpus that catches regressions,
and a routing choice between implementations. Weave's own thinking is subject to
the ladder it applies to everything else, and a state-consuming contract is how
that ladder reaches the parts of the system that need the most context.

### Generative implementations and the crystallization ladder

Once inference is reachable through a contract, an implementation may be a
prompt plus a gateway call. That is legal, and it changes what admission
evidence means:

- Evidence is **distributional** — pass rate over N runs against the corpus at a
  declared bar, not a single green run.
- Maturity caps lower than a deterministic implementation can reach, and
  regresses faster when observed reliability drops.
- Routing prefers a deterministic implementation of the same contract whenever
  one exists and meets the bar.

This is the shape the vision's ladder actually takes. Frontier work runs as raw
inference. The recurring part earns a contract and a corpus. The first admitted
implementation may well be generative — cheap to produce, honest about its
variance. A deterministic implementation then replaces it under the same
contract, inheriting the same corpus as its admission evidence, and the
generative one stays as fallback or is revoked.

Nothing about that ladder requires the loop to know which rung a capability is
on. The contract is the identity; the class of implementation is routing.

## 9. Extension is a thread, not a subroutine

Capability extension runs as ordinary actions in the same loop, on a thread with
declared preconditions. It is therefore interleavable with goal work,
parallelizable within a stage, abandonable when the goal completes another way,
and subject to the same policy, budget, and evidence machinery. No sub-loop, no
second scheduler, no special case.

| Stage | Action | Produces | Gate |
| --- | --- | --- | --- |
| 1 | `select_semantic_verb` | candidate capability id, title, description, effects | registry near-duplicate check first; extending an existing contract beats minting a sibling |
| 2 | `define_contract` | `agentsop` document: input, output, effects, authority, depends_on, invariants, failures | `agentsop` validation, catalogue graph check |
| 3 | `author_tests` | test corpus from the contract only | corpus validated against known evidence and mutations |
| 4 | `demonstrate_red` | observed failure against a placeholder implementation | red is observed, never assumed; a corpus that passes a placeholder is rejected |
| 5 | `generate_implementation` | one or more resolver candidates | inference, parallel across candidates and models |
| 6 | `validate_implementation` | sandboxed run: typecheck, corpus, held-out corpus, effect containment, resource limits | deterministic; probabilistic evaluation may classify remaining questions but cannot turn red green |
| 7 | `request_admission` | approval decision | human or policy; separate from generation |
| 8 | `admit_capability` | registry entry with provenance, maturity, evidence | separate from authority to execute |

Stage 8 changes the capability digest, so the next cycle's candidate
enumeration differs. That is the whole expansion mechanism — the action space
grows because the registry grew, not because the loop learned something.

Three gates stay distinct throughout: generation, admission, and authority to
execute. Admitting a capability grants no grant.

## 10. When to extend at all

Extension costs many inferences. A loop that crystallizes every gap spends its
life building capabilities it uses once.

A **capability gap** is recorded from evidence, not intuition:

- the decision layer returns `inadequate` with `missing`;
- repeated `request_inference` shares a scope signature across cycles;
- fallback execution recurs — AgentFabric already records exactly this in its
  opportunities log, which Weave can consume rather than reimplement.

A recorded gap becomes an extension thread only when recurrence crosses a
threshold or a user asks directly, and the estimated payoff exceeds the
estimated extension cost. Both numbers are recorded and later checked against
what the capability actually cost and saved. Getting this wrong is the most
likely way for Weave to look busy and deliver nothing.

## 11. Evidence and evaluation

Every consequential cycle is replayable: state view, candidates, weights,
policy decisions, frontier, results, and the projection delta. Two uses:

- **Decision evaluation.** Replay recorded state views against a changed
  decision layer and score the weights against known outcomes. Without this,
  a weighted frontier is a guess with extra structure.
- **Capability evaluation.** Observed reliability, cost, and latency per
  implementation feed routing between implementations of one contract, and
  feed maturity regression when an admitted capability degrades.

The record exists for evaluation and accountability. It is not a growing prompt.

## 12. What a capability host must provide

Five requirements on whatever sits behind the capability host port. The current
AgentFabric has none of them, and they are the substance of the "concepts, not
necessarily code" question in §13: inheriting the model is free, and these four
are the work either way. Each belongs below the port, not in the loop.

1. **Substrate-neutral resolver context** (§2) and an out-of-process execution
   tier for untrusted implementations.
2. **Proposed and admitted as distinct states.** Today `crystallise` binds code
   immediately. Weave needs `propose(contract)`, `attach(implementation)`,
   `admit(evidence)`, and `revoke(reason)`, with maturity that can regress.
3. **Several implementations per contract.** The contract is the identity;
   routing between implementations is empirical.
4. **Evidence attached to admission.** Corpus revision, red observation, green
   run, sandbox report, approver, provenance.
5. **Implementation classes.** Deterministic, composed, and generative
   implementations of one contract, with distributional evidence and a routing
   preference for the deterministic one (§8).

The test corpus raises a boundary question deliberately left open: the *shape*
of a test case is expressible purely in contract vocabulary and therefore argues
for the contract package; the runner, the held-out split, and the mutation
policy are runtime. The recommendation is to keep both in the runtime package
until a second runtime needs to read a corpus, then promote only the case shape.

## 13. Inheriting AgentFabric

Two things are being inherited and they are separable.

**The model, inherited unconditionally.** A capability is a durable contract with
typed input and output, declared effects, and declared authority. A resolver is
disposable. A reference to a resource is not a locator, and holding one is not
authority to act on it. A capability may exist unresolved. Failure codes are
contract and messages are not. Composition is declared, not planned. Every claim
in this document above §12 rests on that model, and none of it rests on the
existing code.

**The code, an open decision.** The current implementation is roughly 4,000 lines
of dependency-free Python with a real test suite, a CLI, an MCP binding, a
working grant model, and a fallback path that already records recurring
implementation-level work as capability-gap evidence. Against that: it resolves
one implementation per contract, binds code at crystallisation with no admission
gate, executes resolvers in-process with ambient authority, and discovers its
catalogue by walking parent directories.

The requirements in §12 are the work regardless of which path is taken —
they are not repairs to existing code, they are missing subsystems. So the
decision is narrower than it looks: adopting the code saves the contract
validation, the grant and reference model, the catalogue and overlay handling,
and the bindings, all of which are the parts most expensive to get right twice
and least likely to change. Reimplementing saves nothing structural and loses
the provenance of every contract decision.

The recommendation is to adopt the code, at M3, when there is first something to
put behind the port — and to treat everything before M3 as building against the
port with a fake host, so the decision can be deferred without blocking the loop.
Nothing in M0 through M2 requires it.

### If the code is adopted

Target layout:

```
packages/
  agentsop/
    src/agentsop/            contract types, validation, resolver shape
    spec/EXPERIMENTAL-0.1.md
    spec/capability.schema.json
    tests/
  agentfabric/
    src/agentfabric/         runtime, CLI, MCP binding, builtin resolvers
    examples/capabilities/   demo catalogue (blob.*, text.*, journal.*)
    tests/
  weave/
    src/weave/               goal, state, cycle, ports, adapters
    tests/
```

Order of operations, with the symbol-level move map in
[docs/PACKAGE-SPLIT.md](./docs/PACKAGE-SPLIT.md):

1. **Narrow the resolver context** (§2) in the AgentFabric repository, with its
   current suite green. Behaviour-preserving, and the one change everything else
   waits on.
2. **Fold in with history**, into `packages/agentfabric/`, so the provenance of
   every contract decision survives. That repository stops taking changes at the
   merge commit.
3. **Split the contract package out** per the move map. Mechanical once step 1
   has landed.
4. **Move the demo catalogue** to `packages/agentfabric/examples/capabilities/`;
   resolve schema and spec from package data instead of walking parent
   directories.
5. **Add the import-direction check** to CI.

What comes along working: the CLI, the MCP binding, `.fabric/` overlays,
`agentfabric sync`, the harness skills, and the opportunities log Weave reads as
gap evidence (§10). The Cursor hooks are that repository's own harness adapter;
keeping them is a separate decision.

### If it is not

The contract layer is written fresh against Experimental 0.1 as a specification,
and the demo catalogue becomes the conformance corpus — if a fresh implementation
loads those documents, honours the failure-code precedence, and passes the
existing suite's semantics, it has inherited the model faithfully. That corpus is
worth keeping either way, because it is what makes "AgentSOP-compatible" a
checkable claim rather than a compliment.

## 14. Milestones

- **M0 — loop.** State engine first: log, reducers, entities, slices,
  manifests, golden replay. Then deterministic enumeration over a fixed
  catalogue behind a fake capability host, a scripted decision layer, three
  action kinds (`invoke_capability`, `ask_user`, `complete`), evidence written.
  No inference, no extension.
- **M1 — judgment.** Jev behind `DecisionLayer`, real weights, replay eval
  harness, `request_inference` as an action behind a single-model gateway that
  already records attempts and evaluations, concurrent frontier with effect
  locks. Routing arrives when there is history to route on.
- **M2 — gaps.** Framing inference and its coverage gate (§7), desired
  operations, the deterministic registry diff, and gap detection from decision
  inadequacy, inference-scope recurrence, and the host's opportunities log.
  Threshold and payoff estimate. No generation yet.
- **M3 — extension.** Stages 1–4: verb, contract, corpus, demonstrated red. Ends
  with a red capability in the registry and no implementation.
- **M4 — crystallization.** Stages 5–8 behind the sandbox and an explicit human
  admission gate. One capability, end to end, from gap to admitted.

The capability host decision (§13) and the resolver-context shape (§2) settle
before M3, because M3 is the first point at which generated artifacts reach the
registry. M0 through M2 run against a fake host and do not force the decision.

## 15. Open questions

- **Goal scoping of grants.** A goal-scoped principal with grants derived from
  granted authority is the obvious model, but grant lifetime across threads and
  across extension is undecided.
- **Superseding in-flight work.** When a result arrives against a moved
  projection, reconciliation is currently a policy hook with no default.
- **Composition vs extension.** Weave should prefer composing established
  capabilities. Whether composition is a decision-layer judgment, a deterministic
  type-and-effect search, or both is unresolved.
- **Contract revision.** Changing an admitted contract invalidates a corpus and
  implementations downstream. Versioning exists; the migration path does not.
- **Whether desired operations are state.** Framing emits them, the registry
  diff consumes them, and a gap may recur across goals. Whether they persist as
  first-class state with their own recurrence count, or stay transient
  observations whose recurrence is recomputed, decides how gap thresholds (§10)
  are actually measured.
- **What a state view revision costs in practice.** Pinning the version (§3)
  makes drift visible, but a busy registry of state-consuming contracts could
  make any view change expensive enough to discourage improving state itself.
  Whether views need a compatibility discipline of their own — additive slices,
  deprecation windows — is unsettled.
- **How closed the inference map should be.** Semantic capabilities carry the
  types (§8), so the map only has to name routing and evaluation units. Whether
  that set is closed like the effect vocabulary, extended by revision, or simply
  curated is unsettled — and it decides whether a new kind can appear without
  anyone noticing that routing statistics just reset.
- **Where inference scope is declared.** A tightly scoped inference request looks
  like a capability contract with a non-deterministic implementation. Whether
  `request_inference` should literally be an AgentSOP capability is worth
  settling early, because it decides whether inference routing lives inside the
  fabric or beside it.
