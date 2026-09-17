import { SopError, type FailureCode } from "@weave/agentsop";

export class FabricError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "FabricError";
    this.code = code;
  }
}

export class UnknownCapability extends FabricError {
  constructor(message: string) {
    super("UNKNOWN_CAPABILITY", message);
  }
}

export class Unresolved extends FabricError {
  constructor(message: string) {
    super("UNRESOLVED", message);
  }
}

export class ResolverUnavailable extends FabricError {
  constructor(message: string) {
    super("RESOLVER_UNAVAILABLE", message);
  }
}

export class DependencyBlocked extends FabricError {
  constructor(message: string) {
    super("DEPENDENCY_BLOCKED", message);
  }
}

export class Denied extends FabricError {
  constructor(message: string) {
    super("DENIED", message);
  }
}

export class UnknownResource extends FabricError {
  constructor(message: string) {
    super("UNKNOWN_RESOURCE", message);
  }
}

export class KindMismatch extends FabricError {
  constructor(message: string) {
    super("KIND_MISMATCH", message);
  }
}

export class DependencyFailed extends FabricError {
  constructor(message: string) {
    super("DEPENDENCY_FAILED", message);
  }
}

export class UndeclaredDependency extends FabricError {
  constructor(message: string) {
    super("UNDECLARED_DEPENDENCY", message);
  }
}

export class ResolverError extends FabricError {
  constructor(message: string) {
    super("RESOLVER_ERROR", message);
  }
}

export function asFabricError(error: unknown): FabricError {
  if (error instanceof FabricError) return error;
  if (error instanceof SopError) return new FabricError(error.code, error.message);
  return new ResolverError(error instanceof Error ? error.message : String(error));
}
