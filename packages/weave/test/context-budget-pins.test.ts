import assert from 'node:assert/strict';
import test from 'node:test';
import {
  git,
  tracked,
  plan,
  contract,
  source,
  checkDeclaration,
  checkCall,
  checkTest,
  callPins,
  definitionPins,
  w2Present,
} from './context-budget-pins.js';

const runtime = 'packages/weave/src/runtime.ts';
const start = '`this.append` (call at `packages/weave/src/runtime.ts:1859`)';
const range = '`this.append` (call range `packages/weave/src/runtime.ts:1859-1866`)';
const property = '`this.append` (call at `packages/weave/src/runtime.ts:1863`)';
const expected = [
  ['packages/weave/src/gateway-decision.ts', 'this.gateway.evaluate', 40, 1],
  ['benchmarks/frontier-weigh/build.ts', 'renderWeighView', 233, 1],
  [runtime, 'this.stillAuthorized', 1802, 1],
  [runtime, 'this.append', 1859, 3],
  [runtime, 'renderFrameView', 1236, 2],
  [runtime, 'this.frameGoal', 2545, 2],
  [runtime, 'this.abandonUnrecordedInferences', 1846, 2],
]
  .flatMap(([path, symbol, line, count]) => Array.from({ length: Number(count) }, () => `${path}|${symbol}|${line}|`))
  .sort();
// The one whole-range example in active FU3 is a range rather than a start pin.
for (let index = 0; index < 2; index++)
  expected[expected.indexOf(`${runtime}|this.append|1859|`)] = `${runtime}|this.append|1859|1866`;
expected.sort();

test('C1 reference is an unchanged copy of 841d7f4:PLAN.md', async () => {
  assert.equal(plan, await git('show', '841d7f4:PLAN.md'));
});
test('FU3 contract source table resolves every tracked path and exported symbol', () => {
  const table = contract.split('Contract source pins contain symbols only')[1]!;
  assert.ok(table);
  let count = 0;
  for (const row of table.split('\n').filter((line) => line.startsWith('| `'))) {
    const [path, ...names] = [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    assert.ok(tracked.includes(path!));
    for (const name of names) {
      assert.ok(
        source(path!).declarations.some((declaration) => declaration.name === name && declaration.exported),
        `${path}: exported ${name}`,
      );
      count++;
    }
  }
  assert.equal(count, 22);
  assert.equal(/`[^`]+\.(?:ts|mjs):\d/.test(contract), false, 'contract source references contain no line pins');
});

test('FU3 all active labelled calls resolve to exact AST starts/ranges', () => {
  const result = callPins(plan);
  assert.deepEqual(result.pins, expected);
  assert.deepEqual(result.errors, []);
  assert.equal(w2Present(plan), true);
});
test('FU3 grouped definitions and navigation paths resolve including review dispositions', () => {
  const result = definitionPins(plan);
  assert.ok(result.checked >= 60, `checked ${result.checked} declarations`);
  assert.deepEqual(result.errors, []);
});

for (const [symbol, positive, negatives] of [
  ['WEIGH_CONTROL_RECORDS', 161, [160, 162]],
  ['recordedFrameProfile', 2178, [2177]],
] as const) {
  test(`FU3 AST declaration ${symbol} rejects JSDoc/element pins`, () => {
    assert.deepEqual(checkDeclaration(runtime, symbol, positive), []);
    for (const line of negatives) assert.ok(checkDeclaration(runtime, symbol, line).length);
  });
}
test('FU3 AST frameCandidate rejects body statement as declaration', () => {
  assert.deepEqual(checkDeclaration('packages/weave/src/candidates.ts', 'frameCandidate', 302), []);
  assert.ok(checkDeclaration('packages/weave/src/candidates.ts', 'frameCandidate', 303).length);
});
test('FU3 exact test titles resolve test/it declarations, not comments or body statements', () => {
  const path = 'packages/weave/test/p8.test.ts';
  const title = 'a part-written file journal append is reported as incomplete, not as another writer (#249)';
  assert.deepEqual(checkTest(path, title, 1913), []);
  assert.ok(checkTest(path, title, 1903).length, 'pinned plan positive has drifted at child base');
  for (const line of [1902, 1904]) assert.ok(checkTest(path, title, line).length);
  assert.ok(checkTest(path, 'missing test title', 1903).length);
});
test('FU3 full source tracking is used rather than a three-file source map', () => {
  assert.deepEqual(checkDeclaration('packages/weave/src/digest.ts', 'digest', 5), []);
  assert.ok(checkDeclaration('packages/weave/src/missing.ts', 'digest', 5, true).length);
});

for (const [name, fixture, accepted] of [
  ['call start', start, true],
  ['whole call range', range, true],
  ['argument line', '`renderFrameView` (call at `packages/weave/src/runtime.ts:1240`)', false],
  ['actual render call', '`renderFrameView` (call at `packages/weave/src/runtime.ts:1236`)', true],
  ['property only', property, false],
  ['partial range', range.replace('1859-1866', '1863-1866'), false],
  ['missing end', range.replace('1859-1866', '1859-1865'), false],
  ['wrong callee', '`liveEnvironment.execute` (call at `packages/weave/src/runtime.ts:2545`)', false],
  ['basename', start.replace('packages/weave/src/', ''), false],
  ['bare line', start.replace('packages/weave/src/runtime.ts', ''), false],
  ['unquoted', start.replace('`packages/weave/src/runtime.ts:1859`', 'packages/weave/src/runtime.ts:1859'), false],
  ['unknown syntax', 'call at `packages/weave/src/runtime.ts:1859`', false],
  ['closed property', '## 16. Review disposition — retained\n' + property, true],
  ['open property', '## 29. Review disposition — open\n' + property, false],
  ['future property', '## 99. Review disposition — future\n' + property, false],
  ['future valid', '## 99. Review disposition — future\n' + start, true],
  [
    'missing historical symbol',
    '## 16. Review disposition — retained\n' + property.replace('this.append', 'this.missing'),
    false,
  ],
  [
    'missing historical path',
    '## 16. Review disposition — retained\n' + property.replace('runtime.ts', 'missing.ts'),
    false,
  ],
  ['leaving history', '## 16. Review disposition — retained\n## Active\n' + property, false],
  ['fenced fake history', '```md\n## 16. Review disposition — fake\n```\n' + property, false],
] as const) {
  test(`FU3 grammar fixture: ${name}`, () =>
    assert.equal(callPins(fixture).errors.length === 0, accepted, callPins(fixture).errors.join('\n')));
}
for (const split of ['call\nat', 'call at\n', 'call\nrange', 'call range\n']) {
  for (const table of [false, true]) {
    test(`FU3 rejects wrapped ${JSON.stringify(split)} in ${table ? 'table' : 'prose'}`, () => {
      const original = split.includes('range') ? range : start;
      const label = split.includes('range') ? 'call range' : 'call at';
      const broken = original.replace(label, split);
      assert.ok(callPins(table ? `| ${broken} | explanation |` : broken).errors.length);
    });
  }
}

test('FU3 actual-document wrong-callee, deletion, substitution and relocation mutations fail', () => {
  assert.ok(callPins(plan.replace('`this.frameGoal` (call at', '`liveEnvironment.execute` (call at')).errors.length);
  const w2 = [
    ['renderFrameView', 1236],
    ['this.frameGoal', 2545],
    ['this.abandonUnrecordedInferences', 1846],
  ].map(([symbol, line]) => `\`${symbol}\` (call at \`${runtime}:${line}\`)`);
  for (const scope of ['### 2.7 ', '### 5.5 ']) {
    const boundary = plan.indexOf(scope) + scope.length;
    for (const pin of w2) {
      const head = plan.slice(0, boundary);
      const tail = plan.slice(boundary);
      const deleted = head + tail.replace(pin, '');
      assert.notDeepEqual(callPins(deleted).pins, expected);
      const replacement = w2[(w2.indexOf(pin) + 1) % 3]!;
      const substituted = head + tail.replace(pin, replacement);
      assert.notDeepEqual(callPins(substituted).pins, expected);
      const relocated = deleted.replace(/(^## 3\. .*?$)/m, `$1\n\n${pin}`);
      assert.deepEqual(callPins(relocated).pins, expected);
      assert.equal(w2Present(relocated), false);
    }
  }
});

test('FU3 invalid pin red: a property citation cannot stand for an append call', async () => {
  const { demonstrateRed } = await import('./context-budget-fixture.js');
  demonstrateRed(() => assert.deepEqual(checkCall(runtime, 'this.append', 1863), []));
});
test('FU3 invalid pin red: declaration JSDoc is not a declaration', async () => {
  const { demonstrateRed } = await import('./context-budget-fixture.js');
  demonstrateRed(() => assert.deepEqual(checkDeclaration(runtime, 'WEIGH_CONTROL_RECORDS', 160), []));
});
test('FU3 grouped pin grammar validates every symbol and rejects absent historical symbols', () => {
  const good = '`payloadBytes` and `hasMidValue` (`packages/weave/src/log-bound.ts:7,11`)';
  assert.deepEqual(definitionPins(good).errors, []);
  assert.ok(definitionPins(good.replace('hasMidValue', 'missing')).errors.length);
  assert.ok(
    definitionPins('## 16. Review disposition — retained\n' + good.replace('hasMidValue', 'missing')).errors.length,
  );
});
