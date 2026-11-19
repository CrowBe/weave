// Run directly to observe red. Keep this outside Node's *.test.mjs discovery.
// The gating test requires ten assertion failures,
// not skips/todos, loader failures or unrelated exceptions.
import { test } from 'node:test';
import { scenarios } from './contract.mjs';
import { makeDouble } from './doubles.mjs';

for (const scenario of scenarios) {
  test(scenario.id, () => scenario.check(makeDouble(scenario.id, true)));
}
