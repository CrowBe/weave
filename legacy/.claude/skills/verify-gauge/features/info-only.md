# Info-only results

An info-only criteria set (`gauge.criteria@2`) records measures to reproduce a report and never weighs them. `evaluateInfo(run, context)` builds a `gauge.result@2` with values and counts but no interval, whose verdict is always `info_only`; `evaluate`, `compare` and `track` refuse info-only sets and results with `info_only`, so a set with no bar never reads as having met one.

## Sub-features

- `info-governed` validates an info-only set and the `gauge.revision@1` that records it (digest via `recordDigest`).
- `info-values` reproduces sum 4, coverage 3/4, accuracy 2/3 with keys `measure, value, n` only; the record re-read from disk validates.
- `info-never-a-bar` rejects the same result claiming `meets_bar` (`verdict`).
- `info-empty` gives the declared `empty` value for an empty population (0 for sum and coverage, null for accuracy).
- `info-refusals` refuses a rate sample of 0.5 (`measure`), and `evaluate`, `compare`, `track` on info-only input (`info_only`).

## How to get to it (user POV)

- Record a `gauge.criteria@2` set and its revision in the context, then `import { evaluateInfo } from '@weave/gauge'` and call `evaluateInfo(run, context)`.

## Driving it with gauge-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.
- The drive adds `decision-sites.verify-report@1` (three check-sourced measures) and its initial revision to an in-memory copy of the fixture context; `info-only/criteria.json` records both.

- **Governed set.** Run `$H drive info-only`. Checks `PASS the info-only criteria set validates`, `PASS its governed revision validates`.
- **Values.** Checks `PASS evaluateInfo accepts the run`, `PASS schema gauge.result@2, verdict info_only`, `PASS values hand-computed: …`, `PASS info result re-read from disk validates`.
- **Never a bar.** Check `PASS an info result claiming meets_bar is rejected`.
- **Empty population.** Check `PASS empty population takes the declared empty value`.
- **Refusals.** Checks `PASS a rate sample of 0.5: measure`, `PASS evaluate (the gating producer) refuses an info-only set: info_only`, `PASS compare refuses info-only results: info_only`, `PASS track refuses info-only results: info_only`.
- **Proof.** `info-only/info-result.record.json` and `info-only/result.json` with `ok: true`.

## Gotchas

- The fixture's `decision-sites.criteria@2` is a `gauge.criteria@1` record despite its name; it is not an info-only set. The drive builds its own.
- A criteria set without a recorded revision is unknown context, so `evaluateInfo` would answer `binding`; keep the revision in the context.
- `ece10`, `auc` and percentile aggregates are not driven here; `test/info.test.ts` covers them. Extend this drive if a change touches `infoAggregate`.
