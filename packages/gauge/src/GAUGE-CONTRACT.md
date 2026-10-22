# Gauge evaluation contract v1

Status: contract (G1, #189), validator (G2, #190), governed revisions
(G3, #191), and statistics, producers, evaluation cost and the cost gate
(G5, #193).
`validate` in
`src/validate.ts` implements this contract; `test/contract.test.ts` runs the
fixtures in `fixtures/records.json` against the compiled package as part of
`npm test` (`npm run test:gauge-contract` alone). `@weave/gauge` imports
`@weave/weft` and nothing else in-repo (`checks/import-direction.mjs`).

## What Gauge is for

Gauge turns evidence into **evaluation results**: versioned, bound,
recomputable statements about how one subject performed on a case set under a
criteria set, and comparisons of a baseline with a candidate. Its inputs are
Weft traces (`packages/weft/src/WEFT-CONTRACT.md`) and other recorded evidence:
check results, held-out reports and observations.

Gauge produces evidence. It does not decide:

- It never promotes, admits, rolls back, changes maturity or applies a routing
  preference. Those remain separate governed decisions. In Loom, an
  **Experiment** (`ExperimentRecord`) and its `experiment.compared` observation
  may cite a Gauge comparison; promotion stays with Loom's strategy selection.
- Every verdict is derived. A validator recomputes it from the record and the
  records it binds, and rejects a verdict that does not match. A subject cannot
  assert that it won.
- It does not define success. Criteria sets and case sets are governed records
  with their own authority, and they are not authored by the subject under
  evaluation. A result binds only to a revision that a governed revision
  (`gauge.revision@1`) records, so a change to what counts as success is a
  separate, recorded change with its own authority and justification.

Gauge depends on the Weft contract only: its kinds and field names. It imports
nothing from Loom, Fabric, AgentSOP or the gateway. Agent University and other
consumers use the same records.

## Terms

- **Experiment** is the existing glossary term for a comparative run. *Swatch*
  is not used.
- *Pattern* is not added. An expected behaviour is a constraint in a criteria
  set, or a case in a capability contract's test corpus.
- **Tune split** and **holdout** are the existing glossary terms. A
  **held-out report** is the only evidence a holdout result may disclose.

## Value types

Weft's `id`, `code`, `count`, `metric`, `ratio`, `flag` and `digest` apply
unchanged. In addition:

| Type | Rule |
| --- | --- |
| rev | `^[A-Za-z0-9_.:-]{1,120}@[0-9]{1,9}$`: a governed record's name and revision |
| number | Finite number |
| interval | `[lo, hi]` of numbers with `lo ≤ hi` |
| governance | `{ "kind": "policy" \| "approval", "ref": id }`: the authority that issued this revision |

Every record is an object with exactly the keys listed for its schema. Lists
are bounded as stated and, where keyed, unique by that key.

## `gauge.criteria@1`: criteria set

What counts as success for a workload, and how it is measured.

- `schema`: `"gauge.criteria@1"`
- `criteria`: rev
- `workload`: id
- `governed_by`: governance
- `method`: `{ "interval": "wilson@1" | "bootstrap@1", "level": ratio, "seed": count, "min_samples": count }`.
  `level` is strictly between 0 and 1 and `min_samples` is at least 1.
  Statistics are deterministic for a given seed.
- `measures`: 1–32, unique by `measure`. Each is exactly
  `{ "measure": code, "source": source, "aggregate": "rate" | "mean" | "sum" | "p95", "better": "higher" | "lower", "min_effect": metric }`.
  A source is `{ "weft_kind": code, "field": code }`, naming a Weft v1 kind
  and one of that kind's fields, or `{ "evidence": "check" | "held_out_report" }`.
  `wilson@1` applies only when every measure's aggregate is `rate`.
- `constraints`: 0–32, unique by `constraint`. Each is exactly
  `{ "constraint": code, "measure": code, "op": "ge" | "le", "bound": number, "role": "quality_bar" | "protected" }`.
  `measure` names a measure in this set. A quality-bar constraint and a
  protected constraint are both gates: neither is traded against a score.

## `gauge.caseset@1`: case set

- `schema`: `"gauge.caseset@1"`
- `caseset`: rev
- `workload`: id
- `governed_by`: governance
- `splits`: 1–2, unique by `split`. Each is exactly
  `{ "split": "tune" | "holdout", "digest": digest, "size": count }`, size ≥ 1.

The record names cases by digest only. Holdout content is never readable by
the producer of a candidate. The holdout digest differs from the tune digest:
a holdout identical to the tune split would be visible to whoever tunes.

## `gauge.revision@1`: governed revision

The recorded change that makes one revision of a criteria set or case set
usable. Results, comparisons and attributions bind only to recorded revisions,
so a criteria set or case set that no revision records is unknown.

- `schema`: `"gauge.revision@1"`
- `revision`: rev, the criteria set or case set this records
- `record`: `"criteria"` | `"caseset"`
- `digest`: digest of that set
- `supersedes`: rev | null
- `issued_by`: governance
- `justification`: code
- `evidence`: 0–16, unique by `(source, ref)`, same shape as result evidence

A set's digest is `sha256:` and the lowercase hex SHA-256 of its canonical
JSON: object keys sorted recursively, no whitespace (`recordDigest`).

Rules:

- **Binding.** The set named by `revision` is known as a `record` set and its
  digest equals `digest`. A recorded revision number is a positive integer
  without leading zeros. Revision `@1` supersedes nothing. Revision `@n`, for
  n > 1, supersedes `@n-1` of the same name, and that revision is itself
  recorded as the same kind of set. A revision is recorded only when its whole
  chain back to `@1` validates.
- **Governance.** `issued_by` equals the `governed_by` of the set it
  supersedes, or for `@1` the set's own `governed_by`: only the authority
  that governs a set can change it, and only the old governor can hand it to a
  new one. A revision that supersedes another cites at least one evidence
  entry, its justification for changing what counts as success.
- **Single use.** An approval is a single-use grant: an `issued_by` of kind
  `approval` issues exactly one revision. A policy is a standing authority and
  may issue many. Two revisions are the same revision when their canonical
  digests (`recordDigest`) are equal, so replaying the recorded revision, in
  any key order, still validates. When `context` holds two or more distinct
  revisions citing the same approval (same kind `approval` and same `ref`),
  every one of them fails with `approval_reused`, and so does a revision
  presented beside one it conflicts with. `context` is unordered, so there is
  no first claimant: the rule depends only on which revisions are present,
  never on input order, and a conflict is resolved outside Gauge by removing
  the revision that was not granted. A set whose chain holds a reused approval
  is not recorded. The same `ref` under kind `policy` is a different authority:
  it neither satisfies an approval governor nor spends that approval.
  Because the governor of a set issues its next revision, a set governed by an
  approval cannot be superseded once that approval has issued its `@1`; govern
  a set that must change by a policy.
- **Immutability.** Editing a recorded set in place changes its digest, so the
  set is no longer recorded and nothing binds to it. A change is a new
  revision. A result keeps binding to the revision it cites, and a comparison
  across revisions is a `binding` failure.

A subject under evaluation cannot change its own criteria or held-out cases:
it is not the governor that must issue the change, and a policy subject cannot
be evaluated under a set it governs. Gauge checks that the issuer is the
governor; it cannot authenticate an issuer. Whoever supplies `context` vouches
that each revision in it was issued by the authority it names, and an
Experiment fixes the criteria and case set revisions before results are read.

## `gauge.result@1`: evaluation result

One subject evaluated on one split of a case set under one criteria set.

- `schema`: `"gauge.result@1"`
- `result`: id
- `subject`: `{ "kind": "implementation" | "routed_unit" | "policy" | "operating_strategy", "ref": id }`
- `criteria`: rev; `caseset`: rev; `split`: `"tune"` | `"holdout"`;
  `caseset_digest`: digest
- `mode`: `"replay"` | `"trial"` | `"live"`
- `evidence`: 1–256, unique by `(source, ref)`. Each is
  `{ "source": "weft_trace" | "check" | "held_out_report" | "observation", "ref": id }`.
- `measures`: exactly one entry per criteria measure. Each is
  `{ "measure": code, "value": number | null, "n": count, "interval": interval | null }`.
- `constraints`: exactly one entry per criteria constraint. Each is
  `{ "constraint": code, "status": "held" | "violated" | "unknown" }`.
- `verdict`: `"meets_bar"` | `"misses_bar"` | `"insufficient_evidence"`

Rules:

- **Binding.** The criteria set and case set must be known, share a
  workload, contain the split, and `caseset_digest` must equal that split's
  digest.
- **Governance.** A `policy` subject may not be the policy that governs the
  criteria set or the case set it is evaluated on.
- **Holdout.** Every evidence entry of a holdout result has source
  `held_out_report`, so no `check`, `weft_trace` or `observation` reference can
  point at an individual held-out case.
- **Replay.** Replay compares decisions on recorded inputs. It cannot
  establish the outcomes of actions that were never taken. In `replay` mode, a
  measure sourced from Weft kinds `outcome`, `capability.invoked` or
  `action.transition` must have `n = 0`.
- **Measures.** `n = 0` exactly when `value` is null, and then `interval` is
  null. A non-null value lies within its interval when one is given. A `rate`
  value and interval lie in [0, 1].
- **Constraints** are recomputed. A constraint is `unknown` when its measure
  has `n` below `min_samples`. Otherwise it is judged on the interval when
  present, and on the value when not. For `ge`, it is `held` when the low end is
  at least the bound and `violated` when the high end is below it. For `le`, it
  is `held` when the high end is at most the bound and `violated` when the low
  end is above it. Anything else is `unknown`.
- **Verdict** is recomputed: `misses_bar` if any constraint is violated, else
  `insufficient_evidence` if any is unknown, else `meets_bar`. A result that
  misses its bar is never an improvement, however cheap.

## `gauge.comparison@1`: comparison

A baseline result and a candidate result for the same question.

- `schema`: `"gauge.comparison@1"`
- `comparison`: id
- `experiment`: id | null. The Experiment this serves, if any.
- `baseline`: id; `candidate`: id. These are result ids.
- `deltas`: exactly one per criteria measure. Each is
  `{ "measure": code, "delta": number | null, "interval": interval | null }`.
- `verdict`: `"candidate_better"` | `"no_difference"` | `"candidate_worse"` |
  `"bar_missed"` | `"insufficient_evidence"`

Rules:

- **Binding.** Both results are known and distinct. They share criteria,
  case set, split, mode and subject kind, and their subjects differ. Gains on
  one workload or split say nothing about another.
- **Deltas.** `delta` is candidate value minus baseline value, null when
  either is null. A non-null delta must carry an interval that contains it;
  uncertainty is part of the result. A null delta carries a null interval. Recomputation tolerates an absolute error
  of 1e-9.
- **Verdict** is recomputed in this order:
  1. `insufficient_evidence` if either result is, or no delta is non-null, or
     any non-null delta lacks evidence: `min_samples` applies to every
     compared measure, constrained or not, so either result having `n` below
     it is insufficient; and a zero-width interval (`lo = hi`, as from one
     sample or all-equal samples) on the delta or on either result's measure,
     or a missing measure interval, says nothing about spread and is
     insufficient. A measure with a null delta is not compared.
  2. `bar_missed` if the candidate result is `misses_bar`.
  3. `candidate_worse` if any measure's interval lies strictly on the worse
     side of zero and at least `min_effect` from it: for higher-is-better,
     `hi < 0` and `hi ≤ −min_effect`; for lower-is-better, `lo > 0` and
     `lo ≥ min_effect`.
  4. `candidate_better` if any measure's interval lies strictly on the better
     side of zero and at least `min_effect` from it: for higher-is-better,
     `lo > 0` and `lo ≥ min_effect`; for lower-is-better, `hi < 0` and
     `hi ≤ −min_effect`.
  5. Otherwise `no_difference`.

  The strict comparison with zero matters when `min_effect` is 0: an
  unchanged measure, `delta: 0` with an interval that touches zero such as
  `[-0.04, 0]` or `[0, 4]`, is `no_difference` in either direction, never
  worse or better. With interval `[0, 0]` it is `insufficient_evidence`.

A `candidate_better` comparison is evidence for a promotion decision. It is not
one.

## `gauge.attribution@1`: failure attribution

Why one case in a result failed. It is a claim, not a fact.

- `schema`: `"gauge.attribution@1"`
- `attribution`: id; `result`: id; `case`: id
- `category`: `"capability_gap"` | `"implementation"` | `"routing"` |
  `"orchestration"` | `"unattributed"`
- `basis`: `"deterministic"` | `"judgment"` | `"none"`
- `signal`: code | null
- `confidence`: ratio | null
- `evidence`: 0–64, unique by `(source, ref)`, same shape as result evidence

Rules:

- The result must be known and on the tune split. Attributing a holdout case
  would reveal which held-out case failed.
- `deterministic` requires a signal from its category's closed list, a null
  confidence and at least one evidence entry:
  - `capability_gap`: `no_contract_matched`
  - `implementation`: `contract_tests_failed`, `effect_violation`,
    `implementation_failed`
  - `routing`: `better_route_excluded`, `wrong_contract_selected`
  - `orchestration`: `dependency_failed`, `schedule_conflict`,
    `budget_exhausted`, `superseded`
- `judgment` requires a null signal, a confidence and at least one evidence
  entry. Use it only where deterministic signals are inconclusive (G7, #195).
- `unattributed` is a valid result. It requires basis `none`, a null signal
  and a null confidence. Any other category forbids basis `none`.

## `gauge.cost@1`: evaluation cost

What producing one result cost, so an Experiment counts its whole cost and not
only its successful trials.

- `schema`: `"gauge.cost@1"`
- `cost`: id; `result`: id
- `trials`: count, every trial run for the result, failed ones included
- `failed_trials`: count
- `trial`: line, the cost of every trial, failed ones included
- `evaluation`: line, scoring and judging the trials
- `review`: line, human review
- `total`: line

A line is exactly `{ "basis": "measured" | "estimated" | "unknown", "micros": metric | null }`.
`measured` is metered usage, `estimated` is a computed figure such as tokens
times a price, and `unknown` is a cost that was incurred but not established.

Rules:

- **Binding.** The result is known.
- **Cost.** `failed_trials` is at most `trials`. `micros` is null exactly
  when `basis` is `unknown`: an unknown line is never zero, and a measured
  zero is a valid, distinct line. The total's basis is `unknown` if any line
  is, else `estimated` if any line is, else `measured`; a known total equals
  `trial + evaluation + review` within a relative error of 1e-9. Partial usage
  is an unknown total, never the sum of the known lines. Every line is
  required: a zero or an unknown is stated, never left out.
- **Trial count.** `trials - failed_trials` equals the bound result's
  sample count, the largest `n` among its measures: every trial that did not
  fail gave the result one sample. A mismatch is `trial_count`.

## Weighing cost

`costed(comparison, costs, context)` says whether a comparison may be weighed
against what its results cost, the input to a promotion decision or any other
benefit-against-cost decision. It returns `{ "ok": true }` or the first
rejection: a comparison or cost that fails `validate` gives that reason (one
of another schema, or `costs` not a list, is `envelope`); a cost for neither
result, or two costs for one result, is `binding`; and a result with no cost,
or one whose total is `unknown`, is `cost_unknown`. An `estimated` total may
be weighed, as an estimate. Whatever decides promotion must have `costed`
pass first; Gauge itself weighs and promotes nothing.

## Statistics

`method` fixes how a producer computes intervals, so anyone holding the
samples recomputes the same result. α is `1 - level` and z is the standard
normal quantile at `1 - α/2` (Acklam's rational approximation).

- `wilson@1`: for k successes in n samples and p = k/n, the Wilson score
  interval `(p + z²/2n ± z·sqrt(p(1-p)/n + z²/4n²)) / (1 + z²/n)`.
- `bootstrap@1`: 2000 resamples of n draws with replacement. A draw takes
  sample `floor(u·n)`, where u comes from mulberry32 seeded with `seed` modulo
  2³² and restarted for each measure. The interval is the sorted resample
  statistics at indices `floor(2000·α/2)` and `ceil(2000·(1 - α/2)) - 1`.
- Aggregates: `rate` and `mean` are the arithmetic mean (a rate sample is 0 or
  1), `sum` is the sum, and `p95` is the nearest-rank percentile
  `sorted[ceil(0.95·n) - 1]`.
- A computed interval is widened to contain its value and, for a rate, clamped
  to [0, 1], so rounding cannot put a value outside its own interval.

## Producers

`evaluate`, `compare` and `track` build what the rules above describe. They
return `{ "ok": true, ... }` or `{ "ok": false, "reason": reason }`, and a
record they return has passed `validate`.

- `evaluate(run, context)` builds a `gauge.result@1` from one sample list per
  criteria measure. The run names the workload its samples came from, which
  must be the criteria set's and case set's (`binding`): samples from one
  workload never become a result for another. Sample lists match the criteria
  measures one-to-one (`binding`). An empty list is `n = 0` with a null value;
  a list shorter than `min_samples` leaves its constraints `unknown`, and a
  comparison or track over it is `insufficient_evidence` whether or not the
  measure is constrained. Neither is an error, and neither is a pass or a tie. In `replay` mode a non-empty list for a measure
  sourced from an outcome kind is `mode`, and a rate sample other than 0 or 1
  is `measure`. Malformed samples are `envelope`. Otherwise the result's own
  rejection, if any, is returned.
- `compare(request, context)` builds a `gauge.comparison@1` from two recorded
  results. A delta's interval combines theirs by the method of variance
  estimates recovery, which is Newcombe's hybrid score interval when both are
  Wilson intervals: for candidate c in [l₁, u₁] and baseline b in [l₂, u₂],
  d = c - b and the interval is
  `[d - sqrt((c - l₁)² + (u₂ - b)²), d + sqrt((u₁ - c)² + (b - l₂)²)]`. It
  treats the results as independent, which is conservative when both ran on
  the same cases. A value without an interval has unknown uncertainty, so
  `compare` refuses it with `measure` rather than invent one.
- `track(results, context)` takes results in the order recorded (Gauge reads
  no clock) and compares each with the one before it by the same deltas and
  verdict rules, so a regression is visible step by step. Every result
  answers the same question: criteria set, case set, split, mode and subject
  kind (`binding`). The subject may repeat, to follow one implementation,
  routed unit or policy across re-evaluations, or change, to follow its
  versions. A step is a regression when its verdict is `candidate_worse`, or
  `bar_missed` after a result that met its bar. A track is evidence, not a
  record, and promotes nothing.

A result states its mode, so a replay result is never read as a trial: replay
compares decisions on recorded inputs and leaves outcome measures unmeasured.

## Rejection reasons

`validate(value, context)` returns `{ "ok": true }` or
`{ "ok": false, "reason": reason }`. `context` supplies the known criteria
sets, case sets, results and revisions, keyed by `criteria`, `caseset`,
`result` and `revision`. A context entry is known only if it validates itself
and its key equals its own name, and a criteria set or case set only if a
revision in `context` also records it; anything else in `context` is unknown,
so a record bound to it fails with `binding`. The
first applicable reason, in this order:

1. `envelope`: not an object, unknown `schema`, missing, extra or mistyped
   keys, an out-of-range scalar (`level`, `min_samples`, `size`), an exceeded
   list bound, or a duplicate split or evidence entry
2. `ref`: an id, rev or digest that fails its pattern
3. `binding`: an unknown, unrecorded or mismatched criteria set, case set,
   split, digest or result; measure or constraint entries that do not match
   the criteria set one-to-one; a comparison across different questions or of
   a result with itself; a revision whose set is unknown or has another
   digest, or whose chain is broken
4. `governance`: a policy subject evaluated under criteria or cases it
   governs; a revision issued by anyone but the governor of the set it
   supersedes, or a superseding revision without evidence
5. `approval_reused`: a revision issued by an approval that another, distinct
   revision in `context` also cites, or one whose chain holds such a revision
6. `holdout`: a holdout result with any evidence other than held-out reports,
   an attribution on a holdout result, or a case set whose holdout digest
   equals its tune digest
7. `mode`: the replay rule
8. `measure`: a bad measure definition (unknown Weft kind or field, a
   duplicate measure, `wilson@1` on a non-rate aggregate), or a measure entry
   or delta that breaks its rules
9. `constraint`: a bad constraint definition (a duplicate, or an unknown
   measure), or a status that does not match recomputation
10. `verdict`: a verdict that does not match recomputation
11. `attribution`: a basis, signal or confidence that breaks the attribution
    rules
12. `cost`: more failed trials than trials, an unknown line with an amount or
    a known line without one, or a total whose basis or amount does not
    match its lines
13. `trial_count`: trials that did not fail differ from the bound result's
    sample count
14. `cost_unknown` (`costed` only): a compared result with no cost or an
    unknown total
