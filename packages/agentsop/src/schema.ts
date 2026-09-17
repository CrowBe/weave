import { InvalidInput, InvalidRef } from "./errors.ts";
import {
  RESOURCE_REF_DEF,
  REF_PATTERN,
  type JsonSchema,
  type ResourceRef,
} from "./types.ts";

const SUPPORTED_TYPES = new Set(["object", "string", "integer", "array", "boolean"]);

export function parseResourceRef(value: unknown): ResourceRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRef("ResourceRef must be an object");
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "ref" && key !== "kind");
  if (extra.length > 0) {
    throw new InvalidRef("ResourceRef must not include locators or extra fields");
  }
  const ref = record.ref;
  const kind = record.kind;
  if (typeof ref !== "string" || typeof kind !== "string") {
    throw new InvalidRef("ResourceRef requires string ref and kind");
  }
  if (!REF_PATTERN.test(ref)) {
    throw new InvalidRef("ResourceRef.ref is not a well-formed fabric handle");
  }
  if (!kind) {
    throw new InvalidRef("ResourceRef.kind must be non-empty");
  }
  return { ref, kind };
}

export function assertSupportedSchema(schema: JsonSchema, path = "schema"): void {
  if ("$ref" in schema) {
    const extra = Object.keys(schema).filter((key) => key !== "$ref" && key !== "description");
    if (extra.length > 0) {
      throw new InvalidInput(`${path} has unsupported schema fields: ${extra.sort().join(", ")}`);
    }
    if (schema.$ref !== RESOURCE_REF_DEF) {
      throw new InvalidInput(`${path}: unsupported $ref ${schema.$ref}`);
    }
    return;
  }
  if (!SUPPORTED_TYPES.has(schema.type)) {
    throw new InvalidInput(`${path} has unsupported schema type`);
  }
  if (schema.type === "object") {
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      assertSupportedSchema(sub, `${path}.properties.${key}`);
    }
  }
  if (schema.type === "array" && schema.items) {
    assertSupportedSchema(schema.items, `${path}.items`);
  }
}

export function validateAgainst(schema: JsonSchema, value: unknown, path = "input"): unknown {
  if ("$ref" in schema) {
    return parseResourceRef(value);
  }
  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new InvalidInput(`${path} must be an object`);
      }
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      const additional = schema.additionalProperties ?? true;
      if (additional === false) {
        const extra = Object.keys(record).filter((key) => !(key in properties));
        if (extra.length > 0) {
          throw new InvalidInput(`${path} has unexpected fields: ${extra.sort().join(", ")}`);
        }
      }
      for (const key of schema.required ?? []) {
        if (!(key in record)) {
          throw new InvalidInput(`${path}.${key} is required`);
        }
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(record)) {
        if (key in properties) {
          const property = properties[key];
          if (!property) continue;
          out[key] = validateAgainst(property, item, `${path}.${key}`);
        } else if (additional === true) {
          out[key] = item;
        } else if (typeof additional === "object") {
          out[key] = validateAgainst(additional, item, `${path}.${key}`);
        }
      }
      if (schema.enum && !schema.enum.some((candidate) => candidate === out)) {
        throw new InvalidInput(`${path} must be one of the declared enum values`);
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(value)) throw new InvalidInput(`${path} must be an array`);
      const items = schema.items ?? { type: "string" };
      return value.map((item, index) => validateAgainst(items, item, `${path}[${index}]`));
    }
    case "string": {
      if (typeof value !== "string") throw new InvalidInput(`${path} must be a string`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        throw new InvalidInput(`${path} does not match ${schema.pattern}`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        throw new InvalidInput(`${path} must be one of the declared enum values`);
      }
      return value;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new InvalidInput(`${path} must be an integer`);
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") throw new InvalidInput(`${path} must be a boolean`);
      return value;
    }
  }
}

export function looksLikeRefId(value: string): boolean {
  return REF_PATTERN.test(value);
}
