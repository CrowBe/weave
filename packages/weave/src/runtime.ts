import { checkCandidate } from "./checks/index.ts";
import type { Fabric } from "@weave/agentfabric";
import { assignActionIds, enumerateActions, type Action } from "./action.ts";
import type { DecisionLayer } from "./decision/index.ts";
import { buildFrontier, type ActionFrontier } from "./frontier.ts";
import type { Clock, IdGenerator } from "./ids.ts";
import type {
  InferenceKind,
  InferenceProvider,
  InferenceRequest,
  InferenceRouter,
} from "./inference.ts";
import type { Policy } from "./policy.ts";
import { runScheduler } from "./scheduler.ts";
import {
  applyObservation,
  createState,
  successCriteriaMet,
  type Goal,
  type Observation,
  type WeaveState,
} from "./state/index.ts";

export interface CycleRecord {
  id: string;
  index: number;
  at: string;
  goalId: string;
  factKeys: string[];
  expansionPhase?: string;
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
  fabric: Fabric;
  router: InferenceRouter;
  providers: Map<string, InferenceProvider>;
  ids: IdGenerator;
  clock: Clock;
  crystallisePrincipal?: string;
  onCycle?: (record: CycleRecord, state: WeaveState) => void;
}

export class Runtime {
  private state: WeaveState;
  private readonly journalEntries: Observation[] = [];
  private readonly cycleRecords: CycleRecord[] = [];
  private readonly fabric: Fabric;
  private readonly decision: DecisionLayer;
  private readonly policy: Policy;
  private readonly router: InferenceRouter;
  private readonly providers: Map<string, InferenceProvider>;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly crystallisePrincipal: string;
  private readonly onCycle?: (record: CycleRecord, state: WeaveState) => void;

  constructor(options: RuntimeOptions) {
    this.state = createState(options.goal);
    this.decision = options.decision;
    this.policy = options.policy;
    this.fabric = options.fabric;
    this.router = options.router;
    this.providers = options.providers;
    this.ids = options.ids;
    this.clock = options.clock;
    this.crystallisePrincipal = options.crystallisePrincipal ?? "operator";
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
    if (observation.kind === "approval" && observation.payload.granted === true) {
      const subject = String(observation.payload.subject);
      if (this.fabric.has(subject)) {
        const capability = this.fabric.capability(subject);
        this.fabric.authority.add({
          principal: this.state.goal.principal,
          capability: subject,
          resource: "*",
          effects: capability.effects.length > 0 ? [...capability.effects] : ["*"],
        });
      }
    }
    this.journalEntries.push(observation);
    return observation;
  }

  plan(): ActionFrontier {
    const actionSpace = assignActionIds(enumerateActions(this.state, this.fabric), this.ids);
    const weighted = this.decision.weigh(this.state, actionSpace);
    return buildFrontier(actionSpace, weighted, this.policy, {
      state: this.state,
      fabric: this.fabric,
    });
  }

  async runCycle(): Promise<CycleRecord> {
    const frontier = this.plan();
    const expansionPhase = this.state.expansion?.phase;
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
            resulting.push(this.observe(observation));
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
      expansionPhase,
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
            : observation.kind === "check_event"
              ? "checks"
              : observation.kind === "evaluation_event"
                ? "evaluate"
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
      return [
        {
          id: this.ids.next("obs"),
          at: this.clock.now().toISOString(),
          kind: "action_cancelled",
          actionId: action.id,
          payload: { key: action.key },
        },
      ];
    }
    switch (action.kind) {
      case "request_inference":
        return this.dispatchInference(action);
      case "register_capability": {
        const document = action.input.document;
        const registered = this.fabric.register(document);
        return [
          {
            id: this.ids.next("obs"),
            at: this.clock.now().toISOString(),
            kind: "capability_registered",
            actionId: action.id,
            payload: { capabilityId: registered.id, document: registered },
          },
        ];
      }
      case "check_candidate":
        return this.dispatchCheck();
      case "evaluate_candidate":
        return this.dispatchEvaluate();
      case "crystallise":
        return this.dispatchCrystallise();
      case "invoke_capability":
        return this.dispatchInvoke(action);
      case "request_approval":
        return [
          {
            id: this.ids.next("obs"),
            at: this.clock.now().toISOString(),
            kind: "approval_requested",
            actionId: action.id,
            payload: { subject: action.input.capabilityId, reason: action.input.reason },
          },
        ];
      case "clarify":
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
          return [this.errorObs("complete_goal dispatched without success evidence")];
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

  private async dispatchInference(action: Action): Promise<Observation[]> {
    const request: InferenceRequest = {
      kind: action.input.kind as InferenceKind,
      quality: (action.input.quality as InferenceRequest["quality"]) ?? "min_sufficient",
      context: (action.input.context as Record<string, unknown>) ?? {},
    };
    const binding = this.router.route(request, this.state.goal.authority.inferenceBudget);
    const provider = this.providers.get(binding.providerId);
    if (!provider) return [this.errorObs(`no provider registered for ${binding.providerId}`)];
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

  private async dispatchCheck(): Promise<Observation[]> {
    const work = this.state.expansion;
    if (!work?.corpus || !work.resolverSource) {
      return [this.errorObs("check_candidate requires a corpus and resolver")];
    }
    const capability = this.fabric.has(work.capabilityId)
      ? this.fabric.capability(work.capabilityId)
      : work.document;
    if (!capability) return [this.errorObs("check_candidate requires an AgentSOP document")];
    const checks = await checkCandidate({
      fabric: this.fabric,
      principal: this.crystallisePrincipal,
      capability,
      source: work.resolverSource,
      corpus: work.corpus,
    });
    return [
      {
        id: this.ids.next("obs"),
        at: this.clock.now().toISOString(),
        kind: "check_event",
        payload: { checks },
      },
    ];
  }

  private dispatchEvaluate(): Observation[] {
    const work = this.state.expansion;
    if (!work?.checks) {
      return [this.errorObs("evaluate_candidate requires check evidence")];
    }
    const evaluation = this.decision.evaluate(this.state, work.checks);
    return [
      {
        id: this.ids.next("obs"),
        at: this.clock.now().toISOString(),
        kind: "evaluation_event",
        payload: { evaluation },
      },
    ];
  }

  private dispatchCrystallise(): Observation[] {
    const work = this.state.expansion;
    if (!work?.resolverSource || !work.checks?.passed || work.evaluation?.decision !== "accept") {
      return [this.errorObs("crystallise requires passed checks and an accept evaluation")];
    }
    this.fabric.crystallise(this.crystallisePrincipal, work.capabilityId, work.resolverSource);
    return [
      {
        id: this.ids.next("obs"),
        at: this.clock.now().toISOString(),
        kind: "capability_crystallised",
        payload: { capabilityId: work.capabilityId },
      },
    ];
  }

  private async dispatchInvoke(action: Action): Promise<Observation[]> {
    const capabilityId = String(action.input.capabilityId ?? "");
    const result = await this.fabric.invoke(
      this.state.goal.principal,
      capabilityId,
      action.input.capabilityInput,
    );
    if (!result.ok && result.error?.code === "DENIED") {
      return [
        {
          id: this.ids.next("obs"),
          at: this.clock.now().toISOString(),
          kind: "capability_result",
          actionId: action.id,
          payload: { capabilityId, denied: true, error: result.error },
        },
      ];
    }
    if (!result.ok) {
      return [
        {
          id: this.ids.next("obs"),
          at: this.clock.now().toISOString(),
          kind: "error",
          actionId: action.id,
          payload: { capabilityId, code: result.error?.code, message: result.error?.message },
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
