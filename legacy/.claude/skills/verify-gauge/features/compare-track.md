# Compare and track

`compare(request, context)` builds a `gauge.comparison@1` of two recorded results for the same question, with a delta and an interval per measure and a recomputed verdict (`candidate_better`, `candidate_worse`, `bar_missed`, `insufficient_evidence`, …). `track(results, context)` compares each result with the one before it in recorded order and marks a step a `regression` when its verdict is `candidate_worse`, or `bar_missed` after a result that met its bar. Both produce evidence and promote nothing.

## Sub-features

- `compare-verdicts` reproduces the fixture verdicts from `res-base`: `res-cand` → `candidate_better`, `res-cheap` → `bar_missed`, `res-worse` → `candidate_worse`, `res-small` → `insufficient_evidence`.
- `compare-deltas` gives each delta as candidate − baseline, inside its interval; deterministic on rerun; the re-read record validates and a tampered verdict is rejected (`verdict`).
- `compare-refusals` refuses another split (`res-hold`), a result with itself and an unknown result (`binding`).
- `track-regression` shows `res-base → res-cand → res-worse` as `[candidate_better, false]`, `[candidate_worse, true]`, and `res-cand → res-cheap → res-small` as `[bar_missed, true]`, `[insufficient_evidence, false]`.
- `track-refusals` refuses mixed modes (`res-replay`) and repeated ids (`binding`); one result has no steps.

## How to get to it (user POV)

- `import { compare, track } from '@weave/gauge'`; `compare({ comparison, experiment, baseline, candidate }, context)` with result ids known to `context.results`; `track([id, …], context)`.
- Loom's Experiment (`ExperimentRecord`, `experiment.compared`) cites a Gauge comparison; promotion stays with Loom.

## Driving it with gauge-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.
- The fixture context holds results `res-base`, `res-cand`, `res-cheap`, `res-worse`, `res-small`, `res-hold`, `res-replay`.

- **Fixture verdicts.** Run `$H drive compare-track`. Checks `PASS compare res-base -> res-cand: candidate_better` and the three siblings.
- **Second view.** Checks `PASS comparison re-read from disk validates`, `PASS every delta = candidate - baseline, inside its interval`, `PASS compare is deterministic`, `PASS a tampered comparison verdict is rejected`.
- **Comparison refusals.** Checks `PASS compare across splits (holdout): binding`, `… with itself: binding`, `… an unknown result: binding`.
- **Track.** Checks `PASS track res-base, res-cand, res-worse shows the regression at step 2`, `PASS track: bar_missed after meets_bar is a regression; insufficient_evidence is not a pass`.
- **Track refusals.** Checks `PASS track across modes (trial, replay): binding`, `PASS track with a repeated id: binding`, `PASS track of one result has no steps`.
- **Purity.** Checks `… left the context unchanged (pure)`, `PASS records.json unchanged`.
- **Proof.** `compare-track/comparison.record.json`, `track.base-cand-worse.json`, `track.cand-cheap-small.json`, `result.json` with `ok: true`.

## Gotchas

- `regression: false` with `insufficient_evidence` does not establish that the subject has not regressed; never report it as "no regression".
- `compare` refuses two results with the same subject ref (`binding`); following one subject across re-evaluations is `track`'s job.
- The expected verdicts are the ones `test/experiment.test.ts` pins; if the fixtures change, update both from the contract, not from the drive's output.
