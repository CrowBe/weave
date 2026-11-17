import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localConfiguration } from './config.ts';
import { localTextAdapter } from '@weave/gateway/local-text';
import { liquidLocalEvaluator } from '@weave/gateway/liquid-local';

test('missing extraction configuration is explicit; a local endpoint enables the real route', () => {
  const directory = mkdtempSync(join(tmpdir(), 'loom-config-'));
  try {
    writeFileSync(
      join(directory, 'weave.routes.example.json'),
      readFileSync(new URL('../../weave.routes.example.json', import.meta.url)),
    );
    const root = pathToFileURL(directory + '/');
    const missing = localConfiguration({ TYPESAFE_API_KEY: 'test-credential' }, root);
    assert.equal(missing.status.ready, false);
    const configured = localConfiguration(
      {
        TYPESAFE_API_KEY: 'test-credential',
        LOOM_LOCAL_BASE_URL: 'http://127.0.0.1:8000/v1',
        LOOM_LOCAL_MODEL: 'test-model',
      },
      root,
    );
    assert.equal(configured.status.ready, true);
    assert.equal(configured.status.generation_available, false);
    assert.ok(configured.status.routes.some((route) => route.model === 'test-model' && route.destination === 'local'));
    assert.ok(configured.status.routes.some((route) => route.id === 'local-text.extract'));
    assert.ok(!JSON.stringify(configured.status).includes('test-credential'));
    const native = localConfiguration(
      { LOOM_EXTRACTOR: 'clairic', LOOM_DECISION_BASE_URL: 'http://127.0.0.1:8082', LOOM_DECISION_MODEL: 'd1-2b' },
      root,
    );
    assert.equal(native.status.ready, true);
    assert.ok(native.status.routes.some((route) => route.model === 'd1-2b' && route.destination === 'local'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('local generation refuses remote endpoints and speaks the existing completions wire', async () => {
  assert.throws(() => localTextAdapter({ baseURL: 'https://remote.example/v1' }), /loopback/);
  let destination = '';
  const adapter = localTextAdapter({
    baseURL: 'http://127.0.0.1:8000/v1',
    fetch: async (input, init) => {
      destination = String(input);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'test-model');
      return Response.json({
        id: 'test-response',
        choices: [{ message: { content: 'result' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });
  const outcome = await adapter.execute({
    model: 'test-model',
    instructions: 'transform text',
    prompt: 'input',
    settings: { max_output_tokens: 32 },
    signal: undefined,
  });
  assert.equal(destination, 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(outcome.status, 'completed');
});

test('local Liquid decisions preserve native probabilities and zero output usage', async () => {
  assert.throws(() => liquidLocalEvaluator({ baseURL: 'https://remote.example' }), /loopback/);
  const evaluator = liquidLocalEvaluator({
    baseURL: 'http://127.0.0.1:8082',
    fetch: async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:8082/v1/systemone');
      const request = JSON.parse(String(init?.body));
      assert.equal(request.questions.decision.type, 'choice');
      return Response.json({
        model: 'd1-2b',
        answers: {
          decision: {
            type: 'choice',
            choice: 'normalize',
            probabilities: { normalize: 0.9, generate: 0.1 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 50, output_tokens: 0 },
      });
    },
  });
  const result = await evaluator.evaluate({
    model: 'd1-2b',
    kind: 'choice',
    state: 'Normalize whitespace.',
    questions: {
      decision: {
        type: 'choice',
        instructions: 'Choose an operation.',
        criteria: { normalize: 'Normalize', generate: 'Generate' },
      },
    },
    signal: undefined,
  });
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') {
    assert.deepEqual(result.answers.decision, {
      type: 'choice',
      choice: 'normalize',
      probabilities: { normalize: 0.9, generate: 0.1 },
    });
    assert.equal(result.usage.output_tokens, 0);
  }
});
