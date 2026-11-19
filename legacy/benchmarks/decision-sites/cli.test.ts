import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flags } from './run.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadSets } from './sets.ts';
import type { Provider } from './types.ts';

// Run the real CLI from an isolated composition root so verification never writes recorded results.
const testRoot = mkdtempSync(join(tmpdir(), 'p10-cli-tests-'));
const sourceRoot = new URL('./', import.meta.url).pathname;
for (const name of readdirSync(sourceRoot)) {
  if (name === 'results') continue;
  if (name === 'run.ts' || name === 'REPORT.md') copyFileSync(join(sourceRoot, name), join(testRoot, name));
  else symlinkSync(join(sourceRoot, name), join(testRoot, name));
}
writeFileSync(join(testRoot, 'package.json'), '{"type":"module"}');
const cliPath = join(testRoot, 'run.ts');
const { main } = (await import(pathToFileURL(cliPath).href)) as typeof import('./run.ts');
after(() => rmSync(testRoot, { recursive: true, force: true }));

test('CLI budget hard bound and flags', () => {
  assert.equal(flags([]).maxSpend, 2);
  assert.throws(() => flags(['--max-spend-usd', '5.01']));
  assert.equal(flags(['--max-spend-usd', '6', '--allow-spend-above-5']).maxSpend, 6);
  assert.throws(() => flags(['--run-id', '../escape']));
  assert.throws(() => flags(['--providers', 'unknown']));
});
test('frozen sets have disjoint scenarios and production-shaped questions', () => {
  const sets = loadSets(new URL('./sets/', import.meta.url).pathname, ['loop.route'], 'all');
  assert.ok(sets.entries.length >= 24);
  assert.equal(Object.keys(sets.digests).length, 3);
});
test('canary credentials never enter fake offline files or output; resume does not repeat calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p10-canary-'));
  const id = `offline-test-${process.pid}`;
  const resultDir = join(testRoot, 'results', id);
  const reportPath = join(testRoot, 'REPORT.md');
  let oldReport: string | undefined;
  try {
    oldReport = readFileSync(reportPath, 'utf8');
  } catch {}
  const canaries = ['P10_TYPESAFE_CANARY_7R9', 'P10_OPENAI_CANARY_K39'];
  try {
    const args = [
      '--experimental-strip-types',
      cliPath,
      '--providers',
      'fake',
      '--sites',
      'loop.route',
      '--run-id',
      id,
    ];
    const env = {
      ...process.env,
      TYPESAFE_API_KEY: canaries[0]!,
      TYPESAFE_AI_API_KEY: canaries[0]!,
      OPENAI_API_KEY: canaries[1]!,
    };
    const first = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(first.status, 0, first.stderr);
    const journal = readFileSync(join(resultDir, 'journal.jsonl'), 'utf8');
    const count = journal.split('\n').filter((s) => s.includes('"type":"call"')).length;
    const resumed = spawnSync(process.execPath, [...args, '--resume'], { encoding: 'utf8', env });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(
      readFileSync(join(resultDir, 'journal.jsonl'), 'utf8')
        .split('\n')
        .filter((s) => s.includes('"type":"call"')).length,
      count,
    );
    const all = [
      first.stdout,
      first.stderr,
      resumed.stdout,
      resumed.stderr,
      readFileSync(reportPath, 'utf8'),
      ...readdirSync(resultDir).map((name) => readFileSync(join(resultDir, name), 'utf8')),
    ].join('\n');
    for (const canary of canaries) assert.equal(all.includes(canary), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(resultDir, { recursive: true, force: true });
    if (oldReport !== undefined) writeFileSync(reportPath, oldReport);
    else rmSync(reportPath, { force: true });
  }
});

test('SIGINT and SIGTERM abort in-flight calls, flush cancellation, and return nonzero', async () => {
  const reportPath = join(testRoot, 'REPORT.md');
  let oldReport: string | undefined;
  try {
    oldReport = readFileSync(reportPath, 'utf8');
  } catch {}
  for (const event of ['SIGINT', 'SIGTERM'] as const) {
    const id = `signal-${event}-${process.pid}`;
    const dir = join(testRoot, 'results', id);
    try {
      const code = await main(['--providers', 'fake', '--sites', 'loop.route', '--run-id', id], {
        providers: [
          {
            id: 'fake',
            model: 'signal-fake',
            price: 0,
            serialize: JSON.stringify,
            request: async (_req, signal) =>
              new Promise((resolve) => {
                signal.addEventListener('abort', () => resolve({ status: 'failed', reason: 'cancelled' }), {
                  once: true,
                });
                setImmediate(() => process.emit(event));
              }),
          },
        ],
      });
      assert.equal(code, 130);
      const records = readFileSync(join(dir, 'journal.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(records.some((r) => r.type === 'cancelled'));
      const call = records.find((r) => r.type === 'call');
      assert.ok(call);
      assert.equal(call.result.reason, 'cancelled');
      assert.equal(call.terminal, false);
      assert.equal(call.cost_usd, 0);
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
      assert.equal(summary.decision_providers[0].holdout.coverage, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (oldReport !== undefined) writeFileSync(reportPath, oldReport);
  else rmSync(reportPath, { force: true });
});

test('CLI reports concurrent and stale locks without stealing them', () => {
  const id = `locks-${process.pid}`;
  const dir = join(testRoot, 'results', id);
  try {
    mkdirSync(dir, { recursive: true });
    const args = ['--experimental-strip-types', cliPath, '--providers', 'fake', '--run-id', id];
    for (const [pid, expected] of [
      [process.pid, 'locked'],
      [2147483647, 'stale'],
      ['', 'stale-unknown'],
    ] as const) {
      writeFileSync(join(dir, 'lock'), String(pid));
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.ok(
        result.stderr.includes(expected),
        JSON.stringify({ expected, stderr: result.stderr, stdout: result.stdout }),
      );
      assert.equal(readFileSync(join(dir, 'lock'), 'utf8'), String(pid));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancellation during quota preflight acknowledges an uncalled competitor item', () => {
  const helper = mkdtempSync(join(tmpdir(), 'p10-quota-abort-')),
    id = `quota-abort-${process.pid}`,
    dir = join(testRoot, 'results', id);
  try {
    writeFileSync(
      join(helper, 'quota-axi'),
      `#!${process.execPath}\nprocess.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        '--providers',
        'pi',
        '--sites',
        'loop.route',
        '--split',
        'holdout',
        '--run-id',
        id,
      ],
      { env: { ...process.env, PATH: helper + ':' + process.env.PATH }, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 130, result.stderr);
    const records = readFileSync(join(dir, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const call = records.find((r) => r.type === 'call');
    assert.ok(call);
    assert.equal(call.result.reason, 'cancelled');
    assert.equal(call.terminal, false);
    assert.equal(call.cost_usd, 0);
    assert.equal(
      records.some((r) => r.type === 'provider_status'),
      false,
    );
  } finally {
    rmSync(helper, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const first of ['SIGINT', 'SIGTERM'])
  for (const second of ['SIGINT', 'SIGTERM'])
    test(`${first} then ${second} force-quits with 130 when abort hangs, releasing lock and temp`, () => {
      const temp = mkdtempSync(join(tmpdir(), 'p10-force-quit-')),
        id = `force-quit-${first}-${second}-${process.pid}`,
        dir = join(testRoot, 'results', id);
      try {
        // The provider ignores the graceful abort, so only a second signal can end the run.
        const driver = `
          import { main } from ${JSON.stringify(pathToFileURL(cliPath).href)};
          setInterval(() => {}, 1000);
          await main(['--providers', 'fake', '--sites', 'loop.route', '--run-id', ${JSON.stringify(id)}], {
            providers: [{
              id: 'fake', model: 'hang-fake', price: 0, serialize: JSON.stringify,
              request: (_request, signal) => new Promise(() => {
                signal.addEventListener('abort', () => {
                  process.stdout.write('aborted\\n');
                  process.kill(process.pid, ${JSON.stringify(second)});
                }, { once: true });
                process.kill(process.pid, ${JSON.stringify(first)});
              }),
            }],
          });
          process.exit(0); // Reached only if the abort did not hang.
        `;
        const result = spawnSync(
          process.execPath,
          ['--experimental-strip-types', '--input-type=module', '--eval', driver],
          // SIGKILL: without a force-quit the driver would absorb a SIGTERM timeout too.
          { env: { ...process.env, TMPDIR: temp }, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' },
        );
        assert.equal(result.stdout, 'aborted\n', 'first signal must request graceful abort');
        assert.equal(result.status, 130, 'second signal must force-quit pending work');
        assert.equal(existsSync(join(dir, 'lock')), false, 'force-quit must release the run lock');
        assert.deepEqual(readdirSync(temp), [], 'force-quit must remove the run temp directory');
        const records = readFileSync(join(dir, 'journal.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.ok(records.some((r) => r.type === 'intent'));
        assert.equal(
          records.some((r) => r.type === 'call'),
          false,
        );
        const resumed = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            cliPath,
            '--providers',
            'fake',
            '--sites',
            'loop.route',
            '--run-id',
            id,
            '--resume',
          ],
          { env: { ...process.env, TMPDIR: temp }, encoding: 'utf8', timeout: 15000 },
        );
        assert.equal(resumed.status, 0, resumed.stderr);
      } finally {
        rmSync(temp, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });

test('resume re-renders completed results; render-only never dispatches or mutates the journal', async () => {
  const id = `render-${process.pid}`;
  const dir = join(testRoot, 'results', id);
  const reportPath = join(dir, 'REPORT.md');
  const publishedPath = join(testRoot, 'REPORT.md');
  const published = readFileSync(publishedPath, 'utf8');
  try {
    const args = ['--providers', 'fake', '--sites', 'loop.route', '--run-id', id];
    const first = spawnSync(process.execPath, ['--experimental-strip-types', cliPath, ...args], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const journalPath = join(dir, 'journal.jsonl');
    const completed = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((r) => r.type === 'call').length;
    const noCalls = {
      providers: [
        {
          id: 'fake',
          model: 'offline-fake',
          price: 0,
          serialize: JSON.stringify,
          request: async () => {
            throw Error('unexpected dispatch');
          },
        },
      ],
    };
    writeFileSync(reportPath, 'stale report');
    rmSync(join(dir, 'summary.json'));
    assert.equal(await main([...args, '--resume'], noCalls), 0);
    assert.match(readFileSync(reportPath, 'utf8'), /Decision-site benchmark/);
    assert.equal(readFileSync(publishedPath, 'utf8'), published);
    assert.equal(
      readFileSync(journalPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((r) => r.type === 'call').length,
      completed,
    );
    // A journal may end in a torn tail after a crash. Rendering must leave even those bytes alone.
    const before = readFileSync(journalPath, 'utf8') + '{"torn":';
    writeFileSync(journalPath, before);
    writeFileSync(reportPath, 'stale report');
    rmSync(join(dir, 'summary.json'));
    let calls = 0;
    const uncompleted = {
      providers: [
        {
          ...noCalls.providers[0]!,
          model: 'new-model',
          request: async () => {
            calls++;
            throw Error('unexpected dispatch');
          },
        },
      ],
    };
    assert.equal(await main([...args, '--render-only'], uncompleted), 0);
    assert.equal(calls, 0);
    assert.equal(readFileSync(journalPath, 'utf8'), before);
    assert.match(readFileSync(reportPath, 'utf8'), /Decision-site benchmark/);
    assert.equal(readFileSync(publishedPath, 'utf8'), published);
    assert.ok(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).non_gating);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report binding checks serialized bodies; legacy answers render only without execution', async () => {
  const id = `wire-report-${process.pid}`,
    dir = join(testRoot, 'results', id);
  const args = ['--providers', 'fake', '--sites', 'loop.route', '--split', 'holdout', '--run-id', id];
  let calls = 0;
  const p = {
    id: 'fake',
    model: 'wire-fake',
    price: 0,
    serialize: JSON.stringify,
    request: async () => {
      calls++;
      return { status: 'ok' as const, answers: { decision: { choice: 'flash', confidence: 0.99 } } };
    },
  };
  const attempted = () =>
    JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).decision_providers[0].holdout.attempted;
  try {
    assert.equal(await main(args, { providers: [p] }), 0);
    assert.equal(attempted(), 12);
    const path = join(dir, 'journal.jsonl'),
      bound = readFileSync(path, 'utf8');
    const changed = {
      ...p,
      serialize: (request: Parameters<typeof p.serialize>[0]) => 'new instructions:' + JSON.stringify(request),
    };
    assert.equal(await main([...args, '--render-only'], { providers: [changed] }), 0);
    assert.equal(attempted(), 0);
    assert.equal(calls, 12);
    assert.equal(readFileSync(path, 'utf8'), bound);
    const legacy =
      bound
        .trim()
        .split('\n')
        .map((line) => {
          const r = JSON.parse(line);
          delete r.request_digest;
          return JSON.stringify(r);
        })
        .join('\n') + '\n';
    writeFileSync(path, legacy);
    assert.equal(await main([...args, '--render-only'], { providers: [changed] }), 0);
    assert.equal(attempted(), 12);
    assert.equal(calls, 12);
    assert.equal(readFileSync(path, 'utf8'), legacy);
    // Resume cannot use the render-only legacy exception, even with no spend available.
    assert.equal(await main([...args, '--resume', '--max-spend-usd', '0'], { providers: [{ ...p, price: 0.1 }] }), 0);
    assert.equal(attempted(), 0);
    assert.equal(calls, 12);
    assert.equal(await main([...args, '--resume'], { providers: [changed] }), 0);
    assert.equal(calls, 24);
    assert.equal(attempted(), 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quota and competitor children receive only auth-location environment, never API keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p10-child-env-'));
  const id = `child-env-${process.pid}`;
  const resultDir = join(testRoot, 'results', id);
  const reportPath = join(testRoot, 'REPORT.md');
  const oldReport = readFileSync(reportPath, 'utf8');
  try {
    const stub = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');\nconst name=path.basename(process.argv[1]);\nfs.writeFileSync(path.join(${JSON.stringify(dir)},name+'.env.json'),JSON.stringify(Object.keys(process.env)));\nif(name==='quota-axi'){const now=Date.now();fs.writeSync(1,JSON.stringify({generatedAt:new Date(now).toISOString(),providers:[{provider:'codex',state:{status:'fresh',stale:false},windows:[{id:'weekly',kind:'weekly',percentRemaining:75,resetsAt:new Date(now+3600000).toISOString()}]}]}));}\nelse if(name==='fx'){fs.writeSync(1,'Auth: not authenticated');}\nelse if(process.argv.includes('--help')){fs.writeSync(1,'--mode --no-session --no-tools --no-mcp --no-extensions --no-skills --no-prompt-templates --no-context-files --offline');}\nelse{fs.writeSync(2,'Authentication required');process.exitCode=1;}\n`;
    for (const name of ['quota-axi', 'pi', 'fx']) writeFileSync(join(dir, name), stub, { mode: 0o700 });
    const env = {
      ...process.env,
      PATH: dir + ':' + process.env.PATH,
      XDG_CONFIG_HOME: join(dir, 'config'),
      TYPESAFE_API_KEY: 'FAKE_TYPESAFE',
      TYPESAFE_AI_API_KEY: 'FAKE_TYPESAFE_AI',
      OPENAI_API_KEY: 'FAKE_OPENAI',
      OPENAI_ACCESS_TOKEN: 'FAKE_TOKEN',
      P10_UNRELATED_SECRET: 'FAKE_OTHER',
    };
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        '--providers',
        'pi,fx-ask',
        '--sites',
        'loop.route',
        '--split',
        'holdout',
        '--run-id',
        id,
      ],
      { env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['quota-axi', 'pi', 'fx']) {
      const names = JSON.parse(readFileSync(join(dir, name + '.env.json'), 'utf8')) as string[];
      assert.ok(names.includes('HOME'));
      assert.ok(names.includes('PATH'));
      assert.ok(names.includes('XDG_CONFIG_HOME'));
      assert.deepEqual(
        names.filter((key) => key !== 'HOME' && key !== 'PATH' && !key.startsWith('XDG_')),
        [],
        name + ' received unrelated environment names',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(resultDir, { recursive: true, force: true });
    writeFileSync(reportPath, oldReport);
  }
});

test('fake and partial reports stay in the run directory without overwriting the published report', async () => {
  const id = `local-report-${process.pid}`;
  const dir = join(testRoot, 'results', id);
  const reportPath = join(testRoot, 'REPORT.md');
  const original = readFileSync(reportPath, 'utf8');
  try {
    const args = ['--providers', 'fake', '--sites', 'loop.route', '--run-id', id];
    assert.equal(await main(args), 0);
    assert.equal(readFileSync(reportPath, 'utf8'), original);
    assert.match(readFileSync(join(dir, 'REPORT.md'), 'utf8'), /Decision-site benchmark/);
    assert.equal(await main([...args, '--resume', '--split', 'holdout']), 0);
    assert.equal(readFileSync(reportPath, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(reportPath, original);
  }
  const partialId = `partial-report-${process.pid}`,
    partialDir = join(testRoot, 'results', partialId);
  try {
    assert.equal(
      await main(
        ['--providers', 'typesafe-jev', '--sites', 'loop.route', '--split', 'holdout', '--run-id', partialId],
        {
          providers: [
            {
              id: 'typesafe-jev',
              model: 'fake-live-shape',
              price: 0,
              serialize: JSON.stringify,
              request: async () => ({ status: 'skipped', reason: 'no_credential' }),
            },
          ],
        },
      ),
      0,
    );
    assert.equal(readFileSync(reportPath, 'utf8'), original);
    assert.match(readFileSync(join(partialDir, 'REPORT.md'), 'utf8'), /Decision-site benchmark/);
  } finally {
    rmSync(partialDir, { recursive: true, force: true });
    writeFileSync(reportPath, original);
  }
});

for (const complete of [false, true])
  test(`${complete ? 'full' : 'partial'} provider list with all sites and splits ${complete ? 'publishes' : 'preserves'} the headline report`, async () => {
    const id = `provider-coverage-${complete}-${process.pid}`,
      dir = join(testRoot, 'results', id);
    const reportPath = join(testRoot, 'REPORT.md'),
      original = readFileSync(reportPath, 'utf8');
    // Reverse the default order: coverage depends on membership, including requested providers skipped at runtime.
    const requested = complete ? ['fx-ask', 'pi', 'openai-decisions', 'amos-small', 'typesafe-jev'] : ['amos-small'];
    const providers: Provider[] = requested.map((id) => ({
      id,
      model: 'offline-publish-test',
      competitor: id === 'pi' || id === 'fx-ask',
      price: 0,
      serialize: JSON.stringify,
      request: async (request) =>
        id === 'amos-small'
          ? {
              status: 'ok',
              answers: Object.fromEntries(
                Object.entries(request.questions).map(([id, q]) => [
                  id,
                  q.type === 'choice'
                    ? { choice: Object.keys(q.criteria)[0]!, confidence: 0.95 }
                    : { probability: 0.1, confidence: 0.95 },
                ]),
              ),
            }
          : { status: 'skipped', reason: id === 'pi' || id === 'fx-ask' ? 'auth_required' : 'no_credential' },
    }));
    try {
      assert.equal(
        await main(['--providers', requested.join(','), '--split', 'all', '--run-id', id], { providers }),
        0,
      );
      const report = readFileSync(join(dir, 'REPORT.md'), 'utf8');
      assert.match(report, /Decision-site benchmark/);
      assert.ok(
        readFileSync(reportPath, 'utf8') === (complete ? report : original),
        complete
          ? 'full provider run must publish the run report'
          : 'partial provider run must leave the headline untouched',
      );
      if (complete) {
        assert.match(report, /no_credential/);
        assert.match(report, /auth_required/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(reportPath, original);
    }
  });

test('a quota-skipped competitor leaves the all-site headline uncovered, including render-only', async () => {
  const id = `quota-report-${process.pid}`,
    dir = join(testRoot, 'results', id);
  const reportPath = join(testRoot, 'REPORT.md'),
    original = readFileSync(reportPath, 'utf8');
  const requested = flags([]).providers;
  let calls = 0;
  const providers: Provider[] = requested.map((id) => ({
    id,
    model: 'offline-publish-test',
    competitor: id === 'pi' || id === 'fx-ask',
    price: 0,
    serialize: JSON.stringify,
    request: async (request) => {
      calls++;
      return id === 'amos-small'
        ? {
            status: 'ok',
            answers: Object.fromEntries(
              Object.entries(request.questions).map(([id, q]) => [
                id,
                q.type === 'choice'
                  ? { choice: Object.keys(q.criteria)[0]!, confidence: 0.95 }
                  : { probability: 0.1, confidence: 0.95 },
              ]),
            ),
          }
        : {
            status: 'skipped',
            reason:
              id === 'pi' ? 'quota_unavailable_or_weekly_cap' : id === 'fx-ask' ? 'auth_required' : 'no_credential',
          };
    },
  }));
  const args = ['--providers', requested.join(','), '--split', 'all', '--run-id', id];
  try {
    assert.equal(await main(args, { providers }), 0);
    assert.match(readFileSync(join(dir, 'REPORT.md'), 'utf8'), /quota_unavailable_or_weekly_cap/);
    assert.equal(readFileSync(reportPath, 'utf8'), original, 'quota skips must not count as headline coverage');
    const dispatched = calls,
      journalPath = join(dir, 'journal.jsonl'),
      journal = readFileSync(journalPath, 'utf8');
    assert.equal(await main([...args, '--render-only'], { providers }), 0);
    assert.equal(calls, dispatched);
    assert.equal(readFileSync(journalPath, 'utf8'), journal);
    assert.equal(readFileSync(reportPath, 'utf8'), original, 'render-only must preserve the headline for quota skips');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(reportPath, original);
  }
});

test('a budget-stopped all-site run writes its report only in its run directory', async () => {
  const id = `budget-report-${process.pid}`,
    dir = join(testRoot, 'results', id);
  const reportPath = join(testRoot, 'REPORT.md'),
    original = readFileSync(reportPath, 'utf8');
  let calls = 0;
  try {
    const providers = flags([]).providers.map((id) => ({
      id,
      model: 'fake-live-shape',
      price: 0.1,
      serialize: JSON.stringify,
      request: async () => {
        calls++;
        throw Error('budget must block');
      },
    }));
    assert.equal(await main(['--max-spend-usd', '0', '--run-id', id], { providers }), 0);
    assert.equal(calls, 0);
    assert.equal(readFileSync(reportPath, 'utf8'), original);
    assert.match(readFileSync(join(dir, 'REPORT.md'), 'utf8'), /budget_stop/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(reportPath, original);
  }
});

test('an all-skipped run keeps its empty report out of the published report', async () => {
  const id = `skipped-report-${process.pid}`,
    dir = join(testRoot, 'results', id);
  const reportPath = join(testRoot, 'REPORT.md'),
    original = readFileSync(reportPath, 'utf8');
  try {
    const providers: Provider[] = flags([]).providers.map((id) => ({
      id,
      model: 'fake-live-shape',
      price: 0,
      serialize: JSON.stringify,
      request: async () => ({ status: 'skipped', reason: 'no_credential' }),
    }));
    assert.equal(await main(['--run-id', id], { providers }), 0);
    assert.equal(readFileSync(reportPath, 'utf8'), original);
    assert.match(readFileSync(join(dir, 'REPORT.md'), 'utf8'), /no_credential/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(reportPath, original);
  }
});

test('resume binds spend to the first run ceiling and requires explicit authorization for increases', async () => {
  const id = `ceiling-${process.pid}`,
    dir = join(testRoot, 'results', id),
    args = ['--providers', 'fake', '--sites', 'loop.route', '--run-id', id];
  try {
    assert.equal(await main([...args, '--max-spend-usd', '1']), 0);
    const path = join(dir, 'journal.jsonl'),
      original = readFileSync(path, 'utf8');
    await assert.rejects(
      main([...args, '--resume', '--max-spend-usd', '2']),
      /ceiling increase requires --allow-spend-increase/,
    );
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(await main([...args, '--resume']), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).max_spend_usd, 1);
    assert.equal(await main([...args, '--resume', '--max-spend-usd', '.5']), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).max_spend_usd, 0.5);
    assert.equal(await main([...args, '--render-only']), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).max_spend_usd, 1);
    assert.equal(await main([...args, '--resume', '--max-spend-usd', '3', '--allow-spend-increase']), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).max_spend_usd, 3);
    // A prior increase must not silently reset the original ceiling for later invocations.
    await assert.rejects(main([...args, '--resume', '--max-spend-usd', '3']), /ceiling increase requires/);
    await assert.rejects(main([...args, '--resume', '--max-spend-usd', '6', '--allow-spend-increase']), /above 5/);
    assert.equal(
      await main([...args, '--resume', '--max-spend-usd', '6', '--allow-spend-increase', '--allow-spend-above-5']),
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed temp-directory creation releases the run lock', async () => {
  const id = `temp-failure-${process.pid}`,
    dir = join(testRoot, 'results', id);
  const stub = mock.method(fs, 'mkdtempSync', () => {
    throw Error('fake temp failure');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(main(['--providers', 'fake', '--run-id', id]), /fake temp failure/);
    assert.equal(existsSync(join(dir, 'lock')), false);
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recovered quota skip is not reported as a current provider skip after resume', async () => {
  const id = `quota-recovery-${process.pid}`,
    dir = join(testRoot, 'results', id);
  const args = ['--providers', 'pi', '--sites', 'loop.route', '--split', 'holdout', '--run-id', id];
  let calls = 0;
  const injected = {
    providers: [
      {
        id: 'pi',
        model: 'chatgpt-sign-in',
        competitor: true,
        price: 0,
        serialize: JSON.stringify,
        request: async () => {
          calls++;
          return calls === 1
            ? { status: 'skipped' as const, reason: 'quota_unavailable_or_weekly_cap' }
            : {
                status: 'ok' as const,
                model: 'chatgpt-sign-in',
                answers: { decision: { choice: 'flash', confidence: 0.99 } },
              };
        },
      },
    ],
  };
  try {
    assert.equal(await main(args, injected), 0);
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).competitors[0].skip_reason,
      'quota_unavailable_or_weekly_cap',
    );
    assert.equal(await main([...args, '--resume'], injected), 0);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    assert.equal(summary.competitors[0].holdout.attempted, 12);
    assert.equal(calls, 13);
    assert.equal(summary.competitors[0].skip_reason, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('competitor and quota calls use fresh empty cwd and clean up on success, error and abort', () => {
  const helper = mkdtempSync(join(tmpdir(), 'p10-cwd-fixtures-'));
  const help =
    '--mode --no-session --no-tools --no-mcp --no-extensions --no-skills --no-prompt-templates --no-context-files --offline';
  try {
    for (const mode of ['success', 'error', 'abort']) {
      const id = `cwd-${mode}-${process.pid}`,
        resultDir = join(testRoot, 'results', id),
        log = join(helper, mode + '.jsonl');
      const stub = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const name=path.basename(process.argv[1]),help=process.argv.includes('--help'),status=process.argv[2]==='status';
const prompt=name!=='quota-axi'&&!help&&!status;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({name,prompt,cwd:process.cwd(),entries:fs.readdirSync(process.cwd())})+'\\n');
fs.writeFileSync('marker','fixture residue');
if(name==='quota-axi'){const now=Date.now();fs.writeSync(1,JSON.stringify({generatedAt:new Date(now).toISOString(),providers:[{provider:'codex',state:{status:'fresh',stale:false},windows:[{id:'weekly',kind:'weekly',percentRemaining:75,resetsAt:new Date(now+3600000).toISOString()}]}]}));}
else if(status)fs.writeSync(1,'Auth: authenticated with ChatGPT');
else if(help)fs.writeSync(1,${JSON.stringify(help)});
else if(${JSON.stringify(mode)}==='abort'){process.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);}
else if(${JSON.stringify(mode)}==='error'){fs.writeSync(2,'fixture error');process.exitCode=1;}
else fs.writeSync(1,JSON.stringify({answers:{decision:{choice:'flash',confidence:.95}}}));
`;
      for (const name of ['quota-axi', 'pi', 'fx']) writeFileSync(join(helper, name), stub, { mode: 0o700 });
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          cliPath,
          '--providers',
          mode === 'abort' ? 'pi' : 'pi,fx-ask',
          '--sites',
          'loop.route',
          '--split',
          'holdout',
          '--run-id',
          id,
        ],
        { env: { ...process.env, PATH: helper + ':' + process.env.PATH }, encoding: 'utf8', timeout: 30000 },
      );
      assert.equal(result.status, mode === 'abort' ? 130 : 0, result.stderr);
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { name: string; prompt: boolean; cwd: string; entries: string[] });
      assert.ok(calls.some((call) => call.prompt));
      assert.equal(new Set(calls.map((call) => call.cwd)).size, calls.length, 'each child needs its own cwd');
      for (const call of calls) {
        assert.deepEqual(call.entries, []);
        assert.equal(existsSync(call.cwd), false, call.cwd + ' was not removed');
      }
      if (mode !== 'abort') assert.equal(calls.filter((call) => call.prompt).length, 24);
      else {
        const records = readFileSync(join(resultDir, 'journal.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const call = records.find((r) => r.type === 'call');
        assert.ok(call);
        assert.equal(call.result.reason, 'cancelled_after_dispatch');
        assert.equal(call.terminal, true);
      }
      rmSync(resultDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(helper, { recursive: true, force: true });
  }
});

test('muse-spark is an opt-in holdout competitor that records the operator content class', async () => {
  const id = `muse-spark-${process.pid}`,
    dir = join(testRoot, 'results', id);
  const args = ['--providers', 'muse-spark', '--sites', 'loop.route', '--split', 'all', '--run-id', id];
  await assert.rejects(main(args), /content-class/);
  assert.equal(existsSync(join(dir, 'journal.jsonl')), false, 'a refused classification writes nothing');
  const splits: string[] = [];
  const p: Provider = {
    id: 'muse-spark',
    model: 'muse-spark-1.3-contributor',
    competitor: true,
    price: 0,
    serialize: JSON.stringify,
    request: async (request) => {
      splits.push(JSON.stringify(request.state));
      return {
        status: 'ok',
        model: 'muse-spark-1.3-contributor',
        input_tokens: 5,
        output_tokens: 300,
        answers: { decision: { choice: 'flash', confidence: 0.9 } },
      };
    },
  };
  try {
    assert.equal(await main([...args, '--content-class', 'non_sensitive'], { providers: [p] }), 0);
    assert.equal(splits.length, 12, 'holdout only');
    const run = readFileSync(join(dir, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((r) => r.type === 'run');
    assert.equal(run.content_class, 'non_sensitive');
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.decision_providers, []);
    assert.equal(summary.competitors[0].provider, 'muse-spark');
    assert.equal(summary.competitors[0].holdout.attempted, 12);
    assert.deepEqual(summary.models_served, ['muse-spark-1.3-contributor']);
    assert.match(
      readFileSync(join(dir, 'REPORT.md'), 'utf8'),
      /muse-spark records the requested model of the routed unit that answered/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary and report separate observed spend from reserved spend; the ledger stays conservative', async () => {
  const id = `spend-split-${process.pid}`,
    dir = join(testRoot, 'results', id);
  const args = ['--providers', 'fake', '--sites', 'loop.route', '--split', 'holdout', '--run-id', id];
  // Every item meets one usage-less 429 before an answer with a usage receipt.
  const seen = new Set<string>();
  const p: Provider = {
    id: 'fake',
    model: 'spend-fake',
    price: 0.1,
    serialize: JSON.stringify,
    request: async (request) => {
      const key = JSON.stringify(request.state);
      if (!seen.has(key)) {
        seen.add(key);
        return { status: 'failed', http_status: 429, retry_after_ms: 0 };
      }
      return {
        status: 'ok',
        model: 'spend-fake',
        input_tokens: 10,
        answers: { decision: { choice: 'flash', confidence: 0.99 } },
      };
    },
  };
  try {
    assert.equal(await main(args, { providers: [p] }), 0);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    assert.ok(Math.abs(summary.observed_usd - (12 * 10 * 0.1) / 1e6) < 1e-15);
    assert.equal(summary.metered_call_cost_usd, summary.observed_usd);
    assert.ok(summary.reserved_usd > 0);
    assert.equal(summary.pending_reservation_usd, 0);
    assert.ok(Math.abs(summary.spent_usd - (summary.observed_usd + summary.reserved_usd)) < 1e-15);
    const report = readFileSync(join(dir, 'REPORT.md'), 'utf8');
    assert.match(report, /Ledger spend \(including pending reservations\): \$/);
    assert.match(report, /Observed spend \(usage receipts\): \$0\.00001200/);
    assert.match(report, /Reserved spend \(no usage receipt\): \$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
