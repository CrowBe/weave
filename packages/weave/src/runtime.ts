import {
  demonstrateRed,
  evaluateAdmissionEligibility,
  evaluateHeldOut,
  InProcessRuntime,
  proveGreen,
  type ImplementationRuntime,
} from "@weave/agentfabric";
import { assignActionIds, enumerateActions, type Action } from "./action.ts";
import type { DecisionLayer } from "./decision.ts";
import { buildFrontier, type ActionFrontier } from "./frontier.ts";
import type { Clock, IdGenerator } from "./ids.ts";
import type {
  InferenceKind,
  InferenceProvider,
  InferenceRequest,
  InferenceRouter,
} from "./inference.ts";
import type { Policy } from "./policy.ts";
import type { CapabilityRegistry } from "./registry.ts";
import { runScheduler } from "./scheduler.ts";
import {
  applyObservation,
  createState,
  successCriteriaMet,
  type Goal,
  type Observation,
  type WeaveState,
} from "./state.ts";

export interface CycleRecord {
  id: string;
  index: number;
  at: string;
  goalId: string;
  factKeys: string[];
  crystallizationPhase?: string;
  actionSpace: Array<{ id: string; kind: string; key: string }>;
  weighted: Array<{
    key: string;
    kind: string;
    value: number;
    uncertainty: number;
    basis: string[];
  }>;
  policy: Array<{ key: string; allowed: boolean; cause: string; reasons: string[] }>;
  viable: string[];
  executed: string[];
  cancelled: string[];
  resultingObservations: Array<{ id: string; kind: string; detail?: string }>;
}

export interface RuntimeOptions {
  goal: Goal;
  decision: DecisionLayer;
  policy: Policy;
  registry: CapabilityRegistry;
  router: InferenceRouter;
  providers: Map<string, InferenceProvider>;
  ids: IdGenerator;
  clock: Clock;
  fabricRuntime?: ImplementationRuntime;
  onCycle?: (record: CycleRecord, state: WeaveState) => void;
}

export class Runtime {
  private state: WeaveState;
  private readonly journalEntries: Observation[] = [];
  private readonly cycleRecords: CycleRecord[] = [];
  private readonly fabricRuntime: ImplementationRuntime;
  private readonly decision: DecisionLayer;
  private readonly policy: Policy;
  private readonly registry: CapabilityRegistry;
  private readonly router: InferenceRouter;
  private readonly providers: Map<string, InferenceProvider>;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly onCycle?: (record: CycleRecord, state: WeaveState) => void;

  constructor(options: RuntimeOptions) {
    this.state = createState(options.goal);
    this.decision = options.decision;
    this.policy = options.policy;
    this.registry = options.registry;
    this.router = options.router;
    this.providers = options.providers;
    this.ids = options.ids;
    this.clock = options.clock;
    this.fabricRuntime = options.fabricRuntime ?? new InProcessRuntime();
    this.onCycle = options.onCycle;
  }

  snapshot(): WeaveState {
    return structuredClone(this.state);
  }

  journal(): Observation[] {
    return [...this.journalEntries];
  }

  cycles(): CycleRecord[] {
    return [...this.cycleRecords];
  }

  observe(input: Omit<Observation, "id" | "at"> & { id?: string; at?: string }): Observation {
    const observation: Observation = {
      ...input,
      id: input.id ?? this.ids.next("obs"),
      at: input.at ?? this.clock.now().toISOString(),
    };
    this.state = applyObservation(this.state, observation);
    this.journalEntries.push(observation);
    return observation;
  }

  plan(): ActionFrontier {
    const actionSpace = assignActionIds(enumerateActions(this.state, this.registry), this.ids);
    const weighted = this.decision.weigh(this.state, actionSpace);
    return buildFrontier(actionSpace, weighted, this.policy, {
      state: this.state,
      registry: this.registry,
    });
  }

  async runCycle(): Promise<CycleRecord> {
    const frontier = this.plan();
    const resulting: Observation[] = [];
    let executed: string[] = [];
    let cancelled: string[] = [];
    if (frontier.viable.length > 0 && this.state.goal.status === "active") {
      const scheduled = await runScheduler({
        initial: frontier,
        execute: (action, signal) => this.dispatch(action, signal),
        replan: () => this.plan(),
        onObservations: (observations) => {
          for (const observation of observations) {
            const stored = this.observe(observation);
            resulting.push(stored);
          }
        },
      });
      executed = scheduled.executed;
      cancelled = scheduled.cancelled;
    }
    const record: CycleRecord = {
      id: this.ids.next("cycle"),
      index: this.cycleRecords.length + 1,
      at: this.clock.now().toISOString(),
      goalId: this.state.goal.id,
      factKeys: Object.keys(this.state.facts),
      crystallizationPhase: this.state.crystallization?.phase,
      actionSpace: frontier.actionSpace.map((action) => ({
        id: action.id,
        kind: action.kind,
        key: action.key,
      })),
      weighted: frontier.weighted.map((item) => ({
        key: item.action.key,
        kind: item.action.kind,
        value: item.weight.value,
        uncertainty: item.weight.uncertainty,
        basis: item.weight.basis,
      })),
      policy: frontier.rejected.map((item) => ({
        key: item.action.key,
        allowed: false,
        cause: item.cause,
        reasons: item.policy?.reasons ?? ["below weight threshold"],
      })),
      viable: frontier.viable.map((item) => item.action.key),
      executed,
      cancelled,
      resultingObservations: resulting.map((observation) => ({
        id: observation.id,
        kind: observation.kind,
        detail:
          observation.kind === "inference_result"
            ? String(observation.payload.requestKind ?? "")
            : observation.kind === "crystallization_event"
              ? String(observation.payload.phase ?? "")
              : undefined,
      })),
    };
    this.cycleRecords.push(record);
    this.onCycle?.(record, this.snapshot());
    return record;
  }

  async runUntilIdle(maxCycles = 40): Promise<CycleRecord[]> {
    const records: CycleRecord[] = [];
    for (let i = 0; i < maxCycles; i += 1) {
      if (this.state.goal.status !== "active") break;
      const record = await this.runCycle();
      records.push(record);
      if (record.viable.length === 0) break;
    }
    return records;
  }

  private async dispatch(action: Action, signal: AbortSignal): Promise<Observation[]> {
    if (signal.aborted) {
      return [this.cancelledObservation(action)];
    }
    switch (action.kind) {
      case "request_inference":
        return this.dispatchInference(action);
      case "demonstrate_red":
        return this.dispatchRed();
      case "prove_green":
        return this.dispatchGreen();
      case "admit_capability":
        return this.dispatchAdmit();
      case "execute_capability":
        return this.dispatchExecute(action, signal);
      case "request_approval":
        return [
          {
            id: this.ids.next("obs"),
            at: this.clock.now().toISOString(),
            kind: "approval_requested",
            actionId: action.id,
            payload: {
              subject: action.input.capabilityId,
              reason: action.input.reason,
            },
          },
        ];
      case "clarify":
        return [
          {
            id: this.ids.next("obs"),
            at: this.clock.now().toISOString(),
            kind: "communication",
            actionId: action.id,
            payload: { questions: action.input.questions },
          },
        ];
      case "communicate":
        return [
          {
            id: this.ids.next("obs"),
            at: this.clock.now().toISOString(),
            kind: "communication",
            actionId: action.id,
            payload: action.input,
          },
        ];
      case "complete_goal":
        if (!successCriteriaMet(this.state)) {
          return [
            {
              id: this.ids.next("obs"),
              at: this.clock.now().toISOString(),
              kind: "error",
              actionId: action.id,
              payload: { message: "complete_goal dispatched without success evidence" },
            },
          ];
        }
        return [
          {
            id: this.ids.next("obs"),
            at: this.clock.now().toISOString(),
            kind: "goal_completed",
            actionId: action.id,
            payload: { statement: this.state.goal.statement },
          },
        ];
      case "wait":
        return [];
    }
  }

  private cancelledObservation(action: Action): Observation {
    return {
      id: this.ids.next("obs"),
      at: this.clock.now().toISOString(),
      kind: "action_cancelled",
      actionId: action.id,
      payload: { key: action.key },
    };
  }

  private async dispatchInference(action: Action): Promise<Observation[]> {
    const request: InferenceRequest = {
      kind: action.input.kind as InferenceKind,
      quality: (action.input.quality as InferenceRequest["quality"]) ?? "min_sufficient",
      context: (action.input.context as Record<string, unknown>) ?? {},
    };
    const binding = this.router.route(request, this.state.goal.authority.inferenceBudget);
    const provider = this.providers.get(binding.providerId);
    if (!provider) {
      return [
        {
          id: this.ids.next("obs"),
          at: this.clock.now().toISOString(),
          kind: "error",
          actionId: action.id,
          payload: { message: `no provider registered for ${binding.providerId}` },
        },
      ];
    }
    const output = await provider.complete(binding, request);
    return [
      {
        id: this.ids.next("obs"),
        at: this.clock.now().toISOString(),
        kind: "inference_result",
        actionId: action.id,
        payload: {
          requestKind: request.kind,
          bindingId: binding.id,
          providerId: binding.providerId,
          cost: binding.cost,
          output,
        },
      },
    ];
  }

  private async dispatchRed(): Promise<Observation[]> {
    const work = this.state.crystallization;
    if (!work?.contract || !work.corpus) {
      return [this.errorObs("demonstrate_red requires a contract and test corpus")];
    }
    const red = await demonstrateRed(work.contract, work.corpus, this.fabricRuntime);
    return [
      {
        id: this.ids.next("obs"),
        at: this.clock.now().toISOString(),
        kind: "crystallization_event",
        payload: { phase: "red", red },
      },
    ];
  }

  private async dispatchGreen(): Promise<Observation[]> {
    const work = this.state.crystallization;
    if (!work?.contract || !work.corpus || !work.candidate) {
      return [this.errorObs("prove_green requires a contract, corpus, and candidate")];
    }
    const green = await proveGreen(
      work.contract,
      work.corpus,
      work.candidate,
      this.fabricRuntime,
    );
    return [
      {
        id: this.ids.next("obs"),
        at: this.clock.now().toISOString(),
        kind: "crystallization_event",
        payload: { phase: "green", green },
      },
    ];
  }

  private async dispatchAdmit(): Promise<Observation[]> {
    const work = this.state.crystallization;
    if (!work?.contract || !work.corpus || !work.candidate || !work.red || !work.green) {
      return [this.errorObs("admit_capability requires red and green evidence")];
    }
    const heldOut = await evaluateHeldOut(
      work.contract,
      work.corpus,
      work.candidate,
      this.fabricRuntime,
    );
    const admission = evaluateAdmissionEligibility({
      red: work.red,
      green: work.green,
      heldOut,
    });
    if (admission.eligible) {
      this.registry.admit({
        contract: work.contract,
        implementation: work.candidate,
        maturity: admission.maturity,
        admission,
        admittedAt: this.clock.now().toISOString(),
      });
    }
    return [
      {
        id: this.ids.next("obs"),
        at: this.clock.now().toISOString(),
        kind: "crystallization_event",
        payload: { phase: "admission", heldOut, admission },
      },
    ];
  }

  private async dispatchExecute(action: Action, signal: AbortSignal): Promise<Observation[]> {
    if (signal.aborted) return [this.cancelledObservation(action)];
    const capabilityId = String(action.input.capabilityId ?? "");
    const admitted = this.registry.get(capabilityId);
    if (!admitted) {
      return [this.errorObs(`capability ${capabilityId} is not admitted`)];
    }
    const result = await this.fabricRuntime.execute(
      admitted.implementation,
      action.input.capabilityInput,
      admitted.contract.executionConstraints,
    );
    if (signal.aborted) return [this.cancelledObservation(action)];
    if (!result.ok) {
      return [
        {
          id: this.ids.next("obs"),
          at: this.clock.now().toISOString(),
          kind: "error",
          actionId: action.id,
          payload: {
            capabilityId,
            code: result.error?.code,
            message: result.error?.message,
          },
        },
      ];
    }
    return [
      {
        id: this.ids.next("obs"),
        at: this.clock.now().toISOString(),
        kind: "capability_result",
        actionId: action.id,
        payload: {
          capabilityId,
          outputKey: action.input.outputKey,
          output: result.output,
        },
      },
    ];
  }

  private errorObs(message: string): Observation {
    return {
      id: this.ids.next("obs"),
      at: this.clock.now().toISOString(),
      kind: "error",
      payload: { message },
    };
  }
}
