#!/usr/bin/env node
// VERIFICATION SCAFFOLDING for the verify-weft skill. Not product code.
//
// Drives @weave/weft (packages/weft) through its public entry points
// (`@weave/weft`, `@weave/weft/sqlite`, `@weave/weft/intake`, `@weave/weft/otel`)
// against the package's own fixtures, and records evidence.
//
//   weft-verify.mjs launch [--run ID]     build packages/weft, create scratch + evidence dirs
//   weft-verify.mjs doctor                read-only: is this checkout/run worth driving?
//   weft-verify.mjs drive <feature>       record-contract | sink | trace-import | otel-roundtrip | otlp-intake
//   weft-verify.mjs test                  npm run test:weft-contract, transcript into evidence
//   weft-verify.mjs checks                every checks/*.mjs plus checks/test, results into evidence
//   weft-verify.mjs cleanup               delete this run's scratch dir; never the evidence
//
// The run is chosen by --run ID or WEFT_VERIFY_RUN. Run from anywhere; paths resolve
// from this file to the repo root. Only node: built-ins and @weave/weft are imported.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { deepStrictEqual } from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PKG = join(ROOT, 'packages/weft');
const FIXTURES = join(PKG, 'fixtures');
const EVIDENCE_ROOT = join(ROOT, '.local/verify-weft');
const SCRATCH_ROOT = join(tmpdir(), 'weft-verify');
const FEATURES = ['record-contract', 'sink', 'trace-import', 'otel-roundtrip', 'otlp-intake'];

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const RUN = flag('run') ?? process.env.WEFT_VERIFY_RUN;
const runId = () => {
  if (!RUN) die('No run. Pass --run ID or export WEFT_VERIFY_RUN (printed by launch).');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(RUN)) die(`Bad run id: ${RUN}`);
  return RUN;
};
const evidenceDir = (run) => join(EVIDENCE_ROOT, run);
const scratchDir = (run) => join(SCRATCH_ROOT, run);
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x), 2) + '\n';
function die(msg, code = 2) {
  console.error(`weft-verify: ${msg}`);
  process.exit(code);
}
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const identity = (r) => r;

function loadState(run) {
  const path = join(scratchDir(run), 'state.json');
  if (!existsSync(path)) die(`Run ${run} has no state at ${path}. Launch it first (or it was cleaned up).`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------- launch ----------
function launch() {
  const run =
    RUN ?? `weft-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(run)) die(`Bad run id: ${run}`);
  console.log(`RUN=${run}`);
  const scratch = scratchDir(run);
  const evidence = evidenceDir(run);
  if (existsSync(scratch)) die(`Scratch dir ${scratch} already exists: refusing to reuse another run's state.`);
  if (existsSync(evidence)) die(`Evidence dir ${evidence} already exists: pick a new --run id.`);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  // Weft has no tsconfig references, so building it alone is enough and leaves other packages' dist untouched.
  const build = spawnSync('npx', ['tsc', '-b', 'packages/weft/tsconfig.json'], { cwd: ROOT, encoding: 'utf8' });
  writeFileSync(
    join(evidence, 'build.log'),
    `$ npx tsc -b packages/weft/tsconfig.json\n${build.stdout}${build.stderr}exit=${build.status}\n`,
  );
  if (build.status !== 0) die(`Build failed (exit ${build.status}); see ${join(evidence, 'build.log')}`, 1);
  const state = {
    run,
    root: ROOT,
    scratch,
    evidence,
    sha: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
    node: process.version,
    launchedAt: new Date().toISOString(),
  };
  writeFileSync(join(scratch, 'state.json'), json(state));
  writeFileSync(join(evidence, 'run.json'), json(state));
  console.log(`SCRATCH=${scratch}`);
  console.log(`EVIDENCE=${evidence}`);
  console.log('READY: packages/weft built; run doctor next.');
}

// ---------- doctor ----------
function newestMtime(dir, ext) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p, ext));
    else if (entry.name.endsWith(ext)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}
async function doctor() {
  const run = runId();
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const state = existsSync(join(scratchDir(run), 'state.json')) ? loadState(run) : null;
  check('run state present', state, state ? join(scratchDir(run), 'state.json') : 'missing: launch first');
  check('evidence dir present', existsSync(evidenceDir(run)), evidenceDir(run));
  const [major] = process.versions.node.split('.').map(Number);
  check('node satisfies engines >=26', major >= 26, process.version);
  check(
    'node is v26.x (monorepo baseline requirement; informational here)',
    true,
    major === 26 ? 'yes' : `no: ${process.version} (record this in the report)`,
  );
  const head = git('rev-parse', 'HEAD');
  check('HEAD matches launch SHA', state && state.sha === head, `launch=${state?.sha} head=${head}`);
  const entries = ['index', 'otel', 'sqlite', 'sqlite-intake'].map((n) => join(PKG, 'dist/src', `${n}.js`));
  check('dist entry points built', entries.every(existsSync), entries.map((p) => relative(ROOT, p)).join(', '));
  const srcNewest = Math.max(newestMtime(join(PKG, 'src'), '.ts'), newestMtime(join(PKG, 'test'), '.ts'));
  const distNewest = existsSync(join(PKG, 'dist')) ? newestMtime(join(PKG, 'dist'), '.js') : 0;
  check(
    'dist not older than src/test',
    distNewest >= srcNewest,
    `src=${new Date(srcNewest).toISOString()} dist=${distNewest ? new Date(distNewest).toISOString() : 'none'}`,
  );
  let resolved = '';
  try {
    resolved = fileURLToPath(import.meta.resolve('@weave/weft'));
  } catch (e) {
    resolved = `unresolved: ${e.message}`;
  }
  check('@weave/weft resolves into this checkout', resolved.startsWith(PKG + sep), resolved);
  try {
    const weft = await import('@weave/weft');
    const want = [
      'validateRecord',
      'serializeRecord',
      'createWeftSink',
      'importTraceLines',
      'validateTrace',
      'serializeTrace',
    ];
    check(
      'public exports present',
      want.every((k) => typeof weft[k] === 'function'),
      want.join(', '),
    );
    const sqlite = await import('@weave/weft/sqlite');
    const intake = await import('@weave/weft/intake');
    const otel = await import('@weave/weft/otel');
    check(
      'subpath exports present',
      typeof sqlite.openTraceStore === 'function' &&
        typeof intake.createOtlpListener === 'function' &&
        typeof otel.exportOtlp === 'function',
      'openTraceStore, mapOtlp/intakeOtlp/createOtlpListener, exportOtlp',
    );
  } catch (e) {
    check('public exports importable', false, e.message);
  }
  const records = JSON.parse(readFileSync(join(FIXTURES, 'records.json'), 'utf8'));
  const traceLines = readFileSync(join(FIXTURES, 'weave-trace-v1.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  check(
    'fixtures readable',
    records.valid?.length > 0 &&
      records.invalid?.length > 0 &&
      traceLines.length > 0 &&
      existsSync(join(FIXTURES, 'otel-all-kinds.json')) &&
      existsSync(join(FIXTURES, 'otel-golden.json')),
    `records.json valid=${records.valid?.length} invalid=${records.invalid?.length}; weave-trace-v1.jsonl lines=${traceLines.length}`,
  );
  try {
    await import('node:sqlite');
    check('node:sqlite available', true, 'yes');
  } catch (e) {
    check('node:sqlite available', false, e.message);
  }
  const ok = checks.every((c) => c.ok);
  const out = { run, ok, checks };
  console.log(json(out));
  if (state) writeFileSync(join(evidenceDir(run), `doctor-${Date.now()}.json`), json(out));
  process.exit(ok ? 0 : 1);
}

// ---------- drive ----------
function makeRecorder(run, feature) {
  const dir = join(evidenceDir(run), feature);
  mkdirSync(dir, { recursive: true });
  const results = [];
  return {
    dir,
    expect(name, actual, expected) {
      let ok = true;
      try {
        deepStrictEqual(actual, expected);
      } catch {
        ok = false;
      }
      results.push({ name, ok, expected, actual });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
      return ok;
    },
    finish(extra = {}) {
      const ok = results.every((r) => r.ok);
      const out = {
        run,
        feature,
        ok,
        sha: git('rev-parse', 'HEAD'),
        node: process.version,
        at: new Date().toISOString(),
        ...extra,
        results,
      };
      writeFileSync(join(dir, 'result.json'), json(out));
      console.log(
        `${ok ? 'PASS' : 'FAIL'} ${feature}: ${results.filter((r) => r.ok).length}/${results.length} checks; evidence ${relative(ROOT, dir)}/`,
      );
      process.exitCode = ok ? 0 : 1;
    },
  };
}
const readJson = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
async function sqliteCounts(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = ['runs', 'threads', 'spans', 'decisions', 'model_calls', 'tool_calls', 'errors', 'budget_events'];
    const counts = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
    const kinds = db
      .prepare('SELECT schema, kind, count(*) AS n FROM spans GROUP BY schema, kind ORDER BY schema, kind')
      .all()
      .map((r) => ({ ...r }));
    return { counts, kinds };
  } finally {
    db.close();
  }
}

const drives = {
  // validateRecord over every records.json case: the user path of contract.test.ts, recorded per case.
  async 'record-contract'(rec) {
    const { validateRecord } = await import('@weave/weft');
    const fx = readJson('records.json');
    const cases = [];
    for (const { name, record } of fx.valid)
      cases.push({ name, expected: { ok: true }, actual: validateRecord(record) });
    for (const { name, reason, record } of fx.invalid)
      cases.push({ name, expected: { ok: false, reason }, actual: validateRecord(record) });
    writeFileSync(join(rec.dir, 'verdicts.json'), json(cases));
    const mismatches = cases.filter((c) => JSON.stringify(c.actual) !== JSON.stringify(c.expected));
    rec.expect(
      'every valid fixture accepted',
      fx.valid.length - mismatches.filter((c) => c.expected.ok).length,
      fx.valid.length,
    );
    rec.expect(
      'every invalid fixture rejected with its documented reason',
      fx.invalid.length - mismatches.filter((c) => !c.expected.ok).length,
      fx.invalid.length,
    );
    rec.expect(
      'mismatched cases',
      mismatches.map((c) => c.name),
      [],
    );
    const reasons = [...new Set(fx.invalid.map((c) => c.reason))].sort();
    const envelope = { ok: false, reason: 'envelope' };
    rec.expect(
      'non-object input rejected as envelope, never thrown',
      [validateRecord(null), validateRecord('x'), validateRecord([])],
      [envelope, envelope, envelope],
    );
    rec.finish({
      fixture: 'packages/weft/fixtures/records.json',
      fixtureDigest: sha256(join(FIXTURES, 'records.json')),
      valid: fx.valid.length,
      invalid: fx.invalid.length,
      reasons,
    });
  },

  // createWeftSink writing JSONL to a file in scratch; second view re-reads and re-validates the file.
  async sink(rec, state) {
    const { createWeftSink, serializeRecord, validateRecord } = await import('@weave/weft');
    const fx = readJson('records.json');
    const out = join(state.scratch, 'sink.jsonl');
    writeFileSync(out, '');
    const sink = createWeftSink({ redact: identity, write: (line) => appendFileSync(out, line) });
    for (const { record } of fx.valid) sink.emit(record);
    rec.expect('valid fixtures: none rejected', sink.rejected, 0);
    for (const { record } of fx.invalid) sink.emit(record);
    rec.expect('invalid fixtures: every one counted as rejected', sink.rejected, fx.invalid.length);
    const canary = 'sk-live0123456789abcdefCANARY';
    sink.emit({ ...fx.valid[0].record, record_id: canary });
    rec.expect('record carrying a credential marker rejected', sink.rejected, fx.invalid.length + 1);
    const throwing = createWeftSink({
      redact: () => {
        throw new Error('redactor failed');
      },
      write: (line) => appendFileSync(out, line),
    });
    throwing.emit(fx.valid[0].record);
    rec.expect('throwing redactor: counted, not written, not thrown', throwing.rejected, 1);
    let missingRedactor = '';
    try {
      createWeftSink({ write: () => {} });
    } catch (e) {
      missingRedactor = e.constructor.name;
    }
    rec.expect('sink without a redactor refuses to construct', missingRedactor, 'TypeError');
    // Second view: the file on disk.
    const text = readFileSync(out, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    rec.expect('file holds exactly one line per accepted record', lines.length, fx.valid.length);
    rec.expect(
      'every written line re-validates',
      lines.filter((l) => validateRecord(JSON.parse(l)).ok).length,
      fx.valid.length,
    );
    rec.expect(
      'written bytes equal serializeRecord output',
      text,
      fx.valid.map(({ record }) => serializeRecord(record, identity)).join(''),
    );
    rec.expect('credential canary never written', text.includes('CANARY'), false);
    copyFileSync(out, join(rec.dir, 'sink.jsonl'));
    rec.finish({
      output: relative(ROOT, join(rec.dir, 'sink.jsonl')),
      outputDigest: sha256(out),
      accepted: lines.length,
      rejected: sink.rejected,
    });
  },

  // weave.trace@1 JSONL imported into a fresh SQLite file via importTraceLines and openTraceStore.
  async 'trace-import'(rec, state) {
    const { importTraceLines, validateTrace } = await import('@weave/weft');
    const { openTraceStore } = await import('@weave/weft/sqlite');
    const fixture = readFileSync(join(FIXTURES, 'weave-trace-v1.jsonl'), 'utf8');
    const lines = fixture.split('\n').filter((l) => l.trim());
    rec.expect(
      'every fixture line passes validateTrace',
      lines.filter((l) => validateTrace(JSON.parse(l))).length,
      lines.length,
    );
    const db = join(state.scratch, 'trace.db');
    rec.expect('database starts absent (empty data dir)', existsSync(db), false);
    const opened = openTraceStore(db, { redact: identity, redactTrace: identity });
    rec.expect('store opens', opened.ok, true);
    if (!opened.ok) return rec.finish();
    const store = opened.store;
    let importError = null;
    try {
      await importTraceLines(fixture, store);
    } catch (e) {
      importError = e.message;
    }
    rec.expect('importTraceLines resolves', importError, null);
    rec.expect('re-import is a no-op', await store.importJsonl(fixture), { ok: true, inserted: 0, torn: false });
    const first = JSON.parse(lines[0]);
    const conflicting =
      JSON.stringify({ ...first, payload: { ...first.payload, latency_ms: 1 } }) +
      '\n' +
      JSON.stringify({ ...first, id: 'new-row-in-rejected-batch', sequence: 99 }) +
      '\n';
    let conflict = null;
    try {
      await importTraceLines(conflicting, store);
    } catch (e) {
      conflict = e.message;
    }
    rec.expect('changed content for an existing id conflicts', conflict, 'Trace import rejected: conflict');
    let invalid = null;
    try {
      await importTraceLines(JSON.stringify({ ...first, id: 'x', schema: 'weave.trace@2' }) + '\n', store);
    } catch (e) {
      invalid = e.message;
    }
    rec.expect('wrong schema rejected before any write', invalid, 'Invalid trace record');
    const read = store.read();
    // read() orders rows by (run_id, id), not by fixture line order.
    const byId = (a, b) => (a.run_id + '\0' + a.id < b.run_id + '\0' + b.id ? -1 : 1);
    rec.expect(
      'store.read returns exactly the fixture rows',
      read.ok && read.rows,
      lines.map((l) => JSON.parse(l)).sort(byId),
    );
    rec.expect('store closes', store.close(), { ok: true });
    // Second view: the SQLite file opened read-only, outside Weft.
    const view = await sqliteCounts(db);
    writeFileSync(join(rec.dir, 'sqlite-view.json'), json(view));
    rec.expect('spans table holds the fixture rows only (rejected batch rolled back)', view.counts.spans, lines.length);
    rec.expect(
      'subtype tables populated',
      [view.counts.decisions, view.counts.tool_calls, view.counts.errors, view.counts.budget_events],
      [2, 2, 1, 1],
    );
    copyFileSync(db, join(rec.dir, 'trace.db'));
    rec.finish({
      fixture: 'packages/weft/fixtures/weave-trace-v1.jsonl',
      database: relative(ROOT, join(rec.dir, 'trace.db')),
      databaseDigest: sha256(db),
    });
  },

  // OTLP/JSON fixtures mapped into Weft records and exported back, both directions deterministic.
  async 'otel-roundtrip'(rec) {
    const { validateRecord } = await import('@weave/weft');
    const { mapOtlp } = await import('@weave/weft/intake');
    const { exportOtlp } = await import('@weave/weft/otel');
    for (const name of ['otel-all-kinds.json', 'otel-golden.json']) {
      const fx = readJson(name);
      const mapped = mapOtlp(fx, { redact: identity });
      rec.expect(`${name}: mapOtlp ok`, mapped.ok, true);
      if (!mapped.ok) continue;
      rec.expect(
        `${name}: every mapped record validates`,
        mapped.records.filter((r) => validateRecord(r).ok).length,
        mapped.records.length,
      );
      const exported = exportOtlp(mapped.records, { redact: identity });
      rec.expect(`${name}: exportOtlp ok`, exported.ok, true);
      if (!exported.ok) continue;
      rec.expect(`${name}: export of the mapped records deep-equals the fixture`, JSON.parse(exported.json), fx);
      rec.expect(
        `${name}: export is order-independent`,
        exportOtlp([...mapped.records].reverse(), { redact: identity }),
        exported,
      );
      writeFileSync(
        join(rec.dir, name.replace('.json', '.records.jsonl')),
        mapped.records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      writeFileSync(join(rec.dir, name.replace('.json', '.export.json')), exported.json);
      if (name === 'otel-all-kinds.json')
        rec.expect('all-kinds: 14 distinct kinds', new Set(mapped.records.map((r) => r.kind)).size, 14);
    }
    const bad = structuredClone(readJson('otel-golden.json'));
    bad.resourceSpans[0].scopeSpans[0].spans[0].traceId = 'not-hex';
    rec.expect('malformed traceId rejected as input', mapOtlp(bad, { redact: identity }), {
      ok: false,
      reason: 'input',
    });
    rec.expect('export without a redactor is a config failure', exportOtlp([], {}), { ok: false, reason: 'config' });
    rec.finish();
  },

  // A real loopback HTTP listener (createOtlpListener) receiving OTLP/JSON POSTs into a fresh SQLite file.
  async 'otlp-intake'(rec, state) {
    const { openTraceStore } = await import('@weave/weft/sqlite');
    const { createOtlpListener } = await import('@weave/weft/intake');
    const db = join(state.scratch, 'intake.db');
    rec.expect('database starts absent (empty data dir)', existsSync(db), false);
    const opened = openTraceStore(db, { redact: identity, redactTrace: identity });
    if (!rec.expect('store opens', opened.ok, true)) return rec.finish();
    const listener = await createOtlpListener({
      createServer,
      store: opened.store,
      redact: identity,
      host: '127.0.0.1',
      port: 0,
    });
    if (!rec.expect('listener starts on loopback', listener.ok, true)) return rec.finish();
    const url = new URL(listener.url);
    const transcript = [];
    const send = (method, path, body, headers = {}) =>
      new Promise((resolveReq) => {
        const req = httpRequest({ host: url.hostname, port: url.port, method, path, headers }, (res) => {
          res.resume();
          res.on('end', () => {
            transcript.push({
              method,
              path,
              headers,
              bodyBytes: body ? Buffer.byteLength(body) : 0,
              status: res.statusCode,
            });
            resolveReq(res.statusCode);
          });
        });
        req.on('error', (e) => {
          transcript.push({ method, path, headers, error: e.code });
          resolveReq(e.code);
        });
        if (body) req.write(body);
        req.end();
      });
    const payload = readFileSync(join(FIXTURES, 'otel-all-kinds.json'), 'utf8');
    const jsonType = { 'content-type': 'application/json' };
    try {
      rec.expect('POST /v1/traces all-kinds -> 200', await send('POST', '/v1/traces', payload, jsonType), 200);
      rec.expect('same POST again (idempotent) -> 200', await send('POST', '/v1/traces', payload, jsonType), 200);
      rec.expect('GET /v1/traces -> 404', await send('GET', '/v1/traces'), 404);
      rec.expect('POST other path -> 404', await send('POST', '/v1/logs', payload, jsonType), 404);
      rec.expect(
        'POST text/plain -> 415',
        await send('POST', '/v1/traces', payload, { 'content-type': 'text/plain' }),
        415,
      );
      rec.expect(
        'POST with Origin header -> 403',
        await send('POST', '/v1/traces', payload, { ...jsonType, origin: 'http://evil.example' }),
        403,
      );
      rec.expect('POST malformed JSON -> 400', await send('POST', '/v1/traces', '{"resourceSpans":', jsonType), 400);
      rec.expect('POST non-OTLP JSON -> 400', await send('POST', '/v1/traces', '{"hello":1}', jsonType), 400);
    } finally {
      rec.expect('listener closes', await listener.close(), { ok: true });
      rec.expect('store closes', opened.store.close(), { ok: true });
    }
    const refused = await new Promise((r) => {
      const s = connect({ host: url.hostname, port: Number(url.port) });
      s.once('connect', () => (s.destroy(), r('connected')));
      s.once('error', (e) => r(e.code));
    });
    rec.expect('port no longer accepts connections after close', refused, 'ECONNREFUSED');
    writeFileSync(join(rec.dir, 'http-transcript.json'), json({ url: listener.url, requests: transcript }));
    const view = await sqliteCounts(db);
    writeFileSync(join(rec.dir, 'sqlite-view.json'), json(view));
    rec.expect('spans table holds the 14 all-kinds records once', view.counts.spans, 14);
    rec.expect(
      '14 distinct weft.record@1 kinds stored',
      view.kinds.filter((k) => k.schema === 'weft.record@1').length,
      14,
    );
    copyFileSync(db, join(rec.dir, 'intake.db'));
    rec.finish({
      listener: listener.url,
      database: relative(ROOT, join(rec.dir, 'intake.db')),
      databaseDigest: sha256(db),
    });
  },
};

async function drive() {
  const run = runId();
  const state = loadState(run);
  const feature = rest.find((a) => !a.startsWith('--') && a !== RUN);
  if (!drives[feature]) die(`Unknown feature "${feature}". One of: ${FEATURES.join(', ')}`);
  await drives[feature](makeRecorder(run, feature), state);
}

// ---------- test / checks ----------
function runLogged(run, file, label, command, args) {
  const r = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(file, `$ ${[command, ...args].join(' ')}\n${r.stdout}${r.stderr}\nexit=${r.status}\n`);
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${label} (exit ${r.status}) -> ${relative(ROOT, file)}`);
  return r.status;
}
function packageTest() {
  const run = runId();
  loadState(run);
  const file = join(evidenceDir(run), 'package-test.log');
  const status = runLogged(run, file, 'npm run test:weft-contract', 'npm', ['run', 'test:weft-contract']);
  // TAP (`# fail 0`, Node 22 when piped) or spec (`ℹ fail 0`, Node >= 23) summary lines.
  const lines = readFileSync(file, 'utf8').split('\n');
  const tail = lines.filter((l) => /^(#|ℹ) (tests|pass|fail|cancelled|skipped) /.test(l));
  const failing = [
    ...new Set(
      lines
        .filter((l) => /^(✖ |not ok )/.test(l) && !/failing tests/.test(l))
        .map((l) => l.replace(/ \([0-9.]+ms\)$/, '')),
    ),
  ];
  console.log(tail.join('\n'));
  if (failing.length) console.log(`failing:\n  ${failing.join('\n  ')}`);
  writeFileSync(
    join(evidenceDir(run), 'package-test.json'),
    json({ command: 'npm run test:weft-contract', node: process.version, exit: status, summary: tail, failing }),
  );
  process.exitCode = status === 0 ? 0 : 1;
}
function checks() {
  const run = runId();
  loadState(run);
  const dir = join(evidenceDir(run), 'checks');
  mkdirSync(dir, { recursive: true });
  const scripts = readdirSync(join(ROOT, 'checks'))
    .filter((f) => f.endsWith('.mjs'))
    .sort();
  console.log(`checks/ scripts: ${scripts.join(', ')}`);
  const results = scripts.map((s) => ({
    script: `checks/${s}`,
    exit: runLogged(run, join(dir, `${s}.log`), `node checks/${s}`, 'node', [`checks/${s}`]),
  }));
  const tests = readdirSync(join(ROOT, 'checks/test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort();
  results.push({
    script: `checks/test/{${tests.join(',')}}`,
    exit: runLogged(run, join(dir, 'checks-test.log'), 'node --test checks/test/*.test.mjs', 'node', [
      '--test',
      ...tests.map((t) => `checks/test/${t}`),
    ]),
  });
  const ok = results.every((r) => r.exit === 0);
  writeFileSync(join(dir, 'summary.json'), json({ ok, results }));
  process.exitCode = ok ? 0 : 1;
}

// ---------- cleanup ----------
function cleanup() {
  const run = runId();
  const scratch = scratchDir(run);
  const evidence = evidenceDir(run);
  // Only ever delete the run's own directory under $TMPDIR/weft-verify/.
  if (!scratch.startsWith(SCRATCH_ROOT + sep) || relative(SCRATCH_ROOT, scratch) !== run)
    die(`Refusing to delete ${scratch}`);
  const existed = existsSync(scratch);
  const removed = existed ? readdirSync(scratch) : [];
  if (existed) rmSync(scratch, { recursive: true, force: true });
  const evidenceKept = existsSync(evidence);
  const out = {
    run,
    scratch,
    removed,
    scratchGone: !existsSync(scratch),
    evidence,
    evidenceKept,
    evidenceFiles: evidenceKept ? listTree(evidence) : [],
    at: new Date().toISOString(),
  };
  if (evidenceKept) writeFileSync(join(evidence, 'cleanup.json'), json(out));
  console.log(json(out));
  process.exitCode = out.scratchGone && evidenceKept ? 0 : 1;
}
function listTree(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listTree(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
  );
}

const commands = { launch, doctor, drive, test: packageTest, checks, cleanup };
if (!commands[cmd]) die(`Usage: weft-verify.mjs <${Object.keys(commands).join('|')}> [--run ID] [feature]`);
await commands[cmd]();
