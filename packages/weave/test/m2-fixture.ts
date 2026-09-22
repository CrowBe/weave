/**
 * M2 fixture: novel inspect-and-report goal that requires framing
 * (docs/m2-handle-a-novel-request.md).
 */
import {
  createInferenceGateway,
  type EvaluationAdapter,
  type EvaluationProviderResult,
  type GenerationAdapter,
  type GenerationProviderResult,
} from '@weave/gateway';
import {
  fixtureGateway,
  GatewayDecisionLayer,
  HOSTED_DESTINATION,
  LOCAL_DESTINATION,
  Runtime,
  ScriptedDecisionLayer,
  type DecisionLayer,
  type FrameProfile,
  type Goal,
} from '@weave/weave';
import { FakeHost, FixtureEnvironment } from './fake-host.js';
import {
  ALPHA,
  BETA,
  CONTENT,
  GAMMA,
  goalOpened,
  registerAll,
  type Scenario,
} from './fixture.js';

export const VARIANT_COST = 1_000_000;

export function variantGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: 'g-report-variant',
    purpose: 'Produce a checked report over the listed sources',
    sources: [ALPHA, BETA],
    authority: { read: [ALPHA, BETA] },
    framing: true,
    budget: { actions: 8, judgments: 8, cost: VARIANT_COST },
    success_evidence:
      'a Report artifact covering every goal source whose read set matches the current revision of each source',
    ...overrides,
  };
}

export function bindingJson(sources: readonly string[]): string {
  return JSON.stringify({
    bindings: sources.map((source) => ({ operation: 'source.inspect', inputs: { source } })),
  });
}

export function generateAdapter(
  id: string,
  script: readonly GenerationProviderResult[],
): GenerationAdapter & { calls: number } {
  let calls = 0;
  return {
    id,
    get calls() {
      return calls;
    },
    async execute() {
      const result = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (!result) {
        throw new Error('generate adapter exhausted');
      }
      return result;
    },
  };
}

export function evaluateAdapter(
  id: string,
  script: readonly EvaluationProviderResult[] | ((call: { questions: Record<string, unknown> }) => EvaluationProviderResult),
): EvaluationAdapter & { calls: number } {
  let calls = 0;
  return {
    id,
    get calls() {
      return calls;
    },
    async evaluate(call) {
      calls += 1;
      if (typeof script === 'function') {
        return script(call);
      }
      const result = script[Math.min(calls - 1, script.length - 1)];
      if (!result) {
        throw new Error('evaluate adapter exhausted');
      }
      return result;
    },
  };
}

export function deferredEvaluate(
  id: string,
  result?: EvaluationProviderResult | ((call: { questions: Record<string, unknown> }) => EvaluationProviderResult),
): EvaluationAdapter & { release: () => void; calls: number } {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    id,
    get calls() {
      return calls;
    },
    release() {
      release();
    },
    async evaluate(call) {
      calls += 1;
      await held;
      if (typeof result === 'function') {
        return result(call);
      }
      if (result) {
        return result;
      }
      const scores: Record<string, number> = {};
      for (const questionId of Object.keys(call.questions)) {
        scores[questionId] = 1.6;
      }
      return scoreAnswers(scores);
    },
  };
}

export function completedText(text: string): GenerationProviderResult {
  return {
    status: 'completed',
    text,
    usage: { input_tokens: 20, output_tokens: 40 },
    finish_reason: 'stop',
    provider_response_id: 'frame_1',
  };
}

export function scoreAnswers(scores: Record<string, number>): EvaluationProviderResult {
  const answers: Record<string, { type: 'score'; score: number }> = {};
  for (const [id, score] of Object.entries(scores)) {
    answers[id] = { type: 'score', score };
  }
  return {
    status: 'completed',
    answers,
    usage: { input_tokens: 30, output_tokens: 10 },
    provider_response_id: 'weigh_1',
    confidence: undefined,
  };
}

export function malformedEval(): EvaluationProviderResult {
  return {
    status: 'completed',
    answers: { unexpected: { type: 'boolean', probability: 0.5 } },
    usage: { input_tokens: 10, output_tokens: 5 },
    provider_response_id: 'bad_1',
    confidence: undefined,
  };
}

export function failedEval(): EvaluationProviderResult {
  return {
    status: 'failed',
    failure: { code: 'unavailable', message: 'provider down', retryable: false },
  };
}

export interface NovelScenario extends Scenario {
  readonly generate: GenerationAdapter & { calls: number };
  readonly evaluate?: EvaluationAdapter & { calls: number };
}

export function novelScenario(options: {
  goal?: Goal;
  generate?: GenerationAdapter & { calls: number };
  evaluate?: EvaluationAdapter & { calls: number };
  decisionLayer?: DecisionLayer;
  includeHosted?: boolean;
  destinations?: readonly string[];
  hosted?: EvaluationAdapter;
  frameProfile?: FrameProfile;
} = {}): NovelScenario {
  const environment = new FixtureEnvironment();
  const host = new FakeHost(environment);
  const generate = options.generate ?? generateAdapter('fixture.generate', [completedText(bindingJson([ALPHA, BETA]))]);
  const evaluate = options.evaluate;
  let runtime!: Runtime;
  const clock = { now: () => runtime.state().clock.tick };
  const gatewayOptions: Parameters<typeof fixtureGateway>[0] = { clock, generate };
  if (evaluate) {
    gatewayOptions.evaluate = evaluate;
  }
  if (options.includeHosted) {
    gatewayOptions.includeHosted = true;
  }
  if (options.hosted) {
    gatewayOptions.hosted = options.hosted;
  }
  const gateway = fixtureGateway(gatewayOptions);
  const decisionLayer =
    options.decisionLayer ??
    (evaluate
      ? new GatewayDecisionLayer(gateway, options.destinations ? [...options.destinations] : [LOCAL_DESTINATION])
      : new ScriptedDecisionLayer());
  runtime = new Runtime({
    host,
    decisionLayer,
    gateway,
    ...(options.frameProfile ? { frameProfile: options.frameProfile } : {}),
  });
  const appended: import('@weave/weave').Observation[] = [];
  const s: NovelScenario = {
    environment,
    host,
    decisionLayer,
    generate,
    ...(evaluate ? { evaluate } : {}),
    runtime,
    appended,
    observe(input) {
      const observation = runtime.observe(input);
      appended.push(observation);
      return observation;
    },
  };
  registerAll(s);
  s.runtime.operator.submit(goalOpened(options.goal ?? variantGoal()));
  return s;
}

export { ALPHA, BETA, GAMMA, CONTENT, LOCAL_DESTINATION, HOSTED_DESTINATION, createInferenceGateway };
