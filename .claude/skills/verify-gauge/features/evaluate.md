# Evaluate

`evaluate(run, context)` builds a `gauge.result@1` from one sample list per criteria measure: values, intervals (bootstrap or Wilson, with the criteria set's fixed seed), constraint statuses and a recomputed verdict, then runs the record through `validate`. Empty and short sample lists are honest `insufficient_evidence`, not errors; samples from another workload, a replay claiming outcomes, or a holdout run citing anything but held-out reports are refused.

## Sub-features

- `evaluate-trial` builds a `meets_bar` result for 108/120 accuracy, mean cost 150, 84/120 completion under `decision-sites.criteria@1`, bound to the recorded tune split digest.
- `evaluate-deterministic` gives a byte-identical result for the same samples.
- `evaluate-roundtrip` writes the record to disk, re-reads it, re-validates it and keeps its `recordDigest`.
- `evaluate-insufficient` turns empty lists into `n = 0`, null values, `unknown` constraints, and 12 samples (< `min_samples` 30) into `insufficient_evidence` even at accuracy 1.0.
- `evaluate-refusals` refuses another workload, a missing measure and an unrecorded criteria set (`binding`), a NaN sample (`envelope`), a rate of 0.5 (`measure`), a replay with outcome samples (`mode`), and a holdout run citing a Weft trace (`holdout`).
- `evaluate-replay-holdout` accepts a replay with empty outcome measures and a holdout run citing held-out reports, bound to the holdout digest.
- `evaluate-pure` leaves the context object and `records.json` unchanged.

## How to get to it (user POV)

- `import { evaluate } from '@weave/gauge'`, then `evaluate({ result, subject, workload, criteria, caseset, split, mode, evidence, samples }, context)`.

## Driving it with gauge-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.
- The fixture context has `decision-sites.criteria@1` (accuracy ≥ 0.8, cost ≤ 200, `min_samples` 30) and `decision-sites.cases@1` with tune and holdout splits.

- **Trial result.** Run `$H drive evaluate`. Checks `PASS accuracy value = 108/120`, `PASS cost value = mean 150`, `PASS completion value = 84/120`, `PASS every value lies in its interval`, `PASS constraints recomputed: …`, `PASS verdict meets_bar`, `PASS caseset_digest bound to the recorded tune split`.
- **Determinism.** Check `PASS same samples give the same result (fixed seed)`.
- **Second view.** Checks `PASS record re-read from disk validates`, `PASS record digest survives the disk round-trip`.
- **Insufficient evidence.** Checks `PASS empty samples: …`, `PASS below min_samples (12 < 30): …`.
- **Refusals.** One `PASS … : <reason>` line per refusal listed in Sub-features.
- **Replay and holdout.** Checks `PASS a replay with empty outcome measures is accepted and says replay`, `PASS a holdout run citing held-out reports binds the holdout digest`.
- **Purity.** Checks `PASS evaluate left the context unchanged (pure)`, `PASS records.json unchanged`.
- **Proof.** `evaluate/result.record.json`, `evaluate/empty.record.json`, `evaluate/result.json` with `ok: true` and `recordDigest`.

## Gotchas

- Intervals are seeded bootstrap draws; only exact equality on rerun is asserted, not specific interval bounds. A changed bound with the same seed is a `stats.ts` change; re-derive it, do not loosen the check.
- `completion` is sourced from the `outcome` Weft kind, which is why a replay must leave it empty; `accuracy` (`judgment`) and `cost` (`inference.attempt`) are not outcome kinds.
- The subject refs are verification-only (`boolean.task@verify-a`); nothing is recorded anywhere, so they never collide with real results.
