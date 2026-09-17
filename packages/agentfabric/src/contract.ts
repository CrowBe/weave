import type { JsonSchema } from "./schema.ts";

export type EffectName = string;
export type PermissionName = string;

export type Maturity = "proposed" | "provisional" | "established" | "deprecated" | "revoked";

export interface ExecutionConstraints {
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface FailureMode {
  code: string;
  when: string;
}

export interface Provenance {
  origin: string;
  generators: string[];
  sourceTraces?: string[];
  recordedAt?: string;
}

export interface CapabilityContract {
  id: string;
  version: string;
  purpose: string;
  inputs: JsonSchema;
  outputs: JsonSchema;
  invariants: string[];
  failures: FailureMode[];
  effects: EffectName[];
  permissions: PermissionName[];
  successEvidence: string[];
  executionConstraints: ExecutionConstraints;
}

export function assertContract(contract: CapabilityContract): void {
  const missing: string[] = [];
  if (!contract.id.trim()) missing.push("id");
  if (!contract.version.trim()) missing.push("version");
  if (!contract.purpose.trim()) missing.push("purpose");
  if (!contract.inputs) missing.push("inputs");
  if (!contract.outputs) missing.push("outputs");
  if (!contract.executionConstraints?.timeoutMs || contract.executionConstraints.timeoutMs <= 0) {
    missing.push("executionConstraints.timeoutMs");
  }
  if (missing.length > 0) {
    throw new Error(`capability contract is incomplete: ${missing.join(", ")}`);
  }
}
