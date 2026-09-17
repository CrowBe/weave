export type InferenceKind =
  | "reason"
  | "synthesize"
  | "classify"
  | "transform"
  | "generate_language"
  | "propose_contract"
  | "propose_tests"
  | "propose_resolver"
  | "evaluate_expansion";

export type InferenceQuality = "min_sufficient" | "high";

export interface InferenceRequest {
  kind: InferenceKind;
  quality: InferenceQuality;
  context: Record<string, unknown>;
}

export interface ModelBinding {
  id: string;
  providerId: string;
  cost: number;
  qualityScore: number;
  privacy: "local" | "external";
}

export interface InferenceProvider {
  readonly id: string;
  complete(binding: ModelBinding, request: InferenceRequest): Promise<unknown>;
}

export interface InferenceRouter {
  route(request: InferenceRequest, budgetRemaining: number): ModelBinding;
}

export class CheapestSufficientRouter implements InferenceRouter {
  constructor(private readonly bindings: ModelBinding[]) {
    if (bindings.length === 0) throw new Error("inference router requires at least one binding");
  }

  route(request: InferenceRequest, budgetRemaining: number): ModelBinding {
    const minQuality = request.quality === "high" ? 0.8 : 0.3;
    const affordable = this.bindings
      .filter((binding) => binding.qualityScore >= minQuality && binding.cost <= budgetRemaining)
      .sort((a, b) => a.cost - b.cost || b.qualityScore - a.qualityScore);
    const chosen = affordable[0];
    if (!chosen) {
      throw new Error("no model binding satisfies quality and budget constraints");
    }
    return chosen;
  }
}

export class ScriptedInferenceProvider implements InferenceProvider {
  readonly id: string;

  constructor(
    private readonly scripts: Partial<
      Record<InferenceKind, unknown | ((request: InferenceRequest) => unknown)>
    >,
    id = "scripted",
  ) {
    this.id = id;
  }

  async complete(_binding: ModelBinding, request: InferenceRequest): Promise<unknown> {
    const script = this.scripts[request.kind];
    if (script === undefined) {
      throw new Error(`scripted inference has no handler for ${request.kind}`);
    }
    return typeof script === "function" ? script(request) : script;
  }
}
