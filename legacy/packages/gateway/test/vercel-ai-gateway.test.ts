/**
 * The Vercel AI Gateway evaluator against a local stub of the gateway's
 * evaluation endpoint. Offline: the stub listens on loopback and the adapter
 * is pointed at it with `baseURL`.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { vercelAiGatewayEvaluator } from '@weave/gateway/vercel-ai-gateway';
import type { EvaluationCall } from '@weave/gateway';

const CALL: EvaluationCall = {
  model: 'typesafe/jev-preview',
  kind: 'boolean',
  state: 'payouts failing for three days',
  questions: {
    urgent: { type: 'boolean', instructions: 'Urgent?' },
    blocked: { type: 'boolean', instructions: 'Blocked?' },
    stale: { type: 'boolean', instructions: 'Stale?' },
  },
  signal: undefined,
};

async function withStub(body: unknown, run: (baseURL: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Vercel AI Gateway evaluator: provider confidence', () => {
  it('forwards a published non-number confidence as NaN so a site reads it as invalid, not absent', async () => {
    await withStub(
      {
        answers: {
          urgent: { type: 'boolean', probability: 0.9 },
          blocked: { type: 'boolean', probability: 0.2 },
          stale: { type: 'boolean', probability: 0.1 },
        },
        usage: { inputTokens: 10, outputTokens: 3 },
        providerMetadata: { typesafe: { confidence: { urgent: 0.95, blocked: 'high', stale: null } } },
      },
      async (baseURL) => {
        const result = await vercelAiGatewayEvaluator({ apiKey: 'test-key', baseURL }).evaluate(CALL);
        assert.equal(result.status, 'completed');
        if (result.status !== 'completed') return;
        assert.deepEqual(result.answers['urgent'], { type: 'boolean', probability: 0.9 });
        assert.deepEqual(result.confidence, { urgent: 0.95, blocked: NaN, stale: NaN });
      },
    );
  });

  it('reports no confidence when the provider publishes none', async () => {
    await withStub(
      {
        answers: {
          urgent: { type: 'boolean', probability: 0.9 },
          blocked: { type: 'boolean', probability: 0.2 },
          stale: { type: 'boolean', probability: 0.1 },
        },
      },
      async (baseURL) => {
        const result = await vercelAiGatewayEvaluator({ apiKey: 'test-key', baseURL }).evaluate(CALL);
        assert.equal(result.status, 'completed');
        if (result.status === 'completed') assert.equal(result.confidence, undefined);
      },
    );
  });
});
