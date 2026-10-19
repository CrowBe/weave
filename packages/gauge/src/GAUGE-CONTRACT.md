# Gauge evaluation contract v1

Status: contract (G1, #189) and validator (G2, #190). `validate` in
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
  evaluation (G3, #191, makes this structural beyond the rules below).

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
the producer of a candidate.

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
  1. `insufficient_evidence` if either result is, or no delta is non-null.
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
  unchanged measure, `delta: 0` with interval `[0, 0]`, is `no_difference`
  in either direction, never worse or better.

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

## Rejection reasons

`validate(value, context)` returns `{ "ok": true }` or
`{ "ok": false, "reason": reason }`. `context` supplies the known criteria
sets, case sets and results, keyed by `criteria`, `caseset` and `result`. A
context entry is known only if it validates itself and its key equals its own
name; anything else in `context` is unknown, so a record bound to it fails with
`binding`. The
first applicable reason, in this order:

1. `envelope`: not an object, unknown `schema`, missing, extra or mistyped
   keys, an out-of-range scalar (`level`, `min_samples`, `size`), an exceeded
   list bound, or a duplicate split or evidence entry
2. `ref`: an id, rev or digest that fails its pattern
3. `binding`: an unknown or mismatched criteria set, case set, split, digest or
   result; measure or constraint entries that do not match the criteria set
   one-to-one; a comparison across different questions or of a result with
   itself
4. `governance`: a policy subject evaluated under criteria or cases it governs
5. `holdout`: a holdout result with any evidence other than held-out reports,
   or an attribution on a holdout result
6. `mode`: the replay rule
7. `measure`: a bad measure definition (unknown Weft kind or field, a
   duplicate measure, `wilson@1` on a non-rate aggregate), or a measure entry
   or delta that breaks its rules
8. `constraint`: a bad constraint definition (a duplicate, or an unknown
   measure), or a status that does not match recomputation
9. `verdict`: a verdict that does not match recomputation
10. `attribution`: a basis, signal or confidence that breaks the attribution
    rules
