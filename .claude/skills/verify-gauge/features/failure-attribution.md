# Offline failure attribution

The WV-195 slice 1b leaf (`benchmarks/failure-attribution/`, `CONTRACT.md`) assesses supplied attribution answers offline against a tune-only corpus of 28 synthetic cases: frozen facts, raw receipts and implementer-authored labels, every file pinned by stored-byte digest in a manifest whose own digest is a constant in `reader.ts`. It has no classifier, provider or runner; positive controls prove agreement with the implementer-authored oracle, not classifier quality or independent review. Holdout freeze and sealed evaluation are closed.

## Sub-features

- `fa-pins` re-hashes every manifest entry and the manifest itself (against the `reader.ts` anchor) independently; roles are `tune` only.
- `fa-corpus` loads 28 cases, labels and facts, all split `tune`, review status `implementer-authored-no-independent-review`.
- `fa-oracle` passes 28/28 offline positive controls and every judgment control; an always-unattributed answer passes 11 and fails 17.
- `fa-assess-failures` scores a wrong citation (Gauge shape `ok`, oracle `citation`), a wrong category (`category`) and a missing answer (`missing`) as failures.
- `fa-projection` projects input to exactly `{result, case, split, bundle, revisions, judgment_request}` with no label metadata.
- `fa-sealed-closed` shows `readSealedInputs` refusing with `missing freeze` on the tune-only manifest.
- `fa-no-write` leaves every fixture byte-identical.

## How to get to it (user POV)

- `npm run test:failure-attribution` (build, then `node --experimental-strip-types --disallow-code-generation-from-strings --test "benchmarks/failure-attribution/*.test.ts"`).
- Import `loadTuneCorpus`, `assess`, `expectedOfflineControl`, `projectInput`, `summarize` from `benchmarks/failure-attribution/label-harness.ts` under those flags.

## Driving it with gauge-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0 (including `failure-attribution manifest is tune-only`).

- **Byte pins.** Run `$H drive failure-attribution` (it re-executes itself under the harness flags). Checks `PASS manifest stored-byte digest equals the reader.ts anchor`, `PASS every manifest entry pin equals sha256 of its stored bytes`, `PASS manifest roles are tune only …`.
- **Corpus.** Checks `PASS tune corpus loads 28 cases, labels and facts`, `PASS labels declare no independent review`, `PASS every case is split tune`.
- **Oracle controls.** Checks `PASS offline positive controls: 28/28 pass`, `PASS always-unattributed answer fails every attributed case (11 pass, 17 fail)`, `PASS judgment controls pass for every label with a judgment (n)`.
- **Assessment failures.** Checks `PASS wrong citation passes Gauge shape but fails the oracle`, `PASS wrong category is refused`, `PASS a missing answer is a failure, not a skip`.
- **Projection.** Checks `PASS projected input keys are the closed selection`, `PASS no label rationale, author or citation metadata leaks into projected input`.
- **Closed holdout.** Check `PASS the sealed holdout path is closed: readSealedInputs refuses with missing freeze`.
- **No write.** Check `PASS fixtures byte-identical after the drive`.
- **Package suite.** `$H test` runs `npm run test:failure-attribution` into `test-failure-attribution.log`.
- **Proof.** `failure-attribution/offline-controls.json`, `judgment-controls.json`, `always-unattributed.json`, `projected-input.c05.json`, `result.json` (with `execArgv` showing the flags and `sealedRefusal`).

## Gotchas

- Never run, simulate or claim a holdout or sealed result. The only sealed-path proof is the refusal; independent held-out precision/recall remain outstanding (D-ENG-041).
- The corpus labels are implementer-authored; a 28/28 pass is not evidence of classifier or evaluation quality (`AGENTS.md`, Benchmark evidence).
- Do not import `createTestReader` (the leaf's import lint, `imports.test.ts`, restricts it to `reader.test.ts`); the drive uses the production `reader.ts` exports only.
- Any edit to a fixture changes its byte pin and the manifest anchor; the reader then refuses everything. That is the intended fail-closed behaviour, not a drive bug.
- The drive needs Node >= 22.18 so `.ts` imports strip types without a loader.
