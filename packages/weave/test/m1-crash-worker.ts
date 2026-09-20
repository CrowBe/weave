/**
 * Child process for M1-T13. Publishes through the after-commit gate, persists
 * the destination store and journal, then exits without a runtime result.
 */
import { FabricStore } from '@weave/agentfabric';
import { FileJournal } from '@weave/weave';
import { assembleReport, m1World, pendingApproval } from './m1-fixture.js';

const dir = process.argv[2];
if (!dir) {
  throw new Error('m1-crash-worker requires a directory');
}

const world = m1World({
  store: FabricStore.open(`${dir}/fabric.json`),
  journal: new FileJournal(`${dir}/journal.jsonl`),
});
await assembleReport(world);
world.runtime.decide({
  request_id: pendingApproval(world),
  principal: 'operator',
  decision: 'approved',
  authority_revision: 1,
});
const publish = Object.values(world.runtime.state().actions).find((a) => a.operation === 'report.publish');
if (!publish) {
  throw new Error('publish action missing');
}
world.host.faults.publishGate = 'after_commit';
world.host.faults.disconnectAfterCommit = true;
world.host.release(publish.action_id);
if (!world.host.publication(world.dest)) {
  throw new Error('commit did not persist a publication');
}
process.exit(0);
