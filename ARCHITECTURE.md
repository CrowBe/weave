# Architecture

This document turns [VISION.md](./VISION.md) into a component map, dependency
directions, and typed boundaries. It uses the terms in [CONTEXT.md](./CONTEXT.md)
exactly. Code shapes here are illustrative, not committed signatures.

Nothing in this document is built yet. It exists so the first milestone is a
narrowing of a decided architecture rather than an invention.

## 1. Three packages, one repository, one dependency direction

AgentFabric folds into this repository as a package. It is not a separate
repository and not a separate release cycle. The boundary is a package boundary,
enforced by import discipline rather than by a repository wall.

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

## 2. The resolver context is the load-bearing change

Today `ResolverContext` exposes `locator(ref) -> Path` and `workspace -> Path`.
That single design choice forces two consequences:

1. The resolver contract shape cannot move into `agentsop` as written, because it
   names a filesystem. A contract that mentions `Path` is not substrate-neutral.
2. Resolvers must be trusted local Python, because they hold real paths and the
   ambient authority of the host process.

Both dissolve together. If the context is narrowed to operations expressed only
in contract vocabulary —

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
from the fabric. The fabric mediates every effect because there is no other way
for the resolver to reach anything.

This is a prerequisite for Weave, not a refinement. Weave generates
implementations; generated code cannot be admitted into a process that holds
ambient authority. Existing built-in resolvers can keep an in-process trusted
tier, but the shape they are written against must be the narrow one.

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
  is the eval corpus (§9).

## 7. Extension is a thread, not a subroutine

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

## 8. When to extend at all

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

## 9. Evidence and evaluation

Every consequential cycle is replayable: state view, candidates, weights,
policy decisions, frontier, results, and the projection delta. Two uses:

- **Decision evaluation.** Replay recorded state views against a changed
  decision layer and score the weights against known outcomes. Without this,
  a weighted frontier is a guess with extra structure.
- **Capability evaluation.** Observed reliability, cost, and latency per
  implementation feed routing between implementations of one contract, and
  feed maturity regression when an admitted capability degrades.

The record exists for evaluation and accountability. It is not a growing prompt.

## 10. What AgentFabric must gain

Weave needs four things the current fabric does not have. Each belongs in
`agentfabric`, not in the loop.

1. **Narrow resolver context** (§2) and an out-of-process execution tier for
   untrusted implementations.
2. **Proposed and admitted as distinct states.** Today `crystallise` binds code
   immediately. Weave needs `propose(contract)`, `attach(implementation)`,
   `admit(evidence)`, and `revoke(reason)`, with maturity that can regress.
3. **Several implementations per contract.** The contract is the identity;
   routing between implementations is empirical.
4. **Evidence attached to admission.** Corpus revision, red observation, green
   run, sandbox report, approver, provenance.

The test corpus raises a boundary question deliberately left open: the *shape*
of a test case is expressible purely in contract vocabulary and therefore argues
for `agentsop`; the runner, the held-out split, and the mutation policy are
fabric. The recommendation is to keep both in `agentfabric` until a second
runtime needs to read a corpus, then promote only the case shape.

## 11. Folding AgentFabric in

AgentFabric exists today as its own repository, one distribution, with the
Experimental 0.1 contract text and a demo catalogue beside it. The fold-in and
the package split are the same piece of work, and the symbol-level move map is
in [docs/PACKAGE-SPLIT.md](./docs/PACKAGE-SPLIT.md).

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

Order of operations:

1. **Narrow the resolver context in place** (§2), in the AgentFabric repository,
   with its current suite green. Behaviour-preserving, and the one change that
   everything else waits on.
2. **Fold in with history.** Bring the AgentFabric repository into
   `packages/agentfabric/` preserving commits, so the provenance of every
   contract decision survives. The AgentFabric repository stops taking changes at
   that commit.
3. **Split `agentsop` out** per the move map. Mechanical once step 1 has landed.
4. **Move the demo catalogue** to `packages/agentfabric/examples/capabilities/`;
   resolve schema and spec from `agentsop` package data instead of walking
   parent directories for an `agentsop/` folder.
5. **Add the import-direction check** to CI, at the point where there are three
   packages to check.

What comes with it and stays working: the CLI, the MCP binding, `.fabric/`
overlays, `agentfabric sync`, the harness skills, and the opportunities log that
Weave later reads as gap evidence (§8). The Cursor hooks are an adapter for the
AgentFabric repository's own harness; whether Weave keeps them is a separate
decision from the fold-in.

Steps 1–5 add no behaviour. Weave's own package starts empty and M0 (§12) is its
first code.

## 12. Milestones

- **M0 — loop.** Observation log, projection, state view, deterministic
  enumeration over the existing catalogue, scripted decision layer, three action
  kinds (`invoke_capability`, `ask_user`, `complete`), evidence written. No
  inference, no extension.
- **M1 — judgment.** Jev behind `DecisionLayer`, real weights, replay eval
  harness, `request_inference` as an action, concurrent frontier with effect
  locks.
- **M2 — gaps.** Gap detection from decision inadequacy, inference-scope
  recurrence, and the fabric's opportunities log. Threshold and payoff estimate.
  No generation yet.
- **M3 — extension.** Stages 1–4: verb, contract, corpus, demonstrated red. Ends
  with a red capability in the registry and no implementation.
- **M4 — crystallization.** Stages 5–8 behind the sandbox and an explicit human
  admission gate. One capability, end to end, from gap to admitted.

The fold-in and package split (§11) and the resolver-context narrowing (§2) land
before M3, because M3 is the first point at which generated artifacts enter the
fabric.

## 13. Open questions

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
- **Where inference scope is declared.** A tightly scoped inference request looks
  like a capability contract with a non-deterministic implementation. Whether
  `request_inference` should literally be an AgentSOP capability is worth
  settling early, because it decides whether inference routing lives inside the
  fabric or beside it.
