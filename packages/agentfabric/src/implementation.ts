import vm from "node:vm";
import type { CapabilityContract, ExecutionConstraints, Provenance } from "./contract.ts";

export type ImplementationKind = "local_source" | "function";

export interface ExecutionError {
  code: string;
  message: string;
}

export interface ExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: ExecutionError;
  durationMs: number;
}

export interface ImplementationCandidate {
  id: string;
  contractId: string;
  kind: ImplementationKind;
  source?: string;
  execute?: (input: unknown) => unknown | Promise<unknown>;
  provenance: Provenance;
}

export interface ImplementationRuntime {
  execute(
    candidate: ImplementationCandidate,
    input: unknown,
    constraints: ExecutionConstraints,
  ): Promise<ExecutionResult>;
}

export function placeholderImplementation(contractId: string): ImplementationCandidate {
  return {
    id: `placeholder:${contractId}`,
    contractId,
    kind: "local_source",
    source: "return input;",
    provenance: {
      origin: "agentfabric",
      generators: ["placeholder"],
    },
  };
}

export function normalizeError(err: unknown): ExecutionError {
  if (err && typeof err === "object") {
    const code = "code" in err && typeof err.code === "string" ? err.code : "execution_error";
    const message =
      "message" in err && typeof err.message === "string" ? err.message : safeToString(err);
    return { code, message };
  }
  return { code: "execution_error", message: String(err) };
}

function safeToString(err: object): string {
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(Object.assign(new Error("timeout"), { code: "timeout" }));
    }, ms);
  });
}

export class InProcessRuntime implements ImplementationRuntime {
  async execute(
    candidate: ImplementationCandidate,
    input: unknown,
    constraints: ExecutionConstraints,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    try {
      if (candidate.kind === "function" && candidate.execute) {
        const output = await Promise.race([
          Promise.resolve(candidate.execute(input)),
          timeout(constraints.timeoutMs),
        ]);
        return { ok: true, output, durationMs: Date.now() - started };
      }
      if (candidate.kind === "local_source" && candidate.source) {
        const sandbox: { input: unknown; output: unknown } = { input, output: undefined };
        vm.runInNewContext(
          `"use strict"; output = (function(input) {\n${candidate.source}\n})(input);`,
          sandbox,
          { timeout: Math.max(1, constraints.timeoutMs), displayErrors: true },
        );
        return { ok: true, output: sandbox.output, durationMs: Date.now() - started };
      }
      return {
        ok: false,
        error: { code: "invalid_implementation", message: "implementation has no executable form" },
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, error: normalizeError(err), durationMs: Date.now() - started };
    }
  }
}

export function implementationForContract(
  contract: CapabilityContract,
  candidate: Omit<ImplementationCandidate, "contractId">,
): ImplementationCandidate {
  return { ...candidate, contractId: contract.id };
}
