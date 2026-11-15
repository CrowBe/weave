# Redacting sink

`createWeftSink({ redact, inline?, write })` is what a composition root hands to Loom's, the gateway's or the Fabric host's `WeftPort` as `emit`. Every emitted record is passed through the caller's redactor, validated, and serialized in contract key order; only accepted records reach `write`, one JSONL line each. Rejected records (invalid, carrying a credential marker, or whose redactor throws) are counted in `sink.rejected` and never written, and `emit` never throws.

## Sub-features

- `sink-accept` writes exactly one line per valid record, byte-identical to `serializeRecord(record, redact)`.
- `sink-reject` counts every invalid fixture as rejected and writes nothing for it.
- `sink-credential` rejects a record whose id carries a credential marker (`sk-…`) and the canary never reaches the file.
- `sink-redactor-throws` counts a throwing redactor as a rejection without throwing from `emit`.
- `sink-config` refuses to construct without a redactor (`TypeError`).

## How to get to it (user POV)

- `import { createWeftSink } from '@weave/weft'` in a composition root, with a `write` that appends to a file or stream.
- Pass `sink.emit` as the `emit` of a Loom, gateway or Fabric `WeftPort`.

## Driving it with weft-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.
- `$TMPDIR/weft-verify/<RUN>/sink.jsonl` does not exist yet (the drive truncates it, so re-driving in one run is safe).

- **Emit valid records.** Run `$H drive sink`. All `records.json` `valid` records go to a sink whose `write` appends to `sink.jsonl` in scratch. Check `PASS valid fixtures: none rejected`.
- **Emit invalid records.** The same sink receives every `invalid` record. Check `PASS invalid fixtures: every one counted as rejected` (count equals the `invalid` count).
- **Credential canary.** A valid record with `record_id: "sk-live0123456789abcdefCANARY"` is emitted. Check `PASS record carrying a credential marker rejected`.
- **Throwing redactor.** A second sink whose redactor throws receives one valid record. Check `PASS throwing redactor: counted, not written, not thrown`.
- **No redactor.** Check `PASS sink without a redactor refuses to construct`.
- **Second view: the file.** The drive re-reads `sink.jsonl`. Checks `PASS file holds exactly one line per accepted record`, `PASS every written line re-validates`, `PASS written bytes equal serializeRecord output`, `PASS credential canary never written`.
- **Proof.** `sink/sink.jsonl` (the written bytes) and `sink/result.json` with `ok: true`, `accepted`, `rejected` and the output digest.

## Gotchas

- `write` is called synchronously, but its returned promise is not awaited (`void Promise.resolve(write(line)).catch(() => {})`). An async `write` that fails is silently dropped by design; the drive uses `appendFileSync` so the file is complete when `emit` returns. Do not "prove" async delivery with this drive.
- `sink.rejected` is cumulative per sink instance; the drive's expectations depend on emit order (valid, then invalid, then canary).
- The identity redactor is safe only because the fixtures carry digests, not content. A real composition root must supply a redactor that strips secrets; Weft rejects but does not scrub.
