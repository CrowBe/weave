# Gauge verification map

This directory is the maintained source for verifying the user-facing behaviour of Weave Gauge (`@weave/gauge`, `packages/gauge`) and its offline failure-attribution harness (`benchmarks/failure-attribution`). Gauge is a library: its users are composition roots, Loom's Experiment, benchmarks and evaluators that turn recorded evidence into results, comparisons and attributions. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Repo root is the cwd and `npm ci` has run, so `node_modules/@weave/gauge` links to `packages/gauge`.
- `H=.claude/skills/verify-gauge/bin/gauge-verify.mjs`.
- `$H launch` printed `RUN=<id>` and `READY`, and `GAUGE_VERIFY_RUN` is exported with that id.
- `$H doctor` exits 0: HEAD equals the launch SHA, `dist` is fresh for gauge and weft, `@weave/gauge` resolves into this checkout, every export is present, `records.json` parses, the attribution manifest is tune-only.
- Fixtures are used as committed in `packages/gauge/fixtures/records.json` and `benchmarks/failure-attribution/fixtures/`. Never edit them to make a drive pass.
- Never drive a run whose state you did not launch.

## Driving conventions

- Every drive imports the built package by its public specifier `@weave/gauge`, not `src/` files. The attribution drive imports the leaf's exported `label-harness.ts` and `reader.ts` entry points, never `createTestReader`.
- Records a drive builds beyond the fixtures (a governed info-only criteria set, a tampered verdict) are built in memory and saved to evidence; the fixture files are digested before and after to prove nothing was written.
- Every produced record is written to `$TMPDIR/gauge-verify/<RUN>/`, re-read from disk, re-validated, and copied into evidence.
- No model, provider, network or credential is used. Holdout and sealed evaluation are closed; drives only prove the closed path refuses.
- Run `$H cleanup` after every attempt, passing or failing.

## Proof and skip reporting

- Each check records `expected` and `actual` in `<feature>/result.json`; the summary line and exit code come from those.
- Expected values come from the contract, hand arithmetic, or verdicts the package's own tests pin, not from the producer under test.
- Record the feature id, run id and SHA with every artifact (`result.json` carries them).
- A failing check is reported with its `result.json` entry. Do not report a skipped feature as verified through a different one; `npm run test:gauge-contract` passing does not stand in for a drive.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behaviour, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with gauge-verify`, `Gotchas`.

## Features

- [Record contract](./record-contract.md): `validate` against every valid and invalid case in `records.json`, the context self-validation rule, and a tampered verdict.
- [Evaluate](./evaluate.md): `evaluate` builds a `gauge.result@1` from samples; empty, short, binding, replay and holdout rules.
- [Compare and track](./compare-track.md): `compare` and `track` over the fixture results; verdicts, deltas with intervals, regression steps, question-mismatch refusals.
- [Info-only results](./info-only.md): `evaluateInfo` under a governed `gauge.criteria@2`; never a bar, refused by every judging producer.
- [Offline failure attribution](./failure-attribution.md): the WV-195 slice 1b harness over the tune-only corpus; byte pins, oracle controls, input projection, the closed sealed path.

Not yet mapped (covered only by the `record-contract` fixture sweep and the package tests): `costed` and `gauge.cost@1`, `gauge.preference@1`, governed revision chains and `approval_reused`.
