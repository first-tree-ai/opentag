import { createStreamCancellation } from "../stream-cancellation.js";
import {
  type PerformanceLogger,
  type PerformanceOperationHandle,
  runWithPerformanceContext,
  safePerformanceErrorCode,
} from "./performance-logger.js";

const ALLOWED_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
  "TimeoutError",
  "AbortError",
]);

const FIXED_ROUTE_PROVIDERS = new Set(["github", "cloud-router", "web-router", "cloud-run", "gcp-metadata", "gcs"]);

function sanitizePathSegment(segment: string): string {
  if (!segment) return "";
  if (
    segment.length > 32 ||
    /^(?:xox[abp]-|cli_|gh[pousr]_|sk-|Bearer)/i.test(segment) ||
    /^[0-9a-f]{16,}$/i.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
  ) {
    return ":redacted";
  }
  return segment.replace(/[^A-Za-z0-9._:@~-]/g, "_");
}

export function sanitizeExternalUrl(
  input: unknown,
  options?: { includePath?: boolean },
): {
  targetHost?: string;
  targetPath?: string;
} {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : typeof input === "object" && input !== null && "url" in input && typeof input.url === "string"
            ? input.url
            : undefined;
    if (!raw) return {};
    const parsed = new URL(raw);
    const targetHost = parsed.hostname.slice(0, 128) || undefined;
    if (options?.includePath !== true) {
      return targetHost ? { targetHost } : {};
    }
    const rawSegments = parsed.pathname.split("/").slice(0, 16);
    const sanitizedPath = rawSegments.map(sanitizePathSegment).join("/").slice(0, 128) || "/";
    return {
      ...(targetHost ? { targetHost } : {}),
      targetPath: sanitizedPath,
    };
  } catch {
    return {};
  }
}

export function extractExternalTransportCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth <= 3 && cursor && typeof cursor === "object"; depth += 1) {
    try {
      const code = (cursor as { code?: unknown }).code;
      if (typeof code === "string" && ALLOWED_TRANSPORT_CODES.has(code)) return code;
      const name = (cursor as { name?: unknown }).name;
      if (typeof name === "string" && ALLOWED_TRANSPORT_CODES.has(name)) return name;
      cursor = (cursor as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return undefined;
}

const EXTERNAL_TIMEOUT_SYMBOL = Symbol.for("opentag.externalCallTimedOut");
const TIMEOUT_TOKEN_PATTERN = /^(?:.*[_.:-])?timeout$/i;
const DEADLINE_TOKEN_PATTERN = /_deadline_exceeded$/i;

export function markExternalCallTimedOut<T extends object>(error: T): T {
  try {
    Object.defineProperty(error, EXTERNAL_TIMEOUT_SYMBOL, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Frozen errors stay untouched.
  }
  return error;
}

function matchesTimeoutToken(candidate: unknown): boolean {
  return (
    typeof candidate === "string" &&
    (TIMEOUT_TOKEN_PATTERN.test(candidate) ||
      DEADLINE_TOKEN_PATTERN.test(candidate) ||
      candidate.includes("exceeded its deadline") ||
      /exceeded \d+ms/i.test(candidate))
  );
}

function hasTimeoutCauseOrMarker(error: unknown): boolean {
  if (matchesTimeoutToken(error)) return true;
  let cursor: unknown = error;
  for (let depth = 0; depth <= 3 && cursor && typeof cursor === "object"; depth += 1) {
    try {
      const record = cursor as Record<PropertyKey, unknown>;
      if (record[EXTERNAL_TIMEOUT_SYMBOL] === true || record.timedOut === true) return true;
      if (matchesTimeoutToken(record.code) || matchesTimeoutToken(record.name) || matchesTimeoutToken(record.message)) {
        return true;
      }
      cursor = record.cause;
    } catch {
      break;
    }
  }
  return false;
}

export function isExternalTimeoutError(error: unknown, code?: string, transportCode?: string): boolean {
  const resolvedCode = code ?? safePerformanceErrorCode(error);
  if (matchesTimeoutToken(resolvedCode)) return true;
  const resolvedTransport = transportCode ?? extractExternalTransportCode(error);
  if (
    resolvedTransport === "ETIMEDOUT" ||
    resolvedTransport === "TimeoutError" ||
    matchesTimeoutToken(resolvedTransport)
  ) {
    return true;
  }
  return hasTimeoutCauseOrMarker(error);
}

export interface ExternalCallTraceInput {
  provider: string;
  operation: string;
  accountId?: string;
  agentId?: string;
  computerId?: string;
  sessionId?: string;
  deliveryId?: string;
  turnId?: string;
  sandboxId?: string;
  attributes?: Record<string, unknown>;
}

export interface ExternalCallTraceOptions<T> {
  statusFromResult?: (result: T) => number | undefined;
  resultAttributes?: (result: T) => Record<string, unknown> | undefined;
  errorStatus?: (error: unknown) => number | undefined;
  errorAttributes?: (error: unknown) => Record<string, unknown> | undefined;
  fallbackErrorCode?: string;
}

export function traceExternalCall<T>(
  perfLogger: PerformanceLogger | undefined,
  input: ExternalCallTraceInput,
  fn: () => Promise<T>,
  options?: ExternalCallTraceOptions<T>,
): Promise<T> {
  if (!perfLogger?.config.enabled) return fn();
  return perfLogger.traceAsync(
    {
      module: "external",
      category: "external",
      operation: input.operation,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.computerId ? { computerId: input.computerId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
      attributes: {
        provider: input.provider,
        externalService: input.provider,
        ...input.attributes,
      },
    },
    () => fn(),
    {
      resultAttributes: (result) => {
        const status = options?.statusFromResult?.(result);
        const extra = options?.resultAttributes?.(result);
        return {
          attemptCount: 1,
          retryCount: 0,
          ...(status !== undefined ? { status } : {}),
          ...extra,
        };
      },
      errorAttributes: (error) => {
        const status = options?.errorStatus?.(error);
        const transportCode = extractExternalTransportCode(error);
        const timedOut = isExternalTimeoutError(error, undefined, transportCode);
        const extra = options?.errorAttributes?.(error);
        return {
          attemptCount: 1,
          retryCount: 0,
          ...(status !== undefined ? { status } : {}),
          ...(transportCode ? { transportCode } : {}),
          ...(timedOut ? { timedOut: true } : {}),
          ...extra,
        };
      },
      fallbackErrorCode: options?.fallbackErrorCode ?? "EXTERNAL_CALL_FAILED",
    },
  );
}

function resolveHttpMethod(input: unknown, init?: RequestInit): string {
  if (typeof init?.method === "string" && init.method.trim()) {
    return init.method.trim().toUpperCase().slice(0, 16);
  }
  if (typeof input === "object" && input !== null && "method" in input && typeof input.method === "string") {
    return input.method.trim().toUpperCase().slice(0, 16);
  }
  return "GET";
}

function wrapStreamingFetchResponse(
  response: Response,
  handle: PerformanceOperationHandle,
  signal?: AbortSignal | null,
): Response {
  const status = response.status;
  if (!response.body) {
    handle.complete({ status, attemptCount: 1, retryCount: 0 });
    return response;
  }
  const reader = response.body.getReader();
  const cancelReader = createStreamCancellation(reader);
  const wrappedBody = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            handle.complete({ status, attemptCount: 1, retryCount: 0 });
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          const transportCode = extractExternalTransportCode(error);
          const timedOut =
            isExternalTimeoutError(error, undefined, transportCode) ||
            (signal?.aborted === true && isExternalTimeoutError(signal.reason));
          handle.fail(
            error,
            {
              status,
              attemptCount: 1,
              retryCount: 0,
              ...(transportCode ? { transportCode } : {}),
              ...(timedOut ? { timedOut: true } : {}),
            },
            "EXTERNAL_CALL_FAILED",
          );
          controller.error(error);
        }
      },
      async cancel(reason) {
        handle.complete({ status, attemptCount: 1, retryCount: 0 });
        await cancelReader(reason);
      },
    },
    { highWaterMark: 2 },
  );

  const wrappedResponse = new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrappedResponse, {
    redirected: {
      get: () => response.redirected,
      enumerable: true,
      configurable: true,
    },
    url: {
      get: () => response.url,
      enumerable: true,
      configurable: true,
    },
    type: {
      get: () => response.type,
      enumerable: true,
      configurable: true,
    },
  });
  return wrappedResponse;
}

export function createInstrumentedFetch(
  perfLogger: PerformanceLogger | undefined,
  options: {
    provider: string;
    operation?: string;
    baseFetch?: typeof fetch;
    includePath?: boolean;
  },
): typeof fetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch;
  if (!perfLogger?.config.enabled) return baseFetch;
  const operation = options.operation ?? `external.${options.provider}.http`;
  const includePath = options.includePath ?? FIXED_ROUTE_PROVIDERS.has(options.provider);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const httpMethod = resolveHttpMethod(input, init);
    const urlMeta = sanitizeExternalUrl(input, { includePath });
    const handle = perfLogger.startOperation({
      module: "external",
      category: "external",
      operation,
      attributes: {
        provider: options.provider,
        externalService: options.provider,
        httpMethod,
        ...urlMeta,
      },
    });
    let response: Response;
    try {
      response = await runWithPerformanceContext(handle.context, () => baseFetch(input, init));
    } catch (error) {
      const transportCode = extractExternalTransportCode(error);
      const timedOut =
        isExternalTimeoutError(error, undefined, transportCode) ||
        (init?.signal?.aborted === true && isExternalTimeoutError(init.signal.reason));
      handle.fail(
        error,
        {
          attemptCount: 1,
          retryCount: 0,
          ...(transportCode ? { transportCode } : {}),
          ...(timedOut ? { timedOut: true } : {}),
        },
        "EXTERNAL_CALL_FAILED",
      );
      throw error;
    }
    return wrapStreamingFetchResponse(response, handle, init?.signal);
  }) as typeof fetch;
}
