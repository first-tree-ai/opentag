export type RuntimeSendErrorCode =
  | "aborted"
  | "deadline"
  | "frame_too_large"
  | "overflow"
  | "unavailable"
  | "capability_unavailable";

export class RuntimeConnectionError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "RuntimeConnectionError";
  }
}

export class RuntimeSendError extends Error {
  constructor(
    readonly code: RuntimeSendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeSendError";
  }
}

export class RuntimeProtocolFallbackError extends Error {
  constructor() {
    super("The Server explicitly requires runtime protocol v1");
    this.name = "RuntimeProtocolFallbackError";
  }
}

export function abortError(): RuntimeSendError {
  return new RuntimeSendError("aborted", "The runtime operation was aborted");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof RuntimeSendError && error.code === "aborted";
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The runtime operation failed");
}
