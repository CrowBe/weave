export const AGENTSOP_VERSION = "0.1" as const;

export const EFFECTS = ["discover", "read", "create", "write", "append", "delete"] as const;
export type Effect = (typeof EFFECTS)[number];

export const RESOLUTION_STATUSES = ["resolved", "unresolved", "blocked", "unavailable"] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const FAILURE_CODES = [
  "UNKNOWN_CAPABILITY",
  "UNRESOLVED",
  "RESOLVER_UNAVAILABLE",
  "DEPENDENCY_BLOCKED",
  "DENIED",
  "UNKNOWN_RESOURCE",
  "INVALID_INPUT",
  "INVALID_REF",
  "KIND_MISMATCH",
  "DEPENDENCY_FAILED",
  "UNDECLARED_DEPENDENCY",
  "RESOLVER_ERROR",
  "INVALID_CATALOGUE",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const REF_PATTERN = /^rf_[a-z0-9]+$/;
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const RESOURCE_REF_DEF = "#/$defs/ResourceRef";

export interface ResourceRef {
  ref: string;
  kind: string;
}

export type JsonSchema =
  | { $ref: typeof RESOURCE_REF_DEF; description?: string }
  | {
      type: "object";
      properties?: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean | JsonSchema;
      description?: string;
      enum?: unknown[];
    }
  | { type: "string"; pattern?: string; description?: string; enum?: unknown[] }
  | { type: "integer"; description?: string; enum?: unknown[] }
  | { type: "boolean"; description?: string; enum?: unknown[] }
  | { type: "array"; items?: JsonSchema; description?: string; enum?: unknown[] };

export interface Capability {
  agentsop: typeof AGENTSOP_VERSION;
  id: string;
  title: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  effects: Effect[];
  idempotent: boolean;
  authority: {
    resources: string[];
    effects: Effect[];
  };
  depends_on: string[];
}

export interface ErrorBody {
  code: FailureCode;
  message: string;
}

export interface Result {
  ok: boolean;
  capability: string;
  invocation_id: string;
  output?: Record<string, unknown>;
  error?: ErrorBody;
}

export function isEffect(value: string): value is Effect {
  return (EFFECTS as readonly string[]).includes(value);
}
