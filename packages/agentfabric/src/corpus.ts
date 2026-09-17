import type { CapabilityContract } from "./contract.ts";
import type { ImplementationCandidate, ImplementationRuntime } from "./implementation.ts";
import { deepEqual, validateSchema } from "./schema.ts";

export type TestVisibility = "development" | "held_out";

export interface TestCase {
  id: string;
  name: string;
  visibility: TestVisibility;
  input: unknown;
  expected?: unknown;
  expectedError?: { code: string };
}

export interface TestCorpus {
  contractId: string;
  revision: string;
  cases: TestCase[];
}

export interface TestResult {
  caseId: string;
  passed: boolean;
  detail: string;
}

export function developmentCases(corpus: TestCorpus): TestCase[] {
  return corpus.cases.filter((testCase) => testCase.visibility === "development");
}

export function heldOutCases(corpus: TestCorpus): TestCase[] {
  return corpus.cases.filter((testCase) => testCase.visibility === "held_out");
}

export function assertCorpus(corpus: TestCorpus): void {
  if (!corpus.contractId.trim()) throw new Error("test corpus is missing contractId");
  if (!corpus.revision.trim()) throw new Error("test corpus is missing revision");
  if (corpus.cases.length === 0) throw new Error("test corpus has no cases");
  for (const testCase of corpus.cases) {
    if (testCase.expected === undefined && testCase.expectedError === undefined) {
      throw new Error(`test case ${testCase.id} has neither expected output nor expectedError`);
    }
  }
}

export async function runCases(
  cases: TestCase[],
  contract: CapabilityContract,
  candidate: ImplementationCandidate,
  runtime: ImplementationRuntime,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const testCase of cases) {
    const inputViolations = validateSchema(contract.inputs, testCase.input);
    if (inputViolations.length > 0 && !testCase.expectedError) {
      results.push({
        caseId: testCase.id,
        passed: false,
        detail: `input failed contract schema: ${inputViolations.map((v) => v.message).join("; ")}`,
      });
      continue;
    }
    const execution = await runtime.execute(
      candidate,
      testCase.input,
      contract.executionConstraints,
    );
    if (testCase.expectedError) {
      const passed =
        !execution.ok && execution.error?.code === testCase.expectedError.code;
      results.push({
        caseId: testCase.id,
        passed,
        detail: passed
          ? `failed as required with ${testCase.expectedError.code}`
          : `expected error ${testCase.expectedError.code}, got ${
              execution.ok ? "success" : execution.error?.code ?? "unknown error"
            }`,
      });
      continue;
    }
    if (!execution.ok) {
      results.push({
        caseId: testCase.id,
        passed: false,
        detail: `unexpected error ${execution.error?.code ?? "unknown"}: ${
          execution.error?.message ?? ""
        }`,
      });
      continue;
    }
    const outputViolations = validateSchema(contract.outputs, execution.output);
    if (outputViolations.length > 0) {
      results.push({
        caseId: testCase.id,
        passed: false,
        detail: `output failed contract schema: ${outputViolations
          .map((v) => v.message)
          .join("; ")}`,
      });
      continue;
    }
    const passed = deepEqual(execution.output, testCase.expected);
    results.push({
      caseId: testCase.id,
      passed,
      detail: passed ? "matched expected output" : "output did not match expected value",
    });
  }
  return results;
}
