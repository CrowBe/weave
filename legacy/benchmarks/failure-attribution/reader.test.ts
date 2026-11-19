import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestReader } from './reader-core.ts';
import { readTuneArtifact, readSealedInputs } from './reader.ts';
import { storedByteDigest } from './stored-byte-digest.ts';
import { recordDigest } from '@weave/gauge';

type Entry =
  | { path: string; role: string; storedByteDigest: string }
  | { role: 'sealed-label'; storedByteDigest: string };
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (s: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(s);
const bytes = encode('{"value":1}');
const pin = storedByteDigest(bytes);
const manifestPath = 'fixtures/manifest.json';
const tunePath = 'fixtures/tune.json';
const inputPath = 'fixtures/inputs.json';
const digestPath = 'fixtures/digests.json';
const snapshotPath = 'benchmarks/failure-attribution/fixtures/weft-snapshot.jsonl';
function setup(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'g7-reader-'));
  try {
    mkdirSync(join(root, 'fixtures'));
    writeFileSync(join(root, tunePath), bytes);
    writeFileSync(join(root, inputPath), '{}');
    writeFileSync(join(root, digestPath), '{}');
    writeFileSync(join(root, 'labels.json'), '{"schema":"gauge.sealed-labels@1","labels":[]}');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function tuneEntry(path = tunePath, role = 'tune', digest = pin): Entry {
  return { path, role, storedByteDigest: digest };
}
function manifest(root: string, entries: Entry[], raw?: string) {
  const content = encode(raw ?? JSON.stringify({ entries }));
  writeFileSync(join(root, manifestPath), content);
  const anchor = storedByteDigest(content);
  return { reader: createTestReader(root, manifestPath, anchor), anchor };
}
function sealedEntries(root: string): Entry[] {
  return [
    tuneEntry(inputPath, 'holdout-input', storedByteDigest(readFileSync(join(root, inputPath)))),
    tuneEntry(digestPath, 'holdout-digest', storedByteDigest(readFileSync(join(root, digestPath)))),
    { role: 'sealed-label', storedByteDigest: storedByteDigest(readFileSync(join(root, 'labels.json'))) },
  ];
}
function options(root: string, entries: Entry[]) {
  const compact = (role: string) =>
    entries
      .filter((row) => row.role === role)
      .map((row) => {
        assert.ok('path' in row);
        return { path: row.path, storedByteDigest: row.storedByteDigest };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path === b.path ? 0 : 1));
  const label = entries.find((row) => row.role === 'sealed-label');
  assert.ok(label);
  return {
    sealedLabelPath: join(root, 'labels.json'),
    sealedLabelDigest: label.storedByteDigest,
    holdoutSetDigest: recordDigest({
      domain: 'gauge.holdout-set@1',
      inputs: compact('holdout-input'),
      holdoutSetDigests: compact('holdout-digest'),
      sealedLabelDigest: label.storedByteDigest,
    }),
  };
}
function refuses(action: () => unknown, code?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length < 120);
    assert.ok(!error.message.includes('PAYLOAD_CANARY'));
    if (code) assert.match(error.message, code);
    return true;
  });
}

test('3 stored-byte digest and anchored read: known raw hash and format refusal', () => {
  assert.equal(
    storedByteDigest(encode('abc')),
    'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  setup((root) => {
    const { reader, anchor } = manifest(root, [tuneEntry()]);
    assert.deepEqual(reader.readArtifact(tunePath), bytes);
    assert.deepEqual(reader.readArtifact(tunePath, pin), bytes);
    refuses(() => reader.readArtifact(tunePath, 'sha256:' + '0'.repeat(64)));
    refuses(() => reader.readArtifact(tunePath, pin.slice(7)));
    for (const bad of [anchor.slice(7), anchor.toUpperCase(), 'sha256:abc', ` ${anchor}`, `${anchor}\n`]) {
      refuses(() => createTestReader(root, manifestPath, bad).readArtifact(tunePath));
    }
    for (const bad of [pin.slice(7), pin.toUpperCase(), 'sha256:abc', ` ${pin}`]) {
      const invalid = manifest(root, [tuneEntry(tunePath, 'tune', bad)]);
      refuses(() => invalid.reader.readArtifact(tunePath));
    }
    manifest(root, [tuneEntry()]);
    writeFileSync(join(root, tunePath), '{"value":2}');
    refuses(() => reader.readArtifact(tunePath));
  });
});

test('4 G7 leaf data reads use only declared pinned inputs', () => {
  setup((root) => {
    // Existing synthetic host files distinguish denied access from a missing-file error.
    for (const host of ['packages/weave/src', 'packages/gateway/test'])
      mkdirSync(join(root, host), { recursive: true });
    for (const host of ['packages/weave/src/runtime.ts', 'packages/gateway/test/fixture.json'])
      writeFileSync(join(root, host), bytes);
    const { reader } = manifest(root, [tuneEntry()]);
    assert.deepEqual(reader.readArtifact(tunePath), bytes);
    for (const path of [
      'packages/weave/src/runtime.ts',
      'packages/gateway/test/fixture.json',
      '../fixtures/tune.json',
      './fixtures/tune.json',
      'fixtures/../fixtures/tune.json',
      join(root, tunePath),
      'fixtures//tune.json',
      'fixtures\\tune.json',
      snapshotPath,
      'fixtures/snapshot.jsonl',
    ]) {
      refuses(() => reader.readArtifact(path));
    }
    for (const host of ['packages/weave/src/runtime.ts', 'packages/gateway/test/fixture.json'])
      assert.deepEqual(new Uint8Array(readFileSync(join(root, host))), bytes);
    setup((outsideRoot) => {
      const outside = join(outsideRoot, 'outside.json');
      writeFileSync(outside, bytes);
      symlinkSync(outside, join(root, 'fixtures/link.json'));
      const linked = manifest(root, [tuneEntry('fixtures/link.json')]).reader;
      refuses(() => linked.readArtifact('fixtures/link.json'));
      assert.deepEqual(new Uint8Array(readFileSync(outside)), bytes);
    });
    symlinkSync(join(root, 'fixtures'), join(root, 'linked-directory'));
    refuses(() =>
      manifest(root, [tuneEntry('linked-directory/tune.json')]).reader.readArtifact('linked-directory/tune.json'),
    );
    symlinkSync(join(root, 'fixtures'), join(root, 'manifest-directory'));
    const current = manifest(root, [tuneEntry()]);
    refuses(() => createTestReader(root, 'manifest-directory/manifest.json', current.anchor).readArtifact(tunePath));
    mkdirSync(join(root, 'benchmarks/failure-attribution/fixtures'), { recursive: true });
    writeFileSync(join(root, snapshotPath), bytes);
    const snapshot = manifest(root, [tuneEntry(snapshotPath, 'snapshot')]).reader;
    assert.deepEqual(snapshot.readArtifact(snapshotPath), bytes);
    writeFileSync(join(root, snapshotPath), '{ "value": 1 }\n');
    refuses(() => snapshot.readArtifact(snapshotPath));
  });
});

test('5 formatter-rewritten byte and mutated manifest with internally consistent digests', () => {
  setup((root) => {
    const original = manifest(root, [tuneEntry()]);
    // This exact rewrite was also established by vp fmt on an unexempted /tmp copy.
    const formatted = encode('{ "value": 1 }\n');
    assert.deepEqual(JSON.parse(decode(formatted)), JSON.parse(decode(bytes)));
    writeFileSync(join(root, tunePath), formatted);
    refuses(() => original.reader.readArtifact(tunePath));
    const replacement = manifest(root, [tuneEntry(tunePath, 'tune', storedByteDigest(formatted))]);
    refuses(() => original.reader.readArtifact(tunePath));
    assert.deepEqual(replacement.reader.readArtifact(tunePath), formatted);
  });
});

test('6 sealed digest gate and missing freeze', () => {
  setup((root) => {
    const entries = sealedEntries(root);
    const { reader } = manifest(root, entries);
    const opts = options(root, entries);
    const verified = reader.readSealed(opts);
    assert.equal(verified.inputs.length, 1);
    assert.equal(verified.holdoutSetDigests.length, 1);
    refuses(() => reader.readArtifact(inputPath));
    refuses(() => reader.readArtifact(digestPath));
    verified.inputs[0]!.bytes.fill(0);
    verified.labels.fill(0);
    assert.deepEqual(reader.readSealed(opts).inputs[0]!.bytes, encode('{}'));
    assert.deepEqual(reader.readSealed(opts).labels, new Uint8Array(readFileSync(join(root, 'labels.json'))));
    assert.deepEqual(reader.readSealed(opts).labels, new Uint8Array(readFileSync(join(root, 'labels.json'))));
    for (const key of ['sealedLabelDigest', 'holdoutSetDigest'] as const) {
      const omitted: Record<string, unknown> = { ...opts };
      delete omitted[key];
      refuses(() => reader.readSealed(omitted as typeof opts));
      for (const bad of [
        undefined,
        opts[key].slice(7),
        opts[key].toUpperCase(),
        'sha256:abc',
        ` ${opts[key]}`,
        `sha256:${'0'.repeat(64)}`,
      ]) {
        refuses(() => reader.readSealed({ ...opts, [key]: bad } as typeof opts));
      }
    }
    for (const role of ['sealed-label', 'holdout-input', 'holdout-digest']) {
      const missing = manifest(
        root,
        entries.filter((entry) => entry.role !== role),
      ).reader;
      refuses(() => missing.readSealed({ ...opts, sealedLabelDigest: 'bad' }), /freeze/);
    }
    const missingPath = { ...opts, sealedLabelPath: join(root, 'PAYLOAD_CANARY-missing') };
    refuses(() => reader.readSealed(missingPath));
    refuses(() => reader.readSealed({ ...opts, sealedLabelPath: join(root, '.', 'labels.json') + '/../labels.json' }));
    symlinkSync(join(root, 'labels.json'), join(root, 'labels-link.json'));
    refuses(() => reader.readSealed({ ...opts, sealedLabelPath: join(root, 'labels-link.json') }));
  });
});

test('7 role structure and independent freeze pinning', () => {
  setup((root) => {
    for (const raw of [
      '{"entries":[{"path":"fixtures/tune.json","storedByteDigest":"' + pin + '"}]}',
      '{"entries":[{"path":"fixtures/tune.json","role":"tune","role":"schema","storedByteDigest":"' + pin + '"}]}',
      JSON.stringify({ entries: [tuneEntry(tunePath, 'unknown')] }),
      JSON.stringify({ entries: [tuneEntry(), tuneEntry()] }),
      JSON.stringify({ entries: [tuneEntry(), tuneEntry(tunePath, 'schema')] }),
      JSON.stringify({ entries: [tuneEntry('fixtures/../fixtures/tune.json')] }),
      JSON.stringify({ entries: [tuneEntry()], anchor: pin }),
      JSON.stringify({ entries: [{ ...tuneEntry(), extra: true }] }),
      JSON.stringify({ entries: [{ ...tuneEntry(), role: ['tune', 'schema'] }] }),
      JSON.stringify({ entries: [{ role: 'sealed-label', path: 'labels.json', storedByteDigest: pin }] }),
    ]) {
      refuses(() => manifest(root, [], raw).reader.readArtifact(tunePath));
    }
    writeFileSync(join(root, 'fixtures/extra.json'), bytes);
    const entries = sealedEntries(root);
    const opts = options(root, entries);
    const initial = manifest(root, entries).reader.readSealed(opts);
    for (const role of ['tune', 'schema', 'parity']) {
      const reader = manifest(root, [...entries, tuneEntry('fixtures/extra.json', role)]).reader;
      assert.deepEqual(reader.readSealed(opts), initial);
    }
    // Every mutation is coherently re-anchored; the independently retained pins stay fixed.
    for (const role of ['holdout-input', 'holdout-digest']) {
      const path = role === 'holdout-input' ? inputPath : digestPath;
      writeFileSync(join(root, path), '{"changed":true}');
      const changed = entries.map((entry) =>
        entry.role === role ? tuneEntry(path, role, storedByteDigest(readFileSync(join(root, path)))) : entry,
      );
      refuses(() => manifest(root, changed).reader.readSealed(opts), /holdout-set/);
      writeFileSync(join(root, path), '{}');
      refuses(
        () => manifest(root, [...entries, tuneEntry('fixtures/extra.json', role)]).reader.readSealed(opts),
        /holdout-set/,
      );
      refuses(
        () =>
          manifest(
            root,
            entries.filter((entry) => entry.role !== role),
          ).reader.readSealed(opts),
        /freeze/,
      );
    }
    const additional = [...entries, tuneEntry('fixtures/extra.json', 'holdout-input')];
    const additionalOpts = options(root, additional);
    const relabeled = additional.map((entry) =>
      'path' in entry && entry.path === inputPath ? { ...entry, role: 'tune' } : entry,
    );
    refuses(() => manifest(root, relabeled).reader.readSealed(additionalOpts), /holdout-set/);
    writeFileSync(
      join(root, 'labels.json'),
      '{"schema":"gauge.sealed-labels@1","labels":[{"id":"changed","category":"routing","rationale":"changed"}]}',
    );
    const changedLabels = sealedEntries(root);
    refuses(() => manifest(root, changedLabels).reader.readSealed(opts), /sealed-label/);
    refuses(
      () =>
        manifest(root, changedLabels).reader.readSealed({
          ...opts,
          sealedLabelDigest: options(root, changedLabels).sealedLabelDigest,
        }),
      /holdout-set/,
    );
    refuses(() => manifest(root, [...entries, entries[2]!]).reader.readSealed(opts), /freeze/);
  });
});

test('8 snapshot-backed evidence in sealed evaluation', () => {
  setup((root) => {
    mkdirSync(join(root, 'benchmarks/failure-attribution/fixtures'), { recursive: true });
    writeFileSync(join(root, snapshotPath), bytes);
    for (const evidence of [
      { case: { path: snapshotPath } },
      { bundle: { source: snapshotPath } },
      { bundle: { ['weft']: [{ ref: snapshotPath + '#record' }] } },
      { bundle: { role: 'snapshot' } },
    ]) {
      writeFileSync(join(root, inputPath), JSON.stringify(evidence));
      const entries = [...sealedEntries(root), tuneEntry(snapshotPath, 'snapshot')];
      const reader = manifest(root, entries).reader;
      refuses(() => reader.readSealed(options(root, entries)), /snapshot/);
    }
    writeFileSync(join(root, inputPath), '{"bundle":{"weft":[{"ref":"separate-record"}]}}');
    const entries = [...sealedEntries(root), tuneEntry(snapshotPath, 'snapshot')];
    assert.equal(manifest(root, entries).reader.readSealed(options(root, entries)).inputs.length, 1);
    // Role identity also excludes snapshots declared at a different synthetic path.
    writeFileSync(join(root, inputPath), '{"bundle":{"ref":"fixtures/tune.json"}}');
    const other = [...sealedEntries(root), tuneEntry(tunePath, 'snapshot')];
    refuses(() => manifest(root, other).reader.readSealed(options(root, other)), /snapshot/);
    writeFileSync(join(root, snapshotPath), '{}');
    const reserved = [
      tuneEntry(snapshotPath, 'holdout-input', storedByteDigest(encode('{}'))),
      ...sealedEntries(root).filter((entry) => entry.role !== 'holdout-input'),
    ];
    refuses(() => manifest(root, reserved).reader.readSealed(options(root, reserved)), /snapshot/);
  });
});

test('9 read isolation and bounded failure paths', () => {
  setup((root) => {
    const { reader } = manifest(root, [tuneEntry()]);
    const first = reader.readArtifact(tunePath);
    first.fill(0);
    assert.deepEqual(reader.readArtifact(tunePath), bytes);
    assert.deepEqual(reader.readArtifact(tunePath), reader.readArtifact(tunePath));
    writeFileSync(join(root, tunePath), 'PAYLOAD_CANARY');
    refuses(() => reader.readArtifact(tunePath));
    writeFileSync(join(root, tunePath), bytes);
    assert.deepEqual(reader.readArtifact(tunePath), bytes);
    writeFileSync(join(root, tunePath), '');
    refuses(() => reader.readArtifact(tunePath));
    rmSync(join(root, tunePath));
    refuses(() => reader.readArtifact(tunePath));
    writeFileSync(join(root, tunePath), bytes);
    assert.deepEqual(reader.readArtifact(tunePath), bytes);
    for (const raw of ['{', 'PAYLOAD_CANARY', '{"entries":null}', '{"entries":[]} trailing']) {
      refuses(() => manifest(root, [], raw).reader.readArtifact(tunePath));
    }
    for (const malformed of ['{', 'PAYLOAD_CANARY', '']) {
      writeFileSync(join(root, inputPath), malformed);
      const badInputs = sealedEntries(root);
      refuses(() => manifest(root, badInputs).reader.readSealed(options(root, badInputs)));
      writeFileSync(join(root, inputPath), '{}');
      writeFileSync(join(root, 'labels.json'), malformed);
      const badLabels = sealedEntries(root);
      refuses(() => manifest(root, badLabels).reader.readSealed(options(root, badLabels)));
      writeFileSync(join(root, 'labels.json'), '{"schema":"gauge.sealed-labels@1","labels":[]}');
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = manifest(root, [tuneEntry()]).reader;
      assert.deepEqual(current.readArtifact(tunePath), bytes);
    }
  });
});

test('4/5/6 production code pin and missing-freeze refusal', () => {
  const path = 'benchmarks/failure-attribution/fixtures/tune.jsonl';
  const original = readTuneArtifact(path);
  assert.ok(original.byteLength > 0);
  refuses(() => readTuneArtifact('packages/weave/src/runtime.ts'));
  refuses(() => readTuneArtifact('packages/agentfabric/test/fixture.json'));
  refuses(() => readTuneArtifact(snapshotPath));
  refuses(() => readTuneArtifact(path, { anchor: pin } as unknown as string));
  assert.deepEqual(readTuneArtifact(path), original);
  refuses(
    () => readSealedInputs({ sealedLabelPath: '/PAYLOAD_CANARY', sealedLabelDigest: pin, holdoutSetDigest: pin }),
    /freeze/,
  );
});
