import type { Capability } from "@weave/agentsop";
import type { TestCorpus, TrustVerdict } from "../classifier/index.ts";

export type GoalStatus = "active" | "completed" | "blocked" | "failed" | "cancelled";

export type ClassifierPhase =
  | "awaiting_document"
  | "awaiting_corpus"
  | "awaiting_resolver"
  | "awaiting_trust"
  | "awaiting_crystallise"
  | "ready";

export interface Authority {
  canCrystallise: boolean;
  canClassify: boolean;
  canRequestInference: boolean;
  canCommunicate: boolean;
  canComplete: boolean;
  inferenceBudget: number;
}

export type SuccessCriteria =
  | { kind: "facts_present"; keys: string[] }
  | { kind: "fact_for_each"; listKey: string; factPrefix: string };

export interface Goal {
  id: string;
  statement: string;
  scope: string;
  principal: string;
  authority: Authority;
  status: GoalStatus;
  success: SuccessCriteria;
}

export interface Fact {
  key: string;
  value: unknown;
  evidenceIds: string[];
  producedAt: string;
}

export interface OpenQuestion {
  id: string;
  prompt: string;
  blocking: boolean;
  asked: boolean;
}

export interface CapabilityGap {
  purpose: string;
  capabilityId: string;
  listKey: string;
  outputPrefix: string;
  inputKey: string;
}

export interface Approval {
  subject: string;
  requested: boolean;
  granted: boolean;
  reason?: string;
}

export interface ClassifierWork {
  id: string;
  capabilityId: string;
  purpose: string;
  phase: ClassifierPhase;
  document?: Capability;
  corpus?: TestCorpus;
  resolverSource?: string;
  trust?: TrustVerdict;
}

export interface EvidenceRecord {
  id: string;
  kind: string;
  observationId: string;
  summary: string;
  at: string;
}

export interface WeaveState {
  goal: Goal;
  facts: Record<string, Fact>;
  openQuestions: OpenQuestion[];
  gap?: CapabilityGap;
  approvals: Approval[];
  classifier?: ClassifierWork;
  evidence: EvidenceRecord[];
}

export type ObservationKind =
  | "user_input"
  | "capability_result"
  | "inference_result"
  | "approval"
  | "approval_requested"
  | "error"
  | "timeout"
  | "environment_change"
  | "classifier_event"
  | "capability_registered"
  | "capability_crystallised"
  | "communication"
  | "goal_completed"
  | "action_cancelled";

export interface Observation {
  id: string;
  at: string;
  kind: ObservationKind;
  threadId?: string;
  actionId?: string;
  payload: Record<string, unknown>;
}

export function successCriteriaMet(state: WeaveState): boolean {
  const success = state.goal.success;
  if (success.kind === "facts_present") {
    return success.keys.every((key) => key in state.facts);
  }
  const list = state.facts[success.listKey]?.value;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every((item) => `${success.factPrefix}${String(item)}` in state.facts);
}

export function createState(goal: Goal): WeaveState {
  return {
    goal,
    facts: {},
    openQuestions: [],
    approvals: [],
    evidence: [],
  };
}

function recordEvidence(
  state: WeaveState,
  observation: Observation,
  kind: string,
  summary: string,
): void {
  state.evidence.push({
    id: `ev_${observation.id}`,
    kind,
    observationId: observation.id,
    summary,
    at: observation.at,
  });
}

function setFact(state: WeaveState, key: string, value: unknown, observation: Observation): void {
  state.facts[key] = {
    key,
    value,
    evidenceIds: [observation.id],
    producedAt: observation.at,
  };
}

export function applyObservation(state: WeaveState, observation: Observation): WeaveState {
  const next = structuredClone(state);
  switch (observation.kind) {
    case "user_input": {
      const facts = observation.payload.facts as Record<string, unknown> | undefined;
      if (facts) {
        for (const [key, value] of Object.entries(facts)) {
          setFact(next, key, value, observation);
        }
      }
      if (observation.payload.gap && typeof observation.payload.gap === "object") {
        next.gap = observation.payload.gap as CapabilityGap;
        next.classifier = {
          id: `clf_${observation.id}`,
          capabilityId: next.gap.capabilityId,
          purpose: next.gap.purpose,
          phase: "awaiting_document",
        };
      }
      recordEvidence(next, observation, "user_input", String(observation.payload.text ?? "user input"));
      break;
    }
    case "inference_result": {
      const cost = typeof observation.payload.cost === "number" ? observation.payload.cost : 0;
      next.goal.authority.inferenceBudget = Math.max(0, next.goal.authority.inferenceBudget - cost);
      const work = next.classifier;
      const kind = observation.payload.requestKind;
      const output = observation.payload.output;
      if (work && kind === "propose_contract" && output && typeof output === "object") {
        work.document = output as Capability;
        work.phase = "awaiting_corpus";
      } else if (work && kind === "propose_tests" && output && typeof output === "object") {
        work.corpus = output as TestCorpus;
        work.phase = work.resolverSource ? "awaiting_trust" : "awaiting_resolver";
      } else if (work && kind === "propose_resolver" && typeof output === "string") {
        work.resolverSource = output;
        work.phase = work.corpus ? "awaiting_trust" : "awaiting_corpus";
      } else if (work && kind === "propose_resolver" && output && typeof output === "object" && "source" in output) {
        work.resolverSource = String((output as { source: string }).source);
        work.phase = work.corpus ? "awaiting_trust" : "awaiting_corpus";
      }
      recordEvidence(next, observation, "inference_result", `inference ${String(kind)} recorded as observation`);
      break;
    }
    case "capability_registered": {
      if (next.classifier) {
        next.classifier.document = observation.payload.document as Capability | undefined;
        next.classifier.phase =
          next.classifier.corpus && next.classifier.resolverSource
            ? "awaiting_trust"
            : next.classifier.corpus
              ? "awaiting_resolver"
              : "awaiting_corpus";
      }
      recordEvidence(next, observation, "capability_registered", String(observation.payload.capabilityId));
      break;
    }
    case "classifier_event": {
      if (next.classifier) {
        next.classifier.trust = observation.payload.trust as TrustVerdict;
        next.classifier.phase = next.classifier.trust?.trusted ? "awaiting_crystallise" : "awaiting_trust";
      }
      recordEvidence(next, observation, "classifier_event", "classifier verdict");
      break;
    }
    case "capability_crystallised": {
      if (next.classifier) next.classifier.phase = "ready";
      recordEvidence(next, observation, "capability_crystallised", String(observation.payload.capabilityId));
      break;
    }
    case "capability_result": {
      const outputKey = observation.payload.outputKey;
      if (typeof outputKey === "string") {
        setFact(next, outputKey, observation.payload.output, observation);
      }
      if (observation.payload.denied === true && next.gap) {
        const existing = next.approvals.find((item) => item.subject === next.gap?.capabilityId);
        if (!existing) {
          next.approvals.push({
            subject: next.gap.capabilityId,
            requested: false,
            granted: false,
            reason: "invoke returned DENIED",
          });
        }
      }
      recordEvidence(next, observation, "capability_result", String(observation.payload.capabilityId));
      break;
    }
    case "approval_requested": {
      const subject = String(observation.payload.subject);
      const existing = next.approvals.find((item) => item.subject === subject);
      if (existing) existing.requested = true;
      else {
        next.approvals.push({
          subject,
          requested: true,
          granted: false,
          reason: typeof observation.payload.reason === "string" ? observation.payload.reason : undefined,
        });
      }
      recordEvidence(next, observation, "approval_requested", subject);
      break;
    }
    case "approval": {
      const subject = String(observation.payload.subject);
      const granted = observation.payload.granted === true;
      const existing = next.approvals.find((item) => item.subject === subject);
      if (existing) {
        existing.granted = granted;
        existing.requested = true;
      } else {
        next.approvals.push({ subject, requested: true, granted });
      }
      recordEvidence(next, observation, "approval", subject);
      break;
    }
    case "communication": {
      for (const question of next.openQuestions) {
        if (question.blocking) question.asked = true;
      }
      recordEvidence(next, observation, "communication", "communication emitted");
      break;
    }
    case "goal_completed": {
      next.goal.status = "completed";
      recordEvidence(next, observation, "goal_completed", "goal completed");
      break;
    }
    default: {
      recordEvidence(next, observation, observation.kind, observation.kind);
    }
  }
  return next;
}
