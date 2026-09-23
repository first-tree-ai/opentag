import {
  capWebTimeoutMs,
  RouterGatewayErrorSchema,
  WEB_FETCH_RESPONSE_MAX_BYTES,
  WEB_SEARCH_RESPONSE_MAX_BYTES,
  WEB_TIMEOUT_HEADER,
  type WebFetchParams,
  type WebFetchResult,
  WebFetchResultSchema,
  type WebSearchParams,
  type WebSearchResult,
  WebSearchResultSchema,
  type WebToolErrorCode,
} from "@opentag/shared";
import { RuntimeWebError } from "./web-execution.js";

export interface RouterWebClientOptions {
  /** Configured Router origin (deployment config); callers can never override it per request. */
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: { warn(obj: Record<string, unknown>, message: string): void };
}

interface RouterDispatch {
  readonly idempotencyKey: string;
  readonly operation: "search" | "fetch";
  readonly params: WebSearchParams | WebFetchParams;
  /** Remaining budget; `undefined` means the operation cap (never a full restart after expiry). */
  readonly remainingMs?: number;
  readonly routerKey: string;
  readonly signal?: AbortSignal;
}

/**
 * Fixed internal forwarder to the existing Router. The two paths are pinned, the deployment's
 * Router key is supplied per dispatch by the Server policy, redirects are never followed, the upstream body is
 * bounded before parsing, and error envelopes are mapped to redacted codes — provider material and
 * upstream response bodies never cross back to the caller.
 */
export class RouterWebClient {
  readonly #baseOrigin: string;
  readonly #fetch: typeof fetch;
  readonly #logger?: RouterWebClientOptions["logger"];

  constructor(options: RouterWebClientOptions) {
    const base = new URL(options.baseUrl);
    if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password) {
      throw new Error("The Router base URL must be a credential-less HTTP(S) origin");
    }
    this.#baseOrigin = base.origin;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#logger = options.logger;
  }

  search(input: Omit<RouterDispatch, "operation">): Promise<WebSearchResult> {
    return this.#dispatch({ ...input, operation: "search" }) as Promise<WebSearchResult>;
  }

  fetch(input: Omit<RouterDispatch, "operation">): Promise<WebFetchResult> {
    return this.#dispatch({ ...input, operation: "fetch" }) as Promise<WebFetchResult>;
  }

  async #dispatch(input: RouterDispatch): Promise<WebSearchResult | WebFetchResult> {
    const url = new URL(input.operation === "search" ? "/v1/web/search" : "/v1/web/fetch", this.#baseOrigin);
    if (url.origin !== this.#baseOrigin) {
      throw new RuntimeWebError("upstream_error", "The Router request target is fixed");
    }
    // An expired or explicitly invalid budget must fail before any egress, never restart a cap.
    const remainingMs = capWebTimeoutMs(input.operation, input.remainingMs);
    if (remainingMs < 1) {
      throw new RuntimeWebError("timeout", "The remaining web budget was exhausted before dispatch", {
        retryable: true,
      });
    }
    const timeout = AbortSignal.timeout(remainingMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        // The outbound credential set is reconstructed here; inbound headers are never forwarded.
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.routerKey}`,
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
          [WEB_TIMEOUT_HEADER]: String(remainingMs),
        },
        body: JSON.stringify(input.params),
        redirect: "error",
        signal,
      });
    } catch {
      if (input.signal?.aborted) throw new RuntimeWebError("aborted", "The web request was aborted");
      if (timeout.aborted) throw routerTimeoutError();
      throw new RuntimeWebError("upstream_unavailable", "The Router could not be reached", {
        retryable: true,
      });
    }
    const maxBytes = input.operation === "search" ? WEB_SEARCH_RESPONSE_MAX_BYTES : WEB_FETCH_RESPONSE_MAX_BYTES;
    const body = await readBoundedResponse(response, maxBytes, {
      signal,
      callerSignal: input.signal,
      deadlineSignal: timeout,
    });
    if (response.status !== 200) throw mapRouterError(response.status, body, this.#logger);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new RuntimeWebError("provider_protocol_error", "The Router returned a malformed payload");
    }
    const schema = input.operation === "search" ? WebSearchResultSchema : WebFetchResultSchema;
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new RuntimeWebError("provider_protocol_error", "The Router payload failed validation");
    }
    return result.data;
  }
}

function routerTimeoutError(): RuntimeWebError {
  return new RuntimeWebError("timeout", "The Router did not answer within the remaining budget", {
    retryable: true,
  });
}

interface BoundedReadSignals {
  /** Combined caller + deadline signal, used to cancel the body reader. */
  readonly signal: AbortSignal;
  readonly callerSignal?: AbortSignal;
  readonly deadlineSignal: AbortSignal;
}

/**
 * Reads the whole Router response under the combined caller/deadline signal and maps any
 * abort/timeout raised during body reading to the same bounded codes as the header phase — a
 * slow body or a disconnected client is never a malformed-payload error.
 */
async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signals: BoundedReadSignals,
): Promise<Uint8Array> {
  const { signal, callerSignal, deadlineSignal } = signals;
  const mapReadError = (error: unknown): RuntimeWebError => mapBoundedReadError(error, callerSignal, deadlineSignal);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw responseTooLargeError();
  }
  if (!response.body) return readWholeBuffer(response, maxBytes, mapReadError);
  const reader = response.body.getReader();
  try {
    return await readBodyReader(reader, maxBytes, signal, mapReadError);
  } finally {
    reader.releaseLock();
  }
}

function mapBoundedReadError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): RuntimeWebError {
  if (callerSignal?.aborted) return new RuntimeWebError("aborted", "The web request was aborted");
  if (deadlineSignal.aborted) return routerTimeoutError();
  if (error instanceof RuntimeWebError) return error;
  return new RuntimeWebError("upstream_unavailable", "The Router response could not be read", {
    retryable: true,
  });
}

async function readWholeBuffer(
  response: Response,
  maxBytes: number,
  mapReadError: (error: unknown) => RuntimeWebError,
): Promise<Uint8Array> {
  try {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw responseTooLargeError();
    return buffer;
  } catch (error) {
    throw mapReadError(error);
  }
}

async function readBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  mapReadError: (error: unknown) => RuntimeWebError,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw mapReadError(undefined);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    throw mapReadError(error);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return mergeChunks(chunks, total);
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function responseTooLargeError(): RuntimeWebError {
  return new RuntimeWebError("response_too_large", "The Router response exceeds the bound");
}

/** Map a non-200 Router status to a redacted code; the upstream body is parsed, never echoed. */
function mapRouterError(status: number, body: Uint8Array, logger?: RouterWebClientOptions["logger"]): RuntimeWebError {
  let routerCode: string | undefined;
  let requestId: string | undefined;
  try {
    const envelope = RouterGatewayErrorSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (envelope.success) {
      routerCode = envelope.data.error.code ?? undefined;
      requestId = envelope.data.error.request_id;
    }
  } catch {
    // A non-envelope error body carries no usable evidence.
  }
  try {
    logger?.warn({ code: "router_web_error", status, routerCode, requestId }, "Router web request failed");
  } catch {
    // Logging must never replace the mapped error.
  }
  const mapped: { code: WebToolErrorCode; message: string; retryable?: boolean } = routerErrorMapping(
    status,
    routerCode,
  );
  return new RuntimeWebError(mapped.code, mapped.message, { retryable: mapped.retryable });
}

interface MappedRouterError {
  code: WebToolErrorCode;
  message: string;
  retryable?: boolean;
}

/**
 * The Router reuses HTTP 409 for several distinct outcomes; the bounded body code keeps them
 * apart so request_in_progress, request_uncertain, idempotency_conflict, insufficient_credit,
 * and result_unavailable never collapse into one generic conflict.
 */
const ROUTER_CODE_MAPPING: Readonly<Record<string, MappedRouterError>> = {
  idempotency_key_reuse: {
    code: "idempotency_conflict",
    message: "The idempotency key conflicts with a different request",
  },
  idempotency_conflict: {
    code: "idempotency_conflict",
    message: "The idempotency key conflicts with a different request",
  },
  request_in_progress: {
    code: "request_in_progress",
    message: "A request with this idempotency key is still running and was not redispatched",
    retryable: true,
  },
  request_uncertain: {
    code: "request_uncertain",
    message: "The request outcome is uncertain and pending reconciliation",
  },
  result_unavailable: {
    code: "result_unavailable",
    message: "The stored result is no longer available; the request was not redispatched",
  },
  insufficient_credit: { code: "insufficient_credit", message: "The web service account has insufficient credit" },
  billing_error: { code: "insufficient_credit", message: "The web service account has insufficient credit" },
  request_released: { code: "upstream_error", message: "The previous request cannot be replayed" },
  stream_not_replayable: { code: "upstream_error", message: "The previous request cannot be replayed" },
  rate_limited: { code: "rate_limited", message: "The web service is rate limited", retryable: true },
};

function routerErrorMapping(status: number, routerCode: string | undefined): MappedRouterError {
  const byCode = routerCode === undefined ? undefined : ROUTER_CODE_MAPPING[routerCode];
  if (byCode) return byCode;
  return routerStatusMapping(status);
}

function routerStatusMapping(status: number): MappedRouterError {
  if (status === 402) {
    return { code: "insufficient_credit", message: "The web service account has insufficient credit" };
  }
  if (status === 409) {
    // A 409 without a recognizable code is an idempotency outcome, never a false digest claim.
    return { code: "request_uncertain", message: "The web request outcome is uncertain" };
  }
  if (status === 429) return { code: "rate_limited", message: "The web service is rate limited", retryable: true };
  if (status === 408 || status === 504) {
    return { code: "timeout", message: "The web service timed out", retryable: true };
  }
  if (status === 410) {
    return { code: "result_unavailable", message: "The stored web result is no longer available" };
  }
  if (status === 400 || status === 422) {
    return { code: "invalid_request", message: "The Router rejected the request as invalid" };
  }
  if (status === 401 || status === 403) {
    // The Router key or scope failed: a deployment/configuration fault, never a caller problem.
    return { code: "upstream_error", message: "The web service authorization failed at the Router" };
  }
  if (status >= 500) {
    return { code: "upstream_unavailable", message: "The web service is unavailable", retryable: true };
  }
  return { code: "unknown", message: "The web service returned an unknown error" };
}
