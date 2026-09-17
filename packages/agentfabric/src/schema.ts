export type JsonSchema =
  | { type: "string" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "object"; properties: Record<string, JsonSchema>; required?: string[] }
  | { type: "array"; items: JsonSchema };

export interface SchemaViolation {
  path: string;
  message: string;
}

export function validateSchema(schema: JsonSchema, value: unknown, path = "$"): SchemaViolation[] {
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? [] : [{ path, message: "expected string" }];
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? []
        : [{ path, message: "expected number" }];
    case "boolean":
      return typeof value === "boolean" ? [] : [{ path, message: "expected boolean" }];
    case "null":
      return value === null ? [] : [{ path, message: "expected null" }];
    case "array":
      if (!Array.isArray(value)) return [{ path, message: "expected array" }];
      return value.flatMap((item, index) => validateSchema(schema.items, item, `${path}[${index}]`));
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return [{ path, message: "expected object" }];
      }
      const record = value as Record<string, unknown>;
      const required = schema.required ?? [];
      const missing = required
        .filter((key) => !(key in record))
        .map((key) => ({ path: `${path}.${key}`, message: "required property missing" }));
      const nested = Object.entries(schema.properties).flatMap(([key, property]) =>
        key in record ? validateSchema(property, record[key], `${path}.${key}`) : [],
      );
      return [...missing, ...nested];
    }
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key, index) => key === bKeys[index]) &&
      aKeys.every((key) =>
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}
