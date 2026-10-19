import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as agentsop from '@weave/agentsop';

test('AgentSOP exports no trace API: weave.trace@1 moved to Weft with no shim (#185)', () => {
  for (const name of ['validateTrace', 'serializeTrace', 'importTraceLines']) assert.equal(Object.hasOwn(agentsop, name), false, name);
});
