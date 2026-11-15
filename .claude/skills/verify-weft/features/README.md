# Weft verification map

This directory is the maintained source for verifying the user-facing behaviour of Weave Weft (`@weave/weft`, `packages/weft`). Weft is a library: its users are composition roots and packages that emit, validate, store or exchange traces. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Repo root is the cwd and `npm ci` has run, so `node_modules/@weave/weft` links to `packages/weft`.
- `H=.claude/skills/verify-weft/bin/weft-verify.mjs`.
- `$H launch` printed `RUN=<id>` and `READY`, and `WEFT_VERIFY_RUN` is exported with that id.
- `$H doctor` exits 0: HEAD equals the launch SHA, `dist` is fresh, `@weave/weft` resolves into this checkout, every export is present, the fixtures parse, `node:sqlite` loads.
- Fixtures are used as committed in `packages/weft/fixtures/`. Never edit them to make a drive pass.
- Never drive a run whose state you did not launch.

## Driving conventions

- Every drive imports the built package by its public specifiers (`@weave/weft`, `@weave/weft/sqlite`, `@weave/weft/intake`, `@weave/weft/otel`), not `src/` files.
- Every drive creates its outputs in the empty scratch dir `$TMPDIR/weft-verify/<RUN>/` and copies them into evidence.
- Redactors are identity (`(r) => r`) unless the recipe says otherwise: the fixtures already hold digests, not content, and the drives prove the rejection paths separately.
- Run `$H cleanup` after every attempt, passing or failing.

## Proof and skip reporting

- Each check records `expected` and `actual` in `<feature>/result.json`; the summary line and exit code come from those.
- Every feature re-reads its side effect from a second view (file on disk, SQLite file opened read-only, HTTP status, refused TCP connect).
- Record the feature id, run id and SHA with every artifact (`result.json` carries them).
- A failing check is reported with its `result.json` entry. Do not report a skipped feature as verified through a different one; `npm run test:weft-contract` passing does not stand in for a drive.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behaviour, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with weft-verify`, `Gotchas`.

## Features

- [Record contract](./record-contract.md): `validateRecord` against every valid and invalid case in `fixtures/records.json`, plus the package test script.
- [Redacting sink](./sink.md): `createWeftSink` writes one validated JSONL line per accepted record and counts, never writes, the rejected ones.
- [`weave.trace@1` import into SQLite](./trace-import.md): `importTraceLines` into `openTraceStore`, idempotent and atomic on conflict.
- [OTLP/JSON round-trip](./otel-roundtrip.md): `mapOtlp` and `exportOtlp` against the OTLP goldens.
- [OTLP/JSON loopback intake](./otlp-intake.md): `createOtlpListener` receiving real HTTP POSTs into a SQLite store.
