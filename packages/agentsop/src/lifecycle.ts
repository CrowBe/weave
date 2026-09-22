/**
 * Lifecycle port shared by AgentFabric and Weave. The implementation lives in
 * AgentFabric; Weave schedules the steps and does not own their evidence.
 */
import type { CapabilityContract } from './contracts.js';
import type { TestCase, TestSplit } from './corpus.js';

export interface DesiredOperation {
  readonly operation: string;
  readonly purpose: string;
  readonly input: Readonly<Record<string, string>>;
  readonly output: Readonly<Record<string, string>>;
}

export interface SearchResult {
  readonly status: 'reusable' | 'composed' | 'gap';
  readonly matches: readonly string[];
  readonly compositions: readonly string[];
  readonly informed_by: string | null;
  readonly reason: string;
}

export interface IsolationReport {
  readonly supported: boolean;
  readonly tier: 'untrusted';
  readonly filesystem: 'blocked' | 'open' | 'unprobed';
  readonly network: 'none' | 'open' | 'unprobed';
  readonly child_process: 'blocked' | 'open' | 'unprobed';
  readonly credentials: 'absent' | 'visible' | 'unprobed';
  readonly evaluated_process: 'undefined' | 'defined' | 'unprobed';
  readonly evaluated_require: 'undefined' | 'defined' | 'unprobed';
  readonly evaluated_fetch: 'undefined' | 'defined' | 'unprobed';
  readonly held_out_mounted: false;
  readonly host_process: 'unreachable' | 'unprobed';
  readonly broker: 'resolver-context';
  readonly limits: { readonly memory_bytes: number; readonly cpu_ms: number };
  readonly report_id: string;
}

export interface ImplementerView {
  readonly contract_id: string;
  readonly contract_revision: string;
  readonly purpose: string;
  readonly input: Readonly<Record<string, string>>;
  readonly output: Readonly<Record<string, string>>;
  readonly failures: readonly string[];
  readonly visible_cases: readonly TestCase[];
  readonly retained_procedure: string | null;
}

export interface LifecycleAudit {
  readonly visible_ids: readonly string[];
  readonly held_out_ids: readonly string[];
  readonly held_out_executed: number;
  readonly isolation: IsolationReport | null;
  readonly execute_runs: number;
  readonly probe_runs: number;
}

export type LifecycleStep =
  | { readonly ok: true; readonly output: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export interface AdmissionDecision {
  readonly request_id: string;
  readonly implementation_id: string;
  readonly evidence_digest: string;
  readonly approver: string;
  readonly authority_revision: number;
}

/**
 * Construction evidence for one contract. Admission does not issue an
 * execution grant. Held-out cases are not returned from `implementerView`.
 */
export interface CapabilityLifecycle {
  search(desired: DesiredOperation, retained: string | null): LifecycleStep;
  /** Purpose, closed shapes, and an empty effect set. A shared output type is not a composition. */
  searchExact(desired: DesiredOperation, retained: string | null): LifecycleStep;
  proposeContract(contract: CapabilityContract): LifecycleStep;
  submitCases(split: TestSplit, cases: readonly TestCase[]): LifecycleStep;
  reviseCases(split: TestSplit, cases: readonly TestCase[]): LifecycleStep;
  validateCorpus(): LifecycleStep;
  demonstrateRed(): Promise<LifecycleStep>;
  implementerView(): ImplementerView | null;
  attachImplementation(id: string, source: string): LifecycleStep;
  proveGreen(id: string): Promise<LifecycleStep>;
  /** Counts and failure codes only. A second request for the same pair spends the split. */
  heldOutReport(id: string): LifecycleStep;
  requestAdmission(id: string): LifecycleStep;
  admit(decision: AdmissionDecision): LifecycleStep;
  revoke(operation: string, implementationId: string, reason: string): LifecycleStep;
  reviseContract(next: CapabilityContract): LifecycleStep;
  audit(): LifecycleAudit;
}
