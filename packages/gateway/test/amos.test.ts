import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import { amosEvaluator, resolveAmosBaseURL, AMOS_BASE_URL } from '@weave/gateway/amos';
import type { EvaluationCall } from '@weave/gateway';

const call: EvaluationCall = {
  model: 'amos-1-2b',
  kind: 'choice',
  state: { observation: 'Fix the failing tests' },
  signal: undefined,
  questions: {
    urgent: {
      type: 'boolean',
      instructions: 'Urgent?',
      criteria: { true: 'urgent', false: 'routine' },
    },
    category: { type: 'choice', instructions: 'Category?', criteria: { work: 'task', chat: null } },
    severity: { type: 'score', instructions: 'Severity?', criteria: ['low', 'high'] },
  },
};
const body = {
  model: 'amos-1-2b',
  usage: { input_tokens: 20, output_tokens: 12 },
  answers: {
    urgent: { type: 'noul', noul: 0.9 },
    category: {
      type: 'choice',
      choice: 'work',
      probabilities: { work: 0.9, chat: 0.1 },
      confidence: 0.9,
    },
    severity: {
      type: 'score',
      score: 0.8,
      legend: { '0': 'low', '1': 'high' },
      probabilities: { '0': 0.2, '1': 0.8 },
      confidence: 0.8,
    },
  },
};
async function stub(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseURL: string) => Promise<void>,
) {
  const server = createServer(handler);
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
function serve(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

describe('Amos local decision contract', () => {
  it('resolves the supplied environment and defaults without ambient reads', () => {
    assert.equal(resolveAmosBaseURL({}), AMOS_BASE_URL);
    assert.equal(
      resolveAmosBaseURL({ AMOS_BASE_URL: 'http://localhost:9000' }),
      'http://localhost:9000',
    );
  });
  it('rejects remote URLs, credentials, queries, and fragments', () => {
    for (const baseURL of [
      'https://example.com',
      'http://192.168.1.1:8766',
      'http://user:secret@127.0.0.1',
      'http://localhost?',
      'http://localhost#',
      'file:///tmp/amos',
      '',
      ' ',
      'not a url',
      '127.0.0.1:8766',
    ]) {
      assert.throws(() => amosEvaluator({ baseURL }), /loopback HTTP URL/);
    }
    for (const baseURL of ['http://127.0.0.1:8766', 'http://localhost:8766', 'http://[::1]:8766']) {
      assert.doesNotThrow(() => amosEvaluator({ baseURL }));
    }
  });
  it('checks models and translates all three question types without credentials', async () => {
    const paths: string[] = [];
    await stub(
      (request, response) => {
        paths.push(request.url ?? '');
        assert.equal(request.headers.authorization, undefined);
        if (request.url === '/v1/models') {
          assert.equal(request.method, 'GET');
          serve(response, { models: [{ name: 'amos-1-2b' }] });
          return;
        }
        assert.equal(request.method, 'POST');
        let raw = '';
        request.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        request.on('end', () => {
          const sent = JSON.parse(raw) as Record<string, unknown>;
          assert.equal(sent['state'], JSON.stringify(call.state));
          assert.deepEqual(sent['questions'], {
            urgent: {
              type: 'noul',
              instructions: 'Urgent?',
              criteria: { true: 'urgent', false: 'routine' },
            },
            category: {
              type: 'choice',
              instructions: 'Category?',
              criteria: { work: 'task', chat: null },
            },
            severity: { type: 'score', instructions: 'Severity?', criteria: ['low', 'high'] },
          });
          serve(response, body);
        });
      },
      async (baseURL) => {
        const result = await amosEvaluator({ baseURL }).evaluate(call);
        assert.equal(result.status, 'completed');
        if (result.status !== 'completed') return;
        assert.deepEqual(result.answers['urgent'], { type: 'boolean', probability: 0.9 });
        assert.deepEqual(result.answers['category'], {
          type: 'choice',
          choice: 'work',
          probabilities: { work: 0.9, chat: 0.1 },
        });
        assert.deepEqual(result.answers['severity'], {
          type: 'score',
          score: 0.8,
          probabilities: { '0': 0.2, '1': 0.8 },
        });
        assert.deepEqual(result.confidence, { category: 0.9, severity: 0.8 });
        assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 12 });
      },
    );
    assert.deepEqual(paths, ['/v1/models', '/v1/systemone']);
  });
  it('maps non-2xx health to unavailable without exposing raw text or making a decision call', async () => {
    await stub(
      (request, response) => {
        assert.equal(request.url, '/v1/models');
        serve(response, 'private provider text', 503);
      },
      async (baseURL) => {
        const result = await amosEvaluator({ baseURL }).evaluate(call);
        assert.equal(result.status === 'failed' && result.failure.code, 'unavailable');
        assert.equal(JSON.stringify(result).includes('private'), false);
      },
    );
  });
  it('maps unreachable health to unavailable', async () => {
    let closedURL = '';
    await stub(
      (_request, response) => serve(response, {}),
      async (baseURL) => {
        closedURL = baseURL;
      },
    );
    const result = await amosEvaluator({ baseURL: closedURL }).evaluate(call);
    assert.equal(result.status === 'failed' && result.failure.code, 'unavailable');
  });
  for (const stage of ['health', 'decision'])
    it(`bounds ${stage} timeout as unavailable`, async () => {
      await stub(
        (request, response) => {
          if (stage === 'decision' && request.url === '/v1/models')
            serve(response, { models: [{ name: 'amos-1-2b' }] });
        },
        async (baseURL) => {
          const result = await amosEvaluator({ baseURL, timeoutMs: 30 }).evaluate(call);
          assert.equal(result.status === 'failed' && result.failure.code, 'unavailable');
        },
      );
    });
  it('preserves caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await amosEvaluator().evaluate({ ...call, signal: controller.signal });
    assert.equal(result.status === 'failed' && result.failure.code, 'cancelled');
  });
  const malformed = [
    null,
    { answers: {} },
    { ...body, answers: { ...body.answers, unknown: body.answers.urgent } },
    ...[
      { ...body.answers.category, choice: 'private unknown option' },
      { ...body.answers.category, probabilities: { work: 0.8, chat: 0.8 } },
      { ...body.answers.category, probabilities: { work: 1, chat: 'private' } },
      { ...body.answers.category, probabilities: { work: 1 } },
      { ...body.answers.category, confidence: 2 },
      { ...body.answers.category, probabilities: { work: -0.1, chat: 1.1 } },
    ].map((category) => ({ ...body, answers: { ...body.answers, category } })),
    { ...body, answers: { ...body.answers, urgent: { type: 'noul', noul: 2 } } },
    { ...body, answers: { ...body.answers, severity: { ...body.answers.severity, score: 2 } } },
    {
      ...body,
      answers: {
        ...body.answers,
        severity: { ...body.answers.severity, legend: { '0': 'private', '1': 'high' } },
      },
    },
  ];
  for (const [index, value] of malformed.entries())
    it(`rejects malformed response ${index} without provider text`, async () => {
      await stub(
        (request, response) =>
          serve(
            response,
            request.url === '/v1/models' ? { models: [{ name: 'amos-1-2b' }] } : value,
          ),
        async (baseURL) => {
          const result = await amosEvaluator({ baseURL }).evaluate(call);
          assert.equal(result.status === 'failed' && result.failure.code, 'malformed_response');
          assert.equal(JSON.stringify(result).includes('private'), false);
        },
      );
    });
  it('refuses a model the server does not list, without a decision call', async () => {
    const paths: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      paths.push(new URL(String(url)).pathname);
      return String(url).endsWith('/v1/models')
        ? new Response(JSON.stringify({ models: [{ name: 'amos-1-2b' }] }))
        : new Response(JSON.stringify(body));
    }) as typeof globalThis.fetch;
    const result = await amosEvaluator({ fetch }).evaluate({ ...call, model: 'nope' });
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure.code, 'unavailable');
    // Retrying cannot make the server serve a model it does not list.
    assert.equal(result.failure.retryable, false);
    assert.deepEqual(paths, ['/v1/models']);
  });
  it('rejects a response that names a different model than the call', async () => {
    const fetch = (async (url: string | URL | Request) => String(url).endsWith('/v1/models')
      ? new Response(JSON.stringify({ models: [{ name: 'amos-1-2b' }, { name: 'amos-1-8b' }] }))
      : new Response(JSON.stringify(body))) as typeof globalThis.fetch;
    const result = await amosEvaluator({ fetch }).evaluate({ ...call, model: 'amos-1-8b' });
    assert.equal(result.status === 'failed' && result.failure.code, 'malformed_response');
  });
  it('reads a score legend that echoes a null level as null or as the string null', async () => {
    const nullLevel: EvaluationCall = {
      ...call,
      kind: 'score',
      questions: { severity: { type: 'score', instructions: 'Severity?', criteria: ['low', null] } },
    };
    const answer = { type: 'score', score: 0.8, probabilities: { '0': 0.2, '1': 0.8 } };
    for (const legend of [{ '0': 'low', '1': 'null' }, { '0': 'low', '1': null }]) {
      const fetch = (async (url: string | URL | Request) => String(url).endsWith('/v1/models')
        ? new Response(JSON.stringify({ models: [{ name: 'amos-1-2b' }] }))
        : new Response(JSON.stringify({ ...body, answers: { severity: { ...answer, legend } } }))) as typeof globalThis.fetch;
      const result = await amosEvaluator({ fetch }).evaluate(nullLevel);
      assert.equal(result.status, 'completed', JSON.stringify(legend));
      if (result.status === 'completed') assert.deepEqual(result.answers['severity'], { type: 'score', score: 0.8, probabilities: { '0': 0.2, '1': 0.8 } });
    }
    for (const legend of [{ '0': 'low', '1': 'high' }, { '0': 'null', '1': null }]) {
      const fetch = (async (url: string | URL | Request) => String(url).endsWith('/v1/models')
        ? new Response(JSON.stringify({ models: [{ name: 'amos-1-2b' }] }))
        : new Response(JSON.stringify({ ...body, answers: { severity: { ...answer, legend } } }))) as typeof globalThis.fetch;
      const result = await amosEvaluator({ fetch }).evaluate(nullLevel);
      assert.equal(result.status === 'failed' && result.failure.code, 'malformed_response', JSON.stringify(legend));
    }
  });
  it('round-trips a multi-entry boolean preselect set as noul', async () => {
    const questions = {
      entry_0: { type: 'boolean' as const, instructions: 'Is this disclosed catalogue entry relevant to this step?' },
      entry_1: { type: 'boolean' as const, instructions: 'Is this disclosed catalogue entry relevant to this step?' },
      entry_2: { type: 'boolean' as const, instructions: 'Is this disclosed catalogue entry relevant to this step?' },
    };
    let posted: { model?: string; questions?: Record<string, { type?: string }> } | undefined;
    let authorization: string | undefined;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/v1/models')) return new Response(JSON.stringify({ models: [{ name: 'amos-1-2b' }] }), { status: 200 });
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authorization = headers['authorization'];
      posted = JSON.parse(String(init?.body)) as typeof posted;
      return new Response(JSON.stringify({
        model: 'amos-1-2b',
        usage: { input_tokens: 30, output_tokens: 12 },
        answers: {
          entry_0: { type: 'noul', noul: 0.91, confidence: 0.8 },
          entry_1: { type: 'noul', noul: 0.42, confidence: 0.81 },
          entry_2: { type: 'noul', noul: 0.07, confidence: 0.95 },
        },
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await amosEvaluator({ baseURL: 'http://127.0.0.1:8766', fetch }).evaluate({
      model: 'amos-1-2b',
      kind: 'boolean',
      state: { step: 'narrow the disclosed index', catalogue_index: ['entry_0', 'entry_1', 'entry_2'] },
      signal: undefined,
      questions,
    });
    assert.equal(authorization, undefined);
    assert.equal(posted?.model, 'amos-1-2b');
    assert.deepEqual(Object.keys(posted?.questions ?? {}), ['entry_0', 'entry_1', 'entry_2']);
    assert.equal(posted?.questions?.['entry_0']?.type, 'noul');
    assert.equal(posted?.questions?.['entry_1']?.type, 'noul');
    assert.equal(posted?.questions?.['entry_2']?.type, 'noul');
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.deepEqual(result.answers['entry_0'], { type: 'boolean', probability: 0.91 });
    assert.deepEqual(result.answers['entry_1'], { type: 'boolean', probability: 0.42 });
    assert.deepEqual(result.answers['entry_2'], { type: 'boolean', probability: 0.07 });
    assert.deepEqual(result.confidence, { entry_0: 0.8, entry_1: 0.81, entry_2: 0.95 });
  });
});

it('live Amos intake classification', { skip: process.env['AMOS_LIVE'] !== '1' }, async () => {
  const result = await amosEvaluator({
    baseURL: process.env['AMOS_BASE_URL'] ?? 'http://127.0.0.1:8766',
    timeoutMs: 120_000,
  }).evaluate({
    model: 'amos-1-2b',
    kind: 'choice',
    state:
      'Inbound operator message: Please fix the failing unit tests. There are no running threads.',
    signal: undefined,
    questions: {
      classification: {
        type: 'choice',
        instructions: 'How should this inbound message relate to the running threads?',
        criteria: {
          new_thread: 'Start a new task',
          continue_thread: 'Continue an existing task',
          queue: 'Queue until later',
          steer: 'Change an existing task',
          interrupt: 'Interrupt running work',
          stop: 'Stop running work',
        },
      },
    },
  });
  console.log('AMOS_LIVE intake.classify:', JSON.stringify(result));
  assert.equal(result.status, 'completed');
});
