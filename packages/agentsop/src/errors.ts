import type { FailureCode } from "./types.ts";

export class SopError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "SopError";
    this.code = code;
  }
}

export class InvalidInput extends SopError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "InvalidInput";
  }
}

export class InvalidRef extends SopError {
  constructor(message: string) {
    super("INVALID_REF", message);
    this.name = "InvalidRef";
  }
}

export class InvalidCatalogue extends SopError {
  constructor(message: string) {
    super("INVALID_CATALOGUE", message);
    this.name = "InvalidCatalogue";
  }
}
