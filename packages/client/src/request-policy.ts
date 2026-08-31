import { randomUUID } from "node:crypto";
import type { ErrorCategory, ErrorCode, ValidationIssue } from "@opentag/shared";

export const OPEN_TAG_API_REQUEST_TIMEOUT_MS = 30_000;
export const REQUEST_ID_HEADER = "x-request-id";

export type ErrorRetryability = "never" | "immediate" | "backoff" | "after_auth";
export type ErrorPhase =
  | "validation"
  | "authentication"
  | "authorization"
  | "configuration"
  | "startup"
  | "request"
  | "transport"
  | "provider"
  | "persistence"
  | "dispatch"
  | "socket"
  | "scheduler"
  | "worker"
  | "serialization"
  | "shutdown"
  | "unknown";

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  requestId?: string;
}

export interface RequestCause {
  code?: string;
  category?: ErrorCategory;
  retryability?: ErrorRetryability;
  phase?: ErrorPhase;
  message: string;
  cause?: RequestCause;
}

export interface RequestErrorOptions {
  cause?: unknown;
  retryability?: ErrorRetryability;
  phase?: ErrorPhase;
  requestId?: string;
}

export function defaultRetryability(category: ErrorCategory): ErrorRetryability {
  switch (category) {
    case "transient":
    case "rate_limit":
      return "backoff";
    case "credential":
      return "after_auth";
    default:
      return "never";
  }
}

export function defaultPhase(category: ErrorCategory): ErrorPhase {
  switch (category) {
    case "credential":
      return "authentication";
    case "validation":
      return "validation";
    default:
      return "request";
  }
}

export function createRequestId(): string {
  return randomUUID();
}

export function safeCause(error: unknown): RequestCause | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    const nested = "cause" in error ? safeCause(error.cause) : undefined;
    return {
      ...(code ? { code } : {}),
      message: sanitizeCauseMessage(error.message),
      ...(nested ? { cause: nested } : {}),
    };
  }
  return { message: sanitizeCauseMessage(String(error)) };
}

export function sanitizeCauseMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;}\]]+/giu, "Bearer [REDACTED]")
    .replace(/(\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*)[^\s,;}\]]+/giu, "$1[REDACTED]")
    .slice(0, 2_048);
}

export function statusFallback(status: number): {
  code: ErrorCode | string;
  category: ErrorCategory;
  message: string;
} {
  if (status === 400) {
    return { code: "VALIDATION_ERROR", category: "validation", message: "The request payload is invalid" };
  }
  if (status === 404) {
    return { code: "RESOURCE_NOT_FOUND", category: "deterministic", message: "The requested resource was not found" };
  }
  if (status === 409) {
    return { code: "VALIDATION_ERROR", category: "deterministic", message: "The request conflicts with current state" };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", category: "rate_limit", message: "The OpenTag server rate limit was reached" };
  }
  if (status >= 500) {
    return { code: "SERVICE_UNAVAILABLE", category: "transient", message: "The OpenTag server is unavailable" };
  }
  if (status === 401 || status === 403) {
    return { code: "AUTH_INVALID_TOKEN", category: "credential", message: "Authentication failed" };
  }
  return { code: "VALIDATION_ERROR", category: "validation", message: "The request was rejected" };
}

export function validTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  return timeoutMs;
}

export interface PreparedRequest {
  init: RequestInit;
  requestId: string;
  signal: AbortSignal;
  cleanup(): void;
  reason(): "caller" | "deadline" | undefined;
}

export function prepareRequest(init: RequestInit, options: RequestOptions, defaultTimeoutMs: number): PreparedRequest {
  const normalizedOptions = isAbortSignal(options) ? { signal: options } : options;
  const requestId = normalizedOptions.requestId?.trim() || createRequestId();
  const timeoutMs = validTimeout(normalizedOptions.timeoutMs ?? defaultTimeoutMs);
  const controller = new AbortController();
  let abortReason: "caller" | "deadline" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callerSignal = normalizedOptions.signal;
  const abortFromCaller = () => {
    abortReason = "caller";
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  timer = setTimeout(() => {
    abortReason = "deadline";
    controller.abort(new Error(`OpenTag request deadline exceeded after ${timeoutMs}ms`));
  }, timeoutMs);
  const headers = new Headers(init.headers);
  if (!headers.has(REQUEST_ID_HEADER)) headers.set(REQUEST_ID_HEADER, requestId);
  return {
    init: { ...init, headers, signal: controller.signal },
    requestId,
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
    reason: () => abortReason,
  };
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as AbortSignal).addEventListener === "function"
  );
}

export async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export type { ErrorCategory, ErrorCode, ValidationIssue };
