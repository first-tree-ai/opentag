import {
  RUNTIME_WEB_FETCH_PATH,
  RUNTIME_WEB_SEARCH_PATH,
  WEB_FETCH_RESPONSE_MAX_BYTES,
  WEB_SEARCH_RESPONSE_MAX_BYTES,
  WEB_TIMEOUT_HEADER,
  WEB_TOOL_ERROR_CODES,
  type WebFetchExecutionRequest,
  type WebFetchResult,
  WebFetchResultSchema,
  type WebSearchExecutionRequest,
  type WebSearchResult,
  WebSearchResultSchema,
  type WebToolErrorCode,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { effectiveWebBudgetMs } from "./web-tools-gateway.js";

/**
 * Agreed error codes this trusted client can surface. The shared wire enum is the authority;
 * the three lifecycle/credit codes are part of the agreed Router contract and must survive the
 * client mapping instead of being collapsed into idempotency/unknown.
 */
export type ClientWebToolErrorCode =
  | WebToolErrorCode
  | "request_in_progress"
  | "request_uncertain"
  | "insufficient_credit";

const LIFECYCLE_ERROR_CODES = ["request_in_progress", "request_uncertain", "insufficient_credit"] as const;
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>([...WEB_TOOL_ERROR_CODES, ...LIFECYCLE_ERROR_CODES]);

/** Controlled trusted-client web failure. `code` is the only detail shared with the Sandbox. */
export class WebToolsClientError extends Error {
  readonly code: ClientWebToolErrorCode;
  readonly retryable?: boolean;

  constructor(code: ClientWebToolErrorCode, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = "WebToolsClientError";
    this.code = code;
    if (options?.retryable !== undefined) this.retryable = options.retryable;
  }
}

export interface WebToolsServerClientOptions {
  /** Base Server URL from the trusted daemon configuration; never caller input. */
  readonly serverUrl: string;
  /** The Computer machine token; presented only to the fixed runtime web routes. */
  readonly machineToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: Pick<ClientLogger, "debug" | "warn">;
}

interface WebCallInput {
  readonly operation: "search" | "fetch";
  readonly request: WebSearchExecutionRequest | WebFetchExecutionRequest;
  /** End-to-end budget left when the call entered this trusted hop (never a full restart). */
  readonly remainingMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Trusted Runner → Server web client. The path set is fixed, the machine token is the only
 * credential, the body is the strict execution request, and the response is byte-bounded and
 * schema-validated before anything returns to the Sandbox-facing gateway. One combined deadline
 * spans request headers AND the full response body.
 */
export class WebToolsServerClient {
  readonly #baseUrl: string;
  readonly #machineToken: string;
  readonly #fetch: typeof fetch;
  readonly #logger: Pick<ClientLogger, "debug" | "warn">;

  constructor(options: WebToolsServerClientOptions) {
    const url = new URL(options.serverUrl);
    if (url.username || url.password) throw new Error("The Server URL must not carry credentials");
    this.#baseUrl = url.origin;
    this.#machineToken = options.machineToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#logger = options.logger ?? createLogger("web-tools-client");
  }

  search(input: {
    request: WebSearchExecutionRequest;
    remainingMs?: number;
    signal?: AbortSignal;
  }): Promise<WebSearchResult> {
    return this.#call({
      operation: "search",
      request: input.request,
      ...(input.remainingMs !== undefined ? { remainingMs: input.remainingMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }) as Promise<WebSearchResult>;
  }

  fetch(input: {
    request: WebFetchExecutionRequest;
    remainingMs?: number;
    signal?: AbortSignal;
  }): Promise<WebFetchResult> {
    return this.#call({
      operation: "fetch",
      request: input.request,
      ...(input.remainingMs !== undefined ? { remainingMs: input.remainingMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }) as Promise<WebFetchResult>;
  }

  async #call(input: WebCallInput): Promise<WebSearchResult | WebFetchResult> {
    const startedAt = Date.now();
    const budgetMs = effectiveWebBudgetMs(input.operation, input.remainingMs);
    if (budgetMs === 0) {
      throw new WebToolsClientError("timeout", "The web call budget was exhausted before dispatch", {
        retryable: true,
      });
    }
    const path = input.operation === "search" ? RUNTIME_WEB_SEARCH_PATH : RUNTIME_WEB_FETCH_PATH;
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl) throw new WebToolsClientError("upstream_error", "The web route target is fixed");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("web call timed out")), budgetMs);
    timer.unref?.();
    const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#machineToken}`,
            "content-type": "application/json",
            [WEB_TIMEOUT_HEADER]: String(budgetMs),
          },
          body: JSON.stringify(input.request),
          redirect: "error",
          signal,
        });
      } catch (error) {
        throw abortOrUnavailable(input.signal, deadline.signal, error);
      }
      const maxBytes = input.operation === "search" ? WEB_SEARCH_RESPONSE_MAX_BYTES : WEB_FETCH_RESPONSE_MAX_BYTES;
      const body = await readBounded(response, maxBytes, signal, input.signal, deadline.signal);
      if (response.status !== 200) throw mapServerError(response.status, body, this.#logger);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new WebToolsClientError("provider_protocol_error", "The Server web payload was malformed");
      }
      const schema = input.operation === "search" ? WebSearchResultSchema : WebFetchResultSchema;
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new WebToolsClientError("provider_protocol_error", "The Server web payload failed validation");
      }
      this.#logger.debug(
        { code: "web_call_completed", operation: input.operation, durationMs: Date.now() - startedAt },
        "Web call completed",
      );
      return result.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Distinguish a caller cancellation from our own deadline after any transport rejection. */
function abortOrUnavailable(
  callerSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
  error?: unknown,
): WebToolsClientError {
  if (callerSignal?.aborted) return new WebToolsClientError("aborted", "The web call was aborted");
  if (deadlineSignal.aborted || isTimeoutError(error)) {
    return new WebToolsClientError("timeout", "The Server web call timed out", { retryable: true });
  }
  return new WebToolsClientError("upstream_unavailable", "The Server web route could not be reached", {
    retryable: true,
  });
}

/** A bare DOM/fetch timeout (numeric code 23 / name TimeoutError) is still a timeout, not a fault. */
function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "TimeoutError" || candidate.code === 23;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw oversizedError();
  }
  if (!response.body) return readStreamlessBody(response, maxBytes, callerSignal, deadlineSignal);
  return readStreamBounded(response.body, maxBytes, signal, callerSignal, deadlineSignal);
}

async function readStreamlessBody(
  response: Response,
  maxBytes: number,
  callerSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): Promise<Uint8Array> {
  let buffer: Uint8Array;
  try {
    buffer = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw abortOrUnavailable(callerSignal, deadlineSignal, error);
  }
  if (buffer.byteLength > maxBytes) throw oversizedError();
  return buffer;
}

async function readStreamBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw abortOrUnavailable(callerSignal, deadlineSignal);
      const read = await readChunk(reader, callerSignal, deadlineSignal);
      if (read.done) {
        // A deadline-driven reader.cancel() resolves the pending read with done=true; classify
        // by the signal state instead of continuing into a misleading partial-payload parse.
        if (signal.aborted) throw abortOrUnavailable(callerSignal, deadlineSignal);
        break;
      }
      const value = read.value as Uint8Array;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw oversizedError();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  return mergeChunks(chunks, total);
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callerSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  try {
    return await reader.read();
  } catch (error) {
    throw abortOrUnavailable(callerSignal, deadlineSignal, error);
  }
}

function mergeChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function oversizedError(): WebToolsClientError {
  return new WebToolsClientError("response_too_large", "The Server web response exceeds the bound");
}

/** Map a non-200 Server response to the bounded error code; upstream text is never echoed. */
function mapServerError(
  status: number,
  body: Uint8Array,
  logger: Pick<ClientLogger, "debug" | "warn">,
): WebToolsClientError {
  const envelope = parseServerEnvelope(body, status, logger);
  if (envelope.code) {
    return new WebToolsClientError(envelope.code, `The web call failed: ${envelope.code}`, {
      ...(envelope.retryable !== undefined ? { retryable: envelope.retryable } : {}),
    });
  }
  return statusError(status);
}

function parseServerEnvelope(
  body: Uint8Array,
  status: number,
  logger: Pick<ClientLogger, "debug" | "warn">,
): { code?: ClientWebToolErrorCode; retryable?: boolean } {
  let code: ClientWebToolErrorCode | undefined;
  let retryable: boolean | undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    const envelope =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { error?: { code?: unknown; retryable?: unknown } }).error
        : undefined;
    if (typeof envelope?.code === "string" && KNOWN_ERROR_CODES.has(envelope.code)) {
      code = envelope.code as ClientWebToolErrorCode;
    }
    if (typeof envelope?.retryable === "boolean") retryable = envelope.retryable;
  } catch {
    // A non-envelope body carries no usable evidence.
  }
  try {
    logger.warn({ code: "web_call_failed", status, errorCode: code }, "Server web call failed");
  } catch {
    // Logging must never replace the mapped error.
  }
  return { ...(code ? { code } : {}), ...(retryable !== undefined ? { retryable } : {}) };
}

function statusError(status: number): WebToolsClientError {
  if (status === 401 || status === 403) {
    return new WebToolsClientError("unauthenticated", "The web call was not authenticated");
  }
  if (status === 402) {
    return new WebToolsClientError("insufficient_credit", "The web call has insufficient credit");
  }
  if (status === 429)
    return new WebToolsClientError("rate_limited", "The web call was rate limited", { retryable: true });
  if (status === 504) return new WebToolsClientError("timeout", "The web call timed out", { retryable: true });
  if (status === 410) return new WebToolsClientError("result_unavailable", "The web result is no longer available");
  if (status >= 500) {
    return new WebToolsClientError("upstream_unavailable", "The web route is unavailable", { retryable: true });
  }
  return new WebToolsClientError("unknown", "The web call failed");
}
