/**
 * Offline crystallization harness for one missing report fold.
 *
 * Spins the M3 fixture without a model: search, contract, corpus, demonstrated
 * red under isolation, two implementations, proven green, a human admission,
 * then a separate execution grant that finishes the report. Replay reconstructs
 * the trace without the author, the lifecycle, or the host.
 *
 *   npm run example:crystallize
 */
import { createGrantAuthority, type CapabilityLifecycle } from '@weave/agentsop';
import { AgentFabricHost, FabricLifecycle } from '@weave/agentfabric';
import {
  RETAINED_FOLD_PROCEDURE,
  Runtime,
  ScriptedDecisionLayer,
  ScriptedFoldAuthor,
  replay,
  traceCompletenessViolations,
  type ActionResultPayload,
  type ActionStartedPayload,
  type DecisionLayer,
  type ExtensionAuthor,
  type Goal,
} from '@weave/weave';

const CONTENT = {
  alpha: 'alpha one\nalpha two\nalpha three',
  beta: 'beta one\nbeta two\nbeta three\nbeta four\nbeta five',
} as const;

const authority = createGrantAuthority();
const host = new AgentFabricHost({ authority });
const lifecycle = new FabricLifecycle(host, 'enforcing');
const author = new ScriptedFoldAuthor(['direct', 'aliased']);
const alpha = host.registerSource('mem:alpha', CONTENT.alpha);
const beta = host.registerSource('mem:beta', CONTENT.beta);
const runtime = new Runtime({
  host,
  decisionLayer: new ScriptedDecisionLayer(),
  grantAuthority: authority,
  lifecycle,
  author,
});

runtime.observe({
  observation_id: 'example:source.registered:alpha',
  source: { kind: 'test', id: 'crystallize' },
  caused_by: null,
  payload_type: 'source.registered',
  payload_version: 1,
  payload: { resource: alpha, revision: 1, content: CONTENT.alpha },
});
runtime.observe({
  observation_id: 'example:source.registered:beta',
  source: { kind: 'test', id: 'crystallize' },
  caused_by: null,
  payload_type: 'source.registered',
  payload_version: 1,
  payload: { resource: beta, revision: 1, content: CONTENT.beta },
});

const goal: Goal = {
  goal_id: 'g-report-fold',
  purpose: 'Produce a checked report that includes a fold of the inspections',
  sources: [alpha, beta],
  authority: { read: [alpha, beta] },
  gap: {
    operation: 'report.fold',
    purpose: 'Fold inspection digests into one canonical digest',
    input: { inspections: '[InspectionResult]' },
    output: { fold: 'string' },
    variants: author.variants,
  },
  retained_procedure: RETAINED_FOLD_PROCEDURE,
  budget: { actions: 32, judgments: 32 },
  success_evidence: 'a report covering every goal source and a fold bound to those inspections',
};

runtime.operator.submit({
  observation_id: 'operator:goal.opened:g-report-fold',
  caused_by: null,
  payload_type: 'goal.opened',
  payload_version: 1,
  payload: goal,
});

await drive();

const state = runtime.state();
const trace = runtime.trace();
const violations = traceCompletenessViolations(trace);
if (state.goal?.status !== 'complete' || violations.length > 0) {
  console.error('crystallization did not complete', state.goal?.status, violations);
  process.exit(1);
}

const search = output('gap.search') as { status: string; informed_by: string | null; reason: string };
const isolation = lifecycle.audit().isolation;
const greens = results('green.prove').map((result) =>
  result.outcome.outcome === 'succeeded'
    ? (result.outcome.output as { implementation_id?: string; proven: boolean; visible: { passed: number; failed: number }; held_out: { passed: number; failed: number } })
    : null,
);
const foldStart = started('report.fold')[0];
const fold = state.crystallization.fold;

console.log('procedure          crystallize_and_report@1');
console.log(`gap.search         ${search.status}`);
console.log(`  informed_by      ${search.informed_by ?? 'none'}`);
console.log(`  reason           ${search.reason}`);
console.log(`corpus splits      visible ${state.crystallization.visible_ids.join(', ')}; held-out ids retained by the lifecycle`);
console.log(`red                demonstrated under isolation report ${isolation?.report_id ?? 'missing'}`);
console.log(
  `  probe            filesystem ${isolation?.filesystem}, child_process ${isolation?.child_process}, credentials ${isolation?.credentials}, fetch ${isolation?.evaluated_fetch}`,
);
console.log(`implementations    ${state.crystallization.implementations.map((item) => item.id).join(', ')}`);
for (const green of greens) {
  if (!green) continue;
  console.log(
    `green              visible ${green.visible.passed} passed/${green.visible.failed} failed; held-out ${green.held_out.passed} passed/${green.held_out.failed} failed`,
  );
}
console.log(
  `admission          ${state.crystallization.admission?.status} ${state.crystallization.admission?.implementation_id} by ${state.crystallization.admission?.approver}`,
);
console.log(`  evidence         ${state.crystallization.admission?.evidence_digest}`);
console.log(`fold               ${fold?.fold}`);
console.log(`  grant            ${foldStart?.grant?.operation}@${foldStart?.grant?.contract_rev} permissions ${JSON.stringify(foldStart?.grant?.permissions ?? [])}`);
console.log(`  host invocation  ${host.invocations.some((invocation) => invocation.operation === 'report.fold')}`);
console.log(`report             ${state.report?.report.entries.map((entry) => `${entry.source} rev ${entry.revision}`).join(', ')}`);
console.log(`goal               ${state.goal.status}`);
console.log(`held-out in views  ${author.views.some((view) => JSON.stringify(view).includes('held-digest-unique'))}`);
console.log(`execute runs       ${lifecycle.audit().execute_runs}`);

const replayHost = new AgentFabricHost({ authority: createGrantAuthority() });
const replayed = replay(trace.observations, {
  host: replayHost,
  decisionLayer: failingDecision(),
  lifecycle: failingLifecycle(),
  author: failingAuthor(),
});
if (!replayed.ok) {
  console.error('replay failed', replayed.failure.reason);
  process.exit(1);
}
console.log(`replay             ${replayed.state.goal?.status} fold ${replayed.state.crystallization.fold?.fold === fold?.fold} host invocations ${replayHost.invocations.length}`);

async function drive(): Promise<void> {
  for (let step = 0; step < 50; step += 1) {
    await flush(6);
    const current = runtime.state();
    if (current.goal?.status === 'complete') {
      return;
    }
    if (current.crystallization.admission?.status === 'requested') {
      const admission = current.crystallization.admission;
      runtime.admitCapability({
        request_id: admission.request_id,
        implementation_id: admission.implementation_id,
        evidence_digest: admission.evidence_digest,
        approver: 'operator',
        authority_revision: 1,
      });
      continue;
    }
    for (const action_id of [...host.openActionIds()].sort()) {
      host.release(action_id);
    }
    const running = Object.values(runtime.state().actions).filter((action) => action.state === 'running' || action.state === 'pending');
    if (running.length > 0) {
      await Promise.all(
        running.map(async (action) => {
          try {
            await runtime.settle(action.action_id);
          } catch {
            await flush(4);
          }
        }),
      );
      continue;
    }
    await flush(8);
    const after = runtime.state();
    const still = Object.values(after.actions).some((action) => action.state === 'running' || action.state === 'pending');
    if (!still && host.openActionIds().length === 0 && after.crystallization.admission?.status !== 'requested') {
      return;
    }
  }
  throw new Error('drive stopped before the report completed');
}

function started(operation: string): ActionStartedPayload[] {
  return traceOf()
    .filter((observation) => observation.payload_type === 'action.started')
    .map((observation) => observation.payload as ActionStartedPayload)
    .filter((payload) => payload.operation === operation);
}

function results(operation: string): ActionResultPayload[] {
  const ids = new Set(started(operation).map((payload) => payload.action_id));
  return traceOf()
    .filter((observation) => observation.payload_type === 'action.result')
    .map((observation) => observation.payload as ActionResultPayload)
    .filter((payload) => ids.has(payload.action_id));
}

function output(operation: string): unknown {
  const result = results(operation)[0];
  if (!result || result.outcome.outcome !== 'succeeded') {
    throw new Error(`${operation} did not succeed`);
  }
  return result.outcome.output;
}

function traceOf() {
  return runtime.trace().observations.filter((observation) => observation.validation.status === 'accepted');
}

async function flush(times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function failingDecision(): DecisionLayer {
  return {
    implementation: 'unused',
    weigh(): never {
      throw new Error('decision layer must not be invoked');
    },
  };
}

function failingAuthor(): ExtensionAuthor {
  const fail = (): never => {
    throw new Error('author must not be invoked');
  };
  return { implementation: 'unused', variants: [], proposeContract: fail, proposeCases: fail, proposeImplementation: fail };
}

function failingLifecycle(): CapabilityLifecycle {
  const fail = (): never => {
    throw new Error('lifecycle must not be invoked');
  };
  return {
    search: fail,
    proposeContract: fail,
    submitCases: fail,
    reviseCases: fail,
    validateCorpus: fail,
    demonstrateRed: fail,
    implementerView: fail,
    attachImplementation: fail,
    proveGreen: fail,
    requestAdmission: fail,
    admit: fail,
    revoke: fail,
    reviseContract: fail,
    audit: fail,
  };
}
