# `weave.trace@1` import into SQLite

Weft still reads the P9 `weave.trace@1` envelope as a supported version, without converting it to Weft records. `importTraceLines(jsonl, port)` validates the whole JSONL batch before any write and hands it to a `TraceImportPort`; `openTraceStore(path, { redact, redactTrace })` is Weft's optional local SQLite inspection store implementing that port. Identical content re-imported is a no-op, different content for an existing id is a conflict, and a rejected batch leaves the database unchanged.

## Sub-features

- `trace-validate` every line of `fixtures/weave-trace-v1.jsonl` passes `validateTrace`.
- `trace-import` `importTraceLines` into a fresh `openTraceStore` file resolves and stores all seven rows.
- `trace-idempotent` re-importing the same JSONL inserts nothing (`{ ok: true, inserted: 0, torn: false }`).
- `trace-conflict` a batch that changes an existing id's payload throws `Trace import rejected: conflict` and its other new row is not stored.
- `trace-invalid` a line with `schema: "weave.trace@2"` throws `Invalid trace record` before any write.
- `trace-read` `store.read()` returns exactly the fixture rows (ordered by `run_id, id`).
- `trace-sqlite-view` the SQLite file, opened read-only outside Weft, has 7 `spans` and the subtype rows (`decisions` 2, `tool_calls` 2, `errors` 1, `budget_events` 1).

## How to get to it (user POV)

- `import { importTraceLines, validateTrace } from '@weave/weft'` and `import { openTraceStore } from '@weave/weft/sqlite'`, then `importTraceLines(text, store)`.
- `store.importJsonl(text)` directly for the newline-terminated JSONL path with torn-line reporting.
- Inspect the resulting `.db` with any SQLite reader (tables `runs`, `threads`, `spans`, `decisions`, `model_calls`, `tool_calls`, `errors`, `budget_events`).

## Driving it with weft-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.
- `$TMPDIR/weft-verify/<RUN>/trace.db` does not exist. The drive checks this first (`database starts absent`); a second drive in the same run fails that check, so launch a new run to re-drive.

- **Validate lines.** Run `$H drive trace-import`. Check `PASS every fixture line passes validateTrace`.
- **Open a fresh store.** Checks `PASS database starts absent (empty data dir)` and `PASS store opens`.
- **Import.** Check `PASS importTraceLines resolves`.
- **Re-import.** Check `PASS re-import is a no-op`.
- **Conflicting batch.** Check `PASS changed content for an existing id conflicts`.
- **Invalid batch.** Check `PASS wrong schema rejected before any write`.
- **Read back.** Checks `PASS store.read returns exactly the fixture rows` and `PASS store closes`.
- **Second view: SQLite.** The drive opens `trace.db` with `node:sqlite` `readOnly` and counts rows. Checks `PASS spans table holds the fixture rows only (rejected batch rolled back)` and `PASS subtype tables populated`.
- **Proof.** `trace-import/trace.db`, `trace-import/sqlite-view.json` (per-table counts and per-kind span counts), `trace-import/result.json` with `ok: true` and the database digest.

## Gotchas

- `store.read()` orders rows by `(run_id, id)`, not by `sequence` or file order. Compare as sorted sets.
- `implement` rows have no subtype table; only `decision`/`audit` (→ `decisions`), `shell` (→ `tool_calls`), `error` and `budget` get one. `spans` holds every row.
- `importJsonl` commits only newline-terminated lines and reports a torn final line as `torn: true`; `importTraceLines` skips blank lines and throws on any unparsable line. They are different user paths.
- `node:sqlite` prints an `ExperimentalWarning` on some Node 22 builds. It is noise, not a failure.
