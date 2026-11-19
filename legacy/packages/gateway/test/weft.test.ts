/**
 * W5 (#187): the gateway's Weft emission (packages/weft/src/WEFT-CONTRACT.md,
 * Emission). Routing, attempts and outcomes are the same with or without a
 * sink: emission adds no guardrail to a route, reads no clock and spends no
 * deadline.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createInferenceGateway,
  type Clock,
  type GenerationAdapter,
  type GenerationProviderResult,
  type GenerationRequest,
  type RoutedUnit,
  type WeftPort,
  type WeftRecordShape,
} from '@weave/gateway';

const PERMITTED = 'test-destination';

function unit(
  routed_unit_id: string,
  adapter: string,
  destination = PERMITTED,
): Extract<RoutedUnit, { operation: 'generate' }> {
  return {
    operation: 'generate',
    kind: 'transform',
    context_profile: 'profile.test',
    context_profile_version: 1,
    prompt_template: 'template.test',
    prompt_template_version: 1,
    adapter,
    model: `${adapter}/model`,
    settings: { max_output_tokens: 1_000 },
    destination,
    billing: 'metered',
    quality: 'baseline',
    context_limit_tokens: 100_000,
    price: { input_per_mtok: 1, output_per_mtok: 1 },
    routed_unit_id,
  };
}

function scripted(id: string, script: readonly GenerationProviderResult[], during?: () => void): GenerationAdapter {
  let calls = 0;
  return {
    id,
    async execute(): Promise<GenerationProviderResult> {
      during?.();
      const result = script[Math.min(calls, script.length - 1)] as GenerationProviderResult;
      calls += 1;
      return result;
    },
  };
}

const failed = (code: 'rate_limited' | 'invalid_request', retryable: boolean): GenerationProviderResult => ({
  status: 'failed',
  failure: { code, message: `upstream said ${code} for sk-gatewaycanary0123456789`, retryable },
});

const completed: GenerationProviderResult = {
  status: 'completed',
  text: 'the answer',
  usage: { input_tokens: 1_000, output_tokens: 500 },
  finish_reason: 'stop',
  provider_response_id: 'resp_1',
};

function request(request_id = 'req_1'): GenerationRequest {
  return {
    request_id,
    site: 'test.site',
    role: 'working',
    kind: 'transform',
    input: { instructions: 'answer', prompt: 'question' },
    terms: {
      quality: 'baseline',
      destinations: [PERMITTED],
      max_context_tokens: 10_000,
      deadline: 10_000,
      cost_ceiling: 1_000,
      max_attempts: 3,
    },
  };
}

/** Ticks once per reading, so an extra clock read would show in the outcome. */
function fakeClock(): Clock {
  let t = 100;
  return { now: () => t++ };
}

function gateway(emit?: (record: WeftRecordShape) => unknown, during?: () => void) {
  const port: WeftPort | undefined = emit ? { trace_id: 'bench-1', emitter_id: 'gw', emit } : undefined;
  return createInferenceGateway({
    routes: [unit('unit.far', 'far', 'elsewhere'), unit('unit.a', 'a'), unit('unit.b', 'b')],
    adapters: [
      scripted('a', [failed('rate_limited', true), failed('invalid_request', false)], during),
      scripted('b', [completed], during),
      scripted('far', [completed]),
    ],
    clock: fakeClock(),
    ...(port ? { weft: port } : {}),
  });
}

describe('W5 gateway emission', () => {
  it('W5-T50 a retry and an escalation are explicit links, with exclusions and failure codes only', async () => {
    const records: WeftRecordShape[] = [];
    let emittedDuringRequest = -1;
    const gw = gateway(
      (r) => void records.push(r),
      () => {
        emittedDuringRequest = Math.max(emittedDuringRequest, records.length);
      },
    );
    const outcome = await gw.generate(request());
    assert.equal(outcome.status, 'accepted');
    assert.equal(emittedDuringRequest, 0, 'records reached the sink before the request settled');
    assert.deepEqual(
      records.map((r) => [r.record_id, r.kind, r.parent_id, r.links]),
      [
        ['gw:req_1:route:1', 'route.selected', null, []],
        ['gw:req_1:attempt:1', 'inference.attempt', 'gw:req_1:route:1', []],
        ['gw:req_1:attempt:1:error', 'error', 'gw:req_1:attempt:1', []],
        [
          'gw:req_1:attempt:2',
          'inference.attempt',
          'gw:req_1:route:1',
          [{ rel: 'retry_of', record_id: 'gw:req_1:attempt:1' }],
        ],
        ['gw:req_1:attempt:2:error', 'error', 'gw:req_1:attempt:2', []],
        [
          'gw:req_1:route:2',
          'route.selected',
          null,
          [
            { rel: 'supersedes', record_id: 'gw:req_1:route:1' },
            { rel: 'caused_by', record_id: 'gw:req_1:attempt:2' },
          ],
        ],
        [
          'gw:req_1:attempt:3',
          'inference.attempt',
          'gw:req_1:route:2',
          [{ rel: 'retry_of', record_id: 'gw:req_1:attempt:2' }],
        ],
      ],
    );
    assert.deepEqual(records[0]!.fields, {
      request_ref: 'req_1',
      routed_unit: 'unit.a',
      excluded: [{ routed_unit: 'unit.far', reason: 'destination_not_permitted' }],
    });
    assert.deepEqual(records[2]!.fields, { code: 'rate_limited', retryable: true });
    assert.deepEqual(records[4]!.fields, { code: 'invalid_request', retryable: false });
    const accepted = records[6]!.fields;
    assert.equal(accepted['disposition'], 'accepted');
    assert.equal(accepted['input_tokens'], 1_000);
    assert.equal(accepted['output_tokens'], 500);
    assert.equal(accepted['cost_is_upper_bound'], false);
    assert.equal(accepted['spent_micros'], 1);
    assert.equal(typeof accepted['latency_ms'], 'number');
    assert.deepEqual(
      records.map((r) => r.sequence),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.ok(records.every((r) => r.thread_id === null && r.trace_id === 'bench-1'));
    assert.ok(records.every((r) => r.emitter.kind === 'gateway' && r.emitter.id === 'gw'));
    assert.equal(JSON.stringify(records).includes('upstream said'), false);
    assert.equal(JSON.stringify(records).includes('sk-gatewaycanary'), false);
  });

  it('W5-T51 routing, attempts and outcome are identical with no sink, a sink, a throwing sink and a hanging sink', async () => {
    const plain = JSON.stringify(await gateway().generate(request()));
    for (const emit of [
      () => undefined,
      () => {
        throw new Error('sink down');
      },
      () => new Promise<never>(() => {}),
      () => Promise.reject(new Error('sink rejected')),
    ]) {
      assert.equal(JSON.stringify(await gateway(emit).generate(request())), plain);
    }
  });

  it("W5-T52 concurrent requests share one emitter sequence; each request's records stay together", async () => {
    const records: WeftRecordShape[] = [];
    const gw = gateway((r) => void records.push(r));
    await Promise.all([gw.generate(request('req_a')), gw.generate(request('req_b'))]);
    assert.deepEqual(
      records.map((r) => r.sequence),
      records.map((_, i) => i + 1),
    );
    const order = records.map((r) => (r.fields['request_ref'] as string | undefined) ?? r.evidence[0]!.ref);
    const firstSwitch = order.findIndex((ref) => ref !== order[0]);
    assert.ok(
      order.slice(firstSwitch).every((ref) => ref === order[firstSwitch]),
      'records of two requests interleaved',
    );
  });
});
