import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute, countCompetitorCalls } from './engine.ts';
import { Journal, digest, ledger, projectedCost } from './journal.ts';
import { buildRequest } from './questions.ts';
import { buildProviders } from './providers.ts';
import { buildCompetitors } from './competitors.ts';
import type { Provider, Item } from './types.ts';
const item: Item = {
  id: 'i',
  scenario_id: 's',
  site: 'loop.route',
  state: { task: 'read' },
  gold: { decision: 'flash' },
};
async function fixture(fn: (journal: Journal) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'engine-'));
  try {
    await fn(new Journal(join(dir, 'journal.jsonl')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const entry = { item, split: 'holdout' as const, set_digest: 's' };
function provider(request: Provider['request']): Provider {
  return { id: 'fake', model: 'fake', price: 0.1, serialize: JSON.stringify, request };
}
const clock = { now: () => 100, sleep: async () => {} };
for (const id of ['typesafe-jev', 'openai-decisions'])
  test(`${id} body timeout charges the projection and remains terminal on resume`, (t) =>
    fixture(async (journal) => {
      const deadline = new AbortController(),
        external = new AbortController();
      let calls = 0;
      t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
      const p = buildProviders({
        typesafeKey: 'fake-key',
        openaiKey: 'fake-key',
        fetch: async () => {
          calls++;
          return new Response(
            new ReadableStream(
              {
                pull(controller) {
                  deadline.abort(new DOMException('Body read timed out', 'TimeoutError'));
                  controller.error(deadline.signal.reason);
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
      }).find((p) => p.id === id)!;
      const run = () =>
        execute({ entries: [entry], providers: [p], journal, maxSpend: 2, signal: external.signal, ...clock });
      await run();
      const intent = journal.read().find((r) => r.type === 'intent')!,
        call = journal.read().find((r) => r.type === 'call')!;
      assert.equal(call.result.reason, 'timeout');
      assert.equal(call.result.input_tokens, undefined);
      assert.equal(call.terminal, true);
      assert.ok(intent.projected_usd > 0);
      assert.equal(call.cost_usd, intent.projected_usd);
      assert.equal(journal.spent(), intent.projected_usd);
      assert.equal(external.signal.aborted, false);
      await run();
      assert.equal(calls, 1);
      assert.equal(journal.spent(), intent.projected_usd);
      assert.equal(
        journal.read().some((r) => r.type === 'uncertain'),
        false,
      );
    }));
for (const id of ['typesafe-jev', 'openai-decisions'])
  for (const phase of ['before_fetch', 'mid_fetch', 'after_response', 'after_body', 'body_interrupted']) {
    test(`${id} cancellation ${phase} preserves dispatch, usage and replay safety`, () =>
      fixture(async (journal) => {
        const controller = new AbortController();
        let calls = 0;
        const model = id === 'typesafe-jev' ? 'jev-1.14.0' : 'gpt-6-luna';
        const answer = { type: 'choice', choice: 'flash', confidence: 0.95 };
        const body = {
          model,
          usage: { input_tokens: 7, output_tokens: 1 },
          answers: id === 'typesafe-jev' ? { decision: answer } : [{ name: 'decision', ...answer }],
        };
        const base = buildProviders({
          typesafeKey: 'fake-key',
          openaiKey: 'fake-key',
          fetch: async () => {
            calls++;
            if (phase === 'mid_fetch') {
              controller.abort();
              throw Error('fetch interrupted');
            }
            const response = new Response(JSON.stringify(body));
            if (phase === 'after_response') controller.abort();
            if (phase === 'after_body' || phase === 'body_interrupted')
              Object.defineProperty(response, 'json', {
                value: async () => {
                  controller.abort();
                  if (phase === 'body_interrupted') throw Error('body interrupted');
                  return body;
                },
              });
            return response;
          },
        }).find((p) => p.id === id)!;
        const p = {
          ...base,
          request: async (...args: Parameters<Provider['request']>) => {
            if (phase === 'before_fetch') controller.abort();
            return base.request(...args);
          },
        };
        const run = (providers = [p], signal?: AbortSignal) =>
          execute({ entries: [entry], providers, journal, maxSpend: 2, ...clock, ...(signal ? { signal } : {}) });
        await run([p], controller.signal);
        const call = journal.read().find((r) => r.type === 'call');
        if (phase === 'before_fetch') {
          assert.equal(calls, 0);
          assert.equal(call?.terminal, false);
          assert.equal(call?.result.reason, 'cancelled');
          assert.equal(journal.spent(), 0);
        } else if (phase === 'mid_fetch' || phase === 'body_interrupted') {
          assert.equal(call, undefined);
          assert.equal(journal.spent(), journal.read().find((r) => r.type === 'intent')!.projected_usd);
          assert.ok(journal.spent() > 0);
        } else {
          assert.equal(call?.result.status, 'ok');
          assert.equal(call?.result.input_tokens, 7);
          assert.equal(call?.terminal, true);
          assert.equal(journal.spent(), (7 * base.price) / 1e6);
        }
        const spent = journal.spent();
        await run([base]);
        assert.equal(calls, 1);
        if (phase !== 'before_fetch') assert.equal(journal.spent(), spent);
        assert.equal(
          journal.read().some((r) => r.type === 'uncertain'),
          phase === 'mid_fetch' || phase === 'body_interrupted',
        );
      }));
  }
for (const id of ['pi', 'fx-ask'])
  for (const phase of ['preflight', 'prompt']) {
    test(`${id} cancellation in ${phase} only releases the cap before inference dispatch`, () =>
      fixture(async (journal) => {
        const controller = new AbortController();
        let prompts = 0;
        const p = buildCompetitors({
          cwd: '/tmp/empty',
          quotaAllowed: true,
          run: async (_cmd, args, options) => {
            if ((phase === 'preflight' && !options.stdin) || options.stdin) {
              if (options.stdin) prompts++;
              controller.abort();
              return { exitCode: 1, stdout: '', stderr: '' };
            }
            return {
              exitCode: 0,
              stdout:
                args[0] === 'status'
                  ? 'Auth: authenticated with ChatGPT'
                  : '--mode --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files --offline',
              stderr: '',
            };
          },
        }).find((p) => p.id === id)!;
        await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, signal: controller.signal, ...clock });
        assert.equal(countCompetitorCalls(journal.read(), id), phase === 'prompt' ? 1 : 0);
        const call = journal.read().find((r) => r.type === 'call')!;
        assert.equal(call.terminal, phase === 'prompt');
        let resumed = 0;
        const next = {
          ...p,
          request: async () => {
            resumed++;
            return { status: 'ok' as const, answers: {} };
          },
        };
        await execute({ entries: [entry], providers: [next], journal, maxSpend: 2, ...clock });
        assert.equal(prompts, phase === 'prompt' ? 1 : 0);
        assert.equal(resumed, phase === 'prompt' ? 0 : 1);
      }));
  }
test('budget stops before call and resume reads newly appended live ledger', () =>
  fixture(async (journal) => {
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'ok', model: 'fake', input_tokens: 1000000, answers: {} };
    });
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 0, ...clock });
    assert.equal(n, 0);
    journal.append({ type: 'call', call_id: 'prior', cost_usd: 1 });
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 1, ...clock });
    assert.equal(n, 0);
  }));
test('429 max three attempts, auth skips rest, failure remains in denominator', () =>
  fixture(async (journal) => {
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'failed', model: 'fake', http_status: 429, retry_after_ms: 10 };
    });
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 3);
    assert.equal(journal.read().filter((r) => r.type === 'call').length, 3);
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 3);
  }));
test('an acknowledged paid answer survives cancellation with actual cost and is never repaid', () =>
  fixture(async (journal) => {
    const controller = new AbortController();
    let n = 0;
    const answer = {
      status: 'ok' as const,
      model: 'fake',
      input_tokens: 7,
      answers: { decision: { choice: 'flash', confidence: 0.9 } },
    };
    const p = provider(async () => {
      n++;
      controller.abort();
      return answer;
    });
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, signal: controller.signal, ...clock });
    const records = journal.read(),
      call = records.find((r) => r.type === 'call')!;
    assert.ok(call);
    assert.deepEqual(call.result, answer);
    assert.equal(call.terminal, true);
    assert.equal(call.cost_usd, (7 * p.price) / 1e6);
    assert.equal(journal.spent(), call.cost_usd);
    assert.ok(records.findIndex((r) => r.type === 'call') < records.findIndex((r) => r.type === 'cancelled'));
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 1);
    assert.equal(journal.spent(), call.cost_usd);
    assert.equal(
      journal.read().some((r) => r.type === 'uncertain'),
      false,
    );
  }));
test('acknowledged cancellation or not-sent results release spend and competitor cap and remain retryable', async () => {
  for (const reason of ['cancelled', 'not_sent'])
    await fixture(async (journal) => {
      for (let i = 0; i < 39; i++) {
        journal.append({ type: 'intent', provider: 'fake', call_id: `paid-${i}`, projected_usd: 0 });
        journal.append({
          type: 'call',
          provider: 'fake',
          call_id: `paid-${i}`,
          result: { status: 'ok' },
          terminal: true,
          cost_usd: 0,
        });
      }
      let n = 0;
      for (let i = 0; i < 4; i++) {
        const controller = new AbortController();
        const p = {
          ...provider(async () => {
            n++;
            controller.abort();
            return { status: 'failed', reason };
          }),
          competitor: true,
        };
        await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, signal: controller.signal, ...clock });
        const call = journal
          .read()
          .filter((r) => r.type === 'call')
          .at(-1)!;
        assert.equal(call.result.reason, reason);
        assert.equal(call.terminal, false);
        assert.equal(call.cost_usd, 0);
        assert.equal(journal.spent(), 0);
        assert.equal(countCompetitorCalls(journal.read(), 'fake'), 39);
      }
      const p = {
        ...provider(async () => {
          n++;
          return { status: 'ok' as const, input_tokens: 7, answers: {} };
        }),
        competitor: true,
      };
      await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
      assert.equal(n, 5);
      assert.equal(countCompetitorCalls(journal.read(), 'fake'), 40);
      assert.equal(
        journal.read().some((r) => r.type === 'uncertain'),
        false,
      );
    });
});
test('requests that throw without acknowledgement retain a reservation and are not blindly retried', async () => {
  for (const abort of [false, true])
    await fixture(async (journal) => {
      const controller = new AbortController();
      let n = 0;
      const p = provider(async () => {
        n++;
        if (abort) controller.abort();
        throw Error('no receipt');
      });
      await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, signal: controller.signal, ...clock });
      assert.equal(
        journal.read().some((r) => r.type === 'call'),
        false,
      );
      const spent = journal.spent();
      assert.ok(spent > 0);
      await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
      assert.equal(n, 1);
      assert.equal(journal.spent(), spent);
      assert.equal(
        journal.read().some((r) => r.type === 'uncertain'),
        true,
      );
    });
});
test('already cancelled dispatch creates no reservation or competitor call', () =>
  fixture(async (journal) => {
    const controller = new AbortController();
    controller.abort();
    await execute({
      entries: [entry],
      providers: [
        {
          ...provider(async () => {
            throw Error('must not dispatch');
          }),
          competitor: true,
        },
      ],
      journal,
      maxSpend: 2,
      signal: controller.signal,
      ...clock,
    });
    assert.equal(
      journal.read().some((r) => r.type === 'intent'),
      false,
    );
    assert.equal(journal.spent(), 0);
    assert.equal(countCompetitorCalls(journal.read(), 'fake'), 0);
  }));
test('auth skips provider once and unrelated providers continue; skipped calls cost zero', () =>
  fixture(async (journal) => {
    let denied = 0,
      healthy = 0;
    const auth = {
      ...provider(async () => {
        denied++;
        return { status: 'skipped' as const, http_status: 401, reason: 'unauthorized' };
      }),
      id: 'denied',
    };
    const good = {
      ...provider(async () => {
        healthy++;
        return { status: 'ok' as const, model: 'fake', answers: {} };
      }),
      id: 'healthy',
    };
    await execute({
      entries: [entry, { ...entry, item: { ...item, id: 'j' } }],
      providers: [auth, good],
      journal,
      maxSpend: 2,
      ...clock,
    });
    assert.equal(denied, 1);
    assert.equal(healthy, 2);
    assert.ok(journal.read().some((r) => r.type === 'provider_status' && r.provider === 'denied'));
    assert.equal(journal.read().find((r) => r.type === 'call' && r.provider === 'denied')!.cost_usd, 0);
  }));
test('exact replay skips payment; changed model, set or request re-asks and retains all spend', () =>
  fixture(async (journal) => {
    let n = 0;
    const p = provider(async () => {
      n++;
      return {
        status: 'ok',
        model: 'fake',
        input_tokens: 100,
        answers: { decision: { choice: 'flash', confidence: 0.9 } },
      };
    });
    const run = (entries = [entry], providers = [p]) => execute({ entries, providers, journal, maxSpend: 2, ...clock });
    await run();
    const spent = journal.spent();
    await run();
    assert.equal(n, 1);
    assert.equal(journal.spent(), spent);
    await run([{ ...entry, set_digest: 'changed' }]);
    assert.equal(n, 2);
    await run([{ ...entry, item: { ...item, state: { task: 'changed' } } }]);
    assert.equal(n, 3);
    await run(
      [entry],
      [
        {
          ...p,
          model: 'different',
          request: async () => {
            n++;
            return { status: 'ok', model: 'different', input_tokens: 100, answers: {} };
          },
        },
      ],
    );
    assert.equal(n, 4);
    assert.equal(journal.spent(), spent * 4);
  }));
test('resume binds terminal answers to the serialized body even when the production request is identical', () =>
  fixture(async (journal) => {
    let n = 0;
    const requests: unknown[] = [];
    const p = provider(async (request) => {
      n++;
      requests.push(request);
      return { status: 'ok', input_tokens: 1, answers: {} };
    });
    const run = (profile: string) =>
      execute({
        entries: [entry],
        providers: [{ ...p, serialize: (request) => profile + JSON.stringify(request) }],
        journal,
        maxSpend: 2,
        ...clock,
      });
    await run('v1:');
    await run('v1:');
    assert.equal(n, 1);
    await run('v2:');
    assert.equal(n, 2);
    assert.deepEqual(requests[0], requests[1]);
    await run('v2:');
    assert.equal(n, 2);
    const calls = journal.read().filter((r) => r.type === 'call');
    assert.equal(calls[0]!.request_digest, digest('v1:' + JSON.stringify(requests[0])));
    assert.equal(calls[1]!.request_digest, digest('v2:' + JSON.stringify(requests[1])));
  }));
test('legacy terminal answers without a serialized request digest never match resume', () =>
  fixture(async (journal) => {
    const request = await buildRequest(item);
    journal.append({
      type: 'call',
      provider: 'fake',
      model: 'fake',
      site: item.site,
      item_id: item.id,
      set_digest: entry.set_digest,
      question_digest: digest(JSON.stringify(request)),
      call_id: 'legacy',
      result: { status: 'ok', answers: {} },
      terminal: true,
      cost_usd: 0,
    });
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'ok', input_tokens: 1, answers: {} };
    });
    const run = () => execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    await run();
    await run();
    assert.equal(n, 1);
  }));
for (const status of ['ok', 'failed'] as const)
  for (const maxSpend of [2, 0.001])
    test(`actual cost above reservation stops all further dispatch after ${status} at ceiling ${maxSpend}, including retry and resume`, () =>
      fixture(async (journal) => {
        let n = 0;
        const p = provider(async () => {
          n++;
          return {
            status,
            input_tokens: 1000000,
            ...(status === 'failed' ? { http_status: 429, retry_after_ms: 1 } : { answers: {} }),
          };
        });
        const free = { ...p, id: 'free', price: 0 };
        const run = () =>
          execute({
            entries: [entry, { ...entry, item: { ...item, id: 'next' } }],
            providers: [p, free],
            journal,
            maxSpend,
            ...clock,
          });
        await run();
        assert.equal(n, 1);
        const records = journal.read(),
          intent = records.find((r) => r.type === 'intent')!,
          call = records.find((r) => r.type === 'call')!,
          stop = records.find((r) => r.type === 'budget_stop');
        assert.ok(call.cost_usd > intent.projected_usd);
        assert.ok(stop);
        assert.equal(stop.reason, 'actual_cost_exceeds_projection');
        assert.equal(stop.call_id, call.call_id);
        assert.equal(stop.spent_usd, journal.spent());
        assert.equal(stop.projected_usd, intent.projected_usd);
        assert.ok(records.indexOf(stop) > records.indexOf(call));
        await run();
        assert.equal(n, 1);
      }));
test('every subsequent admission uses actual spend and resume re-reads the ledger', () =>
  fixture(async (journal) => {
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'ok', input_tokens: 1, answers: {} };
    });
    const projected = projectedCost(p.serialize(await buildRequest(item)), p.price),
      actual = p.price / 1e6;
    const maxSpend = projected + actual / 2;
    const rows = [entry, { ...entry, item: { ...item, id: 'next' } }];
    const run = () => execute({ entries: rows, providers: [p], journal, maxSpend, ...clock });
    await run();
    assert.equal(n, 1);
    assert.ok(journal.spent() <= maxSpend);
    journal.append({ type: 'call', call_id: 'external-receipt', cost_usd: maxSpend - actual });
    await run();
    assert.equal(n, 1);
    assert.equal(journal.spent(), maxSpend);
  }));
test('resume stops on an excessive receipt even after a crash before budget_stop was journalled', () =>
  fixture(async (journal) => {
    journal.append({ type: 'intent', call_id: 'crashed', projected_usd: 0.001 });
    journal.append({ type: 'call', call_id: 'crashed', cost_usd: 0.01, result: { status: 'ok' }, terminal: true });
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'ok', input_tokens: 1, answers: {} };
    });
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 0);
    assert.equal(journal.read().find((r) => r.type === 'budget_stop')?.reason, 'actual_cost_exceeds_projection');
  }));
test('an excessive acknowledged receipt preserves cancellation and prevents later resume dispatch', () =>
  fixture(async (journal) => {
    const controller = new AbortController();
    let n = 0;
    const p = provider(async () => {
      n++;
      controller.abort();
      return { status: 'ok', input_tokens: 1000000, answers: {} };
    });
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, signal: controller.signal, ...clock });
    const records = journal.read();
    assert.equal(records.find((r) => r.type === 'call')?.cost_usd, 0.1);
    assert.ok(records.find((r) => r.type === 'budget_stop'));
    assert.equal(records.at(-1)?.type, 'cancelled');
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 1);
  }));
test('Retry-After honored, over-bound backoff fails without early retry', () =>
  fixture(async (journal) => {
    const waits: number[] = [];
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'failed', http_status: 429, retry_after_ms: n === 1 ? 1234 : 61000 };
    });
    await execute({
      entries: [entry],
      providers: [p],
      journal,
      maxSpend: 2,
      now: clock.now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.deepEqual(waits, [1234]);
    assert.equal(n, 2);
    assert.equal(
      journal
        .read()
        .filter((r) => r.type === 'call')
        .at(-1)!.terminal,
      true,
    );
  }));
test('competitor cap applies across resume and sites are sampled round-robin', () =>
  fixture(async (journal) => {
    const calls: string[] = [];
    const p = {
      ...provider(async (req) => {
        calls.push(String(req.state));
        return { status: 'ok' as const, model: 'fake', answers: {} };
      }),
      competitor: true,
    };
    const rows = Array.from({ length: 30 }, (_, n) =>
      ['loop.route', 'loop.continue'].map((site) => ({
        item: { ...item, id: `${site}-${n}`, site, state: site },
        split: 'holdout' as const,
        set_digest: 's',
      })),
    ).flat();
    await execute({ entries: rows, providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(calls.length, 40);
    assert.equal(calls.filter((s) => s === 'loop.route').length, 20);
    await execute({ entries: rows, providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(calls.length, 40);
  }));
test('terminal wrong-model results are replayed without repaying or recounting spend', () =>
  fixture(async (journal) => {
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'failed', reason: 'wrong_model', model: 'unexpected', input_tokens: 100 };
    });
    const run = () => execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    await run();
    const spent = journal.spent();
    await run();
    assert.equal(n, 1);
    assert.equal(journal.spent(), spent);
  }));
test('wrong-model retry records retain their attempt count on resume', () =>
  fixture(async (journal) => {
    const request = await buildRequest(item);
    for (let attempt = 0; attempt < 2; attempt++)
      journal.append({
        type: 'call',
        provider: 'fake',
        model: 'fake',
        site: item.site,
        item_id: item.id,
        set_digest: entry.set_digest,
        question_digest: digest(JSON.stringify(request)),
        request_digest: digest(JSON.stringify(request)),
        call_id: `retry-${attempt}`,
        result: { status: 'failed', reason: 'wrong_model', model: 'unexpected', http_status: 429 },
        terminal: false,
        cost_usd: 0,
      });
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'failed', reason: 'wrong_model', model: 'unexpected', http_status: 429 };
    });
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 1);
    assert.equal(
      journal
        .read()
        .filter((r) => r.type === 'call')
        .at(-1)!.terminal,
      true,
    );
  }));
test('unsupported question types fail only their item, including after legacy provider skips', () =>
  fixture(async (journal) => {
    journal.append({
      type: 'provider_status',
      provider: 'fake',
      result: { status: 'skipped', reason: 'unsupported_question_type' },
    });
    let n = 0;
    const p = provider(async () => {
      n++;
      return n === 1
        ? { status: 'skipped', reason: 'unsupported_question_type' }
        : { status: 'ok', model: 'fake', answers: {} };
    });
    const run = () =>
      execute({
        entries: [entry, { ...entry, item: { ...item, id: 'supported' } }],
        providers: [p],
        journal,
        maxSpend: 2,
        ...clock,
      });
    await run();
    assert.equal(n, 2);
    const calls = journal.read().filter((r) => r.type === 'call');
    assert.equal(calls[0]!.result.status, 'failed');
    assert.equal(calls[0]!.result.reason, 'unsupported_question_type');
    assert.equal(calls[1]!.result.status, 'ok');
    assert.equal(journal.read().filter((r) => r.type === 'provider_status').length, 1);
    await run();
    assert.equal(n, 2);
  }));
test('a metered budget stop still allows later zero-price providers', () =>
  fixture(async (journal) => {
    let paid = 0,
      free = 0;
    const metered = provider(async () => {
      paid++;
      return { status: 'ok', model: 'fake', answers: {} };
    });
    const unmetered = {
      ...provider(async () => {
        free++;
        return { status: 'ok' as const, model: 'fake', answers: {} };
      }),
      id: 'free',
      price: 0,
    };
    await execute({
      entries: [entry, { ...entry, item: { ...item, id: 'second' } }],
      providers: [metered, unmetered],
      journal,
      maxSpend: 0,
      ...clock,
    });
    assert.equal(paid, 0);
    assert.equal(free, 2);
    assert.equal(journal.read().filter((r) => r.type === 'budget_stop').length, 1);
  }));

test('quota skips last for one invocation, retry the uncalled item on resume, and remain journalled', () =>
  fixture(async (journal) => {
    let n = 0;
    const p = {
      ...provider(async () => {
        n++;
        return n === 1
          ? { status: 'skipped' as const, reason: 'quota_unavailable_or_weekly_cap' }
          : { status: 'ok' as const, model: 'fake', answers: {} };
      }),
      competitor: true,
    };
    const rows = [entry, { ...entry, item: { ...item, id: 'next' } }];
    const run = () => execute({ entries: rows, providers: [p], journal, maxSpend: 2, ...clock });
    await run();
    assert.equal(n, 1);
    const status = journal.read().find((r) => r.type === 'provider_status')!;
    assert.equal(status.persistent, false);
    await run();
    assert.equal(n, 3);
    assert.equal(journal.read().filter((r) => r.type === 'call' && r.result.status === 'ok').length, 2);
    await run();
    assert.equal(n, 3);
  }));
test('legacy quota skips are recoverable, while credential/auth/tool skips stay persistent', () =>
  fixture(async (journal) => {
    const request = await buildRequest(item);
    journal.append({
      type: 'provider_status',
      provider: 'fake',
      result: { status: 'skipped', reason: 'quota_unavailable_or_weekly_cap' },
    });
    journal.append({
      type: 'call',
      provider: 'fake',
      model: 'fake',
      site: item.site,
      item_id: item.id,
      set_digest: entry.set_digest,
      question_digest: digest(JSON.stringify(request)),
      call_id: 'legacy-quota',
      result: { status: 'skipped', reason: 'quota_unavailable_or_weekly_cap' },
      terminal: true,
      cost_usd: 0,
    });
    let n = 0;
    const p = provider(async () => {
      n++;
      return { status: 'ok', model: 'fake', answers: {} };
    });
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 1);
    for (const reason of ['auth_required', 'no_credential', 'tools_cannot_be_disabled']) {
      let attempts = 0;
      const persistent = {
        ...provider(async () => {
          attempts++;
          return { status: 'skipped' as const, reason };
        }),
        id: reason,
      };
      const run = () => execute({ entries: [entry], providers: [persistent], journal, maxSpend: 2, ...clock });
      await run();
      await run();
      assert.equal(attempts, 1);
      assert.equal(journal.read().find((r) => r.type === 'provider_status' && r.provider === reason)!.persistent, true);
    }
  }));

test('quota checks that made no inference call do not exhaust the competitor call cap', () =>
  fixture(async (journal) => {
    for (let n = 0; n < 40; n++) {
      journal.append({ type: 'intent', provider: 'fake', call_id: `quota-${n}`, projected_usd: 0 });
      journal.append({
        type: 'call',
        provider: 'fake',
        call_id: `quota-${n}`,
        result: { status: 'skipped', reason: 'quota_unavailable_or_weekly_cap' },
        cost_usd: 0,
        terminal: true,
      });
    }
    let calls = 0;
    const p = {
      ...provider(async () => {
        calls++;
        return { status: 'ok' as const, model: 'fake', answers: {} };
      }),
      competitor: true,
    };
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(calls, 1);
  }));

test('the competitor cap is checked before every attempt, so 429 retries cannot pass 40', async () =>
  fixture(async (journal) => {
    for (let i = 0; i < 39; i++) {
      journal.append({ type: 'intent', provider: 'fake', call_id: `paid-${i}`, projected_usd: 0 });
      journal.append({
        type: 'call',
        provider: 'fake',
        call_id: `paid-${i}`,
        result: { status: 'ok' },
        terminal: true,
        cost_usd: 0,
      });
    }
    let n = 0;
    const p = {
      ...provider(async () => {
        n++;
        return { status: 'failed' as const, http_status: 429, reason: 'rate_limited' };
      }),
      competitor: true,
    };
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 1, 'one attempt fits under the cap; its retries do not');
    assert.equal(countCompetitorCalls(journal.read(), 'fake'), 40);
    assert.ok(journal.read().some((r) => r.type === 'provider_status' && r.result.reason === 'call_cap'));
  }));

test('a request that may dispatch twice reserves both against the cap, and counts what it dispatched', async () =>
  fixture(async (journal) => {
    for (let i = 0; i < 37; i++) {
      journal.append({ type: 'intent', provider: 'fake', call_id: `paid-${i}`, projected_usd: 0 });
      journal.append({
        type: 'call',
        provider: 'fake',
        call_id: `paid-${i}`,
        result: { status: 'ok' },
        terminal: true,
        cost_usd: 0,
      });
    }
    const entries = ['a', 'b', 'c'].map((id) => ({ ...entry, item: { ...item, id, state: { task: id } } }));
    let n = 0;
    const p = {
      ...provider(async () => {
        n++;
        return { status: 'ok' as const, input_tokens: 7, answers: {}, dispatches: 2 };
      }),
      competitor: true,
      max_dispatches: 2,
    };
    await execute({ entries, providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 1, '37 + 2 fits; a second request could reach 41');
    assert.equal(countCompetitorCalls(journal.read(), 'fake'), 39);
    // An intent with no receipt (a crash mid-request) counts its full reservation.
    journal.append({ type: 'intent', provider: 'fake', call_id: 'lost', projected_usd: 0, dispatch_reservation: 2 });
    assert.equal(countCompetitorCalls(journal.read(), 'fake'), 41);
  }));

test('usage-less 429 retries stay charged at projection but are reported as reserved, not observed', () =>
  fixture(async (journal) => {
    let n = 0;
    const p = provider(async () => {
      n++;
      return n < 3
        ? { status: 'failed', http_status: 429, retry_after_ms: 0 }
        : { status: 'ok', model: 'fake', input_tokens: 7, answers: {} };
    });
    const projected = projectedCost(p.serialize(await buildRequest(item)), p.price),
      observed = (7 * p.price) / 1e6;
    await execute({ entries: [entry], providers: [p], journal, maxSpend: 2, ...clock });
    assert.equal(n, 3);
    // The budget keeps the conservative charge: a 429 without usage cannot prove it was unbilled.
    assert.equal(journal.spent(), projected + projected + observed);
    const split = ledger(journal.read());
    assert.equal(split.spent_usd, journal.spent());
    assert.equal(split.observed_usd, observed);
    assert.equal(split.reserved_usd, split.spent_usd - observed);
    assert.ok(Math.abs(split.reserved_usd - 2 * projected) < 1e-15);
    assert.equal(split.pending_reservation_usd, 0);
    // An unacknowledged intent is reserved and pending; a usage receipt is observed even when it costs more.
    journal.append({ type: 'intent', call_id: 'pending', projected_usd: 0.5 });
    journal.append({ type: 'intent', call_id: 'excess', projected_usd: 0.001 });
    journal.append({ type: 'call', call_id: 'excess', cost_usd: 0.002, result: { status: 'ok', input_tokens: 20000 } });
    const after = ledger(journal.read());
    assert.equal(after.spent_usd, journal.spent());
    assert.equal(after.pending_reservation_usd, 0.5);
    assert.equal(after.observed_usd, observed + 0.002);
    assert.equal(after.reserved_usd, after.spent_usd - after.observed_usd);
  }));

test('locked execution and resume do not repeatedly copy the full journal per item', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-index-'));
  const { acquireLock } = await import('./journal.ts');
  const release = acquireLock(dir);
  try {
    const journal = new Journal(join(dir, 'journal.jsonl'));
    const read = t.mock.method(journal, 'read');
    const entries = Array.from({ length: 12 }, (_, n) => ({ ...entry, item: { ...item, id: `item-${n}` } }));
    let calls = 0;
    const p = provider(async () => {
      calls++;
      return { status: 'ok', answers: {} };
    });
    const run = () => execute({ entries, providers: [p], journal, maxSpend: 2, ...clock });
    await run();
    await run();
    assert.equal(calls, entries.length);
    assert.ok(read.mock.callCount() <= 2, `full journal reads: ${read.mock.callCount()}`);
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});

test('render-only legacy binding requires an absent request digest, not null', async () => {
  const { bindObservations } = await import('./observations.ts');
  const { bindingFor } = await import('./binding.ts');
  const p = provider(async () => ({ status: 'ok', answers: {} }));
  const binding = bindingFor(p, entry, await buildRequest(entry.item));
  const legacy = { ...binding, type: 'call', call_id: 'legacy', result: { status: 'ok', answers: {} }, terminal: true };
  delete (legacy as { request_digest?: string }).request_digest;
  const invalid = { ...legacy, request_digest: null, call_id: 'null' };
  const result = await bindObservations([legacy, invalid], [p], [entry], true);
  assert.equal(result.bound[0]?.call_id, 'legacy');
  const nullOnly = await bindObservations([invalid], [p], [entry], true);
  assert.equal(nullOnly.bound.length, 0);
});
