# Record contract

`validateRecord(value, inline?)` is the fail-closed gate for `weft.record@1`: it returns `{ ok: true }` for a record that meets `WEFT-CONTRACT.md`, or `{ ok: false, reason }` with the first applicable rejection reason, and never throws. `packages/weft/fixtures/records.json` holds the contract's worked cases (21 valid across all 14 kinds, 41 invalid across the eight reasons); `test/contract.test.ts` runs the same cases.

## Sub-features

- `contract-accept` accepts every `valid` fixture with exactly `{ ok: true }`.
- `contract-reject` rejects every `invalid` fixture with exactly its documented `reason` (`envelope`, `id`, `sequence`, `kind`, `link`, `evidence`, `content`, `field`).
- `contract-nonobject` rejects `null`, a string and an array as `envelope` without throwing.
- `contract-package-test` the package's own script, `npm run test:weft-contract`, passes.

## How to get to it (user POV)

- `import { validateRecord } from '@weave/weft'` and call it on a candidate record.
- Indirectly through `serializeRecord`, `createWeftSink`, `exportOtlp` and `openTraceStore`, which all validate before writing (see the other features).
- `npm run test:weft-contract` from the repo root.

## Driving it with weft-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.
- Doctor's `fixtures readable` detail reports the counts you expect (`valid=21 invalid=41` at the time of writing; if the fixture grew, the drive follows it).

- **Validate every case.** Run `$H drive record-contract`. Each fixture is passed to `validateRecord`; `record-contract/verdicts.json` lists `{ name, expected, actual }` for all 62 cases.
- **Accepted set.** Check line `PASS every valid fixture accepted`: actual count equals the `valid` count.
- **Rejected set.** Check line `PASS every invalid fixture rejected with its documented reason`, and `PASS mismatched cases` with actual `[]`. A mismatch names the fixture case in `result.json`.
- **Non-object input.** Check line `PASS non-object input rejected as envelope, never thrown`.
- **Package test.** Run `$H test`. `package-test.log` holds the transcript, `package-test.json` the exit code and the `# tests / # pass / # fail` tail; require exit `0` and `# fail 0`.
- **Proof.** `record-contract/result.json` with `ok: true`, the `records.json` digest, and the distinct `reasons` list; `package-test.json` with `exit: 0`.

## Gotchas

- `validateRecord` returns the **first** applicable reason in the contract's order. A fixture that breaks two rules is expected to report the earlier one; do not "fix" an expectation to the later reason.
- Inline content text is only valid under an `InlinePolicy`. The fixtures are validated with no policy, exactly as `contract.test.ts` does; a case that needs a policy belongs in `disclosure.test.ts`, not here.
- `$H test` runs `npm run build` (whole repo, `tsc -b`) before the tests, so it is slower than the drive and writes every package's `dist`.
- `otel-isolation.test.ts` pins `--test-reporter=tap` for its nested run, so `$H test` expects 155/155 on Node 22 and Node 24 alike. A reporter-format failure there is a real failure.
- A green `$H test` does not replace this drive or the others: it proves the compiled tests, not a consumer import through `@weave/weft`.
