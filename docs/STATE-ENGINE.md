# State engine

State is the part of Weave that everything else assumes. The cycle reads it, the
decision layer is shown a rendering of it, capability inputs are bound from it,
gap detection counts over it, and evidence is replayed against it. It carries an
open-ended set of payload types, from user messages to capability results to
sandbox reports, and it has to answer very different questions for very different
consumers without becoming a bag of dictionaries.

This document specifies the engine. [ARCHITECTURE.md §3](../ARCHITECTURE.md) is
the summary.

## 1. What it has to do

Six requirements, each already relied on somewhere else in the architecture:

1. **Capture anything**, including payload types nobody has written a handler for
   yet, without losing them and without the engine knowing their shape in advance.
2. **Mutate deterministically.** The same observations in the same order produce
   the same state, or replay evaluation is worthless.
3. **Represent per consumer.** A classification, a goal decomposition, a
   capability input, and a human inspecting a run need different renderings of
   the same state, at different budgets.
4. **Answer specific queries**: which candidates can bind, which gaps recur,
   which refs are locked, which inference produced which outcome.
5. **Replay exactly**, including what was in a composed view at the moment a
   judgment was made.
6. **Stay bounded** without quietly discarding what it summarized.

## 2. Shape

```
observations (append-only, typed payloads)
        │  reducers: pure, registered per observation type
        ▼
entities (identified, typed, provenanced, versioned)
        │  slices: declarative, budgeted, versioned
        ▼
views (state views, context bundles, capability inputs) + manifests
        │
indexes ─┘ (the queries the loop and the gateway actually make)
```

Three separations do the work. The log is fact and never changes. Entities are
interpretation and can be rebuilt. Views are rendering and are always derived,
never stored as truth.

## 3. Capture

The envelope is fixed and small. The payload is open and registered.

```jsonc
{
  "seq": 1841,                         // monotonic, engine-assigned
  "ts": "…",
  "goal": "gl_…",
  "thread": "th_…",
  "type": "capability.result@1",       // registered observation type
  "payload": { },                      // validated against that type's schema
  "caused_by": { "action": "ac_…", "watermark": 1836 },
  "principal": "pr_…",                 // whose authority produced this
  "evidence": "ev_…",                  // trace, sandbox report, attempt record
  "cost": { "tokens": 0, "usd": 0.0 }
}
```

This is deliberately the same move AgentSOP makes for invocations: a fixed
envelope that the runtime can always reason about, and a per-type payload schema
that extends without touching the core. Use the same schema validator as the
contract package rather than introducing a second dialect — and if the contract
subset is too small for state payloads, widen it there, once.

**An unregistered type is still captured.** The log accepts it, the engine emits
a `state.unhandled_observation` of its own, and no entity changes. Capture never
fails because interpretation lags; the gap is visible rather than silent.

Observation types are namespaced and versioned: `user.message@1`,
`capability.result@1`, `inference.completed@2`, `approval.granted@1`,
`sandbox.report@1`, `gap.observed@1`, `external.event@1`. A breaking payload
change is a new version, not an edit.

## 4. Entities

The projection is not one object. It is a set of identified, typed entities, each
with a lifecycle and provenance.

| Entity | Holds | Lifecycle |
| --- | --- | --- |
| `Goal` | statement, authority envelope, success criteria, budgets | open → satisfied / abandoned |
| `Thread` | causal sequence, parent, purpose | active → joined / superseded / cancelled |
| `Fact` | an asserted value with its citations | asserted → contradicted / stale |
| `OpenQuestion` | what is unknown, what would answer it | open → answered / dropped |
| `DesiredOperation` | verb, effects, rough shapes (§7) | proposed → matched / gap |
| `CapabilityGap` | signature, occurrences, payoff estimate | observed → extending → closed |
| `ActionRecord` | candidate, weights, policy decisions, read set, locks, result | enumerated → executing → complete / superseded |
| `Approval` | what was asked, who answered, scope, expiry | requested → granted / refused / expired |
| `Budget` | allocation and draw per goal and per thread | — |
| `Risk` | hazard, evidence, mitigation | open → mitigated / accepted |
| `Artifact` | contract draft, corpus, implementation candidate, report | proposed → validated / rejected |

One rule keeps this honest:

> **No entity field without a citing observation.**

Every field records the observation seqs that produced it. An entity is a cache
of an interpretation of the log, so anything it claims can be traced, and
anything that cannot be traced is a bug in a reducer rather than a fact about the
world.

## 5. Reducers

A reducer is registered per observation type and is a pure function:

```
reduce(type) : (entities_snapshot, observation) -> [mutation]
```

Rules that make replay meaningful:

- Pure and total. No clock, no network, no randomness — the envelope carries the
  timestamp, and anything else the reducer needs is in the payload.
- Mutations are declared, not imperative: create, set-field-with-citation,
  transition-status, link, retire. A reducer cannot half-update an entity.
- One writer. Observations are applied in `seq` order by a single owner, so two
  reducers touching one entity resolve deterministically.
- Actions never mutate. An executing action emits observations; the engine
  applies them. This is the structural reason a model cannot write to state.

## 6. Representation

A **slice** is a named, versioned, declarative query over entities with a depth
and a budget. Views are built from slices — the decision layer's state view, a
context bundle for an inference kind (§7), the typed state input of a capability
like `goal.decompose` (§8), and the inspector's rendering are all the same
mechanism at different settings.

Slice catalogue, initially: `goal`, `authority`, `facts`, `open_questions`,
`threads`, `actions_in_flight`, `capability_digest`, `gaps`,
`desired_operations`, `budgets`, `approvals`, `risks`, `recent_observations`,
`artifacts`.

Each slice declares depth options, an ordering, and a truncation policy. Three
disciplines:

- **Selection is deterministic.** Ranking is recency, causal distance to the
  goal, and explicit links — not a model. A slice that needed a model to choose
  its contents would be an unrecorded judgment site inside the thing that
  composes inputs for judgment sites.
- **Truncation is disclosed.** A budgeted slice says what it dropped:
  `{"included": 12, "of": 340, "policy": "recency"}`. A consumer that does not
  know it is seeing a subset reasons as though it saw everything.
- **Every view carries a manifest.** Slice by slice: item ids, content hash,
  token count, truncation. The manifest is what makes a recorded judgment
  reproducible, and it is small enough to keep forever even when the view is not.

## 7. Indexes

The engine maintains exactly the indexes the rest of the architecture already
assumes, and each exists for a named caller:

| Index | Answers | Caller |
| --- | --- | --- |
| by thread | what is in flight here | the cycle, joins |
| by entity status | what is open, blocked, superseded | enumeration |
| by resource ref | which actions hold or want this ref | effect locks (§5) |
| by gap signature | has this shape recurred, how often, across which goals | extension gate (§10) |
| by correlation id | which inference produced which downstream outcome | routing feedback (§7) |
| by citation | which entities depend on this observation | invalidation, compaction |

If a query has no caller, it does not get an index. Indexes are derived and
rebuildable, never a second source of truth.

## 8. Concurrency

Write conflicts are already handled by effect locks computed from capability
contracts (§5). Read conflicts need the mirror image.

When a candidate is enumerated it declares its **read set**: the entity ids its
input binding and its rationale depend on. The cycle's snapshot `seq` is the
**watermark**. Both travel with the action.

When a result lands, the engine compares the read set against everything that
changed since the watermark, and applies the action kind's declared
reconciliation policy:

| Policy | Meaning | Typical use |
| --- | --- | --- |
| `apply` | staleness does not matter | appending an observation, logging |
| `recompute` | rebind inputs and re-run if they moved | cheap reads |
| `supersede` | discard the result, keep the evidence | a weighed decision overtaken by a better one |
| `cancel` | stop the thread, record why | the goal or authority moved underneath it |

Staleness becomes computable rather than guessed, which is the only way
concurrent execution stays legible.

## 9. Bounded growth

The log is never trimmed for correctness; it may be archived, but it stays
addressable. What gets bounded is the projection and the views.

Compaction produces **derived summary entities** that obey the same rules as
everything else: they cite the observation range they summarize, they carry their
invalidation conditions, and they are replaced rather than edited when a citing
observation is superseded. A summary that cannot say what it replaced is
forbidden, because that is precisely how state stops being legible.

Views are not stored as state. Manifests are.

## 10. Evolution

This is the part that gets expensive later if it is ignored now.

- Observation types are versioned; old reducers are retained so old logs still
  replay.
- The projection records the reducer registry version that built it.
- Checkpoints are snapshots of entities at a seq with that version, so rebuilding
  does not mean replaying from zero forever.
- A reducer change means rebuild from the last compatible checkpoint, and the
  rebuild is a test: the new projection is diffed against the old one, and
  unexplained differences are the bug.
- Slices are versioned independently of entities, and a consumer pins what it was
  written against (§3). State view versioning is the visible edge of this.

## 11. Two tiers

Not everything belongs to one goal.

**Goal state** is scoped and ephemeral: facts, questions, threads, actions,
approvals, budgets, artifacts. It ends with the goal.

**Durable knowledge** crosses goals: the capability registry, observed
reliability and cost per implementation, routing statistics per routed unit, the
gap ledger, and eval history.

The boundary is an authority boundary, not a convenience:

> Content learned under one goal's authority does not become available to another
> goal by being written down.

So durable knowledge holds statistics, signatures, and capability metadata —
things about the system's own behaviour. Content facts stay goal-scoped unless
explicitly promoted with the authority to do so. A gap signature crossing goals
is a hash and a count, not the data that produced it.

## 12. Storage and testing

Start simple, keep the port: append-only JSONL for the log, an in-memory entity
store rebuilt at startup, periodic checkpoints. Move to SQLite when query volume
justifies it — a log table, entity tables, and real indexes — without changing
the engine's interface. Do not start with a graph database.

Testing is where the design pays off:

- **Golden replay.** A log fixture plus a reducer registry version produces a
  byte-identical entity snapshot.
- **View fixtures.** A projection plus a slice spec produces a byte-identical
  view and manifest.
- **Reducer purity.** Property tests that reordering independent observations, or
  replaying the same observation twice, changes nothing it should not.
- **Reconciliation.** Scripted watermark and read-set collisions per policy.

Every one of these runs without a model, which is what makes the loop testable
before there is anything intelligent in it.

## 13. Open questions

- **Fact contradiction.** When a new observation contradicts an asserted fact,
  the engine can mark it contradicted, but choosing which assertion survives is
  a judgment. Whether that is a judgment site or a deterministic recency rule is
  unsettled.
- **Relevance without a model.** Deterministic ranking is right for the first
  version; at scale, "facts relevant to this goal" may need embeddings, which
  reintroduces a judgment into composition and therefore needs its own eval.
- **Where entity schemas live.** They are contract-shaped and validated like
  capability documents, but they are Weave's own vocabulary. Sharing the
  validator without sharing the namespace is the likely answer.
- **Cross-goal promotion.** The mechanism by which a content fact is deliberately
  promoted from goal state to durable knowledge, and what authority that
  requires, is named here but not designed.
