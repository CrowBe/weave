import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  GenerationRequest,
  EvaluationRequest,
  InferenceGateway,
  GenerationOutcome,
  EvaluationOutcome,
} from '@weave/gateway';
import { runLocalTask } from '@weave/weave';
import { localTaskPorts, type InferenceEvidence } from './ports.ts';

function gateway(options: { low?: boolean; ungrounded?: boolean } = {}): InferenceGateway {
  return {
    async generate(request: GenerationRequest): Promise<GenerationOutcome> {
      const text =
        request.site === 'local.extract'
          ? JSON.stringify({ intent: { value: 'Normalize " a   b "' } })
          : JSON.stringify({ text: options.ungrounded ? 'invented operand' : ' a   b ' });
      return {
        request_id: request.request_id,
        site: request.site,
        status: 'accepted',
        text,
        routed_unit_id: 'test-extraction',
        provider_response_id: undefined,
        attempts: [],
        spent: 1,
        uncertainty: [],
      };
    },
    async evaluate(request: EvaluationRequest): Promise<EvaluationOutcome> {
      const selected = request.site === 'local.band' ? 'tool_call' : 'text.normalize';
      return {
        request_id: request.request_id,
        site: request.site,
        status: 'accepted',
        kind: 'choice',
        answers: {
          decision: { type: 'choice', choice: selected, probabilities: { [selected]: options.low ? 0.4 : 0.98 } },
        },
        confidence: undefined,
        routed_unit_id: 'test-decision',
        provider_response_id: undefined,
        attempts: [],
        spent: 1,
        uncertainty: [],
      } as EvaluationOutcome;
    },
  } as InferenceGateway;
}
const budget = { max_calls: 10, cost_ceiling: 1000, per_call_ceiling: 100, deadline: 1000, destinations: ['local'] };
const limits = { max_nodes: 8, max_depth: 4, concurrency: 2 };

test('grounded extraction and admitted decisions execute the real Fabric operation', async () => {
  const evidence: InferenceEvidence[] = [];
  const local = localTaskPorts(
    gateway(),
    budget,
    () => 1,
    (event) => evidence.push(event),
  );
  const result = await runLocalTask('Normalize " a   b "', local.ports, limits);
  assert.equal(result.status, 'completed', result.reason ?? '');
  assert.deepEqual(result.output, { text: 'a b' });
  assert.equal(local.stats().calls, 4);
  assert.equal(local.stats().spent, 4);
  assert.equal(local.stats().reserved, 0);
  assert.ok(evidence.some((event) => event.site === 'local.fabric'));
});

test('low decision probabilities and invented operands never reach Fabric', async () => {
  for (const options of [{ low: true }, { ungrounded: true }]) {
    const evidence: InferenceEvidence[] = [];
    const local = localTaskPorts(
      gateway(options),
      budget,
      () => 1,
      (event) => evidence.push(event),
    );
    const result = await runLocalTask('Normalize " a   b "', local.ports, limits);
    assert.notEqual(result.status, 'completed');
    assert.ok(!evidence.some((event) => event.site === 'local.fabric'));
  }
});

test('inference allowance and thrown extraction ports stop explicitly', async () => {
  const local = localTaskPorts(
    gateway(),
    { ...budget, max_calls: 1 },
    () => 1,
    () => {},
  );
  const result = await runLocalTask('Normalize " a   b "', local.ports, limits);
  assert.equal(result.status, 'budget_exhausted');
  const broken = gateway();
  broken.generate = async () => {
    throw new Error('secret provider error');
  };
  const stopped = localTaskPorts(
    broken,
    budget,
    () => 1,
    () => {},
  );
  const failure = await runLocalTask('Normalize " a   b "', stopped.ports, limits);
  assert.equal(failure.status, 'failed');
  assert.ok(!JSON.stringify(failure).includes('secret provider error'));
});
