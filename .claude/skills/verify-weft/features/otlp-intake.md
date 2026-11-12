# OTLP/JSON loopback intake

`createOtlpListener({ createServer, store, redact, host?, port?, maxBytes? })` opens a loopback-only HTTP endpoint that accepts OTLP/JSON on `POST /v1/traces`, maps it with `mapOtlp`, and imports the validated records into a `TraceStore` from `openTraceStore`. The caller injects `createServer`, so Weft never opens a socket on its own. The listener refuses non-loopback hosts, cross-origin requests, wrong paths, wrong content types, oversized and malformed bodies, and answers with status codes only.

## Sub-features

- `intake-accept` `POST /v1/traces` with `otel-all-kinds.json` and `content-type: application/json` returns `200` and stores 14 records.
- `intake-idempotent` the same POST again returns `200` and stores nothing new.
- `intake-route` `GET /v1/traces` and `POST /v1/logs` return `404`.
- `intake-content-type` `content-type: text/plain` returns `415`.
- `intake-origin` any request carrying an `Origin` header returns `403`.
- `intake-bad-body` malformed JSON and non-OTLP JSON return `400`.
- `intake-close` `close()` resolves `{ ok: true }` and the port then refuses TCP connections.

## How to get to it (user POV)

- `import { createOtlpListener } from '@weave/weft/intake'`, `import { openTraceStore } from '@weave/weft/sqlite'`, and `import { createServer } from 'node:http'`; start the listener and point an OTLP/HTTP JSON exporter at `<url>/v1/traces`.
- Inspect the resulting `.db` with any SQLite reader.

## Driving it with weft-verify

Preconditions:

- Baseline preconditions in `README.md` hold and `$H doctor` exits 0.
- `$TMPDIR/weft-verify/<RUN>/intake.db` does not exist (one intake drive per run).
- Loopback `127.0.0.1` is available; the listener binds port `0`, so no fixed port is needed or reused.

- **Start the listener.** Run `$H drive otlp-intake`. Checks `PASS database starts absent (empty data dir)`, `PASS store opens`, `PASS listener starts on loopback`.
- **Accept a trace.** Check `PASS POST /v1/traces all-kinds -> 200`.
- **Repeat it.** Check `PASS same POST again (idempotent) -> 200`.
- **Refusals.** Checks `PASS GET /v1/traces -> 404`, `PASS POST other path -> 404`, `PASS POST text/plain -> 415`, `PASS POST with Origin header -> 403`, `PASS POST malformed JSON -> 400`, `PASS POST non-OTLP JSON -> 400`.
- **Close.** Checks `PASS listener closes`, `PASS store closes`, `PASS port no longer accepts connections after close`.
- **Second view: SQLite.** Checks `PASS spans table holds the 14 all-kinds records once` and `PASS 14 distinct weft.record@1 kinds stored`.
- **Proof.** `otlp-intake/http-transcript.json` (method, path, headers, body size and status per request), `otlp-intake/intake.db`, `otlp-intake/sqlite-view.json`, `otlp-intake/result.json` with `ok: true`, the listener URL and the database digest.

## Gotchas

- The drive sends requests with `node:http`, not `fetch`, so it can set `Origin` and control `content-type` exactly. Browser-style clients add `Origin` and are refused by design (`403`).
- The listener checks `Host` equals the bound authority. A proxy or client that rewrites `Host` gets `403`; this drive does not exercise a mismatched `Host`.
- The `413` (body over `maxBytes`, default 1 MiB) path is not driven here; it is covered by `test/sqlite-intake.test.ts`.
- The HTTP status is the only response; a `200` alone does not prove storage. Always check the SQLite view.
