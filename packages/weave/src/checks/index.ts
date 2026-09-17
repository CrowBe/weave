import type { Capability } from "@weave/agentsop";
import { Fabric, placeholderResolver, type ResolverFn } from "@weave/agentfabric";

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
  capabilityId: string;
  revision: string;
  cases: TestCase[];
}

export interface CaseResult {
  caseId: string;
  passed: boolean;
  detail: string;
}

export interface CheckEvidence {
  passed: boolean;
  reasons: string[];
  red: { demonstrated: boolean; rejectedBy: string[] };
  green: { proven: boolean };
  heldOut: { proven: boolean };
}

function development(corpus: TestCorpus): TestCase[] {
  return corpus.cases.filter((testCase) => testCase.visibility === "development");
}

function heldOut(corpus: TestCorpus): TestCase[] {
  return corpus.cases.filter((testCase) => testCase.visibility === "held_out");
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runCase(
  fabric: Fabric,
  principal: string,
  capabilityId: string,
  source: string | ResolverFn,
  testCase: TestCase,
): Promise<CaseResult> {
  const result = await fabric.trial(principal, capabilityId, source, testCase.input);
  if (testCase.expectedError) {
    const passed = !result.ok && result.error?.code === testCase.expectedError.code;
    return {
      caseId: testCase.id,
      passed,
      detail: passed
        ? `failed as required with ${testCase.expectedError.code}`
        : `expected ${testCase.expectedError.code}, got ${result.error?.code ?? "success"}`,
    };
  }
  const passed = result.ok && deepEqual(result.output, testCase.expected);
  return {
    caseId: testCase.id,
    passed,
    detail: passed ? "matched expected output" : result.error?.message ?? "output mismatch",
  };
}

export async function checkCandidate(args: {
  fabric: Fabric;
  principal: string;
  capability: Capability;
  source: string | ResolverFn;
  corpus: TestCorpus;
}): Promise<CheckEvidence> {
  const reasons: string[] = [];
  const redCases = development(args.corpus);
  const redResults: CaseResult[] = [];
  for (const testCase of redCases) {
    redResults.push(
      await runCase(args.fabric, args.principal, args.capability.id, placeholderResolver(), testCase),
    );
  }
  const rejectedBy = redResults.filter((result) => !result.passed).map((result) => result.caseId);
  const red = { demonstrated: rejectedBy.length > 0, rejectedBy };
  if (!red.demonstrated) reasons.push("red was not demonstrated against a placeholder");

  const greenResults: CaseResult[] = [];
  for (const testCase of redCases) {
    greenResults.push(
      await runCase(args.fabric, args.principal, args.capability.id, args.source, testCase),
    );
  }
  const green = { proven: redCases.length > 0 && greenResults.every((result) => result.passed) };
  if (!green.proven) reasons.push("development corpus did not prove green");

  const heldCases = heldOut(args.corpus);
  const heldResults: CaseResult[] = [];
  for (const testCase of heldCases) {
    heldResults.push(
      await runCase(args.fabric, args.principal, args.capability.id, args.source, testCase),
    );
  }
  const heldOutVerdict = {
    proven: heldCases.length > 0 && heldResults.every((result) => result.passed),
  };
  if (!heldOutVerdict.proven) reasons.push("held-out corpus did not pass");

  return {
    passed: reasons.length === 0,
    reasons: reasons.length === 0 ? ["red demonstrated", "green proven", "held-out passed"] : reasons,
    red,
    green,
    heldOut: heldOutVerdict,
  };
}
