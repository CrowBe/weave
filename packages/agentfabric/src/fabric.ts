import {
  extractResourceRefs,
  validateAgainst,
  validateCapabilityDocument,
  validateDependencyGraph,
  type Capability,
  type ResolutionStatus,
  type Result,
} from "@weave/agentsop";
import {
  asFabricError,
  DependencyBlocked,
  FabricError,
  ResolverError,
  ResolverUnavailable,
  UnknownCapability,
  Unresolved,
} from "./errors.ts";
import { Authority, defaultPrincipals, type Grant, type Principal } from "./grants.ts";
import { ResourceRegistry } from "./resources.ts";
import {
  createResolverContext,
  loadResolver,
  type ResolverBinding,
  type ResolverFn,
} from "./resolver.ts";

export interface CapabilityView {
  id: string;
  title: string;
  description: string;
  effects: string[];
  idempotent: boolean;
  depends_on: string[];
  status: ResolutionStatus;
  resolver: string | null;
}

export interface FabricOptions {
  principals?: Principal[];
  grants?: Omit<Grant, "id">[];
}

export class Fabric {
  readonly authority: Authority;
  readonly resources = new ResourceRegistry();
  private readonly capabilities = new Map<string, Capability>();
  private readonly bindings = new Map<string, ResolverBinding>();
  private readonly bindingErrors = new Map<string, string>();
  private invocationN = 0;

  constructor(options: FabricOptions = {}) {
    const principals = new Map(
      (options.principals ?? [...defaultPrincipals().values()]).map((principal) => [
        principal.id,
        principal,
      ]),
    );
    this.authority = new Authority(principals);
    if (principals.has("operator")) {
      this.authority.add({
        principal: "operator",
        capability: "*",
        resource: "*",
        effects: ["*"],
      });
    }
    for (const grant of options.grants ?? []) {
      this.authority.add(grant);
    }
  }

  register(document: unknown): Capability {
    const capability = validateCapabilityDocument(document);
    const next = new Map(this.capabilities);
    next.set(capability.id, capability);
    validateDependencyGraph(next);
    this.capabilities.set(capability.id, capability);
    return capability;
  }

  bind(capabilityId: string, fn: ResolverFn, label: string): void {
    this.capability(capabilityId);
    this.bindings.set(capabilityId, { capability: capabilityId, label, fn });
    this.bindingErrors.delete(capabilityId);
  }

  capability(id: string): Capability {
    const capability = this.capabilities.get(id);
    if (!capability) throw new UnknownCapability(`unknown capability ${id}`);
    return capability;
  }

  has(id: string): boolean {
    return this.capabilities.has(id);
  }

  list(): CapabilityView[] {
    return [...this.capabilities.keys()].map((id) => this.resolutionOf(id));
  }

  resolutionOf(capabilityId: string, seen = new Set<string>()): CapabilityView {
    const capability = this.capability(capabilityId);
    const binding = this.bindings.get(capabilityId);
    let status: ResolutionStatus;
    let resolver: string | null = null;
    if (!binding) {
      status = this.bindingErrors.has(capabilityId) ? "unavailable" : "unresolved";
    } else {
      status = "resolved";
      resolver = binding.label;
      for (const dep of capability.depends_on) {
        if (seen.has(dep)) continue;
        if (this.resolutionOf(dep, new Set([...seen, capabilityId])).status !== "resolved") {
          status = "blocked";
          break;
        }
      }
    }
    return {
      id: capability.id,
      title: capability.title,
      description: capability.description,
      effects: [...capability.effects],
      idempotent: capability.idempotent,
      depends_on: [...capability.depends_on],
      status,
      resolver,
    };
  }

  async invoke(
    principal: string,
    capabilityId: string,
    input: unknown = {},
    options: { nested?: boolean } = {},
  ): Promise<Result> {
    const invocation_id = `inv_${(this.invocationN += 1)}`;
    try {
      const output = await this.run(principal, capabilityId, input);
      return { ok: true, capability: capabilityId, invocation_id, output };
    } catch (error) {
      const fabricError = asFabricError(error);
      void options.nested;
      return {
        ok: false,
        capability: capabilityId,
        invocation_id,
        error: { code: fabricError.code, message: fabricError.message },
      };
    }
  }

  async trial(
    principal: string,
    capabilityId: string,
    source: string | ResolverFn,
    input: unknown = {},
  ): Promise<Result> {
    const fn = typeof source === "function" ? source : loadResolver(source);
    const previous = this.bindings.get(capabilityId);
    this.bind(capabilityId, fn, "trial");
    try {
      return await this.invoke(principal, capabilityId, input);
    } finally {
      if (previous) this.bindings.set(capabilityId, previous);
      else this.bindings.delete(capabilityId);
    }
  }

  crystallise(
    principal: string,
    capabilityId: string,
    source: string | ResolverFn,
    label?: string,
  ): { capability: string; resolver: string } {
    this.authority.requirePrivilege(principal, "crystallise");
    const capability = this.capability(capabilityId);
    const fn = typeof source === "function" ? source : loadResolver(source);
    const resolver = label ?? "local:resolver";
    this.bind(capability.id, fn, resolver);
    return { capability: capability.id, resolver };
  }

  private async run(
    principal: string,
    capabilityId: string,
    input: unknown,
  ): Promise<Record<string, unknown>> {
    const capability = this.capability(capabilityId);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new FabricError("INVALID_INPUT", "input must be an object");
    }
    const typedInput = validateAgainst(capability.input, input) as Record<string, unknown>;
    const refs = extractResourceRefs(capability, typedInput);
    const resourceKeys = refs.length > 0 ? refs.map((ref) => ref.ref) : [null];
    const effects = capability.authority.effects;
    for (const resourceKey of resourceKeys) {
      this.authority.allow(principal, capabilityId, resourceKey, effects);
    }
    for (const ref of refs) {
      this.resources.require(ref);
    }
    const view = this.resolutionOf(capabilityId);
    if (view.status === "unresolved") {
      throw new Unresolved(`capability ${capabilityId} has no resolver`);
    }
    if (view.status === "unavailable") {
      throw new ResolverUnavailable(
        `capability ${capabilityId} resolver is unavailable: ${this.bindingErrors.get(capabilityId)}`,
      );
    }
    if (view.status === "blocked") {
      throw new DependencyBlocked(`capability ${capabilityId} is blocked on unresolved dependencies`);
    }
    const binding = this.bindings.get(capabilityId);
    if (!binding) throw new Unresolved(`capability ${capabilityId} has no resolver`);
    const ctx = createResolverContext(this, principal, capability);
    let output: unknown;
    try {
      output = await Promise.resolve(binding.fn(ctx, typedInput));
    } catch (error) {
      if (error instanceof FabricError) throw error;
      throw new ResolverError(
        `resolver ${binding.label} raised: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return validateAgainst(capability.output, output, "output") as Record<string, unknown>;
    } catch (error) {
      throw new ResolverError(
        `resolver ${binding.label} returned invalid output: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
