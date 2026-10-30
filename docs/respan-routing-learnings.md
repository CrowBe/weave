# Respan learnings for gateway routing (WV-307)

Status: design note plus one evidence field. From
[#307](https://github.com/CrowBe/weave/issues/307). The external source is the
issue body (findings dated 24 Oct 2026); Respan's documentation was not
re-fetched for this note. Respan is not a dependency and no Weave traffic goes
through it.

- Respan: <https://www.respan.ai/>
- span-router concept:
  <https://www.respan.ai/docs/documentation/features/gateway/span-router/concept.md>

According to the issue, Respan's `span-router` selects a model for each request
from task context, capabilities and cache-aware cost, and keeps a thread on one
model through `thread_identifier`. Weave's gateway does something similar
inside deterministic policy: **Routing** (GLOSSARY.md "Routing") filters
routed units by hard constraints, then orders the rest by expected cost to the
quality bar, and a **prefix cache** (GLOSSARY.md "Prefix cache") discounts one
unit's input. This note checks three things the issue asks about, using the
current code.

## 1. Cache-sticky policy

### How it works today

- The caller supplies the prefix cache record and the prefix digest. The gateway
  never discovers a cache (`packages/gateway/src/types.ts:128-153`). Loom passes
  through a fixed `prefixCache` option and digests the stable prefix of the view
  (`packages/weave/src/runtime.ts:126-131`, `:1254-1263`). These terms go into
  the journalled inference request, so a replay prices the request the same way.
- `priceAttempt` discounts cached input only when the record names this unit
  **and** this digest. A cache larger than the input is ignored and priced cold
  (`packages/gateway/src/routing.ts:78-104`).
- The cache affects **order only** and only among units that have evaluation
  evidence. `expectedCost` returns `null` when evidence is thin, and those units
  keep the order they were configured in, behind the units that have evidence
  (`routing.ts:121-124`, `:166-183`).
- The cache never makes a unit affordable. The `unaffordable` exclusion and the
  check before each attempt both use `worstCaseCost`, which is the cold window
  (`routing.ts:66-71`, `:221`; `packages/gateway/src/gateway.ts:500-505`).
  M6-T01 pins this: a warm unit under a ceiling below its cold worst case is
  blocked (`packages/gateway/test/m6-routing.test.ts:131-159`).
- The budget gate runs after `route()`. It removes units but keeps their order
  (`packages/gateway/src/budget.ts:109-119`). The cache cannot outrank it.

### Can the prefix-cache path thrash units across turns?

**No, not in the current code, because nothing writes back.** The record is
input data that the caller owns. No code writes the unit that actually served
a turn back into the record, so turns have no feedback loop. With the same
record, digest and table, `route()` returns the same order every turn
(`routing.ts:127-130`: filters keep the declared order, and ties are broken on
`routed_unit_id`).

Within one request the gateway calls `budgetRoute` again before every attempt
(`gateway.ts:466`). Terms stay fixed. A unit is left once it is exhausted, has
used up its per-route attempts, or no longer fits under the ceiling
(`gateway.ts:500-505`, `:610`, `:626`, `:633`, `:661`), and it does not come
back. The one way a request can switch away and later return is a quota
snapshot that changes between attempts and makes the budget gate exclude a
unit, then readmit it. Both switches are policy decisions and both show up as
route records.

The real hazard is **staleness**, not thrash. Weave has no stickiness of
Respan's `thread_identifier` kind. Suppose a turn escalates off the cached unit.
The provider's warm cache may now be on the fallback, but the next turn still
prices the original unit warm. The record is where stickiness lives, and the
operator owns it.

If a composition root ever writes the record back, the write must:

- be a durable observation keyed by thread and digest
- be written only from an accepted attempt
- be idempotent under replay
- be compare-and-set on `prefix_digest`

Weave's durable-journal rules already require this. The discount must also
stay behind every filter, as it does today. This note does not add a
write-back.

### Evidence: what was missing, and the change

| Question                                     | Before                                                                                                                                                                  | After                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Did routing price this unit warm or cold?    | Not recorded. Outcome `uncertainty` noted only the `ignored` case (`routing.ts:161-165`, `gateway.ts:562-571`)                                                          | `route.selected.prefix_cache`: `hit`, `reload` or `ignored`        |
| Did an escalation leave the cached unit?     | A new `route.selected` that `supersedes` the old one (`packages/gateway/src/weft.ts:91-120`), with nothing about the cache                                              | The superseding record reads `reload` after a `hit`                |
| Did the budget gate exclude the cached unit? | `excluded[].reason` on the next route record (`budget.ts:116`)                                                                                                          | Unchanged, and that next record now carries its own `prefix_cache` |
| Did Gauge evidence depend on cache state?    | No. Preference sets credit accept rate per routed unit (`packages/gateway/src/preferences.ts:147-168`). That is correct, because the cache changes cost, not acceptance | Unchanged                                                          |

The new **prefix cache use** field (GLOSSARY.md) is set by `prefixCacheUse`
(`routing.ts:106-115`) and emitted from the attempt loop (`gateway.ts:548`)
onto `route.selected` (`weft.ts:110-112`). The Weft contract and validator
accept it as an optional reference code
(`packages/weft/src/WEFT-CONTRACT.md:180`,
`packages/weft/src/validate.ts:185`). The field is absent when the request
asked for no cache lookup. SQLite schema v1 adds no column, and the field stays
in the canonical record. This is Respan's "cache-aware switch in logs", inside
Weft.

Red then green: `M6-T05` (`m6-routing.test.ts:259`) failed with
`prefix_cache` `undefined` on both route records. It passes after the change.
The test pins four behaviours:

- **Hit, then reload.** A warm request whose cached unit refuses
  non-retryably records a `hit` for `route.strong`, then a `reload` for the
  `route.cheap` escalation.
- **Ignored.** An oversized cache records `ignored`.
- **Empty.** A matching record with zero cached tokens discounts nothing, so
  it records `reload`. This case was added in review and passed on its first
  run, because it pins existing pricing.
- **Absent.** A request with no cache record emits no field.

Routing semantics did not change. The order and the outcomes are the same as
before.

### Failure, cancellation and concurrency

- **The cached unit becomes unavailable mid-thread.** If it is already
  unavailable when a request routes, `route()` excludes it as
  `provider_unavailable` (`routing.ts:208`). The next unit is selected with
  `prefix_cache: reload`, and the exclusion is listed. If it fails during a
  request, the loop escalates (`gateway.ts:597-643`): the new route record
  `supersedes` the old one, is `caused_by` the failed attempt, and reads
  `reload` (M6-T05). On the next turn, if the unit is available again, the
  unchanged record sends the request back to it. That is expected, and it is
  not thrash.
- **The budget gate excludes the cached unit.** The gate removes it with its
  budget reason (`budget.ts:113-119`). Pace-ahead on a strong unit may
  downgrade the tier, but never the quality, and never for audit
  (`budget.ts:120-145`). The cache discount has no influence on the gate. The
  fallback's route record reads `reload`.
- **Cancellation.** The abort signal is checked before and after routing
  (`gateway.ts:457`, `:477`). The gateway holds no cache state, so there is
  nothing to undo.
- **Concurrent turns on one thread racing the same cache key.** The only
  per-gateway state shared across calls is pacing (`gateway.ts:145-147`). Both
  requests price from the same input record, so they route identically and no
  update can be lost. On the provider side only one request may warm the
  cache. The other may be served cold but charged at the warm price (see
  uncertainty below). A future write-back must use the compare-and-set
  journal write described above, so two racing turns cannot each claim the
  key.

## 2. Task context the ranker sees

After the budget gate, the only soft ranking left in this repo is the
expected-cost sort over evidenced units (`routing.ts:175-183`). The budget gate
keeps that order (`budget.ts:113`). The sort is deterministic arithmetic over
recorded evidence, not a probabilistic ranker. Dispatch `resolve.py` (grok-ship)
is outside this repo and is not audited here.

What `route()` reads:

- **Target.** `operation`, `kind`, and optionally `tier`
  (`types.ts:398-400`). The gateway builds it from the request's `kind`
  (`gateway.ts:168`, `:245`).
- **Terms.** `tier`, `audit`, `quality`, `destinations`, `content_class`,
  `max_context_tokens`, `cost_ceiling`, `prefix_digest` and `prefix_cache`
  (`types.ts:138-164`). All of them are **hard filters** except the prefix
  fields, which only affect price.
- **Per unit.** Declared quality, context limit, price, destination, the
  training mark, and `evidence` (`attempts`, `accepted`).
- **Request-wide.** A content-free credential screen bit and the injected
  provider availability.

What it does **not** read:

- **Site.** The site reaches routing only by narrowing evaluation routes to the
  bound decision provider (`gateway.ts:225-238`). Otherwise it reaches routing
  through whichever table or preference set the composition root supplies.
- **Role.** Never read.
- **Request content.** Never read, beyond the credential screen bit.

So Weave already routes "the task, not the prompt" in Respan's sense: the kind,
tier, quality, privacy, context and budget are all declared. It does not use
prompt features. The gap is that evidence is **not keyed by site** inside the
gateway. GLOSSARY "Routing" says "per-site success rates", but `RouteEvidence`
belongs to the routed unit, and a preference set names a `workload`
(`preferences.ts:37-49`). Per-site evidence holds only when the composition
root supplies a site-specific table or set.

If this needs to be denser, do it with a typed evidence key such as
(site, kind), carried as data, rather than by putting prompt or brief text in
front of the ranker. `resolve.py` should follow the same rule:

- Kind, brief, role and hard constraints arrive as typed fields.
- Hard constraints filter **before** any ranking.
- A Jev pick only orders what survives.

No change is made here.

## 3. Keep the split

- **Routing stays deterministic.** `route()` and `budgetRoute()` are pure
  functions of the table, target, terms, availability, quota snapshot and an
  injected `now` (`routing.ts:131-139`, `budget.ts:99-108`). They make no model
  call and read no ambient clock.
- **Jev and Amos stay on judgment sites.** They are reached only through
  evaluation requests at a judgment site. `bindDecisionProvider` allows only
  `typesafe-jev` as the default. Amos is allowed only as a per-site override
  for `intake.classify` and `loop.preselect`
  (`packages/gateway/src/config.ts:37`, `:93-113`). No judgment site selects a
  routed unit.
- **A span-router-style ranker can only be a comparison.** It would be a
  judgment site that scores the eligible order **after policy** in replay or
  trial mode, recorded as an observation and a Gauge result. It can reach
  routing only by promoting a `gauge.preference@1` set. `applyPreferences`
  replaces only `evidence`, cannot add a unit, and runs ahead of every filter
  (`preferences.ts:155-168`). This matches
  [Jev model routing](research/jev-model-routing-implementations.md#local-architectural-boundary).

No product fork is needed.

## Hand-off

- **WV-042** (structured model options for dispatch, Jev vs Clef-flash): link
  #307 and fold in Respan's published span-router vs Jev Router τ-bench numbers
  (Sep 2026) as an **external datapoint**. Record their provenance and license
  status first. They are cases authored by the vendor, not held-out cases
  reserved by Weave, so they cannot be the only evidence for any comparison
  (AGENTS.md, Benchmark evidence). No WV-042 brief exists in this repo yet to
  link from.

## Remaining uncertainty

- **Charged cost can understate spend.** When a provider reports tokens but no
  `cost`, metered cost applies the caller's cache record to the reported tokens
  (`gateway.ts:1069-1073`). `ProviderUsage` has no cached-token count
  (`types.ts:408-413`). A provider-side miss on a unit that routing priced as a
  `hit` is therefore charged at the warm price. Reservations stay safe because
  they use the cold worst case. Closing this would need adapters to report
  cached tokens, which is a separate change.
- **The cache can be moot without a field saying so.** A warm unit with thin
  evidence keeps its configured position. `prefix_cache: hit` then records the
  price, not that the price changed the order. The existing "no evaluation
  evidence" uncertainty note covers this case.
- **Respan claims are unverified.** Statements about Respan's behaviour come
  from the issue body and were not checked against their current documentation.
