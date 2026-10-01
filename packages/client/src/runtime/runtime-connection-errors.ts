export type RuntimeSendErrorCode =
  | "aborted"
  | "deadline"
  | "frame_too_large"
  | "overflow"
  | "unavailable"
  | "capability_unavailable";

export type RuntimeConnectionErrorCategory =
  | "authentication_rejection"
  | "capability_incompatibility"
  | "protocol"
  | "transient_connection";

export class RuntimeConnectionError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
    readonly category: RuntimeConnectionErrorCategory = fatal ? "protocol" : "transient_connection",
  ) {
    super(message);
    this.name = "RuntimeConnectionError";
  }
}

export function runtimeConnectionErrorCategory(
  code: string | undefined,
  fatal: boolean,
  allowTransient = true,
): RuntimeConnectionErrorCategory {
  if (code?.startsWith("AUTH_")) return "authentication_rejection";
  if (code === "PROTOCOL_CAPABILITY_UNSUPPORTED") return "capability_incompatibility";
  if (
    allowTransient &&
    (code === "INTERNAL_ERROR" ||
      code === "SERVICE_UNAVAILABLE" ||
      code === "RUNTIME_AUTH_TIMEOUT" ||
      code === "RUNTIME_REGISTER_TIMEOUT")
  ) {
    return "transient_connection";
  }
  return fatal ? "protocol" : "transient_connection";
}

export function runtimeConnectionCloseError(code: number, established: boolean): RuntimeConnectionError | undefined {
  if (code === 4001 || (code >= 4400 && code < 4500)) {
    const category = code === 4401 ? "authentication_rejection" : code === 4408 ? "transient_connection" : "protocol";
    return new RuntimeConnectionError(
      "The runtime connection was rejected",
      category !== "transient_connection",
      category,
    );
  }
  return new RuntimeConnectionError(
    established ? "The runtime connection closed" : "Could not establish runtime connection",
    false,
    "transient_connection",
  );
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
