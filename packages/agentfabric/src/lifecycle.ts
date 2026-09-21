/**
 * Capability construction evidence. Generation, admission, and authority to
 * execute stay separate. Held-out cases never leave this object through the
 * implementer view, and generated source runs only after an isolation probe.
 */
import {
  checkHeldOutRetained,
  checkRevision,
  validateTestCases,
  type AdmissionDecision,
  type CapabilityContract,
  type CapabilityLifecycle,
  type DesiredOperation,
  type ImplementerView,
  type LifecycleAudit,
  type LifecycleStep,
  type SearchResult,
  type TestCase,
  type TestSplit,
} from '@weave/agentsop';
import { digest } from './digest.js';
import { stableStringify } from './stable-json.js';
import type { AgentFabricHost, CapabilityImplementation } from './host.js';
import { IsolateRunner, isolatedCall, type IsolationMode } from './isolate.js';

const PLACEHOLDER_SOURCE = 'return { fold: "placeholder" };';

interface GreenRecord {
  readonly implementation_id: string;
  readonly proven: boolean;
  readonly contract_revision: string;
  readonly corpus_revision: string;
  readonly source_digest: string;
  readonly isolation_report_id: string;
  readonly evidence_digest: string;
  readonly visible_passed: number;
  readonly held_out_passed: number;
  readonly held_out_failed: number;
  valid: boolean;
}

export class FabricLifecycle implements CapabilityLifecycle {
  readonly runner: IsolateRunner;
  private desired: DesiredOperation | null = null;
  private retained: string | null = null;
  private contract: CapabilityContract | null = null;
  private readonly visible: TestCase[] = [];
  private readonly heldOut: TestCase[] = [];
  private corpusRevision: string | null = null;
  private corpusValidated = false;
  private red: { readonly demonstrated: boolean; readonly corpus_revision: string; readonly contract_revision: string } | null = null;
  private readonly sources = new Map<string, string>();
  private readonly attached = new Set<string>();
  private heldOutSpent = false;
  private heldOutExecuted = 0;
  private readonly green = new Map<string, GreenRecord>();
  private admission: {
    request_id: string;
    implementation_id: string;
    evidence_digest: string;
    status: 'requested' | 'admitted' | 'denied';
  } | null = null;
  private revoked = false;

  constructor(
    private readonly host: AgentFabricHost,
    mode: IsolationMode = 'enforcing',
  ) {
    this.runner = new IsolateRunner(mode);
  }

  /** Already-established capability, used when search should find reuse. */
  installEstablished(contract: CapabilityContract, source: string): void {
    this.host.installAdmitted(contract, this.implementation(source));
  }

  search(desired: DesiredOperation, retained: string | null): LifecycleStep {
    this.desired = desired;
    this.retained = retained;
    const catalogue = this.host.liveContracts();
    const matches = catalogue
      .filter((contract) => contract.id === desired.operation && this.host.resolution(contract.id) === 'resolved')
      .map((contract) => contract.id);
    if (matches.length > 0) {
      return ok(searchBody('reusable', matches, [], retained, 'an admitted capability already performs this operation'));
    }
    const compositions = catalogue.filter((contract) => typeMapsEqual(contract.output, desired.output)).map((contract) => contract.id);
    if (compositions.length > 0) {
      return ok(
        searchBody('composed', [], compositions, retained, 'an admitted capability already produces the desired output'),
      );
    }
    return ok(searchBody('gap', [], [], retained, 'no admitted capability or composition produces the desired output'));
  }

  proposeContract(contract: CapabilityContract): LifecycleStep {
    const revision = checkRevision(this.contract, contract);
    if (!revision.ok) {
      return fail(revision.reason);
    }
    if (this.desired && contract.id !== this.desired.operation) {
      return fail('contract id must name the desired operation');
    }
    this.contract = contract;
    this.invalidateDownstream();
    return ok({
      contract_id: contract.id,
      contract_revision: contract.revision,
      purpose: contract.purpose,
      role: 'extension',
    });
  }

  submitCases(split: TestSplit, cases: readonly TestCase[]): LifecycleStep {
    if (!this.contract) {
      return fail('contract is not established');
    }
    const scoped = cases.map((testCase) => ({ ...testCase, split }));
    const checked = validateTestCases(scoped, this.contract);
    if (!checked.ok) {
      return fail(checked.reason);
    }
    const target = split === 'visible' ? this.visible : this.heldOut;
    if (target.length > 0) {
      return fail(`${split} cases are already submitted`);
    }
    target.push(...scoped);
    this.corpusValidated = false;
    this.corpusRevision = null;
    return ok({ split, case_ids: scoped.map((testCase) => testCase.id), accepted: true });
  }

  reviseCases(split: TestSplit, cases: readonly TestCase[]): LifecycleStep {
    if (!this.contract) {
      return fail('contract is not established');
    }
    const scoped = cases.map((testCase) => ({ ...testCase, split }));
    const retained = checkHeldOutRetained(this.heldOut, split === 'held_out' ? scoped : this.heldOut);
    if (!retained.ok) {
      return fail(retained.reason);
    }
    const checked = validateTestCases(scoped, this.contract);
    if (!checked.ok) {
      return fail(checked.reason);
    }
    const target = split === 'visible' ? this.visible : this.heldOut;
    target.splice(0, target.length, ...scoped);
    this.invalidateDownstream();
    return ok({ split, case_ids: scoped.map((testCase) => testCase.id), accepted: true });
  }

  validateCorpus(): LifecycleStep {
    if (!this.contract) {
      return fail('contract is not established');
    }
    if (this.visible.length === 0 || this.heldOut.length === 0) {
      return fail('corpus requires a visible split and a held-out split');
    }
    const checked = validateTestCases([...this.visible, ...this.heldOut], this.contract);
    if (!checked.ok) {
      return fail(checked.reason);
    }
    this.corpusRevision = digest({
      contract_revision: this.contract.revision,
      visible: this.visible.map((testCase) => testCase.id),
      held_out: this.heldOut.map((testCase) => testCase.id),
    });
    this.corpusValidated = true;
    return ok({
      corpus_revision: this.corpusRevision,
      contract_revision: this.contract.revision,
      validated: true,
      visible_ids: this.visible.map((testCase) => testCase.id),
      held_out_ids: this.heldOut.map((testCase) => testCase.id),
    });
  }

  async demonstrateRed(): Promise<LifecycleStep> {
    if (!this.contract || !this.corpusValidated || !this.corpusRevision) {
      return fail('corpus is not validated');
    }
    const isolation = await this.runner.prove();
    if (!isolation.supported) {
      return fail('isolation unsupported');
    }
    const results = await this.score(PLACEHOLDER_SOURCE, this.visible);
    const failed = results.filter((result) => !result.passed).length;
    if (failed < 1) {
      return fail('placeholder was not rejected');
    }
    this.red = {
      demonstrated: true,
      corpus_revision: this.corpusRevision,
      contract_revision: this.contract.revision,
    };
    return ok({
      demonstrated: true,
      placeholder_digest: digest(PLACEHOLDER_SOURCE),
      corpus_revision: this.corpusRevision,
      contract_revision: this.contract.revision,
      isolation,
      visible_failed: failed,
      visible_passed: results.length - failed,
      role: 'extension',
    });
  }

  implementerView(): ImplementerView | null {
    if (!this.contract) {
      return null;
    }
    return {
      contract_id: this.contract.id,
      contract_revision: this.contract.revision,
      purpose: this.contract.purpose,
      input: this.contract.input,
      output: this.contract.output,
      failures: this.contract.failures,
      visible_cases: this.visible.map((testCase) => ({ ...testCase })),
      retained_procedure: this.retained,
    };
  }

  attachImplementation(id: string, source: string): LifecycleStep {
    if (!this.red?.demonstrated) {
      return fail('red has not been demonstrated');
    }
    if (this.heldOutSpent && !this.attached.has(id)) {
      return fail('held-out evidence spent');
    }
    if (!source.trim()) {
      return fail('implementation source is empty');
    }
    this.attached.add(id);
    this.sources.set(id, source);
    const view = this.implementerView();
    return ok({
      implementation_id: id,
      source_digest: digest(source),
      view: view ?? {},
      role: 'extension',
    });
  }

  async proveGreen(id: string): Promise<LifecycleStep> {
    if (!this.contract || !this.corpusValidated || !this.corpusRevision || !this.red?.demonstrated) {
      return fail('red has not been demonstrated');
    }
    const source = this.sources.get(id);
    if (!source || !this.attached.has(id)) {
      return fail('implementation is not attached');
    }
    this.heldOutSpent = true;
    const isolation = await this.runner.prove();
    if (!isolation.supported) {
      return fail('isolation unsupported');
    }
    const visible = await this.score(source, this.visible);
    const heldOut = await this.score(source, this.heldOut);
    this.heldOutExecuted += heldOut.length;
    const visibleFailed = visible.filter((result) => !result.passed).length;
    const heldOutFailed = heldOut.filter((result) => !result.passed).length;
    const proven = visibleFailed === 0 && heldOutFailed === 0;
    const source_digest = digest(source);
    const evidence_digest = digest({
      contract_revision: this.contract.revision,
      corpus_revision: this.corpusRevision,
      implementation_id: id,
      source_digest,
      isolation_report_id: isolation.report_id,
      visible_passed: visible.length - visibleFailed,
      held_out_passed: heldOut.length - heldOutFailed,
      held_out_failed: heldOutFailed,
      red_demonstrated: true,
    });
    const record: GreenRecord = {
      implementation_id: id,
      proven,
      contract_revision: this.contract.revision,
      corpus_revision: this.corpusRevision,
      source_digest,
      isolation_report_id: isolation.report_id,
      evidence_digest,
      visible_passed: visible.length - visibleFailed,
      held_out_passed: heldOut.length - heldOutFailed,
      held_out_failed: heldOutFailed,
      valid: true,
    };
    this.green.set(id, record);
    return ok({
      implementation_id: id,
      proven,
      contract_revision: record.contract_revision,
      corpus_revision: record.corpus_revision,
      source_digest,
      isolation_report_id: isolation.report_id,
      evidence_digest,
      visible: { passed: record.visible_passed, failed: visibleFailed },
      held_out: { passed: record.held_out_passed, failed: heldOutFailed },
      role: 'extension',
    });
  }

  requestAdmission(id: string): LifecycleStep {
    const record = this.green.get(id);
    if (!record || !record.proven || !record.valid) {
      return fail('implementation has no valid green evidence');
    }
    if (this.revoked) {
      return fail('implementation is revoked');
    }
    const request_id = `adm:${id}:${record.evidence_digest.slice(0, 12)}`;
    this.admission = {
      request_id,
      implementation_id: id,
      evidence_digest: record.evidence_digest,
      status: 'requested',
    };
    return ok({
      request_id,
      implementation_id: id,
      evidence_digest: record.evidence_digest,
      contract_revision: record.contract_revision,
      corpus_revision: record.corpus_revision,
    });
  }

  admit(decision: AdmissionDecision): LifecycleStep {
    const pending = this.admission;
    if (!pending || pending.status !== 'requested' || pending.request_id !== decision.request_id) {
      return fail('admission request is not pending');
    }
    if (pending.implementation_id !== decision.implementation_id || pending.evidence_digest !== decision.evidence_digest) {
      return fail('admission decision does not match the recorded evidence');
    }
    const record = this.green.get(decision.implementation_id);
    if (!record || !record.valid || !record.proven || record.evidence_digest !== decision.evidence_digest) {
      return fail('evidence invalidated');
    }
    if (!this.contract || this.contract.revision !== record.contract_revision) {
      return fail('evidence invalidated');
    }
    const source = this.sources.get(decision.implementation_id);
    if (!source) {
      return fail('implementation source is missing');
    }
    this.host.installAdmitted(this.contract, this.implementation(source));
    this.admission = { ...pending, status: 'admitted' };
    return ok({
      implementation_id: decision.implementation_id,
      contract_revision: this.contract.revision,
      approver: decision.approver,
      evidence_digest: decision.evidence_digest,
    });
  }

  revoke(operation: string, implementationId: string, reason: string): LifecycleStep {
    if (!reason) {
      return fail('revocation requires a reason');
    }
    this.revoked = true;
    this.host.revoke(operation, reason);
    if (this.admission && this.admission.implementation_id === implementationId) {
      this.admission = { ...this.admission, status: 'denied' };
    }
    return ok({ operation, implementation_id: implementationId, reason, kind: 'revoked' });
  }

  reviseContract(next: CapabilityContract): LifecycleStep {
    const revision = checkRevision(this.contract, next);
    if (!revision.ok) {
      return fail(revision.reason);
    }
    const changed = !this.contract || stableStringify(semantic(this.contract)) !== stableStringify(semantic(next));
    if (!changed) {
      return fail('revision does not change the contract');
    }
    if (this.contract && this.host.resolution(this.contract.id) === 'resolved') {
      this.host.revoke(this.contract.id, 'contract revision invalidated admission');
    }
    this.contract = next;
    this.invalidateDownstream();
    return ok({ contract_revision: next.revision, invalidated: true, kind: 'invalidated' });
  }

  audit(): LifecycleAudit {
    return {
      visible_ids: this.visible.map((testCase) => testCase.id),
      held_out_ids: this.heldOut.map((testCase) => testCase.id),
      held_out_executed: this.heldOutExecuted,
      isolation: this.runner.currentReport(),
      execute_runs: this.runner.executeRuns,
      probe_runs: this.runner.probeRuns,
    };
  }

  heldOutCases(): readonly TestCase[] {
    return this.heldOut.map((testCase) => ({ ...testCase }));
  }

  private implementation(source: string): CapabilityImplementation {
    return async (inputs) => {
      const ran = await isolatedCall(this.runner, source, inputs);
      if (!ran.ok) {
        return { outcome: 'failed', failure: ran.failure };
      }
      const output = ran.output;
      if (isRecord(output) && typeof output['failure'] === 'string') {
        return { outcome: 'failed', failure: output['failure'] };
      }
      if (isRecord(output) && typeof output['fold'] === 'string') {
        return { outcome: 'succeeded', output: { fold: output['fold'] } };
      }
      return { outcome: 'failed', failure: 'invalid_inspection' };
    };
  }

  private async score(
    source: string,
    cases: readonly TestCase[],
  ): Promise<readonly { readonly id: string; readonly passed: boolean }[]> {
    const results = await this.runner.runCases(
      source,
      cases.map((testCase) => ({ id: testCase.id, input: testCase.input })),
    );
    return cases.map((testCase) => {
      const result = results.find((item) => item.id === testCase.id);
      return { id: testCase.id, passed: result ? matches(result, testCase) : false };
    });
  }

  private invalidateDownstream(): void {
    this.visible.splice(0, this.visible.length);
    this.heldOut.splice(0, this.heldOut.length);
    this.corpusValidated = false;
    this.corpusRevision = null;
    this.red = null;
    this.sources.clear();
    this.attached.clear();
    this.heldOutSpent = false;
    this.green.clear();
    this.admission = null;
    this.revoked = false;
  }
}

function matches(result: { output?: unknown; error?: string }, testCase: TestCase): boolean {
  if (result.error) {
    return false;
  }
  const output = result.output;
  if (testCase.expected.kind === 'failure') {
    return isRecord(output) && output['failure'] === testCase.expected.code;
  }
  return stableStringify(output) === stableStringify(testCase.expected.output);
}

function searchBody(
  status: SearchResult['status'],
  matches: string[],
  compositions: string[],
  informed_by: string | null,
  reason: string,
): Record<string, unknown> {
  return { status, matches, compositions, informed_by, reason };
}

function semantic(contract: CapabilityContract): unknown {
  return {
    purpose: contract.purpose,
    input: contract.input,
    output: contract.output,
    effects: contract.effects,
    permissions: contract.permissions,
    failures: contract.failures,
    depends_on: contract.depends_on,
  };
}

function typeMapsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return stableStringify(left) === stableStringify(right);
}

function ok(output: Record<string, unknown>): LifecycleStep {
  return { ok: true, output };
}

function fail(reason: string): LifecycleStep {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
