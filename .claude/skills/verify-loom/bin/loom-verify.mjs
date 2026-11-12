#!/usr/bin/env node
// verify-loom helper. Verification scaffolding, not product code.
//
// Drives Weave Loom (packages/weave, @weave/weave) through its public Runtime
// API and its offline entry points, and writes per-check evidence under
// .local/verify-loom/<RUN>/. Offline only: scripted decision layers, the
// AgentFabric host over in-memory sources, no provider, no credential.
//
//   H=.claude/skills/verify-loom/bin/loom-verify.mjs
//   $H launch [--run ID]      build packages/weave (+ refs), create scratch + evidence dirs
//   $H doctor                 read-only: is this checkout/build worth driving?
//   $H drive <feature>        observe-dispatch | policy-refusal | replay-recover | crystallize | task-acceptance-offline
//   $H test                   the packages/weave slice of `npm test`, transcript into evidence
//   $H checks                 every checks/*.mjs plus node --test checks/test/*.test.mjs
//   $H cleanup                remove scratch only; evidence survives
//
// The run id comes from --run ID or LOOM_VERIFY_RUN. Exit: 0 pass, 1 a check failed, 2 usage/missing run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const EVIDENCE_ROOT = join(ROOT, '.local', 'verify-loom');
const SCRATCH_ROOT = join(tmpdir(), 'loom-verify');
const NET_GUARD = join(HERE, 'net-guard.mjs');
const FEATURES = ['observe-dispatch', 'policy-refusal', 'replay-recover', 'crystallize', 'task-acceptance-offline'];

const args = process.argv.slice(2);
const command = args[0];
const runFlag = args.indexOf('--run');
const runArg = runFlag >= 0 ? args[runFlag + 1] : undefined;

function usage(message) {
  if (message) console.error(message);
  console.error(
    `usage: loom-verify.mjs launch [--run ID] | doctor | drive <${FEATURES.join('|')}> | test | checks | cleanup`,
  );
  process.exit(2);
}

function sh(cmd, argv, options = {}) {
  const started = Date.now();
  const out = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  return {
    command: [cmd, ...argv].join(' '),
    status: out.status,
    signal: out.signal,
    stdout: out.stdout ?? '',
    stderr: out.stderr ?? '',
    ms: Date.now() - started,
  };
}

function git(...argv) {
  return sh('git', argv).stdout.trim();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runId() {
  const id = runArg ?? process.env.LOOM_VERIFY_RUN;
  if (!id) usage('no run: pass --run ID or export LOOM_VERIFY_RUN (printed by launch)');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) usage(`bad run id ${id}`);
  return id;
}

function dirs(id) {
  return { evidence: join(EVIDENCE_ROOT, id), scratch: join(SCRATCH_ROOT, id) };
}

function requireRun() {
  const id = runId();
  const d = dirs(id);
  if (!existsSync(join(d.scratch, 'state.json')) || !existsSync(d.evidence)) {
    console.error(`run ${id} not launched (missing ${d.scratch}/state.json or ${d.evidence}); run launch first`);
    process.exit(2);
  }
  return { id, ...d, state: JSON.parse(readFileSync(join(d.scratch, 'state.json'), 'utf8')) };
}

function headInfo() {
  return { sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0, node: process.version };
}

// ---------------------------------------------------------------------------
// launch / doctor / cleanup
// ---------------------------------------------------------------------------

function launch() {
  const id = runArg ?? `loom-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) usage(`bad run id ${id}`);
  console.log(`RUN=${id}`);
  const d = dirs(id);
  if (existsSync(d.scratch) || existsSync(d.evidence)) {
    console.error(`run ${id} already exists (${d.scratch} or ${d.evidence}); pick another id`);
    process.exit(2);
  }
  mkdirSync(d.scratch, { recursive: true });
  mkdirSync(d.evidence, { recursive: true });
  const info = { run: id, ...headInfo(), launched_at: new Date().toISOString(), root: ROOT };
  writeJson(join(d.evidence, 'run.json'), info);
  writeJson(join(d.scratch, 'state.json'), info);
  // packages/weave references agentsop, agentfabric, gateway, weft; tsc -b builds exactly that tree.
  const build = sh('npx', ['tsc', '-b', 'packages/weave/tsconfig.json']);
  writeFileSync(
    join(d.evidence, 'build.log'),
    `$ ${build.command}\nexit ${build.status}\n${build.stdout}${build.stderr}`,
  );
  if (build.status !== 0) {
    console.error(`build failed (exit ${build.status}); see ${relative(ROOT, d.evidence)}/build.log`);
    process.exit(1);
  }
  console.log(`evidence ${relative(ROOT, d.evidence)}/  scratch ${d.scratch}/`);
  console.log('READY: packages/weave built; run doctor next.');
}

function newestMtime(dir, filter) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !filter(entry.name)) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

async function doctor() {
  const run = requireRun();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  add('run state and evidence dir exist', true, { scratch: run.scratch, evidence: run.evidence });
  const [maj, min] = process.versions.node.split('.').map(Number);
  add('node satisfies engines >=22.18', maj > 22 || (maj === 22 && min >= 18), {
    node: process.version,
    is_v22: maj === 22,
    note: 'the monorepo baseline requires recording Node 22; record the version actually used',
  });
  const head = git('rev-parse', 'HEAD');
  add('HEAD unchanged since launch', head === run.state.sha, { launched: run.state.sha, now: head });
  const entry = join(ROOT, 'packages/weave/dist/src/index.js');
  add('packages/weave/dist/src/index.js exists', existsSync(entry), entry);
  for (const pkg of ['agentsop', 'agentfabric', 'gateway', 'weft', 'weave']) {
    const src = Math.max(
      newestMtime(join(ROOT, 'packages', pkg, 'src'), (n) => n.endsWith('.ts')),
      newestMtime(join(ROOT, 'packages', pkg, 'test'), (n) => n.endsWith('.ts')),
    );
    const dist = newestMtime(join(ROOT, 'packages', pkg, 'dist'), (n) => n.endsWith('.js'));
    add(`packages/${pkg} dist not older than src/test`, dist >= src, { src_mtime: src, dist_mtime: dist });
  }
  const req = createRequire(join(ROOT, 'package.json'));
  let resolved = null;
  try {
    resolved = req.resolve('@weave/weave');
  } catch (error) {
    resolved = String(error);
  }
  add('@weave/weave resolves into this checkout', String(resolved).startsWith(join(ROOT, 'packages/weave/')), resolved);
  try {
    const weave = await import(pathToFileURL(entry).href);
    const names = [
      'Runtime',
      'ScriptedDecisionLayer',
      'replay',
      'recover',
      'FileJournal',
      'MemoryJournal',
      'traceCompletenessViolations',
      'stableStringify',
    ];
    const missing = names.filter((n) => typeof weave[n] !== 'function');
    add('public Runtime API exports are functions', missing.length === 0, { checked: names, missing });
  } catch (error) {
    add('public Runtime API exports are functions', false, String(error));
  }
  add('examples/crystallize.ts present', existsSync(join(ROOT, 'examples/crystallize.ts')), 'examples/crystallize.ts');
  add(
    'task-acceptance frozen set present',
    existsSync(join(ROOT, 'benchmarks/task-acceptance/frozen-set.json')),
    'benchmarks/task-acceptance/frozen-set.json',
  );
  const ok = checks.every((c) => c.ok);
  const verdict = { run: run.id, ok, checks };
  writeJson(join(run.evidence, `doctor-${Date.now()}.json`), verdict);
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(ok ? 0 : 1);
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath ?? e.path, e.name)))
    .sort();
}

function cleanup() {
  const id = runId();
  const d = dirs(id);
  const target = resolve(d.scratch);
  if (dirname(target) !== resolve(SCRATCH_ROOT)) {
    console.error(`refusing to remove ${target}: not a run dir under ${SCRATCH_ROOT}`);
    process.exit(2);
  }
  const existed = existsSync(target);
  rmSync(target, { recursive: true, force: true });
  const evidenceFiles = listFiles(d.evidence);
  const report = {
    run: id,
    removed: existed ? [target] : [],
    scratch_gone: !existsSync(target),
    processes_killed: [],
    note: 'verify-loom starts no long-lived process; every drive is a child that has exited',
    evidence_dir: d.evidence,
    evidence_files: evidenceFiles,
  };
  if (existsSync(d.evidence)) writeJson(join(d.evidence, 'cleanup.json'), report);
  console.log(JSON.stringify({ ...report, evidence_files: `${evidenceFiles.length} files` }, null, 2));
  const ok = report.scratch_gone && existsSync(d.evidence) && evidenceFiles.length > 0;
  console.log(ok ? `CLEAN: scratch removed; evidence kept at ${relative(ROOT, d.evidence)}/` : 'CLEANUP FAILED');
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// drive
// ---------------------------------------------------------------------------

const CONTENT = {
  alpha: 'alpha one\nalpha two\nalpha three',
  beta: 'beta one\nbeta two\nbeta three\nbeta four\nbeta five',
  gamma: 'gamma one',
};

/** Independent of the producer: AgentFabric's inspect digest is sha256(content) hex, first 16 chars. */
function contentDigest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function loadApi() {
  const weave = await import('@weave/weave');
  const agentsop = await import('@weave/agentsop');
  const agentfabric = await import('@weave/agentfabric');
  return {
    ...weave,
    createGrantAuthority: agentsop.createGrantAuthority,
    AgentFabricHost: agentfabric.AgentFabricHost,
  };
}

const refusingDecision = () => ({
  implementation: 'verify-loom-refusing@1',
  weigh() {
    throw new Error('decision layer must not be invoked');
  },
});

/** One isolated world: enforcing AgentFabric host, grant authority, scripted weighing, optional FileJournal. */
function world(api, { journalPath, sources = ['alpha', 'beta'], readable = ['alpha', 'beta'], budget } = {}) {
  const authority = api.createGrantAuthority();
  const host = new api.AgentFabricHost({ authority });
  const journal = journalPath ? new api.FileJournal(journalPath) : new api.MemoryJournal();
  const handle = {};
  for (const name of ['alpha', 'beta', 'gamma']) handle[name] = host.registerSource(`mem:${name}`, CONTENT[name]);
  const runtime = new api.Runtime({
    host,
    decisionLayer: new api.ScriptedDecisionLayer(),
    grantAuthority: authority,
    journal,
  });
  for (const name of ['alpha', 'beta', 'gamma']) {
    runtime.observe({
      observation_id: `verify-loom:source.registered:${name}`,
      source: { kind: 'test', id: 'verify-loom' },
      caused_by: null,
      payload_type: 'source.registered',
      payload_version: 1,
      payload: { resource: handle[name], revision: 1, content: CONTENT[name] },
    });
  }
  const goal = {
    goal_id: 'g-loom-verify',
    purpose: 'Produce a checked report over the listed sources',
    sources: sources.map((n) => handle[n]),
    authority: { read: readable.map((n) => handle[n]) },
    budget: budget ?? { actions: 6, judgments: 6 },
    success_evidence: 'a Report artifact covering every goal source at its current revision',
  };
  const open = () =>
    runtime.operator.submit({
      observation_id: 'operator:goal.opened:g-loom-verify',
      caused_by: null,
      payload_type: 'goal.opened',
      payload_version: 1,
      payload: goal,
    });
  return { authority, host, journal, runtime, handle, goal, open };
}

/** Release every held host invocation and wait for its result, until nothing is open. */
async function settleAll(w, maxRounds = 10) {
  for (let round = 0; round < maxRounds; round += 1) {
    const open = [...w.host.openActionIds()].sort();
    if (open.length === 0) return round;
    for (const id of open) {
      w.host.release(id);
      await w.runtime.settle(id);
    }
  }
  throw new Error('host invocations still open after settle rounds');
}

const started = (trace) =>
  trace.observations.filter((o) => o.payload_type === 'action.started' && o.validation.status === 'accepted');

function makeChecks() {
  const list = [];
  const check = (name, ok, expected, actual) => {
    list.push({ name, ok: Boolean(ok), expected, actual });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  };
  return { list, check };
}

async function driveObserveDispatch(ctx) {
  const api = await loadApi();
  const { check } = ctx;
  const journalPath = join(ctx.scratch, 'observe-dispatch.journal.jsonl');
  rmSync(journalPath, { force: true }); // FileJournal appends; each drive starts from an empty journal
  const w = world(api, { journalPath });
  const before = api.stableStringify(w.runtime.state().sources);
  const revBefore = w.runtime.state().state_revision;
  const bad = w.runtime.observe({
    observation_id: 'verify-loom:source.changed:malformed',
    source: { kind: 'test', id: 'verify-loom' },
    caused_by: null,
    payload_type: 'source.changed',
    payload_version: 1,
    payload: { resource: w.handle.alpha, content: 'changed without a revision' },
  });
  check(
    'observe-reject: malformed source.changed is rejected',
    bad.validation.status === 'rejected',
    'rejected',
    bad.validation,
  );
  check(
    'observe-reject: rejected observation is retained in the trace',
    w.runtime.trace().observations.some((o) => o.seq === bad.seq && o.validation.status === 'rejected'),
    true,
    bad.seq,
  );
  check(
    'observe-reject: state did not transition',
    api.stableStringify(w.runtime.state().sources) === before && w.runtime.state().state_revision === revBefore,
    { state_revision: revBefore },
    { state_revision: w.runtime.state().state_revision },
  );

  w.open();
  const c1 = w.runtime.trace().cycles[0];
  check(
    'cycle: goal is active after goal.opened',
    w.runtime.state().goal?.status === 'active',
    'active',
    w.runtime.state().goal?.status,
  );
  check(
    'cycle: procedure is inspect_and_report@1',
    c1?.procedure === 'inspect_and_report@1',
    'inspect_and_report@1',
    c1?.procedure,
  );
  const inspects = c1.candidates.filter((c) => c.operation === 'source.inspect');
  check(
    'cycle: one allowed source.inspect candidate per goal source, no report.assemble yet',
    inspects.length === 2 &&
      inspects.every((c) => c.eligibility.status === 'allowed') &&
      !c1.candidates.some((c) => c.operation === 'report.assemble'),
    2,
    c1.candidates.map((c) => [c.operation, c.eligibility.status]),
  );
  const weights = w.runtime.trace().observations.find((o) => o.seq === c1.weights_ref);
  check(
    'weights: frontier weights are a judgment observation from scripted@1',
    weights?.payload_type === 'weights.recorded' &&
      weights.source.kind === 'judgment' &&
      weights.validation.status === 'accepted' &&
      weights.payload.implementation === 'scripted@1',
    { payload_type: 'weights.recorded', source: 'judgment', implementation: 'scripted@1' },
    {
      payload_type: weights?.payload_type,
      source: weights?.source.kind,
      implementation: weights?.payload?.implementation,
    },
  );
  const firstStarts = started(w.runtime.trace());
  check(
    'dispatch: both inspections start in cycle 1 under a grant, concurrently',
    c1.outcome.status === 'dispatched' &&
      firstStarts.length === 2 &&
      firstStarts.every((o) => o.payload.grant && o.payload.grant.operation === 'source.inspect') &&
      w.host.openActionIds().length === 2,
    { outcome: 'dispatched', started: 2, open_on_host: 2 },
    {
      outcome: c1.outcome,
      started: firstStarts.length,
      open_on_host: w.host.openActionIds().length,
      grants: firstStarts.map((o) => o.payload.grant?.operation),
    },
  );
  await settleAll(w);
  const state = w.runtime.state();
  const trace = w.runtime.trace();
  check('complete: goal status is complete', state.goal?.status === 'complete', 'complete', state.goal?.status);
  const ops = w.host.invocations.map((i) => i.operation);
  check(
    'complete: host ran inspect, inspect, then report.assemble',
    JSON.stringify(ops) === JSON.stringify(['source.inspect', 'source.inspect', 'report.assemble']),
    ['source.inspect', 'source.inspect', 'report.assemble'],
    ops,
  );
  const expectedEntries = [
    { source: w.handle.alpha, revision: 1, line_count: 3, digest: contentDigest(CONTENT.alpha) },
    { source: w.handle.beta, revision: 1, line_count: 5, digest: contentDigest(CONTENT.beta) },
  ];
  check(
    'report: entries carry revision, line count and an independently recomputed digest',
    JSON.stringify(state.report?.report.entries) === JSON.stringify(expectedEntries),
    expectedEntries,
    state.report?.report.entries,
  );
  check(
    'report: carries evidence (observation seqs)',
    Array.isArray(state.report?.evidence) && state.report.evidence.length > 0,
    'non-empty evidence',
    state.report?.evidence,
  );
  const violations = api.traceCompletenessViolations(trace);
  check(
    'trace: every action.started is explained by exactly one cycle record',
    violations.length === 0,
    [],
    violations,
  );

  const disk = readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const accepted = trace.observations.filter((o) => o.validation.status === 'accepted');
  check(
    'journal: FileJournal on disk equals the accepted observations, and holds no rejected one',
    api.stableStringify(disk) === api.stableStringify(accepted) &&
      !disk.some((o) => o.observation_id === bad.observation_id),
    { lines: accepted.length },
    { lines: disk.length },
  );
  // Informational, not a check: the journal holds only accepted observations, so after a rejected
  // input its seqs have a gap and replay over the journal diverges; replay is fed the trace instead.
  const journalReplay = api.replay(disk, {
    host: new api.AgentFabricHost({ authority: api.createGrantAuthority() }),
    decisionLayer: refusingDecision(),
  });
  ctx.extra.info_replay_over_journal_after_a_rejected_input = {
    ok: journalReplay.ok,
    failure: journalReplay.failure ?? null,
  };
  writeJson(join(ctx.out, 'trace.json'), trace);
  writeJson(join(ctx.out, 'state.json'), state);
  writeFileSync(join(ctx.out, 'journal.jsonl'), readFileSync(journalPath, 'utf8'));
  writeJson(join(ctx.out, 'host-invocations.json'), w.host.invocations);
}

async function drivePolicyRefusal(ctx) {
  const api = await loadApi();
  const { check } = ctx;
  const w = world(api, { sources: ['alpha', 'beta', 'gamma'], readable: ['alpha', 'beta'] });
  w.open();
  const c1 = w.runtime.trace().cycles[0];
  const gammaCand = c1.candidates.find((c) => c.operation === 'source.inspect' && c.inputs.source === w.handle.gamma);
  check(
    'prohibited: the unauthorised source forms a candidate marked prohibited with no weight',
    gammaCand?.eligibility.status === 'prohibited' && gammaCand.weight === null,
    { eligibility: 'prohibited', weight: null },
    { eligibility: gammaCand?.eligibility, weight: gammaCand?.weight },
  );
  const weights = w.runtime.trace().observations.find((o) => o.seq === c1.weights_ref);
  const weighed = (weights?.payload.weights ?? []).map((x) => x.candidate_id);
  check(
    'prohibited: it is excluded before weighing',
    gammaCand && !weighed.includes(gammaCand.candidate_id) && weighed.length === 2,
    'only the two allowed candidates weighed',
    weighed,
  );
  await settleAll(w);
  const trace = w.runtime.trace();
  const gammaStarts = started(trace).filter((o) => o.payload.inputs?.source === w.handle.gamma);
  check('prohibited: no action.started ever targets it', gammaStarts.length === 0, 0, gammaStarts.length);
  const last = trace.cycles.at(-1);
  check(
    'blocked: the last cycle blocks honestly, naming the missing authority',
    last?.outcome.status === 'blocked' &&
      last.outcome.reason === `no read authority for ${w.handle.gamma}` &&
      last.weights_ref === null,
    { status: 'blocked', reason: `no read authority for ${w.handle.gamma}`, weights_ref: null },
    { ...last?.outcome, weights_ref: last?.weights_ref },
  );
  check(
    'blocked: goal stays active with no report and no report.assemble',
    w.runtime.state().goal?.status === 'active' &&
      !w.runtime.state().report &&
      !w.host.invocations.some((i) => i.operation === 'report.assemble'),
    { goal: 'active', report: null },
    {
      goal: w.runtime.state().goal?.status,
      report: w.runtime.state().report ?? null,
      ops: w.host.invocations.map((i) => i.operation),
    },
  );
  const alphaStart = started(trace).find((o) => o.payload.inputs?.source === w.handle.alpha);
  const invBefore = w.host.invocations.length;
  const rejBefore = w.host.rejections.length;
  const noGrant = w.host.invoke(null, 'source.inspect', { source: w.handle.gamma });
  const wrongGrant = w.host.invoke(alphaStart.payload.grant, 'source.inspect', { source: w.handle.gamma });
  check(
    'host: an ungranted or mis-granted invocation is rejected DENIED and never runs',
    noGrant.kind === 'rejected' &&
      noGrant.code === 'DENIED' &&
      wrongGrant.kind === 'rejected' &&
      wrongGrant.code === 'DENIED' &&
      w.host.invocations.length === invBefore &&
      w.host.rejections.length === rejBefore + 2,
    { no_grant: 'DENIED', alpha_grant_on_gamma: 'DENIED', new_invocations: 0, new_rejections: 2 },
    {
      no_grant: noGrant,
      alpha_grant_on_gamma: wrongGrant,
      new_invocations: w.host.invocations.length - invBefore,
      new_rejections: w.host.rejections.length - rejBefore,
    },
  );
  check(
    'trace: complete (no unexplained action.started)',
    api.traceCompletenessViolations(trace).length === 0,
    [],
    api.traceCompletenessViolations(trace),
  );

  const nb = world(api, { budget: { actions: 6, judgments: 0 } });
  nb.open();
  const nbTrace = nb.runtime.trace();
  check(
    'budget: no judgment budget means no weighing and no dispatch',
    !nbTrace.observations.some((o) => o.payload_type === 'weights.recorded') &&
      started(nbTrace).length === 0 &&
      nb.host.invocations.length === 0,
    { weights_recorded: 0, started: 0, host_invocations: 0 },
    {
      weights_recorded: nbTrace.observations.filter((o) => o.payload_type === 'weights.recorded').length,
      started: started(nbTrace).length,
      host_invocations: nb.host.invocations.length,
      last_outcome: nbTrace.cycles.at(-1)?.outcome ?? null,
    },
  );
  writeJson(join(ctx.out, 'trace.json'), trace);
  writeJson(join(ctx.out, 'host-rejections.json'), w.host.rejections);
  writeJson(join(ctx.out, 'no-judgment-budget.trace.json'), nbTrace);
}

async function driveReplayRecover(ctx) {
  const api = await loadApi();
  const { check } = ctx;
  const journalPath = join(ctx.scratch, 'replay-recover.journal.jsonl');
  rmSync(journalPath, { force: true }); // FileJournal appends; each drive starts from an empty journal
  const w = world(api, { journalPath });
  w.open();
  await settleAll(w);
  const live = w.runtime.trace();
  check(
    'setup: live run completed',
    w.runtime.state().goal?.status === 'complete',
    'complete',
    w.runtime.state().goal?.status,
  );
  const tracePath = join(ctx.scratch, 'recorded-trace.json');
  writeFileSync(tracePath, JSON.stringify(live.observations));
  const recorded = JSON.parse(readFileSync(tracePath, 'utf8'));
  const journal = readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const freshHost = () => new api.AgentFabricHost({ authority: api.createGrantAuthority() });
  const h1 = freshHost();
  const r = api.replay(recorded, { host: h1, decisionLayer: refusingDecision() });
  check(
    'replay: the recorded log (read back from disk) reproduces without invoking host or decision layer',
    r.ok &&
      r.state.goal?.status === 'complete' &&
      api.stableStringify(r.trace.observations) === api.stableStringify(live.observations) &&
      api.stableStringify(r.trace.cycles) === api.stableStringify(live.cycles) &&
      h1.invocations.length === 0 &&
      h1.rejections.length === 0,
    { ok: true, goal: 'complete', identical: true, host_invocations: 0 },
    { ok: r.ok, goal: r.state?.goal?.status, failure: r.failure ?? null, host_invocations: h1.invocations.length },
  );
  const h2 = freshHost();
  const rj = api.replay(journal, { host: h2, decisionLayer: refusingDecision() });
  check(
    'replay: the FileJournal (no rejected inputs in this run) replays the same way',
    rj.ok && rj.state.goal?.status === 'complete' && h2.invocations.length === 0,
    { ok: true, goal: 'complete' },
    { ok: rj.ok, failure: rj.failure ?? null },
  );
  const results = recorded.filter((o) => o.payload_type === 'action.result');
  const lastResult = results.at(-1);
  const h3 = freshHost();
  const truncated = api.replay(
    recorded.filter((o) => o.seq !== lastResult.seq),
    { host: h3, decisionLayer: refusingDecision() },
  );
  const missing = lastResult.payload.action_id;
  check(
    'replay fails closed: a missing recorded result is a failure, not a reason to execute',
    !truncated.ok &&
      truncated.failure.action_id === missing &&
      truncated.failure.reason === `missing recorded action.result for ${missing}` &&
      h3.invocations.length === 0 &&
      truncated.state.goal?.status !== 'complete',
    { ok: false, reason: `missing recorded action.result for ${missing}`, host_invocations: 0 },
    {
      ok: truncated.ok,
      failure: truncated.failure ?? null,
      host_invocations: h3.invocations.length,
      goal: truncated.state?.goal?.status,
    },
  );
  const tampered = structuredClone(recorded);
  const w1 = tampered.find((o) => o.payload_type === 'weights.recorded');
  w1.payload.weights[0].weight = 0.1;
  const h4 = freshHost();
  const div = api.replay(tampered, { host: h4, decisionLayer: refusingDecision() });
  // Replay does not re-ask the decision layer: it takes the recorded judgment as an observation and
  // re-derives the runtime's own decisions from it, so the divergence surfaces at the first runtime
  // observation that depends on the tampered weights (the first action.started after them).
  const dependent = recorded.find((o) => o.seq > w1.seq && o.source.kind === 'runtime');
  check(
    'replay fails closed: a tampered judgment diverges at the first runtime decision that depends on it',
    !div.ok &&
      div.failure.at_seq === dependent.seq &&
      div.failure.reason === `replay diverged from the record at seq ${dependent.seq}` &&
      h4.invocations.length === 0,
    {
      ok: false,
      tampered_seq: w1.seq,
      at_seq: dependent.seq,
      reason: `replay diverged from the record at seq ${dependent.seq}`,
    },
    { ok: div.ok, failure: div.failure ?? null },
  );
  const h5 = freshHost();
  const rec = api.recover(journal, { host: h5, decisionLayer: refusingDecision() });
  check(
    'recover: a runtime rebuilt from the FileJournal has the same goal and report, and executes nothing',
    rec.state().goal?.status === 'complete' &&
      api.stableStringify(rec.state().report) === api.stableStringify(w.runtime.state().report) &&
      h5.invocations.length === 0,
    { goal: 'complete', report_equal: true, host_invocations: 0 },
    {
      goal: rec.state().goal?.status,
      report_equal: api.stableStringify(rec.state().report) === api.stableStringify(w.runtime.state().report),
      host_invocations: h5.invocations.length,
    },
  );
  const reordered = [...journal];
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  let refused = null;
  try {
    api.recover(reordered, { host: freshHost(), decisionLayer: refusingDecision() });
  } catch (error) {
    refused = String(error.message ?? error);
  }
  check(
    'recover fails closed: an out-of-order journal is refused',
    refused !== null && /refusing to load it/.test(refused),
    '/refusing to load it/',
    refused,
  );
  writeJson(join(ctx.out, 'recorded-trace.json'), recorded);
  writeFileSync(join(ctx.out, 'journal.jsonl'), readFileSync(journalPath, 'utf8'));
  writeJson(join(ctx.out, 'replay-failures.json'), {
    truncated: truncated.failure,
    tampered: div.failure,
    reordered_recover: refused,
  });
}

function porcelain() {
  return git('status', '--porcelain');
}

/** Run a node entry point with the net-guard preload; return the run and every refused network attempt. */
function guardedNode(ctx, label, argv) {
  const netLog = join(ctx.scratch, `${label}.net.jsonl`);
  writeFileSync(netLog, '');
  const run = sh(process.execPath, ['--import', pathToFileURL(NET_GUARD).href, ...argv], {
    env: { ...process.env, LOOM_VERIFY_NET_LOG: netLog },
  });
  const attempts = readFileSync(netLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  writeFileSync(join(ctx.out, `${label}.stdout.txt`), run.stdout);
  writeFileSync(join(ctx.out, `${label}.stderr.txt`), run.stderr);
  writeJson(join(ctx.out, `${label}.net-attempts.json`), attempts);
  return { run, attempts };
}

function exampleBody(stdout) {
  const i = stdout.indexOf('procedure ');
  return i < 0 ? '' : stdout.slice(i);
}

async function driveCrystallize(ctx) {
  const { check } = ctx;
  const gitBefore = porcelain();
  // 1. Exactly what a user runs. The script runs the whole-repo `npm run build` first.
  const npmRun = sh('npm', ['run', 'example:crystallize']);
  writeFileSync(join(ctx.out, 'npm-run.stdout.txt'), npmRun.stdout);
  writeFileSync(join(ctx.out, 'npm-run.stderr.txt'), npmRun.stderr);
  writeJson(join(ctx.out, 'npm-run.json'), { command: npmRun.command, exit: npmRun.status, ms: npmRun.ms });
  check('npm run example:crystallize exits 0', npmRun.status === 0, 0, npmRun.status);
  // 2. The same entry point under the network observer (the npm script's second half, plus --import).
  const g = guardedNode(ctx, 'guarded', ['--experimental-strip-types', 'examples/crystallize.ts']);
  writeJson(join(ctx.out, 'guarded.json'), { command: g.run.command, exit: g.run.status, ms: g.run.ms });
  check('guarded run exits 0', g.run.status === 0, 0, g.run.status);
  check(
    'offline: no network attempt (fetch/connect/http/dns) from the example process',
    g.attempts.length === 0,
    [],
    g.attempts,
  );
  const body = exampleBody(npmRun.stdout);
  check(
    'deterministic: the npm run and the guarded run print the same report',
    body.length > 0 && body === exampleBody(g.run.stdout),
    'identical stdout from "procedure" on',
    body === exampleBody(g.run.stdout) ? 'identical' : 'differs (see npm-run.stdout.txt vs guarded.stdout.txt)',
  );
  const line = (key) => {
    const m = body.split('\n').filter((l) => l.startsWith(key));
    return m.map((l) => l.slice(key.length).trim());
  };
  const one = (key) => line(key)[0];
  check(
    'procedure is crystallize_and_report@1',
    one('procedure ') === 'crystallize_and_report@1',
    'crystallize_and_report@1',
    one('procedure '),
  );
  check(
    'search: a gap is recorded (no admitted capability fits)',
    one('gap.search ') === 'gap',
    'gap',
    one('gap.search '),
  );
  check(
    'search: reason names the absence',
    one('  reason ') === 'no admitted capability or composition produces the desired output',
    'no admitted capability or composition produces the desired output',
    one('  reason '),
  );
  check(
    'corpus: only visible case ids are printed; held-out ids stay with the lifecycle',
    one('corpus splits ') === 'visible vis-pair, vis-empty, vis-bad; held-out ids retained by the lifecycle',
    'visible vis-pair, vis-empty, vis-bad; held-out ids retained by the lifecycle',
    one('corpus splits '),
  );
  check(
    'red: demonstrated under an isolation report',
    /^demonstrated under isolation report [0-9a-f]{64}$/.test(one('red ') ?? ''),
    'demonstrated under isolation report <sha256>',
    one('red '),
  );
  check(
    'red: isolation probe blocked filesystem and child_process, no credentials, no fetch',
    one('  probe ') === 'filesystem blocked, child_process blocked, credentials absent, fetch undefined',
    'filesystem blocked, child_process blocked, credentials absent, fetch undefined',
    one('  probe '),
  );
  const impls = (one('implementations ') ?? '').split(', ').filter(Boolean);
  check('implementations: two variants generated', impls.length === 2, 2, impls);
  const greens = line('green ');
  check(
    'green: every implementation proven on visible and held-out cases',
    greens.length === impls.length &&
      greens.every(
        (g2) => /^visible (\d+) passed\/0 failed; held-out (\d+) passed\/0 failed$/.test(g2) && !/visible 0 /.test(g2),
      ),
    'visible n passed/0 failed; held-out m passed/0 failed, per implementation',
    greens,
  );
  const admission = one('admission ') ?? '';
  const am = /^admitted (\S+) by operator$/.exec(admission);
  check(
    'admission: one implementation admitted by the operator',
    am && impls.includes(am[1]),
    'admitted <one of implementations> by operator',
    admission,
  );
  check(
    'admission: bound to an evidence digest',
    /^[0-9a-f]{64}$/.test(one('  evidence ') ?? ''),
    '<sha256>',
    one('  evidence '),
  );
  const expectedFold = `fold|ref_1=${contentDigest(CONTENT.alpha)}|ref_2=${contentDigest(CONTENT.beta)}`;
  check(
    'fold: equals the canonical fold recomputed independently from the source text',
    one('fold ') === expectedFold,
    expectedFold,
    one('fold '),
  );
  check(
    'execution: a separate grant for report.fold@r1 with no permissions',
    one('  grant ') === 'report.fold@r1 permissions []',
    'report.fold@r1 permissions []',
    one('  grant '),
  );
  check(
    'execution: the admitted capability ran on the host',
    one('  host invocation ') === 'true',
    'true',
    one('  host invocation '),
  );
  check(
    'report: covers both sources at revision 1',
    one('report ') === 'ref_1 rev 1, ref_2 rev 1',
    'ref_1 rev 1, ref_2 rev 1',
    one('report '),
  );
  check('goal: complete', one('goal ') === 'complete', 'complete', one('goal '));
  check(
    'held-out text never reached an author view',
    one('held-out in views ') === 'false',
    'false',
    one('held-out in views '),
  );
  check('isolated execute runs were recorded', Number(one('execute runs ')) > 0, '> 0', one('execute runs '));
  check(
    'replay: reconstructs complete with the same fold and zero host invocations',
    one('replay ') === 'complete fold true host invocations 0',
    'complete fold true host invocations 0',
    one('replay '),
  );
  const gitAfter = porcelain();
  check(
    'side effects: git working tree unchanged (no tracked or unignored file written)',
    gitAfter === gitBefore,
    gitBefore || '(clean)',
    gitAfter || '(clean)',
  );
  ctx.extra.m3_milestone_satisfied = false;
  ctx.extra.m3_note =
    'examples/crystallize.ts predates docs/m3-fill-a-capability-gap.md and adds a procedure arm; a green run here does not satisfy M3.';
}

async function driveTaskAcceptance(ctx) {
  const { check } = ctx;
  const gitBefore = porcelain();
  const offline = guardedNode(ctx, 'offline', ['--experimental-strip-types', 'benchmarks/task-acceptance/offline.ts']);
  check('offline.ts exits 0', offline.run.status === 0, 0, offline.run.status);
  check('offline.ts makes no network attempt', offline.attempts.length === 0, [], offline.attempts);
  let report = null;
  try {
    report = JSON.parse(offline.run.stdout);
  } catch (error) {
    report = { parse_error: String(error) };
  }
  writeJson(join(ctx.out, 'report.json'), report);
  check(
    'report: scoring rule and contract are named',
    report.scoring_rule === 'task-acceptance.score@1' && report.contract === 'acceptance.line@2',
    { scoring_rule: 'task-acceptance.score@1', contract: 'acceptance.line@2' },
    { scoring_rule: report.scoring_rule, contract: report.contract },
  );
  check(
    'report: live comparison not run (offline)',
    report.live_comparison === 'not_run',
    'not_run',
    report.live_comparison,
  );
  check(
    'report: thresholds declared before the run, holdout not used for tuning',
    report.thresholds_source === 'declared_before_run' && report.holdout_used_for_tuning === false,
    { thresholds_source: 'declared_before_run', holdout_used_for_tuning: false },
    { thresholds_source: report.thresholds_source, holdout_used_for_tuning: report.holdout_used_for_tuning },
  );
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  const frozen = JSON.parse(readFileSync(join(ROOT, 'benchmarks/task-acceptance/frozen-set.json'), 'utf8'));
  const frozenTasks = Array.isArray(frozen) ? frozen : (frozen.tasks ?? []);
  check(
    'report: counts agree with the per-task rows and with the frozen set on disk',
    report.counts?.tasks === tasks.length &&
      tasks.length === frozenTasks.length &&
      report.counts.tune === tasks.filter((t) => t.split === 'tune').length &&
      report.counts.holdout === tasks.filter((t) => t.split === 'holdout').length &&
      report.counts.disagreements === (report.disagreements ?? []).length &&
      (report.disagreements ?? []).every((d) => d.disagreement !== null),
    { tasks: frozenTasks.length },
    report.counts,
  );
  const liveTest = guardedNode(ctx, 'live-test', [
    '--experimental-strip-types',
    '--test',
    'benchmarks/task-acceptance/live.test.ts',
  ]);
  check('live.test.ts (skip paths only, no provider) exits 0', liveTest.run.status === 0, 0, liveTest.run.status);
  check('live.test.ts parent process makes no network attempt', liveTest.attempts.length === 0, [], liveTest.attempts);
  check(
    'side effects: git working tree unchanged',
    porcelain() === gitBefore,
    gitBefore || '(clean)',
    porcelain() || '(clean)',
  );
  ctx.extra.commands = [offline.run.command, liveTest.run.command];
  ctx.extra.note =
    'equals `npm run task-acceptance:offline` minus its leading whole-repo build (launch built the packages/weave tree)';
}

const DRIVES = {
  'observe-dispatch': driveObserveDispatch,
  'policy-refusal': drivePolicyRefusal,
  'replay-recover': driveReplayRecover,
  crystallize: driveCrystallize,
  'task-acceptance-offline': driveTaskAcceptance,
};

async function drive() {
  const feature = args[1];
  if (!DRIVES[feature]) usage(`unknown feature ${feature ?? '(none)'}`);
  const run = requireRun();
  const out = join(run.evidence, feature);
  mkdirSync(out, { recursive: true });
  const { list, check } = makeChecks();
  const ctx = { check, out, scratch: run.scratch, extra: {} };
  let error = null;
  try {
    await DRIVES[feature](ctx);
  } catch (e) {
    error = String(e?.stack ?? e);
    check(`drive completed without throwing`, false, 'no exception', error);
  }
  const passed = list.filter((c) => c.ok).length;
  const ok = list.length > 0 && passed === list.length;
  writeJson(join(out, 'result.json'), {
    run: run.id,
    feature,
    ok,
    passed,
    total: list.length,
    sha: git('rev-parse', 'HEAD'),
    node: process.version,
    finished_at: new Date().toISOString(),
    ...ctx.extra,
    checks: list,
  });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${feature}: ${passed}/${list.length} checks; evidence ${relative(ROOT, out)}/`);
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// test / checks
// ---------------------------------------------------------------------------

function summary(text) {
  const pick = (k) => {
    const m = new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    tests: pick('tests'),
    pass: pick('pass'),
    fail: pick('fail'),
    cancelled: pick('cancelled'),
    skipped: pick('skipped'),
  };
}

function failingNames(text) {
  const i = text.indexOf('✖ failing tests:');
  if (i < 0) return [];
  return [
    ...new Set(
      text
        .slice(i)
        .split('\n')
        .filter((l) => /^✖ /.test(l) && !l.startsWith('✖ failing tests'))
        .map((l) => l.slice(2).replace(/ \([\d.]+ms\)$/, '')),
    ),
  ];
}

function test() {
  const run = requireRun();
  const build = sh('npx', ['tsc', '-b', 'packages/weave/tsconfig.json']);
  const t = sh(process.execPath, ['--test', 'packages/weave/dist/test/**/*.test.js']);
  const log = `$ ${build.command}\nexit ${build.status}\n${build.stdout}${build.stderr}\n$ ${t.command}\nexit ${t.status}\n${t.stdout}${t.stderr}`;
  writeFileSync(join(run.evidence, 'test-weave.log'), log);
  const failing = failingNames(t.stdout);
  // A failure is a failure. For diagnosis only, rerun each failing file alone once and record it.
  const files = readdirSync(join(ROOT, 'packages/weave/dist/test')).filter((f) => f.endsWith('.test.js'));
  const isolated = [];
  for (const name of failing) {
    const file = files.find((f) =>
      readFileSync(join(ROOT, 'packages/weave/dist/test', f), 'utf8').includes(name.split(' ')[0]),
    );
    if (!file) continue;
    if (isolated.some((x) => x.file === file)) continue;
    const r = sh(process.execPath, ['--test', join('packages/weave/dist/test', file)]);
    writeFileSync(
      join(run.evidence, `test-weave.isolated.${file}.log`),
      `$ ${r.command}\nexit ${r.status}\n${r.stdout}${r.stderr}`,
    );
    isolated.push({ file, exit: r.status, ...summary(r.stdout) });
  }
  const result = {
    command: t.command,
    equivalent_to: 'the packages/weave slice of `npm test` (npm test globs packages/*/dist/test/**/*.test.js)',
    build_exit: build.status,
    exit: t.status,
    ...summary(t.stdout),
    failing,
    isolated_rerun_for_diagnosis_only: isolated,
    ok: build.status === 0 && t.status === 0,
  };
  writeJson(join(run.evidence, 'package-test.json'), result);
  console.log(JSON.stringify(result, null, 2));
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'} test: ${result.pass}/${result.tests}; evidence ${relative(ROOT, run.evidence)}/test-weave.log`,
  );
  process.exit(result.ok ? 0 : 1);
}

function checks() {
  const run = requireRun();
  const out = join(run.evidence, 'checks');
  mkdirSync(out, { recursive: true });
  const listing = readdirSync(join(ROOT, 'checks'), { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const results = [];
  for (const name of listing.filter((n) => n.endsWith('.mjs'))) {
    const r = sh(process.execPath, [join('checks', name)]);
    writeFileSync(join(out, `${name}.log`), `$ ${r.command}\nexit ${r.status}\n${r.stdout}${r.stderr}`);
    results.push({ script: `checks/${name}`, exit: r.status, ms: r.ms });
    console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} checks/${name} (exit ${r.status})`);
  }
  const testFiles = existsSync(join(ROOT, 'checks/test'))
    ? readdirSync(join(ROOT, 'checks/test'))
        .filter((f) => f.endsWith('.test.mjs'))
        .sort()
    : [];
  if (testFiles.length > 0) {
    const r = sh(process.execPath, ['--test', ...testFiles.map((f) => join('checks/test', f))]);
    writeFileSync(join(out, 'checks-test.log'), `$ ${r.command}\nexit ${r.status}\n${r.stdout}${r.stderr}`);
    results.push({
      script: `node --test ${testFiles.map((f) => `checks/test/${f}`).join(' ')}`,
      exit: r.status,
      ms: r.ms,
      ...summary(r.stdout),
    });
    console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} checks/test/*.test.mjs (exit ${r.status})`);
  }
  const ok = results.every((r) => r.exit === 0);
  writeJson(join(out, 'summary.json'), { listing, results, ok });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} checks: ${results.filter((r) => r.exit === 0).length}/${results.length}; evidence ${relative(ROOT, out)}/`,
  );
  process.exit(ok ? 0 : 1);
}

switch (command) {
  case 'launch':
    launch();
    break;
  case 'doctor':
    await doctor();
    break;
  case 'drive':
    await drive();
    break;
  case 'test':
    test();
    break;
  case 'checks':
    checks();
    break;
  case 'cleanup':
    cleanup();
    break;
  default:
    usage(command ? `unknown command ${command}` : undefined);
}
