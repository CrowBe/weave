/** Offline composition contract: a free-tier refusal immediately escalates. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createInferenceGateway,
  type GenerationAdapter,
  type GenerationProviderResult,
  type GenerationRequest,
  type ProviderAvailability,
  type ProviderFailureCode,
  type RoutedUnit,
} from '@weave/gateway';
import {
  opencodeZenAdapter,
  OPENCODE_ZEN_ADAPTER,
  OPENCODE_ZEN_DESTINATION,
  OPENCODE_ZEN_MODEL,
  OPENCODE_ZEN_MODELS_URL,
} from '@weave/gateway/opencode-zen';

const KEY = 'sk-test-SENTINEL-zen-gateway-credential';
const SHARED = {
  operation: 'generate', kind: 'transform', context_profile: 'profile.none',
  context_profile_version: 1, prompt_template: 'template.public', prompt_template_version: 1,
  settings: { max_output_tokens: 4_096 }, quality: 'baseline', context_limit_tokens: 100_000,
  price: { input_per_mtok: 0, output_per_mtok: 0 },
} as const;
const ZEN: RoutedUnit = {
  ...SHARED, routed_unit_id: 'public@zen', adapter: OPENCODE_ZEN_ADAPTER,
  model: OPENCODE_ZEN_MODEL, destination: OPENCODE_ZEN_DESTINATION,
};
const SECOND: RoutedUnit = {
  ...SHARED, routed_unit_id: 'public@second', adapter: 'second', model: 'fake-free', destination: 'second',
};
const TERMS = {
  quality: 'baseline', destinations: [OPENCODE_ZEN_DESTINATION, 'second'], max_context_tokens: 100,
  deadline: 10_000, cost_ceiling: 1_000, max_attempts: 4,
} as const;
function request(terms: Partial<GenerationRequest['terms']> = {}): GenerationRequest {
  return { request_id: 'req_zen', site: 'test.zen', role: 'working', kind: 'transform',
    input: { instructions: 'Be brief.', prompt: 'Reply with the single word: ok' },
    terms: { ...TERMS, ...terms } };
}
function completed(): GenerationProviderResult {
  return { status: 'completed', text: 'ok', usage: { input_tokens: 2, output_tokens: 1 },
    finish_reason: 'stop', provider_response_id: 'fake-response' };
}
function failed(code: ProviderFailureCode): GenerationProviderResult {
  return { status: 'failed', failure: { code, message: 'safe failure', retryable: false } };
}
function fakeSecond(result: GenerationProviderResult = completed()) {
  let calls = 0;
  const adapter: GenerationAdapter = { id: 'second', async execute() { calls++; return result; } };
  return { adapter, get calls() { return calls; } };
}
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const LIST = { data: [{ id: OPENCODE_ZEN_MODEL }] };
interface Sent { url: string; init: RequestInit }
function fixture(options: {
  list?: () => Response | Promise<Response>;
  generation?: () => Response | Promise<Response>;
  second?: GenerationProviderResult;
  routes?: readonly RoutedUnit[];
  availability?: ProviderAvailability;
} = {}) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} });
    return String(url) === OPENCODE_ZEN_MODELS_URL
      ? await (options.list?.() ?? response(LIST))
      : await (options.generation?.() ?? response({ error: { message: `${KEY} ${JSON.stringify(init?.headers)}` } }, 429));
  };
  const second = fakeSecond(options.second);
  const waits: number[] = [];
  const clock = { time: 100, now() { return this.time; } };
  const gateway = createInferenceGateway({
    routes: options.routes ?? [ZEN, SECOND],
    ...(options.availability === undefined ? {} : { availability: options.availability }),
    adapters: [opencodeZenAdapter({ apiKey: KEY, fetch }), second.adapter], clock,
    timer: { async sleep(ms) { waits.push(ms); } },
  });
  return { gateway, sent, second, waits, clock };
}
function assertSafe(outcome: unknown) { assert.ok(!JSON.stringify(outcome).includes(KEY), 'attempt records and trace must never disclose the credential'); }

const LIST_FAILURES: ReadonlyArray<readonly [string, () => Response | Promise<Response>]> = [
  ['missing model', () => response({ data: [{ id: 'deepseek-v4.1-flash' }] })],
  ['unreachable list', () => { throw new TypeError(`network failed ${KEY}`); }],
  ['list HTTP 500', () => response({ error: KEY }, 500)],
  ['list HTTP 401', () => response({ error: KEY }, 401)],
  ['malformed list JSON', () => new Response(`<html>${KEY}</html>`, { headers: { 'content-type': 'application/json' } })],
  ['wrong list shape', () => response({ models: [OPENCODE_ZEN_MODEL], secret: KEY })],
];

describe('OpenCode Zen gateway escalation', () => {
  for (const retryAfter of [undefined, '9999']) {
    it(`escalates a 429 ${retryAfter ? 'with' : 'without'} Retry-After after exactly one Zen generation and no wait`, async () => {
      const f = fixture({ generation: () => response({ error: { message: `Bearer ${KEY}` } }, 429,
        retryAfter ? { 'retry-after': retryAfter } : {}) });
      const outcome = await f.gateway.generate(request());
      assert.equal(outcome.status, 'accepted');
      assert.equal(outcome.status === 'accepted' && outcome.routed_unit_id, SECOND.routed_unit_id);
      assert.deepEqual(outcome.attempts.map(a => a.routed_unit_id), [ZEN.routed_unit_id, SECOND.routed_unit_id]);
      assert.deepEqual(outcome.attempts[0]?.disposition.status === 'failed' && {
        code: outcome.attempts[0].disposition.failure.code,
        retryable: outcome.attempts[0].disposition.failure.retryable,
        retry_after_ms: outcome.attempts[0].disposition.failure.retry_after_ms,
      }, { code: 'unavailable', retryable: false, retry_after_ms: undefined });
      assert.equal(f.sent.filter(s => s.init.method === 'POST').length, 1);
      assert.equal(f.sent.filter(s => s.url === OPENCODE_ZEN_MODELS_URL).length, 1);
      assert.equal(new Headers(f.sent[0]!.init.headers).has('authorization'), false);
      assert.equal(f.second.calls, 1);
      assert.deepEqual(f.waits, []);
      assertSafe(outcome);
    });
  }
  for (const [name, list] of LIST_FAILURES) {
    it(`escalates ${name} without a Zen generation, retry, wait, or credential disclosure`, async () => {
      const f = fixture({ list });
      const outcome = await f.gateway.generate(request());
      assert.equal(outcome.status, 'accepted');
      assert.equal(outcome.status === 'accepted' && outcome.routed_unit_id, SECOND.routed_unit_id);
      assert.deepEqual(outcome.attempts.map(a => a.routed_unit_id), [ZEN.routed_unit_id, SECOND.routed_unit_id]);
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0]?.url, OPENCODE_ZEN_MODELS_URL);
      assert.equal(new Headers(f.sent[0]?.init.headers).has('authorization'), false);
      assert.ok(!JSON.stringify(f.sent).includes(KEY));
      assert.equal(f.second.calls, 1);
      assert.deepEqual(f.waits, []);
      assertSafe(outcome);
    });
  }

  it('blocks provider_unavailable once every eligible generation unit is unavailable', async () => {
    const f = fixture({ second: failed('unavailable') });
    const outcome = await f.gateway.generate(request());
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'provider_unavailable');
    assert.equal(outcome.attempts.length, 2);
    assert.equal(f.sent.filter(s => s.init.method === 'POST').length, 1);
    assert.equal(f.second.calls, 1);
    assertSafe(outcome);
  });

  for (const count of [1, 2]) {
    it(`blocks provider_unavailable when ${count} unavailable units complete escalation at the attempt cap`, async () => {
      const f = fixture({ routes: count === 1 ? [ZEN] : [ZEN, SECOND], second: failed('unavailable') });
      const outcome = await f.gateway.generate(request({ max_attempts: count }));
      assert.equal(outcome.status, 'blocked');
      assert.equal(outcome.status === 'blocked' && outcome.reason, 'provider_unavailable');
      assert.equal(outcome.attempts.length, count);
      assert.equal(f.second.calls, count - 1);
      assertSafe(outcome);
    });
  }

  it('does not classify a mixture of unavailable and unauthorized as provider_unavailable', async () => {
    const f = fixture({ second: failed('unauthorized') });
    const outcome = await f.gateway.generate(request());
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'provider_failed');
    assert.equal(outcome.attempts.length, 2);
  });

  it('blocks when all permitted units are unavailable without disclosing to an unapproved fallback', async () => {
    const f = fixture();
    const outcome = await f.gateway.generate(request({ destinations: [OPENCODE_ZEN_DESTINATION] }));
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'provider_unavailable');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(f.second.calls, 0);
    assertSafe(outcome);
  });

  it('preserves the attempt bound before reaching a remaining eligible fallback', async () => {
    const f = fixture();
    const outcome = await f.gateway.generate(request({ max_attempts: 1 }));
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'attempts_exhausted');
    assert.equal(f.second.calls, 0);
    assert.equal(outcome.attempts.length, 1);
  });

  it('preserves the attempt cap if another routed unit becomes available after the last attempt', async () => {
    const availability = { second: 'unavailable' as 'unavailable' | 'available' };
    const f = fixture({ availability, generation: () => {
      availability.second = 'available';
      return response({}, 429);
    } });
    const outcome = await f.gateway.generate(request({ max_attempts: 1 }));
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'attempts_exhausted');
    assert.equal(f.second.calls, 0);
    assert.equal(outcome.attempts.length, 1);
  });

  it('preserves an expired deadline when all units become unavailable at the attempt cap', async () => {
    const f = fixture({ routes: [ZEN], generation: () => {
      f.clock.time = TERMS.deadline;
      return response({}, 429);
    } });
    const outcome = await f.gateway.generate(request({ max_attempts: 1 }));
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'deadline_reached');
    assert.equal(outcome.attempts.length, 1);
  });

  it('preserves an exhausted budget when all units become unavailable at the attempt cap', async () => {
    const paid: RoutedUnit = { ...ZEN, price: { input_per_mtok: 1_000_000, output_per_mtok: 1_000_000 } };
    const f = fixture({ routes: [paid] });
    const outcome = await f.gateway.generate(request({ max_attempts: 1, cost_ceiling: 4_196 }));
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'budget_exhausted');
    assert.equal(outcome.attempts.length, 1);
  });

  it('preserves the deadline when it expires after the unavailable attempt', async () => {
    const f = fixture({ generation: () => { f.clock.time = TERMS.deadline; return response({}, 429); } });
    const outcome = await f.gateway.generate(request());
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'deadline_reached');
    assert.equal(f.second.calls, 0);
  });

  it('preserves budget exhaustion before a paid eligible fallback', async () => {
    const paidZen: RoutedUnit = { ...ZEN, price: { input_per_mtok: 1_000_000, output_per_mtok: 1_000_000 } };
    const paidSecond: RoutedUnit = { ...SECOND, price: paidZen.price };
    const f = fixture({ routes: [paidZen, paidSecond] });
    const outcome = await f.gateway.generate(request({ cost_ceiling: 4_196 }));
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'budget_exhausted');
    assert.equal(f.second.calls, 0);
  });

  it('excludes Zen before any network call unless the caller explicitly permits its destination', async () => {
    const f = fixture({ routes: [ZEN] });
    const outcome = await f.gateway.generate(request({ destinations: ['local'] }));
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.status === 'blocked' && outcome.reason, 'no_route');
    assert.equal(outcome.attempts.length, 0);
    assert.equal(f.sent.length, 0);
  });

  it('does no network or fallback work for cancellation before start', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException(`stop ${KEY}`, 'AbortError'));
    const f = fixture();
    const outcome = await f.gateway.generate(request(), controller.signal);
    assert.equal(outcome.status, 'unaccepted');
    assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'provider_failed');
    assert.equal(f.sent.length, 0);
    assert.equal(f.second.calls, 0);
    assertSafe(outcome);
  });

  for (const phase of ['list', 'generation'] as const) {
    it(`does not retry or fall back after caller cancellation during ${phase}`, async () => {
      const controller = new AbortController();
      const sent: Sent[] = [];
      let started!: () => void;
      const start = new Promise<void>(resolve => { started = resolve; });
      const fetch: typeof globalThis.fetch = async (url, init) => {
        sent.push({ url: String(url), init: init ?? {} });
        if (phase === 'generation' && String(url) === OPENCODE_ZEN_MODELS_URL) return response(LIST);
        assert.ok(init?.signal);
        started();
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      };
      const second = fakeSecond();
      const gateway = createInferenceGateway({ routes: [ZEN, SECOND], clock: { now: () => 100 },
        adapters: [opencodeZenAdapter({ apiKey: KEY, fetch }), second.adapter] });
      const pending = gateway.generate(request(), controller.signal);
      assert.equal(await Promise.race([start.then(() => 'started'), pending.then(() => 'completed')]), 'started');
      controller.abort(new DOMException(`stop ${KEY}`, 'AbortError'));
      const outcome = await pending;
      assert.equal(outcome.status, 'unaccepted');
      assert.equal(outcome.status === 'unaccepted' && outcome.reason, 'provider_failed');
      assert.equal(outcome.attempts.length, 1);
      assert.equal(outcome.attempts[0]?.disposition.status === 'failed' && outcome.attempts[0].disposition.failure.code, 'cancelled');
      assert.equal(sent.length, phase === 'list' ? 1 : 2);
      assert.equal(second.calls, 0);
      assertSafe(outcome);
    });
  }
});
