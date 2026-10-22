import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { InferenceGateway, EvaluationOutcome, EvaluationKind, EvaluationRequest } from '@weave/gateway';
import { CORPUS } from '../corpus.ts';
import type { SuiteRecord } from '../transfer.ts';

import * as probe from '../probe.ts';
import * as transferProbe from '../transfer-probe.ts';

const PIN = 'jev-1.14.0';
const env = { TYPESAFE_API_KEY: 'fake-direct', AI_GATEWAY_API_KEY: 'fake-vercel' };
const suite: SuiteRecord[] = [
  {
    id: 'fake-record',
    source: 'fake',
    group: 'g',
    variant: 'v',
    state: 'state',
    questionId: 'q',
    question: { type: 'choice', instructions: 'Choose.', criteria: { b: 'B', a: 'A' }, label: 'a', src: 'fake' },
  },
];

function fake(model: string | undefined, onCall?: (signal?: AbortSignal) => Promise<void>): InferenceGateway {
  return {
    generate: async () => {
      throw new Error('unexpected generation');
    },
    async evaluate<K extends EvaluationKind>(
      request: EvaluationRequest<K>,
      signal?: AbortSignal,
    ): Promise<EvaluationOutcome<K>> {
      await onCall?.(signal);
      assert.equal(request.role, 'working');
      assert.deepEqual(request.terms.destinations, ['typesafe-ai']);
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, q]) => [
          id,
          { type: 'choice', choice: q.type === 'choice' ? Object.keys(q.criteria ?? {})[0] : 'a' },
        ]),
      );
      return {
        request_id: request.request_id,
        site: request.site,
        status: 'accepted',
        kind: request.kind,
        answers: answers as never,
        confidence: undefined,
        routed_unit_id: `${request.kind}@typesafe`,
        provider_response_id: 'response-fake',
        ...(model === undefined ? {} : { resolved_model_id: model }),
        spent: 1,
        uncertainty: [],
        attempts: [],
      };
    },
  };
}

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'wv037-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const cli of [probe, transferProbe]) {
  test(`${cli === probe ? 'probe' : 'transfer'} concurrent default outputs include their run ids`, async () =>
    temporary(async (dir) => {
      const previous = process.cwd();
      process.chdir(dir);
      try {
        const config = {
          argv: ['--reference', '--kinds', 'choice', '--all'],
          env,
          clock: { now: () => 1_000 },
          gateway: fake(PIN),
          corpus: [CORPUS[0]!],
          suite,
        };
        assert.deepEqual(await Promise.all([cli.main(config), cli.main(config)]), [0, 0]);
        const folder = join(dir, '.local/jev');
        const outputs = (await readdir(folder)).filter((n) => n.endsWith('.json'));
        assert.equal(outputs.length, 2, 'concurrent reference runs must have separate default outputs');
        const ids = [];
        for (const name of outputs) {
          const saved = JSON.parse(await readFile(join(folder, name), 'utf8'));
          assert.ok(name.includes(saved.header.run_id), 'default filename must contain the header run_id');
          assert.equal(saved.records.length, 1);
          ids.push(saved.header.run_id);
        }
        assert.notEqual(ids[0], ids[1]);
      } finally {
        process.chdir(previous);
      }
    }));

  test(`${cli === probe ? 'probe' : 'transfer'} refuses an output held by a live reference run before inference`, async () =>
    temporary(async (dir) => {
      const output = join(dir, 'shared.json');
      const config = {
        argv: ['--reference', '--kinds', 'choice', '--all', '--output', output],
        env,
        clock: { now: () => 1_000 },
        corpus: [CORPUS[0]!],
        suite,
      };
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const owner = cli.main({
        ...config,
        gateway: fake(PIN, async () => {
          entered();
          await gate;
        }),
      });
      await started;
      const checkpoint = await readFile(output, 'utf8');
      let calls = 0;
      try {
        await assert.rejects(
          cli.main({
            ...config,
            gateway: fake(PIN, async () => {
              calls++;
            }),
          }),
          /output.*in use/i,
        );
        assert.equal(calls, 0);
        assert.equal(await readFile(output, 'utf8'), checkpoint, 'contender must not replace the live checkpoint');
      } finally {
        release();
        await owner;
      }
      assert.equal(await cli.main({ ...config, gateway: fake(PIN) }), 0, 'release permits a fresh run');
    }));

  for (const model of [PIN, 'jev-1.15.0', 'jev-preview', undefined]) {
    test(`${cli === probe ? 'probe' : 'transfer'} CLI writes header and exits for resolved ${String(model)}`, async () =>
      temporary(async (dir) => {
        const output = join(dir, 'result.json');
        const code = await cli.main({
          argv: ['--reference', '--kinds', 'choice', '--all', '--output', output],
          env,
          clock: { now: () => 1_000 },
          gateway: fake(model),
          corpus: [CORPUS[0]!],
          suite,
        });
        assert.equal(code, model === PIN ? 0 : 1);
        const saved = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(saved.header.mode, 'reference');
        assert.equal(saved.header.pinned_model_id, PIN);
        assert.equal(saved.header.run_date, '1970-01-01T00:00:01.000Z');
        assert.match(saved.header.corpus_hash, /^[a-f0-9]{64}$/);
        assert.equal(saved.header.route.adapter, 'typesafe-ai');
        assert.equal(saved.header.status, 'completed');
        assert.equal(saved.header.pin_mismatch, model !== PIN);
        assert.equal(saved.header.pin_mismatch_count, model === PIN ? 0 : 1);
        assert.equal(saved.records.length, 1);
        assert.equal(saved.records[0].pin_mismatch, model !== PIN);
        assert.equal(await cli.main({ argv: ['--from', output], env: {}, clock: { now: () => 9_000 } }), code);
      }));
  }

  test(`${cli === probe ? 'probe' : 'transfer'} CLI refuses conflicting model and missing TypeSafe before inference`, async () => {
    let calls = 0;
    const gateway = fake(PIN, async () => {
      calls++;
    });
    for (const argv of [
      ['--reference', '--model', 'jev-preview'],
      ['--reference', '--model', 'kev'],
    ]) {
      await assert.rejects(cli.main({ argv, env, gateway }), /reference.*jev-1\.14\.0/);
    }
    await assert.rejects(cli.main({ argv: ['--reference'], env: { AI_GATEWAY_API_KEY: 'fake' }, gateway }), /TypeSafe/);
    assert.equal(calls, 0);
  });

  test(`${cli === probe ? 'probe' : 'transfer'} cancellation keeps only complete records with valid header`, async () =>
    temporary(async (dir) => {
      const output = join(dir, 'result.json');
      const controller = new AbortController();
      let calls = 0;
      const code = await cli.main({
        argv: ['--reference', '--kinds', 'choice', '--all', '--output', output],
        env,
        clock: { now: () => 2_000 },
        corpus: CORPUS.slice(0, 3),
        suite: [suite[0]!, { ...suite[0]!, id: 'second' }],
        signal: controller.signal,
        gateway: fake(PIN, async (signal) => {
          if (++calls === 2) {
            assert.equal(signal, controller.signal);
            controller.abort();
          }
        }),
      });
      assert.equal(code, 1);
      const saved = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(saved.header.status, 'cancelled');
      assert.equal(saved.records.length, 1);
      assert.equal(saved.header.pin_mismatch_count, 0);
      assert.equal(calls, 2);
      assert.deepEqual(await readdir(`${output}.lock`), [], 'cancellation releases the output claim');
    }));
}

for (const script of ['probe.ts', 'transfer-probe.ts'])
  for (const reference of [false, true]) {
    test(`${script} ${reference ? 'reference' : 'legacy'} errors identify cause without exposing secrets`, async () =>
      temporary(async (dir) => {
        const path = fileURLToPath(new URL(`../${script}`, import.meta.url));
        const secret = 'fake-only-diagnostic-credential';
        const input = join(dir, 'input.json');
        const invoke = (preload?: string): Promise<{ status: number; stderr: string; stdout: string }> =>
          new Promise((resolve, reject) => {
            const worker = new Worker(
              `
        const { workerData } = require('node:worker_threads');
        const { pathToFileURL } = require('node:url');
        process.argv = [process.execPath, workerData.path, '--from', workerData.input, ...(workerData.reference ? ['--reference'] : [])];
        (async () => {
          if (workerData.preload) await import(pathToFileURL(workerData.preload).href);
          await import(pathToFileURL(workerData.path).href);
        })();
      `,
              {
                eval: true,
                stderr: true,
                stdout: true,
                workerData: { path, input, reference, preload },
                env: { TYPESAFE_API_KEY: secret, AI_GATEWAY_API_KEY: secret },
              },
            );
            let stderr = '';
            let stdout = '';
            worker.stderr.on('data', (chunk) => {
              stderr += chunk;
            });
            worker.stdout.on('data', (chunk) => {
              stdout += chunk;
            });
            worker.on('error', reject);
            worker.on('exit', (status) => resolve({ status, stderr, stdout }));
          });
        const check = (result: Awaited<ReturnType<typeof invoke>>, expected: RegExp) => {
          assert.equal(result.status, 1, result.stderr);
          assert.match(result.stderr, expected);
          assert.ok(!`${result.stderr}${result.stdout}`.includes(secret), 'diagnostics must not reveal credentials');
        };
        check(await invoke(), /Error.*ENOENT.*file or directory.*not found/i);
        await writeFile(input, `{ "credential": "${secret}" BROKEN }`);
        check(await invoke(), /SyntaxError.*code=none.*invalid JSON/i);
        await writeFile(input, '{"header":{"mode":"invalid"}}');
        check(await invoke(), /Error.*invalid reference run header/i);
        const preload = join(dir, 'header-error.mjs');
        await writeFile(
          preload,
          `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      fs.readFile = async () => { throw Object.assign(new TypeError('header invalid: ' + process.env.TYPESAFE_API_KEY), { code: 'ERR_INVALID_CHAR' }); };
      syncBuiltinESMExports();
    `,
        );
        check(await invoke(preload), /TypeError.*ERR_INVALID_CHAR.*invalid.*header/i);
        await writeFile(
          preload,
          `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      fs.readFile = async () => { throw Object.assign(new Error(process.env.TYPESAFE_API_KEY), { name: process.env.TYPESAFE_API_KEY, code: process.env.TYPESAFE_API_KEY }); };
      syncBuiltinESMExports();
    `,
        );
        check(await invoke(preload), /Error.*code=unknown.*probe execution failed/i);
      }));
  }

test('parallel reference runs isolate header and provenance; reruns replace without duplication', async () =>
  temporary(async (dir) => {
    const run = async (index: number, model: string, selected = [CORPUS[index]!]) => {
      const output = join(dir, `${index}.json`);
      const code = await probe.main({
        argv: ['--reference', '--kinds', 'choice', '--output', output],
        env,
        clock: { now: () => index * 1_000 },
        corpus: selected,
        gateway: fake(model),
      });
      return { code, saved: JSON.parse(await readFile(output, 'utf8')) };
    };
    const [a, b] = await Promise.all([run(0, PIN), run(1, 'jev-1.15.0')]);
    assert.equal(a.code, 0);
    assert.equal(b.code, 1);
    assert.notEqual(a.saved.header.run_id, b.saved.header.run_id);
    assert.notEqual(a.saved.header.corpus_hash, b.saved.header.corpus_hash);
    assert.equal(a.saved.records[0].resolved_model_id, PIN);
    assert.equal(b.saved.records[0].resolved_model_id, 'jev-1.15.0');
    // A torn staging file from an interrupted process never becomes replay input.
    await writeFile(join(dir, '0.json.tmp-torn'), '{broken');
    const rerun = await run(0, PIN);
    assert.equal(rerun.saved.records.length, 1);
    assert.notEqual(rerun.saved.header.run_id, a.saved.header.run_id);
    assert.equal((await readdir(dir)).filter((n) => n === '0.json').length, 1);
  }));

test('crash during inference leaves a parseable checkpoint and rerun binds new records to its corpus', async () =>
  temporary(async (dir) => {
    const output = join(dir, 'result.json');
    let calls = 0;
    await assert.rejects(
      probe.main({
        argv: ['--reference', '--kinds', 'choice', '--output', output],
        env,
        clock: { now: () => 1_000 },
        corpus: CORPUS.slice(0, 2),
        gateway: fake(PIN, async () => {
          if (++calls === 2) throw new Error('simulated process fault');
        }),
      }),
      /simulated process fault/,
    );
    const partial = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(partial.records.length, 1);
    assert.equal(partial.header.status, 'interrupted');
    assert.deepEqual(await readdir(`${output}.lock`), [], 'an inference error releases the output claim');
    await probe.main({
      argv: ['--reference', '--kinds', 'choice', '--output', output],
      env,
      clock: { now: () => 1_000 },
      corpus: [CORPUS[2]!],
      gateway: fake(PIN),
    });
    const rerun = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(rerun.records.length, 1);
    assert.equal(rerun.records[0].case_id, CORPUS[2]!.id);
    assert.notEqual(rerun.header.corpus_hash, partial.header.corpus_hash);
    assert.notEqual(rerun.header.run_id, partial.header.run_id);
  }));

for (const cli of [probe, transferProbe]) {
  test(`${cli === probe ? 'probe' : 'transfer'} rejects every conflicting model flag, including equals syntax`, async () => {
    for (const argv of [
      ['--reference', '--model=jev-preview'],
      ['--reference', '--model', PIN, '--model', 'jev-preview'],
      ['--reference', '--model'],
    ]) {
      await assert.rejects(cli.main({ argv, env: {}, gateway: fake(PIN) }), /reference.*jev-1\.14\.0/);
    }
  });
}
