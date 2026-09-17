import type { CapabilityContract, Maturity } from "./contract.ts";
import {
  assertCorpus,
  developmentCases,
  heldOutCases,
  runCases,
  type TestCorpus,
  type TestResult,
} from "./corpus.ts";
import { assertContract } from "./contract.ts";
import {
  placeholderImplementation,
  type ImplementationCandidate,
  type ImplementationRuntime,
} from "./implementation.ts";

export interface RedEvidence {
  kind: "demonstrated_red";
  demonstrated: boolean;
  rejectedBy: string[];
  passedUnexpectedly: string[];
  results: TestResult[];
}

export interface GreenEvidence {
  kind: "proven_green";
  proven: boolean;
  results: TestResult[];
}

export interface AdmissionVerdict {
  eligible: boolean;
  maturity: Maturity;
  reasons: string[];
  red: RedEvidence;
  green: GreenEvidence;
  heldOut: GreenEvidence;
}

export interface CrystallizationRecord {
  contract: CapabilityContract;
  corpus: TestCorpus;
  placeholder: ImplementationCandidate;
  candidate: ImplementationCandidate;
  verdict: AdmissionVerdict;
}

export async function demonstrateRed(
  contract: CapabilityContract,
  corpus: TestCorpus,
  runtime: ImplementationRuntime,
  placeholder: ImplementationCandidate = placeholderImplementation(contract.id),
): Promise<RedEvidence> {
  assertContract(contract);
  assertCorpus(corpus);
  const results = await runCases(developmentCases(corpus), contract, placeholder, runtime);
  const rejectedBy = results.filter((result) => !result.passed).map((result) => result.caseId);
  const passedUnexpectedly = results.filter((result) => result.passed).map((result) => result.caseId);
  return {
    kind: "demonstrated_red",
    demonstrated: rejectedBy.length > 0,
    rejectedBy,
    passedUnexpectedly,
    results,
  };
}

export async function proveGreen(
  contract: CapabilityContract,
  corpus: TestCorpus,
  candidate: ImplementationCandidate,
  runtime: ImplementationRuntime,
): Promise<GreenEvidence> {
  assertContract(contract);
  assertCorpus(corpus);
  const cases = developmentCases(corpus);
  const results = await runCases(cases, contract, candidate, runtime);
  const failed = results.filter((result) => !result.passed);
  return {
    kind: "proven_green",
    proven: cases.length > 0 && failed.length === 0,
    results,
  };
}

export async function evaluateHeldOut(
  contract: CapabilityContract,
  corpus: TestCorpus,
  candidate: ImplementationCandidate,
  runtime: ImplementationRuntime,
): Promise<GreenEvidence> {
  assertContract(contract);
  assertCorpus(corpus);
  const cases = heldOutCases(corpus);
  const results = await runCases(cases, contract, candidate, runtime);
  const failed = results.filter((result) => !result.passed);
  return {
    kind: "proven_green",
    proven: cases.length > 0 && failed.length === 0,
    results,
  };
}

export function evaluateAdmissionEligibility(args: {
  red: RedEvidence;
  green: GreenEvidence;
  heldOut: GreenEvidence;
}): AdmissionVerdict {
  const reasons: string[] = [];
  if (!args.red.demonstrated) {
    reasons.push("red was not demonstrated: the test corpus did not reject the placeholder");
  }
  if (!args.green.proven) {
    reasons.push("development corpus did not prove green");
  }
  if (!args.heldOut.proven) {
    reasons.push("held-out corpus did not pass");
  }
  const eligible = reasons.length === 0;
  return {
    eligible,
    maturity: eligible ? "provisional" : "proposed",
    reasons: eligible
      ? ["red demonstrated", "green proven", "held-out passed"]
      : reasons,
    red: args.red,
    green: args.green,
    heldOut: args.heldOut,
  };
}

export async function runCrystallizationPipeline(args: {
  contract: CapabilityContract;
  corpus: TestCorpus;
  candidate: ImplementationCandidate;
  runtime: ImplementationRuntime;
  placeholder?: ImplementationCandidate;
}): Promise<CrystallizationRecord> {
  const placeholder =
    args.placeholder ?? placeholderImplementation(args.contract.id);
  const red = await demonstrateRed(args.contract, args.corpus, args.runtime, placeholder);
  const green = await proveGreen(args.contract, args.corpus, args.candidate, args.runtime);
  const heldOut = await evaluateHeldOut(
    args.contract,
    args.corpus,
    args.candidate,
    args.runtime,
  );
  return {
    contract: args.contract,
    corpus: args.corpus,
    placeholder,
    candidate: args.candidate,
    verdict: evaluateAdmissionEligibility({ red, green, heldOut }),
  };
}
