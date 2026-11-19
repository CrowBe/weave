/**
 * Runtime steps that call the capability lifecycle. Results are observations.
 * The author proposes; the lifecycle accepts or refuses. Neither issues a grant.
 */
import type {
  CapabilityContract,
  CapabilityLifecycle,
  DesiredOperation,
  ImplementerView,
  LifecycleStep,
  TestCase,
  TestSplit,
} from '@weave/agentsop';
import type { ActionOutcome, ActionStartedPayload } from './types.js';

export interface ExtensionAuthor {
  readonly implementation: string;
  readonly variants: readonly string[];
  proposeContract(desired: DesiredOperation): CapabilityContract;
  proposeCases(split: TestSplit): readonly TestCase[];
  proposeImplementation(variant: string, view: ImplementerView): { readonly source: string };
}

export function runCrystallizeAction(
  started: ActionStartedPayload,
  lifecycle: CapabilityLifecycle,
  author: ExtensionAuthor,
  desired: DesiredOperation,
  retained: string | null,
  exact = false,
): ActionOutcome | Promise<ActionOutcome> {
  switch (started.operation) {
    case 'gap.search':
      return fromStep(exact ? lifecycle.searchExact(desired, retained) : lifecycle.search(desired, retained));
    case 'contract.establish':
      return fromStep(lifecycle.proposeContract(author.proposeContract(desired)));
    case 'corpus.propose': {
      const split = (started.inputs as { split?: TestSplit }).split;
      if (split !== 'visible' && split !== 'held_out') {
        return { outcome: 'failed', failure: 'corpus split is missing' };
      }
      return fromStep(lifecycle.submitCases(split, author.proposeCases(split)));
    }
    case 'corpus.validate':
      return fromStep(lifecycle.validateCorpus());
    case 'red.demonstrate':
      return lifecycle.demonstrateRed().then(fromStep);
    case 'implementation.generate': {
      const variant = (started.inputs as { variant?: string }).variant;
      if (!variant) {
        return { outcome: 'failed', failure: 'implementation variant is missing' };
      }
      const view = lifecycle.implementerView();
      if (!view) {
        return { outcome: 'failed', failure: 'implementer view is unavailable' };
      }
      const proposed = author.proposeImplementation(variant, view);
      return fromStep(lifecycle.attachImplementation(variant, proposed.source));
    }
    case 'green.prove': {
      const id = (started.inputs as { implementation_id?: string }).implementation_id;
      if (!id) {
        return { outcome: 'failed', failure: 'implementation id is missing' };
      }
      return lifecycle.proveGreen(id).then(fromStep);
    }
    case 'admission.request': {
      const id = (started.inputs as { implementation_id?: string }).implementation_id;
      if (!id) {
        return { outcome: 'failed', failure: 'implementation id is missing' };
      }
      return fromStep(lifecycle.requestAdmission(id));
    }
    default:
      return { outcome: 'failed', failure: `unknown runtime action ${started.operation}` };
  }
}

export function isCrystallizeOperation(operation: string): boolean {
  return (
    operation === 'gap.search' ||
    operation === 'contract.establish' ||
    operation === 'corpus.propose' ||
    operation === 'corpus.validate' ||
    operation === 'red.demonstrate' ||
    operation === 'implementation.generate' ||
    operation === 'green.prove' ||
    operation === 'admission.request'
  );
}

function fromStep(step: LifecycleStep): ActionOutcome {
  if (!step.ok) {
    return { outcome: 'failed', failure: step.reason };
  }
  return { outcome: 'succeeded', output: step.output };
}
