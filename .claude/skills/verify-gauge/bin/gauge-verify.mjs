#!/usr/bin/env node
// VERIFICATION SCAFFOLDING for the verify-gauge skill. Not product code.
//
// Drives @weave/gauge (packages/gauge) through its public entry point against the
// package's own fixtures, and the offline failure-attribution harness
// (benchmarks/failure-attribution) against its tune-only corpus. Records evidence.
//
//   gauge-verify.mjs launch [--run ID]   build packages/gauge (+ weft reference), create scratch + evidence dirs
//   gauge-verify.mjs doctor              read-only: is this checkout/run worth driving?
//   gauge-verify.mjs drive <feature>     record-contract | evaluate | compare-track | info-only | failure-attribution
//   gauge-verify.mjs test                npm run test:gauge-contract and npm run test:failure-attribution, transcripts into evidence
//   gauge-verify.mjs checks              every checks/*.mjs plus checks/test, results into evidence
//   gauge-verify.mjs cleanup             delete this run's scratch dir; never the evidence
//
// The run is chosen by --run ID or GAUGE_VERIFY_RUN. Run from anywhere; paths resolve
// from this file to the repo root. Imports only node: built-ins, @weave/gauge and, for the
// failure-attribution drive, the harness's own exported .ts entry points. No model, no
// provider, no network.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { deepStrictEqual } from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '../../../..');
const PKG = join(ROOT, 'packages/gauge');
const FIXTURE = join(PKG, 'fixtures/records.json');
const LEAF = join(ROOT, 'benchmarks/failure-attribution');
const EVIDENCE_ROOT = join(ROOT, '.local/verify-gauge');
const SCRATCH_ROOT = join(tmpdir(), 'gauge-verify');
const FEATURES = ['record-contract', 'evaluate', 'compare-track', 'info-only', 'failure-attribution'];
// The flags `npm run test:failure-attribution` runs the harness under.
const HARNESS_FLAGS = ['--experimental-strip-types', '--disallow-code-generation-from-strings'];

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const RUN = flag('run') ?? process.env.GAUGE_VERIFY_RUN;
const runId = () => {
  if (!RUN) die('No run. Pass --run ID or export GAUGE_VERIFY_RUN (printed by launch).');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(RUN)) die(`Bad run id: ${RUN}`);
  return RUN;
};
const evidenceDir = (run) => join(EVIDENCE_ROOT, run);
const scratchDir = (run) => join(SCRATCH_ROOT, run);
const json = (v) => JSON.stringify(v, null, 2) + '\n';
function die(msg, code = 2) {
  console.error(`gauge-verify: ${msg}`);
  process.exit(code);
}
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const listTree = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listTree(join(dir, e.name), base) : [relative(base, join(dir, e.name))]))
    .sort();
const treeDigests = (dir) => Object.fromEntries(listTree(dir).map((f) => [f, sha256(join(dir, f))]));

function loadState(run) {
  const path = join(scratchDir(run), 'state.json');
  if (!existsSync(path)) die(`Run ${run} has no state at ${path}. Launch it first (or it was cleaned up).`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------- launch ----------
function launch() {
  const run =
    RUN ?? `gauge-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(run)) die(`Bad run id: ${run}`);
  console.log(`RUN=${run}`);
  const scratch = scratchDir(run);
  const evidence = evidenceDir(run);
  if (existsSync(scratch)) die(`Scratch dir ${scratch} already exists: refusing to reuse another run's state.`);
  if (existsSync(evidence)) die(`Evidence dir ${evidence} already exists: pick a new --run id.`);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  // Gauge references only ../weft, so this builds packages/weft/dist and packages/gauge/dist and nothing else.
  const build = spawnSync('npx', ['tsc', '-b', 'packages/gauge/tsconfig.json'], { cwd: ROOT, encoding: 'utf8' });
  writeFileSync(
    join(evidence, 'build.log'),
    `$ npx tsc -b packages/gauge/tsconfig.json\n${build.stdout}${build.stderr}exit=${build.status}\n`,
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
  console.log('READY: packages/gauge built; run doctor next.');
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
  const entry = join(PKG, 'dist/src/index.js');
  check('dist entry point built', existsSync(entry), relative(ROOT, entry));
  for (const pkg of ['gauge', 'weft']) {
    const dir = join(ROOT, 'packages', pkg);
    const srcNewest = Math.max(newestMtime(join(dir, 'src'), '.ts'), newestMtime(join(dir, 'test'), '.ts'));
    const distNewest = existsSync(join(dir, 'dist')) ? newestMtime(join(dir, 'dist'), '.js') : 0;
    check(
      `packages/${pkg} dist not older than src/test`,
      distNewest >= srcNewest,
      `src=${new Date(srcNewest).toISOString()} dist=${distNewest ? new Date(distNewest).toISOString() : 'none'}`,
    );
  }
  let resolved = '';
  try {
    resolved = fileURLToPath(import.meta.resolve('@weave/gauge'));
  } catch (e) {
    resolved = `unresolved: ${e.message}`;
  }
  check('@weave/gauge resolves into this checkout', resolved.startsWith(PKG + sep), resolved);
  try {
    const gauge = await import('@weave/gauge');
    const want = ['validate', 'evaluate', 'evaluateInfo', 'compare', 'track', 'costed', 'recordDigest'];
    const missing = want.filter((k) => typeof gauge[k] !== 'function');
    check('public exports present', missing.length === 0, missing.length ? `missing: ${missing}` : want.join(', '));
  } catch (e) {
    check('public exports importable', false, e.message);
  }
  try {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const ctx = f.context ?? {};
    check(
      'records.json readable',
      f.valid?.length > 0 &&
        f.invalid?.length > 0 &&
        ['criteria', 'casesets', 'results', 'revisions'].every((k) => ctx[k]),
      `valid=${f.valid?.length} invalid=${f.invalid?.length} context=${Object.keys(ctx).join(',')} results=${Object.keys(ctx.results ?? {}).length}`,
    );
  } catch (e) {
    check('records.json readable', false, e.message);
  }
  const manifest = join(LEAF, 'fixtures/manifest.json');
  try {
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    const roles = [...new Set(m.entries.map((e) => e.role))];
    check(
      'failure-attribution manifest is tune-only',
      roles.length === 1 && roles[0] === 'tune',
      `entries=${m.entries.length} roles=${roles.join(',')}`,
    );
  } catch (e) {
    check('failure-attribution manifest is tune-only', false, e.message);
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
    save(name, value) {
      writeFileSync(join(dir, name), typeof value === 'string' ? value : json(value));
    },
    finish(extra = {}) {
      const ok = results.every((r) => r.ok);
      const out = {
        run,
        feature,
        ok,
        sha: git('rev-parse', 'HEAD'),
        node: process.version,
        execArgv: process.execArgv,
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
const fixtures = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const verdictOf = (v) => (v.ok ? 'ok' : v.reason);
/** Write a value into scratch, read it back from disk: the second view of a produced record. */
function roundTrip(state, name, value) {
  const path = join(state.scratch, name);
  writeFileSync(path, json(value));
  return { path, back: JSON.parse(readFileSync(path, 'utf8')) };
}
const rates = (successes, n) => Array.from({ length: n }, (_, i) => (i < successes ? 1 : 0));
/** An even count of costs whose mean is exactly `centre` (the shape experiment.test.ts uses). */
const costs = (centre, n) => Array.from({ length: n }, (_, i) => centre + (i % 2 === 0 ? -5 : 5));
const C1 = 'decision-sites.criteria@1';
const CASES = 'decision-sites.cases@1';
const baseRun = (overrides = {}) => ({
  result: 'res-verify-a',
  subject: { kind: 'routed_unit', ref: 'boolean.task@verify-a' },
  workload: 'decision-sites',
  criteria: C1,
  caseset: CASES,
  split: 'tune',
  mode: 'trial',
  evidence: [{ source: 'weft_trace', ref: 'trace-verify-a' }],
  samples: { accuracy: rates(108, 120), cost: costs(150, 120), completion: rates(84, 120) },
  ...overrides,
});

const drives = {
  // validate over every records.json case: the user path of contract.test.ts, recorded per case.
  async 'record-contract'(rec, state) {
    const { validate } = await import('@weave/gauge');
    const before = sha256(FIXTURE);
    const f = fixtures();
    const verdicts = [];
    for (const { name, record } of f.valid)
      verdicts.push({ set: 'valid', name, expected: 'ok', actual: verdictOf(validate(record, f.context)) });
    for (const { name, reason, record } of f.invalid)
      verdicts.push({ set: 'invalid', name, expected: reason, actual: verdictOf(validate(record, f.context)) });
    rec.save('verdicts.json', verdicts);
    const wrong = verdicts.filter((v) => v.expected !== v.actual);
    rec.expect(
      `all ${f.valid.length} valid fixtures accepted`,
      wrong.filter((v) => v.set === 'valid'),
      [],
    );
    rec.expect(
      `all ${f.invalid.length} invalid fixtures rejected with their documented reason`,
      wrong.filter((v) => v.set === 'invalid'),
      [],
    );
    // Context entries are known only if they validate themselves (GAUGE-CONTRACT "Rejection reasons").
    const ctxBad = [];
    for (const [kind, entries] of Object.entries(f.context))
      for (const [key, record] of Object.entries(entries)) {
        const v = verdictOf(validate(record, f.context));
        if (v !== 'ok') ctxBad.push({ kind, key, verdict: v });
      }
    rec.save('context-verdicts.json', ctxBad);
    // decision-sites.edited@1 / unrecorded@1 exist in the fixture context precisely to fail binding.
    rec.expect(
      'context entries that do not validate are only the deliberate unrecorded/edited criteria',
      ctxBad.map((b) => b.key).filter((k) => !/edited|unrecorded/.test(k)),
      [],
    );
    rec.expect('non-object input is envelope', verdictOf(validate('not a record', f.context)), 'envelope');
    rec.expect('unknown schema is envelope', verdictOf(validate({ schema: 'gauge.nope@1' }, f.context)), 'envelope');
    // A subject cannot assert it won: flip a fixture result's verdict and the validator recomputes and rejects it.
    const asserted = { ...f.context.results['res-base'], result: 'res-asserted', verdict: 'misses_bar' };
    rec.expect(
      'a result asserting a verdict that does not recompute is rejected',
      verdictOf(validate(asserted, f.context)),
      'verdict',
    );
    rec.expect('records.json unchanged by validation', sha256(FIXTURE), before);
    rec.finish({ fixture: relative(ROOT, FIXTURE), fixtureDigest: before, cases: verdicts.length });
  },

  // evaluate: samples -> gauge.result@1, re-validated from disk; empty/short/binding/replay/holdout rules.
  async evaluate(rec, state) {
    const { evaluate, validate, recordDigest } = await import('@weave/gauge');
    const before = sha256(FIXTURE);
    const f = fixtures();
    const ctx = f.context;
    const pristine = JSON.stringify(ctx);
    const out = evaluate(baseRun(), ctx);
    rec.expect('evaluate accepts a well-bound trial run', verdictOf(out), 'ok');
    if (!out.ok) return rec.finish();
    const r = out.record;
    const m = Object.fromEntries(r.measures.map((x) => [x.measure, x]));
    rec.expect('schema is gauge.result@1', r.schema, 'gauge.result@1');
    // Hand-computed from the samples: 108/120, mean of 150±5, 84/120.
    rec.expect('accuracy value = 108/120', [m.accuracy.value, m.accuracy.n], [0.9, 120]);
    rec.expect('cost value = mean 150', [m.cost.value, m.cost.n], [150, 120]);
    rec.expect('completion value = 84/120', [m.completion.value, m.completion.n], [0.7, 120]);
    rec.expect(
      'every value lies in its interval',
      r.measures
        .filter((x) => !(x.interval && x.interval[0] <= x.value && x.value <= x.interval[1]))
        .map((x) => x.measure),
      [],
    );
    rec.expect('constraints recomputed: accuracy >= 0.8 held, cost <= 200 held', r.constraints, [
      { constraint: 'accuracy_bar', status: 'held' },
      { constraint: 'cost_cap', status: 'held' },
    ]);
    rec.expect('verdict meets_bar', r.verdict, 'meets_bar');
    rec.expect(
      'caseset_digest bound to the recorded tune split',
      r.caseset_digest,
      ctx.casesets[CASES].splits.find((s) => s.split === 'tune').digest,
    );
    rec.expect('same samples give the same result (fixed seed)', evaluate(baseRun(), ctx), out);
    const { path, back } = roundTrip(state, 'result.json', r);
    rec.save('result.record.json', back);
    rec.expect('record re-read from disk validates', verdictOf(validate(back, ctx)), 'ok');
    rec.expect('record digest survives the disk round-trip', recordDigest(back), recordDigest(r));

    const empty = evaluate(
      baseRun({ result: 'res-verify-empty', samples: { accuracy: [], cost: [], completion: [] } }),
      ctx,
    );
    rec.save('empty.record.json', empty);
    rec.expect(
      'empty samples: n=0, null value, constraints unknown, insufficient_evidence',
      empty.ok && [
        empty.record.measures.map((x) => [x.value, x.n, x.interval]),
        empty.record.constraints.map((c) => c.status),
        empty.record.verdict,
      ],
      [
        [
          [null, 0, null],
          [null, 0, null],
          [null, 0, null],
        ],
        ['unknown', 'unknown'],
        'insufficient_evidence',
      ],
    );
    const few = evaluate(
      baseRun({
        result: 'res-verify-few',
        samples: { accuracy: rates(12, 12), cost: costs(100, 12), completion: rates(9, 12) },
      }),
      ctx,
    );
    rec.expect(
      'below min_samples (12 < 30): insufficient_evidence even with accuracy 1.0',
      few.ok && [few.record.measures[0].value, few.record.verdict],
      [1, 'insufficient_evidence'],
    );
    rec.expect(
      'samples from another workload: binding',
      verdictOf(evaluate(baseRun({ workload: 'task-acceptance' }), ctx)),
      'binding',
    );
    const { completion: _dropped, ...missing } = baseRun().samples;
    rec.expect('a missing measure: binding', verdictOf(evaluate(baseRun({ samples: missing }), ctx)), 'binding');
    rec.expect(
      'an unrecorded criteria set: binding',
      verdictOf(evaluate(baseRun({ criteria: 'decision-sites.unrecorded@1' }), ctx)),
      'binding',
    );
    rec.expect(
      'a NaN sample: envelope',
      verdictOf(evaluate(baseRun({ samples: { ...baseRun().samples, cost: [1, Number.NaN] } }), ctx)),
      'envelope',
    );
    rec.expect(
      'a rate sample of 0.5: measure',
      verdictOf(evaluate(baseRun({ samples: { ...baseRun().samples, accuracy: [1, 0.5, 0] } }), ctx)),
      'measure',
    );
    rec.expect(
      'a replay claiming outcome samples: mode',
      verdictOf(evaluate(baseRun({ mode: 'replay' }), ctx)),
      'mode',
    );
    const replay = evaluate(baseRun({ mode: 'replay', samples: { ...baseRun().samples, completion: [] } }), ctx);
    rec.expect(
      'a replay with empty outcome measures is accepted and says replay',
      replay.ok && replay.record.mode,
      'replay',
    );
    const holdout = baseRun({
      result: 'res-verify-hold',
      split: 'holdout',
      samples: { accuracy: rates(36, 40), cost: costs(150, 40), completion: rates(28, 40) },
    });
    rec.expect('a holdout run citing a weft trace: holdout', verdictOf(evaluate(holdout, ctx)), 'holdout');
    const held = evaluate({ ...holdout, evidence: [{ source: 'held_out_report', ref: 'hor-verify' }] }, ctx);
    rec.expect(
      'a holdout run citing held-out reports binds the holdout digest',
      held.ok && held.record.caseset_digest,
      ctx.casesets[CASES].splits.find((s) => s.split === 'holdout').digest,
    );
    rec.expect('evaluate left the context unchanged (pure)', JSON.stringify(ctx), pristine);
    rec.expect('records.json unchanged', sha256(FIXTURE), before);
    rec.finish({ scratchRecord: path, recordDigest: recordDigest(r) });
  },

  // compare and track over the fixture results: verdicts, deltas with intervals, regression steps.
  async 'compare-track'(rec, state) {
    const { compare, track, validate } = await import('@weave/gauge');
    const before = sha256(FIXTURE);
    const ctx = fixtures().context;
    const pristine = JSON.stringify(ctx);
    const req = (candidate, extra = {}) => ({
      comparison: `cmp-verify-${candidate}`,
      experiment: null,
      baseline: 'res-base',
      candidate,
      ...extra,
    });
    // Expected verdicts are the ones experiment.test.ts pins for these fixture results.
    const expected = {
      'res-cand': 'candidate_better',
      'res-cheap': 'bar_missed',
      'res-worse': 'candidate_worse',
      'res-small': 'insufficient_evidence',
    };
    const comparisons = {};
    for (const [cand, verdict] of Object.entries(expected)) {
      const out = compare(req(cand), ctx);
      comparisons[cand] = out;
      rec.expect(`compare res-base -> ${cand}: ${verdict}`, out.ok ? out.record.verdict : out.reason, verdict);
    }
    const cmp = comparisons['res-cand'];
    if (cmp.ok) {
      const { path, back } = roundTrip(state, 'comparison.json', cmp.record);
      rec.save('comparison.record.json', back);
      rec.expect('comparison re-read from disk validates', verdictOf(validate(back, ctx)), 'ok');
      const val = (id, name) => ctx.results[id].measures.find((x) => x.measure === name).value;
      rec.expect(
        'every delta = candidate - baseline, inside its interval',
        back.deltas.map((d) => [
          d.measure,
          d.delta === val('res-cand', d.measure) - val('res-base', d.measure),
          d.interval[0] <= d.delta && d.delta <= d.interval[1],
        ]),
        back.deltas.map((d) => [d.measure, true, true]),
      );
      rec.expect('compare is deterministic', compare(req('res-cand'), ctx), cmp);
      rec.expect(
        'a tampered comparison verdict is rejected',
        verdictOf(validate({ ...back, verdict: 'candidate_worse' }, ctx)),
        'verdict',
      );
      rec.save('scratch-paths.json', { comparison: path });
    }
    rec.expect('compare across splits (holdout): binding', verdictOf(compare(req('res-hold'), ctx)), 'binding');
    rec.expect('compare a result with itself: binding', verdictOf(compare(req('res-base'), ctx)), 'binding');
    rec.expect('compare an unknown result: binding', verdictOf(compare(req('res-nowhere'), ctx)), 'binding');
    const t1 = track(['res-base', 'res-cand', 'res-worse'], ctx);
    rec.save('track.base-cand-worse.json', t1);
    rec.expect(
      'track res-base, res-cand, res-worse shows the regression at step 2',
      t1.ok && t1.steps.map((s) => [s.previous, s.next, s.verdict, s.regression]),
      [
        ['res-base', 'res-cand', 'candidate_better', false],
        ['res-cand', 'res-worse', 'candidate_worse', true],
      ],
    );
    const t2 = track(['res-cand', 'res-cheap', 'res-small'], ctx);
    rec.save('track.cand-cheap-small.json', t2);
    rec.expect(
      'track: bar_missed after meets_bar is a regression; insufficient_evidence is not a pass',
      t2.ok && t2.steps.map((s) => [s.verdict, s.regression]),
      [
        ['bar_missed', true],
        ['insufficient_evidence', false],
      ],
    );
    rec.expect(
      'track across modes (trial, replay): binding',
      verdictOf(track(['res-cand', 'res-replay'], ctx)),
      'binding',
    );
    rec.expect('track with a repeated id: binding', verdictOf(track(['res-base', 'res-base'], ctx)), 'binding');
    rec.expect('track of one result has no steps', track(['res-base'], ctx), { ok: true, steps: [] });
    rec.expect('compare/track left the context unchanged (pure)', JSON.stringify(ctx), pristine);
    rec.expect('records.json unchanged', sha256(FIXTURE), before);
    rec.finish();
  },

  // evaluateInfo: a governed gauge.criteria@2 report set, never a bar; refused by every judging producer.
  async 'info-only'(rec, state) {
    const { compare, evaluate, evaluateInfo, recordDigest, track, validate } = await import('@weave/gauge');
    const base = fixtures().context;
    const INFO = 'decision-sites.verify-report@1';
    const check = { evidence: 'check' };
    const info = {
      schema: 'gauge.criteria@2',
      criteria: INFO,
      workload: 'decision-sites',
      governed_by: { kind: 'policy', ref: 'eval-policy-3' },
      measures: [
        { measure: 'attempted', source: check, aggregate: 'sum', empty: 0 },
        { measure: 'coverage', source: check, aggregate: 'rate', empty: 0 },
        { measure: 'accuracy', source: check, aggregate: 'rate', empty: null },
      ],
    };
    const revision = {
      schema: 'gauge.revision@1',
      revision: INFO,
      record: 'criteria',
      digest: recordDigest(info),
      supersedes: null,
      issued_by: info.governed_by,
      justification: 'initial',
      evidence: [],
    };
    const ctx = {
      ...base,
      criteria: { ...base.criteria, [INFO]: info },
      revisions: { ...base.revisions, [INFO]: revision },
    };
    rec.save('criteria.json', { info, revision });
    rec.expect('the info-only criteria set validates', verdictOf(validate(info, ctx)), 'ok');
    rec.expect('its governed revision validates', verdictOf(validate(revision, ctx)), 'ok');
    const run = (samples, overrides = {}) => ({
      result: 'res-verify-info',
      subject: { kind: 'policy', ref: 'verify.policy' },
      workload: 'decision-sites',
      criteria: INFO,
      caseset: CASES,
      split: 'tune',
      mode: 'replay',
      evidence: [{ source: 'check', ref: 'decision-sites.score' }],
      samples: { attempted: [1, 1, 1, 1], coverage: [1, 0, 1, 1], accuracy: [1, 0, 1], ...samples },
      ...overrides,
    });
    const out = evaluateInfo(run({}), ctx);
    rec.expect('evaluateInfo accepts the run', verdictOf(out), 'ok');
    if (!out.ok) return rec.finish();
    const { path, back } = roundTrip(state, 'info-result.json', out.record);
    rec.save('info-result.record.json', back);
    rec.expect(
      'schema gauge.result@2, verdict info_only',
      [back.schema, back.verdict],
      ['gauge.result@2', 'info_only'],
    );
    rec.expect('values hand-computed: sum 4, coverage 3/4, accuracy 2/3; no interval key', back.measures, [
      { measure: 'attempted', value: 4, n: 4 },
      { measure: 'coverage', value: 0.75, n: 4 },
      { measure: 'accuracy', value: 2 / 3, n: 3 },
    ]);
    rec.expect('info result re-read from disk validates', verdictOf(validate(back, ctx)), 'ok');
    rec.expect(
      'an info result claiming meets_bar is rejected',
      verdictOf(validate({ ...back, verdict: 'meets_bar' }, ctx)),
      'verdict',
    );
    const empty = evaluateInfo(run({ attempted: [], coverage: [], accuracy: [] }), ctx);
    rec.expect(
      'empty population takes the declared empty value',
      empty.ok && empty.record.measures.map((m) => [m.measure, m.value, m.n]),
      [
        ['attempted', 0, 0],
        ['coverage', 0, 0],
        ['accuracy', null, 0],
      ],
    );
    rec.expect('a rate sample of 0.5: measure', verdictOf(evaluateInfo(run({ coverage: [1, 0.5] }), ctx)), 'measure');
    rec.expect(
      'evaluate (the gating producer) refuses an info-only set: info_only',
      verdictOf(evaluate(run({}), ctx)),
      'info_only',
    );
    const second = { ...back, result: 'res-verify-info-b', subject: { kind: 'policy', ref: 'verify.policy-b' } };
    const withInfo = { ...ctx, results: { ...ctx.results, [back.result]: back, [second.result]: second } };
    rec.expect(
      'compare refuses info-only results: info_only',
      verdictOf(
        compare(
          { comparison: 'cmp-verify-info', experiment: null, baseline: back.result, candidate: second.result },
          withInfo,
        ),
      ),
      'info_only',
    );
    rec.expect(
      'track refuses info-only results: info_only',
      verdictOf(track([back.result, second.result], withInfo)),
      'info_only',
    );
    rec.finish({ scratchRecord: path });
  },

  // The offline failure-attribution harness over its tune-only corpus. Runs under the harness's own flags.
  async 'failure-attribution'(rec, state) {
    const fx = join(LEAF, 'fixtures');
    const before = treeDigests(fx);
    const imp = (f) => import(pathToFileURL(join(LEAF, f)).href);
    const h = await imp('label-harness.ts');
    const { readSealedInputs } = await imp('reader.ts');

    // Second view of the byte pins: hash every manifest entry ourselves, and the manifest against reader.ts's anchor.
    const manifestPath = join(fx, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const anchor = readFileSync(join(LEAF, 'reader.ts'), 'utf8').match(/'(sha256:[0-9a-f]{64})'/)?.[1];
    rec.expect('manifest stored-byte digest equals the reader.ts anchor', sha256(manifestPath), anchor);
    rec.expect(
      'every manifest entry pin equals sha256 of its stored bytes',
      manifest.entries.filter((e) => sha256(join(ROOT, e.path)) !== e.storedByteDigest).map((e) => e.path),
      [],
    );
    rec.expect(
      'manifest roles are tune only (no sealed-label, holdout or snapshot entry)',
      [...new Set(manifest.entries.map((e) => e.role))],
      ['tune'],
    );

    const corpus = h.loadTuneCorpus();
    rec.expect(
      'tune corpus loads 28 cases, labels and facts',
      [corpus.cases.length, corpus.labels.length, corpus.facts.length],
      [28, 28, 28],
    );
    rec.expect(
      'labels declare no independent review',
      corpus.review_status,
      'implementer-authored-no-independent-review',
    );
    rec.expect('every case is split tune', [...new Set(corpus.cases.map((c) => c.split))], ['tune']);
    const label = (id) => corpus.labels.find((l) => l.case === id);
    const outcomes = corpus.facts.map((f) => ({
      case: f.case,
      ...h.assess(f, label(f.case), h.expectedOfflineControl(label(f.case))),
    }));
    rec.save('offline-controls.json', outcomes);
    rec.expect('offline positive controls: 28/28 pass', h.summarize(outcomes), {
      total: 28,
      passed: 28,
      failed: 0,
      failures: {},
    });
    const abstain = { category: 'unattributed', basis: 'none', signal: null, confidence: null, evidence: [] };
    const abst = h.summarize(corpus.facts.map((f) => h.assess(f, label(f.case), abstain)));
    rec.save('always-unattributed.json', abst);
    rec.expect(
      'always-unattributed answer fails every attributed case (11 pass, 17 fail)',
      [abst.passed, abst.failed],
      [11, 17],
    );
    const judged = corpus.labels.filter((l) => l.judgment !== null);
    const jOut = judged.map((l) => ({
      case: l.case,
      ...h.assess(
        corpus.facts.find((f) => f.case === l.case),
        l,
        h.expectedJudgmentControl(l),
      ),
    }));
    rec.save('judgment-controls.json', jOut);
    rec.expect(
      `judgment controls pass for every label with a judgment (${judged.length})`,
      jOut.filter((o) => !o.ok),
      [],
    );
    const c05 = corpus.facts.find((f) => f.case === 'c05');
    const good = h.expectedOfflineControl(label('c05'));
    const wrongCite = { ...good, evidence: [{ source: 'check', ref: 'invented' }] };
    rec.expect(
      'wrong citation passes Gauge shape but fails the oracle',
      [verdictOf(h.shapeVerdict(c05, wrongCite)), h.assess(c05, label('c05'), wrongCite).code],
      ['ok', 'citation'],
    );
    rec.expect(
      'wrong category is refused',
      h.assess(c05, label('c05'), { ...good, category: 'capability_gap', signal: 'no_contract_matched' }).code,
      'category',
    );
    rec.expect('a missing answer is a failure, not a skip', h.assess(c05, label('c05'), undefined), {
      ok: false,
      code: 'missing',
    });

    const revisions = {
      classifier_revision: `sha256:${'a'.repeat(64)}`,
      rule_revision: `sha256:${'b'.repeat(64)}`,
      prompt_revision: null,
      model_revision: null,
    };
    const projected = corpus.facts.map((f) => h.projectInput(f, revisions));
    rec.save(
      'projected-input.c05.json',
      projected.find((p) => p.case === 'c05'),
    );
    rec.expect(
      'projected input keys are the closed selection',
      [...new Set(projected.map((p) => Object.keys(p).sort().join(',')))],
      ['bundle,case,judgment_request,result,revisions,split'],
    );
    const text = JSON.stringify(projected);
    rec.expect(
      'no label rationale, author or citation metadata leaks into projected input',
      corpus.labels
        .filter(
          (l) => text.includes(l.rationale) || text.includes('acceptable_citations') || text.includes('"rationale"'),
        )
        .map((l) => l.case),
      [],
    );
    let sealed;
    try {
      readSealedInputs({
        sealedLabelPath: '/nonexistent',
        sealedLabelDigest: `sha256:${'c'.repeat(64)}`,
        holdoutSetDigest: `sha256:${'d'.repeat(64)}`,
      });
      sealed = 'opened';
    } catch (e) {
      sealed = String(e.message);
    }
    rec.expect(
      'the sealed holdout path is closed: readSealedInputs refuses with missing freeze',
      /missing freeze/.test(sealed),
      true,
    );
    rec.expect('fixtures byte-identical after the drive', treeDigests(fx), before);
    rec.finish({ sealedRefusal: sealed, fixtureFiles: Object.keys(before).length, judgmentControls: judged.length });
  },
};

async function drive() {
  const run = runId();
  const feature = rest.find((a) => FEATURES.includes(a));
  if (!feature) die(`drive needs a feature: ${FEATURES.join(' | ')}`);
  const state = loadState(run);
  if (feature === 'failure-attribution' && !HARNESS_FLAGS.every((f) => process.execArgv.includes(f))) {
    // Re-run under the exact flags the package script uses, so the harness sees the same runtime.
    const child = spawnSync(process.execPath, [...HARNESS_FLAGS, SELF, 'drive', feature, '--run', run], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    process.exit(child.status ?? 1);
  }
  await drives[feature](makeRecorder(run, feature), state);
}

// ---------- test / checks ----------
function runLogged(file, label, command, args) {
  const r = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(file, `$ ${label}\n${r.stdout}${r.stderr}exit=${r.status}\n`);
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${label} (exit ${r.status}) -> ${relative(ROOT, file)}`);
  return r.status;
}
function packageTest() {
  const run = runId();
  loadState(run);
  const results = [];
  for (const script of ['test:gauge-contract', 'test:failure-attribution']) {
    const file = join(evidenceDir(run), `${script.replace(':', '-')}.log`);
    const exit = runLogged(file, `npm run ${script}`, 'npm', ['run', script]);
    const lines = readFileSync(file, 'utf8').split('\n');
    // TAP (`# fail 0`, Node 22 when piped) or spec (`ℹ fail 0`, Node >= 23) summary lines.
    const summary = lines.filter((l) => /^(#|ℹ) (tests|pass|fail|cancelled|skipped) /.test(l));
    const failing = [...new Set(lines.filter((l) => /^(✖ |not ok )/.test(l) && !/failing tests/.test(l)))];
    console.log(summary.join('\n'));
    if (failing.length) console.log(`failing:\n  ${failing.join('\n  ')}`);
    results.push({ command: `npm run ${script}`, exit, summary, failing });
  }
  writeFileSync(join(evidenceDir(run), 'package-test.json'), json({ node: process.version, results }));
  process.exitCode = results.every((r) => r.exit === 0) ? 0 : 1;
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
    exit: runLogged(join(dir, `${s}.log`), `node checks/${s}`, 'node', [`checks/${s}`]),
  }));
  const tests = readdirSync(join(ROOT, 'checks/test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort();
  results.push({
    script: `checks/test/{${tests.join(',')}}`,
    exit: runLogged(join(dir, 'checks-test.log'), 'node --test checks/test/*.test.mjs', 'node', [
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
  // Only ever delete the run's own directory under $TMPDIR/gauge-verify/.
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

const commands = { launch, doctor, drive, test: packageTest, checks, cleanup };
if (!commands[cmd]) die(`Usage: gauge-verify.mjs <${Object.keys(commands).join('|')}> [--run ID] [feature]`);
await commands[cmd]();
