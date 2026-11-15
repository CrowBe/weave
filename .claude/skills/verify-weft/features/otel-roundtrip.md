# OTLP/JSON round-trip

Weft projects a batch of Weft records to OTLP/HTTP JSON with `exportOtlp(records, { redact, baseTimeUnixNano?, inline? })` (all-or-nothing, deterministic ids, no ambient clock) and maps OTLP/JSON back to validated Weft records with `mapOtlp(value, { redact })`. The fixtures `otel-all-kinds.json` (one span per kind, 14 kinds, computed independently of `exportOtlp`) and `otel-golden.json` (two spans with a parent and cross-thread link) are the goldens.

## Sub-features

- `otel-map` `mapOtlp` maps each golden to records that all pass `validateRecord` (14 distinct kinds for all-kinds).
- `otel-export` `exportOtlp` of those mapped records deep-equals the golden it came from.
- `otel-deterministic` exporting the same records in reverse order gives the identical result.
- `otel-reject-input` a span with a non-hex `traceId` maps to `{ ok: false, reason: 'input' }`.
- `otel-reject-config` `exportOtlp` without a redactor returns `{ ok: false, reason: 'config' }`.

## How to get to it (user POV)

- `import { exportOtlp, createOtlpExporter } from '@weave/weft/otel'` to send a Weft trace to an OTLP collector (the exporter's transport is injected by the caller).
- `import { mapOtlp } from '@weave/weft/intake'` to read OTLP/JSON produced by Weft or another tool.

## Driving it with weft-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.

- **Map each golden.** Run `$H drive otel-roundtrip`. For each of `otel-all-kinds.json` and `otel-golden.json`: checks `PASS <fixture>: mapOtlp ok` and `PASS <fixture>: every mapped record validates`; for all-kinds also `PASS all-kinds: 14 distinct kinds`.
- **Export back.** Checks `PASS <fixture>: exportOtlp ok` and `PASS <fixture>: export of the mapped records deep-equals the fixture`.
- **Order independence.** Check `PASS <fixture>: export is order-independent`.
- **Fail closed.** Checks `PASS malformed traceId rejected as input` and `PASS export without a redactor is a config failure`.
- **Proof.** `otel-roundtrip/<fixture>.records.jsonl` (the mapped Weft records), `otel-roundtrip/<fixture>.export.json` (the re-exported OTLP), `otel-roundtrip/result.json` with `ok: true`.

## Gotchas

- Compare OTLP output structurally (deep-equal of parsed JSON). `exportOtlp`'s key order differs from the hand-written all-kinds golden, so a byte or `JSON.stringify` comparison fails even when the projection is correct.
- This drive does not call `createOtlpExporter`'s transport or any collector. Proving delivery to a real collector needs a caller-supplied transport and is not covered offline.
- `test/otel-all-kinds.test.ts` builds its export input from `records.json`, not from `mapOtlp`; this drive proves the inverse direction (golden → records → golden). Both should hold.
