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
for §12, and the architecture above it does not change either way.

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

State is an append-only **observation** log plus a derived projection. The log is
the evidence record; the projection is what the runtime reasons over. Both are
goal-scoped.

```
Observation  = { seq, ts, thread, kind, payload, caused_by, evidence_ref }
```

Every observation carries a monotonic `seq`. A cycle reads a snapshot at some
`seq`; an action executed from that snapshot records it. When a result lands
against a projection that has moved, the runtime reconciles explicitly —
continue, supersede, or cancel — instead of applying stale work silently.

State is written by a single owner. Concurrent actions produce observations;
they do not mutate the projection.

The projection holds goal and authority envelope, known facts, open questions,
active threads, capability digest, constraints, approvals, budgets, and risks.
Conversation is one source of observations, never the projection itself.

### State view

A **state view** is the bounded, typed rendering of the projection handed to the
decision layer. It is not the projection and not the log. It exists so that
decision quality can be evaluated: the same state view must produce comparable
weights across models and across time.

State views are budgeted. A capability digest is one compact line per capability
(id, title, effects, resolution status, cost class, observed reliability); full
input and output schemas travel only for shortlisted candidates. The stable
prefix of a state view — goal, authority, capability digest — is ordered first so
it can be cached across cycles.

## 4. Ports

Weave defines the interfaces; adapters implement them.

| Port | Responsibility | First adapter |
| --- | --- | --- |
| `CapabilityHost` | list, describe, invoke, propose, admit, revoke capabilities | `agentfabric` |
| `DecisionLayer` | weight candidates against a state view | Jev |
| `InferenceRouter` | select a model for a requested kind of inference | single-model stub |
| `ApprovalChannel` | request and receive human authority | CLI prompt |
| `EvidenceSink` | persist traces, weights, outcomes | JSONL |
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

## 6. Decision layer contract

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
  is the eval corpus (§10).

## 7. Inference flow

Four inference roles, separated by what they may author and what they cost.

| Role | Question it answers | When | May author |
| --- | --- | --- | --- |
| **Weighing** (the decision layer) | which of these candidates | every cycle | weights and uncertainty, nothing else |
| **Framing** | what is this goal made of | goal opening, impasse | observations: subgoals, success criteria, open questions, desired operations |
| **Working** | do this scoped thing | per action | the output its request declared |
| **Extension** | contract, corpus, implementation | inside an extension thread | artifacts, admitted only by §8 gates |

### The two obvious flows are one dial

A purely reactive flow — goal in, enumerate, weigh, act, repeat — is this machine
with framing never running. A decomposition-first flow — goal in, deconstruct,
describe the operations the goal wants, diff against the registry, crystallize
the gaps, then act — is this machine with framing always running first.

They are not competing architectures. **Framing is a candidate, not a stage.**
The runtime enumerates `request_inference(kind=framing)` like anything else; the
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

### Weighing does not route

The decision layer decides whether to infer and at what quality bar. The
inference router turns (kind, quality bar, privacy, latency, budget) into a
model, from eval history. Letting the weigher pick models couples it to
providers and makes both unevaluable, and the decision layer's own strength —
fast, typed, cheap judgment — is not model selection.

### Cost gate and how to settle the question

Framing is gated on enumeration coverage: run it when nothing binds above
threshold, or at an impasse, not on arrival by reflex. Whether
framing-on-arrival beats framing-on-demand is an empirical question, not an
architectural one. Both are the same gate at different settings, so the answer
comes from replay (§10) rather than from a rewrite.

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

## 8. Extension is a thread, not a subroutine

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

## 9. When to extend at all

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

## 10. Evidence and evaluation

Every consequential cycle is replayable: state view, candidates, weights,
policy decisions, frontier, results, and the projection delta. Two uses:

- **Decision evaluation.** Replay recorded state views against a changed
  decision layer and score the weights against known outcomes. Without this,
  a weighted frontier is a guess with extra structure.
- **Capability evaluation.** Observed reliability, cost, and latency per
  implementation feed routing between implementations of one contract, and
  feed maturity regression when an admitted capability degrades.

The record exists for evaluation and accountability. It is not a growing prompt.

## 11. What a capability host must provide

Four requirements on whatever sits behind the capability host port. The current
AgentFabric has none of them, and they are the substance of the "concepts, not
necessarily code" question in §12: inheriting the model is free, and these four
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

The test corpus raises a boundary question deliberately left open: the *shape*
of a test case is expressible purely in contract vocabulary and therefore argues
for the contract package; the runner, the held-out split, and the mutation
policy are runtime. The recommendation is to keep both in the runtime package
until a second runtime needs to read a corpus, then promote only the case shape.

## 12. Inheriting AgentFabric

Two things are being inherited and they are separable.

**The model, inherited unconditionally.** A capability is a durable contract with
typed input and output, declared effects, and declared authority. A resolver is
disposable. A reference to a resource is not a locator, and holding one is not
authority to act on it. A capability may exist unresolved. Failure codes are
contract and messages are not. Composition is declared, not planned. Every claim
in this document above §11 rests on that model, and none of it rests on the
existing code.

**The code, an open decision.** The current implementation is roughly 4,000 lines
of dependency-free Python with a real test suite, a CLI, an MCP binding, a
working grant model, and a fallback path that already records recurring
implementation-level work as capability-gap evidence. Against that: it resolves
one implementation per contract, binds code at crystallisation with no admission
gate, executes resolvers in-process with ambient authority, and discovers its
catalogue by walking parent directories.

The four requirements in §11 are the work regardless of which path is taken —
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
gap evidence (§9). The Cursor hooks are that repository's own harness adapter;
keeping them is a separate decision.

### If it is not

The contract layer is written fresh against Experimental 0.1 as a specification,
and the demo catalogue becomes the conformance corpus — if a fresh implementation
loads those documents, honours the failure-code precedence, and passes the
existing suite's semantics, it has inherited the model faithfully. That corpus is
worth keeping either way, because it is what makes "AgentSOP-compatible" a
checkable claim rather than a compliment.

## 13. Milestones

- **M0 — loop.** Observation log, projection, state view, deterministic
  enumeration over a fixed catalogue behind a fake capability host, scripted
  decision layer, three action kinds (`invoke_capability`, `ask_user`,
  `complete`), evidence written. No inference, no extension.
- **M1 — judgment.** Jev behind `DecisionLayer`, real weights, replay eval
  harness, working inference as an action, concurrent frontier with effect locks.
- **M2 — gaps.** Framing inference and its coverage gate (§7), desired
  operations, the deterministic registry diff, and gap detection from decision
  inadequacy, inference-scope recurrence, and the host's opportunities log.
  Threshold and payoff estimate. No generation yet.
- **M3 — extension.** Stages 1–4: verb, contract, corpus, demonstrated red. Ends
  with a red capability in the registry and no implementation.
- **M4 — crystallization.** Stages 5–8 behind the sandbox and an explicit human
  admission gate. One capability, end to end, from gap to admitted.

The capability host decision (§12) and the resolver-context shape (§2) settle
before M3, because M3 is the first point at which generated artifacts reach the
registry. M0 through M2 run against a fake host and do not force the decision.

## 14. Open questions

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
  observations whose recurrence is recomputed, decides how gap thresholds (§9)
  are actually measured.
- **Where inference scope is declared.** A tightly scoped inference request looks
  like a capability contract with a non-deterministic implementation. Whether
  `request_inference` should literally be an AgentSOP capability is worth
  settling early, because it decides whether inference routing lives inside the
  fabric or beside it.
