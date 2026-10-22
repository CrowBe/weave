import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { exportOtlp, createOtlpExporter } from '../src/otel.js';
import type { Redactor } from '@weave/weft';

const timer = (ms: number, expire: () => void) => {
  const handle = setTimeout(expire, ms);
  return () => clearTimeout(handle);
};
const keep: Redactor = r => r;
const record = (record_id = 'a', trace_id = 'trace') => ({
  schema: 'weft.record@1', trace_id, record_id,
  emitter: { kind: 'gateway', id: 'gateway' }, sequence: 0,
  kind: 'inference.attempt', thread_id: null, parent_id: null, links: [], evidence: [],
  fields: { request_ref: 'request', routed_unit: 'unit', attempt_no: 0,
    disposition: 'accepted', input_tokens: 7, output_tokens: 2, latency_ms: 1.5 },
});
const json = (records: unknown) => {
  const result = exportOtlp(records, { redact: keep });
  if (!result.ok) assert.fail(result.reason);
  return result.json;
};

test('golden mapping: deterministic ids, point times, parent and cross-thread links', () => {
  const a = record();
  const b = { ...record('b'), sequence: 1, kind: 'thread.transition', thread_id: 'thread-b',
    parent_id: 'a', links: [{ rel: 'handoff', record_id: 'a' }],
    evidence: [{ source: 'external', ref: 'evidence' }], fields: { transition: 'cancelled' } };
  assert.equal(json([b, a]), readFileSync(new URL('../../fixtures/otel-golden.json', import.meta.url), 'utf8').trimEnd());
  assert.equal(json([a, b, a]), json([b, a]));
});

test('malformed, partial, conflicting, sequence-invalid and cyclic batches fail closed', () => {
  const a = record();
  for (const [input, reason] of [
    [null, 'input'], [[null], 'disclosure'], [[{ ...a, fields: {} }], 'disclosure'],
    [[{ ...a, parent_id: 'missing' }], 'incomplete'],
    [[{ ...a, links: [{ rel: 'handoff', record_id: 'missing' }] }], 'incomplete'],
    [[a, { ...a, fields: { ...a.fields, input_tokens: 9 } }], 'conflict'],
    [[a, record('b')], 'sequence'],
    [[{ ...a, parent_id: 'b' }, { ...record('b'), sequence: 1, parent_id: 'a' }], 'parent_cycle'],
  ] as const) assert.deepEqual(exportOtlp(input, { redact: keep }), { ok: false, reason });
  assert.deepEqual(exportOtlp([a], { redact: () => { throw Error('secret'); } }), { ok: false, reason: 'disclosure' });
});

test('W4 canaries: environment, credential strings and single-use grants never cross export', () => {
  const canary = 'ENV-CANARY-032';
  process.env['WEFT_OTEL_CANARY'] = canary;
  try {
    assert.ok(!json([record()]).includes(canary));
    for (const patch of [{ record_id: 'sk-secret' }, { grant: { token: canary } },
      { fields: { ...record().fields, grant: canary } },
      { fields: { ...record().fields, request_ref: 'ghp_secret' } }]) {
      assert.deepEqual(exportOtlp([{ ...record(), ...patch }], { redact: keep }), { ok: false, reason: 'disclosure' });
    }
    const raw = { ...record(), fields: { ...record().fields, request_ref: canary } };
    const result = exportOtlp([raw], { redact: r => ({ ...r, fields: { ...r.fields, request_ref: 'redacted' } }) });
    assert.ok(result.ok && !result.json.includes(canary));
  } finally { delete process.env['WEFT_OTEL_CANARY']; }
});

test('one-way writes contain sync throws and async rejections; interleaved traces and crash retry are isolated', async () => {
  for (const write of [() => { throw Error('failure'); }, async () => { throw Error('failure'); }]) {
    assert.deepEqual(await createOtlpExporter({ timer, redact: keep, write }).export([record()]), { ok: false, reason: 'write' });
  }
  const writes: string[] = [];
  const exporter = createOtlpExporter({ timer, redact: keep, write: async (s: string) => { await Promise.resolve(); writes.push(s); } });
  const inputs = [[record('a', 'one')], [record('a', 'two')]];
  await Promise.all(inputs.map(r => exporter.export(r)));
  assert.deepEqual(writes, inputs.map(json));
  assert.ok(!writes[0]!.includes('two'));
  const crashed = createOtlpExporter({ timer, redact: keep, write: () => { throw Error(); } });
  await crashed.export(inputs[0]);
  assert.equal(json(inputs[0]), writes[0]);
  let called = false;
  await createOtlpExporter({ timer, redact: keep, write: () => { called = true; } }).export([{}]);
  assert.equal(called, false);
});

test('inline export follows the exact W4 trace/class/digest/credential boundary', () => {
  const text = 'ENV-CONTENT-CANARY-032';
  const digest = 'sha256:' + createHash('sha256').update(text).digest('hex');
  const goal = { ...record(), kind: 'goal.intent', fields: {
    goal_ref: 'goal', statement: { content_class: 'private', digest, text },
  } };
  assert.deepEqual(exportOtlp([goal], { redact: keep }), { ok: false, reason: 'disclosure' });
  const options = { redact: keep, inline: { trace_id: 'trace', classes: ['private'] as const } };
  const allowed = exportOtlp([goal], options);
  assert.ok(allowed.ok && allowed.json.includes(text));
  assert.deepEqual(exportOtlp([{ ...goal, trace_id: 'other' }], options), { ok: false, reason: 'disclosure' });
  for (const secret of ['sk-secret', 'ghp_secret', 'Bearer private', 'AKIAsecret']) {
    const value = { ...goal, fields: { ...goal.fields, statement: {
      content_class: 'private', digest: 'sha256:' + createHash('sha256').update(secret).digest('hex'), text: secret,
    } } };
    assert.deepEqual(exportOtlp([value], options), { ok: false, reason: 'disclosure' });
  }
  assert.deepEqual(exportOtlp([goal], { ...options, redact: () => { throw Error(text); } }), { ok: false, reason: 'disclosure' });
});

test('interleaved batches group traces without inferring links from matching evidence', () => {
  const a = record('same', 'a');
  const b = record('same', 'b');
  const second = { ...record('second', 'a'), sequence: 1, parent_id: 'same' };
  const result = JSON.parse(json([b, second, a]));
  const groups = result.resourceSpans;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g: { scopeSpans: { spans: unknown[] }[] }) => g.scopeSpans[0]!.spans.length), [2, 1]);
  assert.ok(groups[0].scopeSpans[0].spans.every((s: { traceId: string }) => s.traceId === groups[0].scopeSpans[0].spans[0].traceId));
  assert.notEqual(groups[0].scopeSpans[0].spans[0].traceId, groups[1].scopeSpans[0].spans[0].traceId);
  assert.deepEqual(groups[1].scopeSpans[0].spans[0].links, []);
  assert.deepEqual(exportOtlp([{ ...b, parent_id: 'second' }, a, second], { redact: keep }), { ok: false, reason: 'incomplete' });
  const max = JSON.parse(json([{ ...a, sequence: Number.MAX_SAFE_INTEGER }]));
  assert.equal(max.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano, '9007199254740992');
});

test('malformed revoked proxy input cannot throw across the export boundary', () => {
  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  assert.deepEqual(exportOtlp(proxy, { redact: keep }), { ok: false, reason: 'disclosure' });
});

for (const mode of ['timeout', 'abort', 'late rejection'] as const) {
  test(`writer liveness: ${mode} releases an awaiting run`, async () => {
    let expire = () => {};
    let rejectWrite = (_error: Error) => {};
    let cancelled = 0;
    let delay = 0;
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const exporter = createOtlpExporter({ redact: keep,
        write: () => new Promise((_resolve, reject) => { rejectWrite = reject; }),
        ...(mode === 'timeout' ? { writeTimeoutMs: 17 } : {}),
        timer: (ms, callback) => { delay = ms; expire = callback; return () => { cancelled++; }; },
      });
      let settled: unknown;
      const pending = exporter.export([record()], controller.signal).then(result => { settled = result; });
      if (mode === 'abort') controller.abort(); else expire();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.deepEqual(settled, { ok: false, reason: 'write' });
      await pending;
      assert.equal(delay, mode === 'timeout' ? 17 : 1000);
      assert.equal(cancelled, 1);
      rejectWrite(Error('secret late failure'));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });
}

test('export configuration failures are distinct from disclosure, including empty batches', () => {
  for (const records of [[], [record()]]) {
    for (const options of [undefined, {}, { redact: null }, { redact: keep, inline: {} },
      { redact: keep, inline: { trace_id: 'trace', classes: ['unknown'] } }]) {
      assert.deepEqual(exportOtlp(records, options as never), { ok: false, reason: 'config' });
    }
  }
  assert.deepEqual(exportOtlp([record()], { redact: () => { throw Error('secret'); } }),
    { ok: false, reason: 'disclosure' });
});

test('write bounds reject invalid configuration and pre-abort without delivery', async () => {
  let writes = 0;
  const write = () => { writes++; };
  for (const writeTimeoutMs of [0, -1, Infinity, NaN, 2 ** 31]) {
    assert.deepEqual(await createOtlpExporter({ redact: keep, write, timer, writeTimeoutMs }).export([record()]),
      { ok: false, reason: 'config' });
  }
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await createOtlpExporter({ redact: keep, write, timer }).export([record()], controller.signal),
    { ok: false, reason: 'write' });
  assert.equal(writes, 0);
});

test('timer cleanup and cancellation belong to each concurrent export', async () => {
  const deadlines: (() => void)[] = [];
  const cancelled: number[] = [];
  let complete = () => {};
  let calls = 0;
  const exporter = createOtlpExporter({ redact: keep,
    timer: (_ms, expire) => { const id = deadlines.length; deadlines.push(expire); return () => { cancelled.push(id); }; },
    write: () => ++calls === 1 ? new Promise<void>(resolve => { complete = resolve; }) : new Promise(() => {}),
  });
  const first = exporter.export([record()]);
  const controller = new AbortController();
  const second = exporter.export([record()], controller.signal);
  controller.abort();
  assert.deepEqual(await second, { ok: false, reason: 'write' });
  complete();
  assert.equal((await first).ok, true);
  assert.deepEqual(cancelled, [1, 0]);
  deadlines.forEach(expire => expire());
  assert.deepEqual(cancelled, [1, 0]);
});


test('injected base shifts only timestamps and preserves sequence ordering and epoch bytes', () => {
  const records = [record(), { ...record('b'), sequence: Number.MAX_SAFE_INTEGER }];
  const epoch = json(records);
  for (const baseTimeUnixNano of [0n, '0', 1700000000000000000n, '1700000000000000000']) {
    const result = exportOtlp(records, { redact: keep, baseTimeUnixNano });
    assert.ok(result.ok);
    const expected = JSON.parse(epoch);
    for (const span of expected.resourceSpans[0].scopeSpans[0].spans) {
      span.startTimeUnixNano = (BigInt(span.startTimeUnixNano) + BigInt(baseTimeUnixNano)).toString();
      span.endTimeUnixNano = span.startTimeUnixNano;
    }
    assert.equal(result.json, JSON.stringify(expected));
    if (BigInt(baseTimeUnixNano) === 0n) assert.equal(result.json, epoch);
  }
});

test('base validation fails closed, including empty batches and uint64 endpoint overflow', () => {
  const max = (1n << 64n) - 1n;
  for (const baseTimeUnixNano of [-1n, '-1', '', ' ', '1.5', '1e3', '+1', '0x10', 1, NaN,
    Infinity, null, {}, max + 1n, (max + 1n).toString()]) {
    for (const records of [[], [record()]]) {
      assert.deepEqual(exportOtlp(records, { redact: keep, baseTimeUnixNano } as never), { ok: false, reason: 'config' });
    }
  }
  for (const baseTimeUnixNano of [max, max.toString(), max - BigInt(Number.MAX_SAFE_INTEGER)]) {
    assert.deepEqual(exportOtlp([{ ...record(), sequence: Number.MAX_SAFE_INTEGER }],
      { redact: keep, baseTimeUnixNano }), { ok: false, reason: 'config' });
  }
  const result = exportOtlp([record()], { redact: keep, baseTimeUnixNano: max - 1n });
  assert.ok(result.ok);
  assert.equal(JSON.parse(result.json).resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano, max.toString());
});

test('base export reads no ambient clock', () => {
  const date = Date.now;
  const performanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const fail = () => { throw Error('ambient clock'); };
  try {
    Date.now = fail;
    Object.defineProperty(performance, 'now', { configurable: true, value: fail });
    for (const baseTimeUnixNano of [undefined, '1700000000000000000']) {
      assert.ok(exportOtlp([record()], { redact: keep, baseTimeUnixNano }).ok);
    }
  } finally {
    Date.now = date;
    if (performanceNow) Object.defineProperty(performance, 'now', performanceNow);
    else Reflect.deleteProperty(performance, 'now');
  }
});

test('base survives concurrent cancellation, writer failure and crash/re-export without disclosure', async () => {
  const baseTimeUnixNano = '1700000000000000000';
  const writes: string[] = [];
  let complete = () => {};
  const exporter = createOtlpExporter({ redact: keep, baseTimeUnixNano,
    timer: () => () => {},
    write: s => { writes.push(s); return new Promise<void>(resolve => { complete = resolve; }); },
  });
  const first = exporter.export([record('a', 'one')]);
  const finishFirst = complete;
  const controller = new AbortController();
  const second = exporter.export([record('a', 'two')], controller.signal);
  controller.abort();
  assert.deepEqual(await second, { ok: false, reason: 'write' });
  finishFirst();
  const result = await first;
  assert.ok(result.ok);
  assert.equal(result.json, writes[0]);
  assert.equal(JSON.parse(result.json).resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano,
    '1700000000000000001');
  assert.notEqual(writes[0], writes[1]);
  const crashed = createOtlpExporter({ redact: keep, baseTimeUnixNano, timer,
    write: () => { throw Error('crash'); } });
  assert.deepEqual(await crashed.export([record('a', 'one')]), { ok: false, reason: 'write' });
  assert.deepEqual(exportOtlp([record('a', 'one')], { redact: keep, baseTimeUnixNano }), result);
  let called = false;
  const invalid = createOtlpExporter({ redact: keep, baseTimeUnixNano: -1n,
    timer, write: () => { called = true; } });
  assert.deepEqual(await invalid.export([record()]), { ok: false, reason: 'config' });
  assert.equal(called, false);
  assert.deepEqual(exportOtlp([{ ...record(), grant: 'single-use' }], { redact: keep, baseTimeUnixNano }),
    { ok: false, reason: 'disclosure' });
});

test('a base preserves cross-emitter child-before-parent times without inventing chronology', () => {
  const parent = { ...record('parent'), sequence: 10 };
  const child = { ...record('child'), emitter: { kind: 'gateway', id: 'other' }, parent_id: 'parent' };
  const result = exportOtlp([child, parent], { redact: keep, baseTimeUnixNano: '1000' });
  assert.ok(result.ok);
  const [p, c] = JSON.parse(result.json).resourceSpans[0].scopeSpans[0].spans;
  assert.equal(p.startTimeUnixNano, '1011');
  assert.equal(c.startTimeUnixNano, '1001');
  assert.equal(c.parentSpanId, p.spanId);
});
