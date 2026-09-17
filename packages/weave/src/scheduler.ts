import type { Action } from "./action.ts";
import type { ActionFrontier } from "./frontier.ts";
import type { Observation } from "./state.ts";

export interface SchedulerResult {
  executed: string[];
  cancelled: string[];
}

export async function runScheduler(args: {
  initial: ActionFrontier;
  execute: (action: Action, signal: AbortSignal) => Promise<Observation[]>;
  replan: () => ActionFrontier;
  onObservations: (observations: Observation[]) => void;
}): Promise<SchedulerResult> {
  const executed: string[] = [];
  const cancelled: string[] = [];
  const inFlight = new Map<
    string,
    {
      action: Action;
      abort: AbortController;
      promise: Promise<void>;
    }
  >();

  const launch = (action: Action): void => {
    if (inFlight.has(action.key) || executed.includes(action.key) || cancelled.includes(action.key)) {
      return;
    }
    const abort = new AbortController();
    const promise = args
      .execute(action, abort.signal)
      .then((observations) => {
        if (abort.signal.aborted) return;
        executed.push(action.key);
        args.onObservations(observations);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        args.onObservations([
          {
            id: `error_${action.id}`,
            at: new Date().toISOString(),
            kind: "error",
            actionId: action.id,
            payload: {
              message: error instanceof Error ? error.message : String(error),
              actionKey: action.key,
            },
          },
        ]);
      })
      .finally(() => {
        inFlight.delete(action.key);
      });
    inFlight.set(action.key, { action, abort, promise });
  };

  const reconcile = (frontier: ActionFrontier): void => {
    const wanted = new Set(frontier.viable.map((item) => item.action.key));
    for (const [key, slot] of inFlight) {
      if (!wanted.has(key)) {
        slot.abort.abort();
        cancelled.push(key);
        inFlight.delete(key);
      }
    }
    for (const item of frontier.viable) {
      if (item.action.dependsOn.length > 0) continue;
      launch(item.action);
    }
  };

  reconcile(args.initial);
  while (inFlight.size > 0) {
    await Promise.race([...inFlight.values()].map((slot) => slot.promise));
    reconcile(args.replan());
  }
  return { executed, cancelled };
}
