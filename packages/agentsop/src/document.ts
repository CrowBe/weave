import { InvalidCatalogue, InvalidInput } from "./errors.ts";
import { assertSupportedSchema, parseResourceRef } from "./schema.ts";
import {
  AGENTSOP_VERSION,
  CAPABILITY_ID_PATTERN,
  RESOURCE_REF_DEF,
  isEffect,
  type Capability,
  type JsonSchema,
  type ResourceRef,
} from "./types.ts";

export function parseAuthoritySelector(pointer: string): string {
  if (!pointer.startsWith("input.")) {
    throw new InvalidInput(`unsupported authority resource selector: ${pointer}`);
  }
  const rest = pointer.slice("input.".length);
  if (!rest || rest.includes(".") || rest === "*") {
    throw new InvalidInput(
      `${pointer} is not a top-level scalar ResourceRef selector; nested objects and collections are not supported in 0.1`,
    );
  }
  return rest;
}

function assertAuthoritySelector(pointer: string, input: JsonSchema): void {
  const key = parseAuthoritySelector(pointer);
  if (!("type" in input) || input.type !== "object") {
    throw new InvalidInput(`${pointer}: input is not an object`);
  }
  const target = input.properties?.[key];
  if (!target || !("$ref" in target) || target.$ref !== RESOURCE_REF_DEF) {
    throw new InvalidInput(`${pointer} must target a top-level ResourceRef field`);
  }
}

export function validateCapabilityDocument(doc: unknown, source = ""): Capability {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new InvalidInput("capability document must be an object");
  }
  const record = doc as Record<string, unknown>;
  if (record.agentsop !== AGENTSOP_VERSION) {
    throw new InvalidInput("agentsop must be '0.1'");
  }
  const id = record.id;
  if (typeof id !== "string" || !CAPABILITY_ID_PATTERN.test(id)) {
    throw new InvalidInput("invalid capability id");
  }
  for (const key of ["title", "description"] as const) {
    if (typeof record[key] !== "string" || !record[key]) {
      throw new InvalidInput(`${key} is required`);
    }
  }
  if (typeof record.input !== "object" || record.input === null) {
    throw new InvalidInput("input must be a schema object");
  }
  if (typeof record.output !== "object" || record.output === null) {
    throw new InvalidInput("output must be a schema object");
  }
  const effects = record.effects;
  if (!Array.isArray(effects) || effects.some((effect) => typeof effect !== "string" || !isEffect(effect))) {
    throw new InvalidInput("effects must be a list of known effects");
  }
  if (typeof record.idempotent !== "boolean") {
    throw new InvalidInput("idempotent must be a boolean");
  }
  const authority = record.authority;
  if (authority === null || typeof authority !== "object" || Array.isArray(authority)) {
    throw new InvalidInput("authority is required");
  }
  const auth = authority as Record<string, unknown>;
  if (Object.keys(auth).some((key) => key !== "resources" && key !== "effects")) {
    throw new InvalidInput("authority has unexpected fields");
  }
  if (!Array.isArray(auth.resources) || !Array.isArray(auth.effects)) {
    throw new InvalidInput("authority.resources and authority.effects must be lists");
  }
  if (auth.effects.some((effect) => typeof effect !== "string" || !isEffect(effect))) {
    throw new InvalidInput("authority.effects must be known effects");
  }
  const typedEffects = effects as Capability["effects"];
  const authorityEffects = auth.effects as Capability["authority"]["effects"];
  if (new Set(typedEffects).size !== typedEffects.length) {
    throw new InvalidCatalogue("effects must not contain duplicates");
  }
  if (new Set(authorityEffects).size !== authorityEffects.length) {
    throw new InvalidCatalogue("authority.effects must not contain duplicates");
  }
  if (new Set(typedEffects).size !== new Set([...typedEffects, ...authorityEffects]).size) {
    throw new InvalidCatalogue(
      `${id}: effects ${JSON.stringify(typedEffects)} must equal authority.effects ${JSON.stringify(authorityEffects)}`,
    );
  }
  const depends = record.depends_on;
  if (!Array.isArray(depends) || depends.some((item) => typeof item !== "string")) {
    throw new InvalidInput("depends_on must be a list of capability ids");
  }
  const allowed = new Set([
    "agentsop",
    "id",
    "title",
    "description",
    "input",
    "output",
    "effects",
    "idempotent",
    "authority",
    "depends_on",
  ]);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new InvalidInput(`capability has unexpected fields: ${extra.sort().join(", ")}`);
  }
  const input = record.input as JsonSchema;
  const output = record.output as JsonSchema;
  assertSupportedSchema(input, "input");
  assertSupportedSchema(output, "output");
  for (const pointer of auth.resources) {
    if (typeof pointer !== "string") {
      throw new InvalidInput("authority.resources must be strings");
    }
    assertAuthoritySelector(pointer, input);
  }
  void source;
  return {
    agentsop: AGENTSOP_VERSION,
    id,
    title: record.title as string,
    description: record.description as string,
    input,
    output,
    effects: typedEffects,
    idempotent: record.idempotent,
    authority: {
      resources: auth.resources as string[],
      effects: authorityEffects,
    },
    depends_on: depends as string[],
  };
}

export function extractResourceRefs(
  capability: Capability,
  inputValue: Record<string, unknown>,
): ResourceRef[] {
  return capability.authority.resources.map((pointer) => {
    const key = parseAuthoritySelector(pointer);
    if (!(key in inputValue)) {
      throw new InvalidInput(`${pointer} is missing`);
    }
    return parseResourceRef(inputValue[key]);
  });
}

export function validateDependencyGraph(capabilities: Map<string, Capability>): void {
  for (const capability of capabilities.values()) {
    for (const dep of capability.depends_on) {
      if (!capabilities.has(dep)) {
        throw new InvalidCatalogue(`${capability.id} depends_on unknown capability ${dep}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id) || visiting.has(id)) {
      if (visiting.has(id)) throw new InvalidCatalogue(`capability dependency cycle at ${id}`);
      return;
    }
    visiting.add(id);
    const capability = capabilities.get(id);
    if (capability) {
      for (const dep of capability.depends_on) visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of capabilities.keys()) visit(id);
}
