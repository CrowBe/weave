import type {
  CapabilityContract,
  ImplementationCandidate,
  TestCorpus,
} from "@weave/agentfabric";
import type { GreenEvidence, RedEvidence } from "@weave/agentfabric";
import type { AdmissionVerdict } from "@weave/agentfabric";

export type GoalStatus = "active" | "completed" | "blocked" | "failed" | "cancelled";

export type CrystallizationPhase =
  | "awaiting_contract"
  | "awaiting_tests"
  | "awaiting_red"
  | "awaiting_implementation"
  | "awaiting_green"
  | "awaiting_admission"
  | "admitted";

export interface Authority {
  canCrystallize: boolean;
  canRequestInference: boolean;
  canCommunicate: boolean;
  canComplete: boolean;
  /** Capability ids this goal may execute. Newly admitted capabilities are not implied. */
  canExecute: string[];
  inferenceBudget: number;
}

export type SuccessCriteria =
  | { kind: "facts_present"; keys: string[] }
  | { kind: "fact_for_each"; listKey: string; factPrefix: string };

export interface Goal {
  id: string;
  statement: string;
  scope: string;
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

export interface CapabilityRef {
  contractId: string;
  version: string;
  maturity: string;
}

export interface CrystallizationWork {
  id: string;
  capabilityId: string;
  purpose: string;
  phase: CrystallizationPhase;
  contract?: CapabilityContract;
  corpus?: TestCorpus;
  candidate?: ImplementationCandidate;
  red?: RedEvidence;
  green?: GreenEvidence;
  heldOut?: GreenEvidence;
  admission?: AdmissionVerdict;
}

export interface EvidenceRecord {
  id: string;
  kind: string;
  observationId: string;
  summary: string;
  at: string;
}

export interface Thread {
  id: string;
  label: string;
  status: "open" | "joined" | "cancelled" | "superseded";
}

export interface WeaveState {
  goal: Goal;
  facts: Record<string, Fact>;
  openQuestions: OpenQuestion[];
  gap?: CapabilityGap;
  approvals: Approval[];
  capabilityRefs: CapabilityRef[];
  crystallization?: CrystallizationWork;
  evidence: EvidenceRecord[];
  threads: Thread[];
}

export interface UserInputPayload {
  text?: string;
  facts?: Record<string, unknown>;
  gap?: CapabilityGap;
  questions?: Array<{ prompt: string; blocking?: boolean }>;
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
  | "crystallization_event"
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
    capabilityRefs: [],
    evidence: [],
    threads: [{ id: "thread_main", label: "main", status: "open" }],
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

function setFact(
  state: WeaveState,
  key: string,
  value: unknown,
  observation: Observation,
): void {
  state.facts[key] = {
    key,
    value,
    evidenceIds: [observation.id],
    producedAt: observation.at,
  };
}

function ensureCrystallization(state: WeaveState, observation: Observation): CrystallizationWork {
  if (state.crystallization) return state.crystallization;
  if (!state.gap) {
    throw new Error("cannot start crystallization without a capability gap");
  }
  state.crystallization = {
    id: `crys_${observation.id}`,
    capabilityId: state.gap.capabilityId,
    purpose: state.gap.purpose,
    phase: "awaiting_contract",
  };
  return state.crystallization;
}

export function applyObservation(state: WeaveState, observation: Observation): WeaveState {
  const next = structuredClone(state);
  switch (observation.kind) {
    case "user_input": {
      const payload = observation.payload as unknown as UserInputPayload;
      if (payload.facts) {
        for (const [key, value] of Object.entries(payload.facts)) {
          setFact(next, key, value, observation);
        }
      }
      if (payload.gap) {
        next.gap = payload.gap;
        if (!next.crystallization) {
          next.crystallization = {
            id: `crys_${observation.id}`,
            capabilityId: payload.gap.capabilityId,
            purpose: payload.gap.purpose,
            phase: "awaiting_contract",
          };
        }
      }
      if (payload.questions) {
        for (const question of payload.questions) {
          next.openQuestions.push({
            id: `q_${next.openQuestions.length + 1}`,
            prompt: question.prompt,
            blocking: question.blocking ?? true,
            asked: false,
          });
        }
      }
      recordEvidence(next, observation, "user_input", payload.text ?? "user input");
      break;
    }
    case "inference_result": {
      const cost = typeof observation.payload.cost === "number" ? observation.payload.cost : 0;
      next.goal.authority.inferenceBudget = Math.max(
        0,
        next.goal.authority.inferenceBudget - cost,
      );
      const requestKind = observation.payload.requestKind;
      const output = observation.payload.output;
      const work = next.crystallization ?? (next.gap ? ensureCrystallization(next, observation) : undefined);
      if (work && requestKind === "propose_contract" && output && typeof output === "object") {
        work.contract = output as CapabilityContract;
        work.phase = "awaiting_tests";
      } else if (work && requestKind === "propose_tests" && output && typeof output === "object") {
        work.corpus = output as TestCorpus;
        work.phase = "awaiting_red";
      } else if (
        work &&
        requestKind === "propose_implementation" &&
        output &&
        typeof output === "object"
      ) {
        work.candidate = output as ImplementationCandidate;
        work.phase = "awaiting_green";
      }
      recordEvidence(
        next,
        observation,
        "inference_result",
        `inference ${String(requestKind)} recorded as observation`,
      );
      break;
    }
    case "crystallization_event": {
      const work = next.crystallization ?? (next.gap ? ensureCrystallization(next, observation) : undefined);
      if (!work) break;
      const phase = observation.payload.phase;
      if (phase === "red") {
        work.red = observation.payload.red as RedEvidence;
        work.phase = work.red?.demonstrated ? "awaiting_implementation" : "awaiting_red";
      } else if (phase === "green") {
        work.green = observation.payload.green as GreenEvidence;
        work.phase = work.green?.proven ? "awaiting_admission" : "awaiting_green";
      } else if (phase === "admission") {
        work.heldOut = observation.payload.heldOut as GreenEvidence | undefined;
        work.admission = observation.payload.admission as AdmissionVerdict | undefined;
        if (work.admission?.eligible && work.contract) {
          work.phase = "admitted";
          next.capabilityRefs.push({
            contractId: work.contract.id,
            version: work.contract.version,
            maturity: work.admission.maturity,
          });
        }
      }
      recordEvidence(next, observation, "crystallization_event", `crystallization ${String(phase)}`);
      break;
    }
    case "capability_result": {
      const outputKey = observation.payload.outputKey;
      if (typeof outputKey === "string") {
        setFact(next, outputKey, observation.payload.output, observation);
      }
      recordEvidence(
        next,
        observation,
        "capability_result",
        `capability ${String(observation.payload.capabilityId)} produced ${String(outputKey)}`,
      );
      break;
    }
    case "approval_requested": {
      const subject = String(observation.payload.subject);
      const existing = next.approvals.find((approval) => approval.subject === subject);
      if (existing) {
        existing.requested = true;
      } else {
        next.approvals.push({
          subject,
          requested: true,
          granted: false,
          reason: typeof observation.payload.reason === "string" ? observation.payload.reason : undefined,
        });
      }
      recordEvidence(next, observation, "approval_requested", `approval requested for ${subject}`);
      break;
    }
    case "approval": {
      const subject = String(observation.payload.subject);
      const granted = observation.payload.granted === true;
      const existing = next.approvals.find((approval) => approval.subject === subject);
      if (existing) {
        existing.granted = granted;
        existing.requested = true;
      } else {
        next.approvals.push({ subject, requested: true, granted });
      }
      recordEvidence(
        next,
        observation,
        "approval",
        granted ? `approval granted for ${subject}` : `approval denied for ${subject}`,
      );
      break;
    }
    case "communication": {
      const questionId = observation.payload.questionId;
      if (typeof questionId === "string") {
        const question = next.openQuestions.find((item) => item.id === questionId);
        if (question) question.asked = true;
      } else {
        for (const question of next.openQuestions) {
          if (question.blocking) question.asked = true;
        }
      }
      recordEvidence(next, observation, "communication", "communication emitted");
      break;
    }
    case "goal_completed": {
      next.goal.status = "completed";
      recordEvidence(next, observation, "goal_completed", "goal completed");
      break;
    }
    case "error": {
      recordEvidence(next, observation, "error", String(observation.payload.message ?? "error"));
      break;
    }
    case "timeout":
    case "environment_change":
    case "action_cancelled": {
      recordEvidence(next, observation, observation.kind, observation.kind);
      break;
    }
  }
  return next;
}
