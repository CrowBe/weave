# Record contract

`validate(value, context)` is the gate every Gauge record passes: it returns `{ ok: true }` or `{ ok: false, reason }` with the first applicable reason from the ordered list in `GAUGE-CONTRACT.md` ("Rejection reasons"), and it recomputes every verdict, so a record cannot assert that its subject won. `fixtures/records.json` holds the context (criteria sets, case sets, results, revisions) and the valid and invalid cases that `test/contract.test.ts` runs.

## Sub-features

- `contract-valid` accepts every `valid` fixture (all eight schemas: criteria, caseset, revision, result, comparison, attribution, cost, preference).
- `contract-invalid` rejects every `invalid` fixture with exactly its documented `reason`.
- `contract-context` treats a context entry as known only if it validates itself; `decision-sites.edited@1` is the deliberate exception (its revision digest no longer matches, so it fails `binding`).
- `contract-envelope` rejects a non-object and an unknown schema with `envelope`.
- `contract-derived-verdict` rejects a fixture result whose verdict was flipped to `misses_bar` with `verdict`.

## How to get to it (user POV)

- `import { validate } from '@weave/gauge'` and call it on any Gauge record with a `Context` of known criteria, case sets, results and revisions.
- `npm run test:gauge-contract` runs the same fixture sweep (plus the other Gauge tests) in the package's own suite.

## Driving it with gauge-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.

- **Sweep the fixtures.** Run `$H drive record-contract`. Checks `PASS all 30 valid fixtures accepted` and `PASS all 90 invalid fixtures rejected with their documented reason` (the counts are read from the file, so they change with it).
- **Context self-validation.** Check `PASS context entries that do not validate are only the deliberate unrecorded/edited criteria`; `record-contract/context-verdicts.json` lists the exceptions.
- **Envelope.** Checks `PASS non-object input is envelope`, `PASS unknown schema is envelope`.
- **Derived verdict.** Check `PASS a result asserting a verdict that does not recompute is rejected`.
- **No side effect.** Check `PASS records.json unchanged by validation` (sha256 before and after).
- **Package suite.** Run `$H test`; `test-gauge-contract.log` shows the `accepts …` / `rejects … with <reason>` tests and `package-test.json` the exit code.
- **Proof.** `record-contract/verdicts.json` (every case, expected vs actual) and `record-contract/result.json` with `ok: true`.

## Gotchas

- Reasons are ordered; a fixture that breaks two rules reports the earlier one. A changed reason for an invalid fixture is a contract change, not a flaky test.
- `decision-sites.unrecorded@1` validates as a record but has no revision, so it is unknown as context; only `edited@1` appears in `context-verdicts.json`.
- `$H test` runs the whole-repo `npm run build` first; a build failure anywhere fails it, which is a finding for that package, not for Gauge.
- The sweep alone does not exercise the producers; drive `evaluate`, `compare-track` and `info-only` for changes to `produce.ts` or `stats.ts`.
