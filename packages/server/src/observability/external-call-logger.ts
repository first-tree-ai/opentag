import {
  type PerformanceLogger,
  type PerformanceOperationHandle,
  runWithPerformanceContext,
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

const FIXED_ROUTE_PROVIDERS = new Set(["github", "cloud-router", "web-router", "cloud-run", "gcp-metadata"]);

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

export interface ExternalCallTraceInput {
  provider: string;
  operation: string;
  accountId?: string;
  agentId?: string;
  attributes?: Record<string, unknown>;
}

export interface ExternalCallTraceOptions<T> {
  statusFromResult?: (result: T) => number | undefined;
  resultAttributes?: (result: T) => Record<string, unknown> | undefined;
  errorStatus?: (error: unknown) => number | undefined;
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
      attributes: {
        provider: input.provider,
        ...input.attributes,
      },
    },
    () => fn(),
    {
      resultAttributes: (result) => {
        const status = options?.statusFromResult?.(result);
        const extra = options?.resultAttributes?.(result);
        return {
          ...(status !== undefined ? { status } : {}),
          ...extra,
        };
      },
      errorAttributes: (error) => {
        const status = options?.errorStatus?.(error);
        const transportCode = extractExternalTransportCode(error);
        return {
          ...(status !== undefined ? { status } : {}),
          ...(transportCode ? { transportCode } : {}),
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

function wrapStreamingFetchResponse(response: Response, handle: PerformanceOperationHandle): Response {
  const status = response.status;
  if (!response.body) {
    handle.complete({ status });
    return response;
  }
  const reader = response.body.getReader();
  const wrappedBody = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            handle.complete({ status });
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          const transportCode = extractExternalTransportCode(error);
          handle.fail(
            error,
            {
              status,
              ...(transportCode ? { transportCode } : {}),
            },
            "EXTERNAL_CALL_FAILED",
          );
          controller.error(error);
        }
      },
      async cancel(reason) {
        handle.complete({ status });
        await reader.cancel(reason);
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
        httpMethod,
        ...urlMeta,
      },
    });
    let response: Response;
    try {
      response = await runWithPerformanceContext(handle.context, () => baseFetch(input, init));
    } catch (error) {
      const transportCode = extractExternalTransportCode(error);
      handle.fail(error, transportCode ? { transportCode } : undefined, "EXTERNAL_CALL_FAILED");
      throw error;
    }
    return wrapStreamingFetchResponse(response, handle);
  }) as typeof fetch;
}
