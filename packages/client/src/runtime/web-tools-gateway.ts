import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WEB_FETCH_TIMEOUT_CAP_MS,
  WEB_GATEWAY_FETCH_PATH,
  WEB_GATEWAY_SEARCH_PATH,
  WEB_REQUEST_MAX_BYTES,
  WEB_SEARCH_TIMEOUT_CAP_MS,
  type WebFetchParams,
  type WebFetchResult,
  type WebGatewayFetchRequest,
  WebGatewayFetchRequestSchema,
  type WebGatewaySearchRequest,
  WebGatewaySearchRequestSchema,
  type WebSearchParams,
  type WebSearchResult,
  type WebToolErrorCode,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";

/**
 * Agreed cross-repo error codes. The shared wire enum is the authority; the three
 * lifecycle/credit codes are part of the agreed Router contract and are listed here so the
 * gateway maps them correctly even before the shared enum names them.
 */
export type GatewayWebToolErrorCode =
  | WebToolErrorCode
  | "request_in_progress"
  | "request_uncertain"
  | "insufficient_credit";

/** Controlled gateway dispatch failure; `code` maps deterministically to an HTTP status. */
export class WebGatewayDispatchError extends Error {
  readonly code: GatewayWebToolErrorCode;
  readonly retryable?: boolean;

  constructor(code: GatewayWebToolErrorCode, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = "WebGatewayDispatchError";
    this.code = code;
    if (options?.retryable !== undefined) this.retryable = options.retryable;
  }
}

/**
 * The one dispatch entry a trusted boundary provides. The gateway owns framing, validation, the
 * decreasing remaining-budget, and abort wiring; the caller owns execution identity and
 * authorization. `remainingMs` is the end-to-end budget left when the request entered the
 * gateway (never more than the operation cap, never reset).
 */
export type WebGatewayDispatch = (
  input:
    | { operation: "search"; toolCallId: string; remainingMs: number; params: WebSearchParams }
    | { operation: "fetch"; toolCallId: string; remainingMs: number; params: WebFetchParams },
  signal: AbortSignal,
) => Promise<WebSearchResult | WebFetchResult>;

/**
 * Deterministic status per bounded error code, including the agreed Router lifecycle/credit
 * codes; unknown codes fall back to 500 and never pass through raw.
 */
const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  insufficient_credit: 402,
  web_disabled: 403,
  credential_scope_denied: 403,
  execution_unknown: 404,
  execution_closed: 409,
  idempotency_conflict: 409,
  request_in_progress: 409,
  request_uncertain: 409,
  rate_limited: 429,
  timeout: 504,
  aborted: 499,
  upstream_unavailable: 503,
  upstream_error: 502,
  provider_protocol_error: 502,
  response_too_large: 502,
  result_unavailable: 410,
  unknown: 500,
};

/** Unix socket paths are kernel-bounded (≈104 bytes on common platforms); fail before bind. */
const SOCKET_PATH_MAX_BYTES = 100;

/**
 * Allocate a fresh, short, private per-execution gateway endpoint. `mkdtemp` under the OS temp
 * root keeps the path independent of long Session storage layouts, and a brand-new directory per
 * call is the ownership proof: a stale descriptor from an earlier execution can never be
 * rebound and a late close can never unlink a successor's socket.
 */
export async function allocateWebGatewaySocket(): Promise<{ directory: string; socketPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "opentag-web-"));
  return { directory, socketPath: join(directory, "web.sock") };
}

/** Hop header carrying the remaining end-to-end budget (metadata only, never in the digest). */
export const WEB_GATEWAY_REMAINING_HEADER = "x-web-remaining-ms" as const;

/**
 * Effective per-operation budget for an already-parsed numeric remaining value. When no value
 * was supplied the operation cap applies; an explicit invalid/expired value yields 0 so the
 * caller fails before dispatch instead of restarting the full budget.
 */
export function effectiveWebBudgetMs(operation: "search" | "fetch", remainingMs?: number): number {
  const cap = operation === "search" ? WEB_SEARCH_TIMEOUT_CAP_MS : WEB_FETCH_TIMEOUT_CAP_MS;
  if (remainingMs === undefined) return cap;
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) return 0;
  return Math.min(remainingMs, cap);
}

/**
 * Raw hop-header budget: at most 7 ASCII digits and positive. An absent header returns the
 * operation cap; a present but malformed header is invalid (undefined) and must be rejected.
 */
export function resolveWebBudgetHeader(operation: "search" | "fetch", raw: string | undefined): number | undefined {
  if (raw === undefined) return effectiveWebBudgetMs(operation);
  if (!/^[0-9]{1,7}$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return Math.min(value, operation === "search" ? WEB_SEARCH_TIMEOUT_CAP_MS : WEB_FETCH_TIMEOUT_CAP_MS);
}

/** Bounded hop response: a 200 business result or a bounded redacted error envelope. */
export interface GatewayCallOutcome {
  readonly status: number;
  readonly body: string;
}

/**
 * Transport-neutral gateway call: validate the strict request body, enforce the decreasing
 * budget with its own deadline race, dispatch once, and map every failure to a bounded outcome.
 * Both the local Unix HTTP server and the native Sandbox exec-pipe bridge use this exact path.
 */
export interface ExecuteGatewayCallInput {
  readonly operation: "search" | "fetch";
  readonly rawBody: Buffer;
  readonly remainingHeader?: string | undefined;
  readonly dispatch: WebGatewayDispatch;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /** Ingress time already elapsed before the body was read (included in the budget). */
  readonly ingressAtMs?: number;
  readonly logger?: Pick<ClientLogger, "warn">;
}

export async function executeGatewayCall(input: ExecuteGatewayCallInput): Promise<GatewayCallOutcome> {
  const ingressAtMs = input.ingressAtMs ?? input.now();
  const budgetMs = resolveWebBudgetHeader(input.operation, input.remainingHeader);
  if (budgetMs === undefined) {
    return errorOutcome(400, "invalid_request", "The remaining-budget header is invalid");
  }
  if (input.rawBody.byteLength > WEB_REQUEST_MAX_BYTES) {
    return errorOutcome(413, "invalid_request", "The web gateway request exceeds the bound");
  }
  const remainingMs = budgetMs - (input.now() - ingressAtMs);
  if (remainingMs <= 0) {
    return errorOutcome(504, "timeout", "The web request budget was exhausted", true);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    return errorOutcome(400, "invalid_request", "The web gateway request is not valid JSON");
  }
  if (input.operation === "search") {
    const body = WebGatewaySearchRequestSchema.safeParse(parsed);
    if (!body.success) {
      return errorOutcome(400, "invalid_request", "The web gateway request failed validation");
    }
    return dispatchGatewayCall(input, body.data, remainingMs);
  }
  const body = WebGatewayFetchRequestSchema.safeParse(parsed);
  if (!body.success) {
    return errorOutcome(400, "invalid_request", "The web gateway request failed validation");
  }
  return dispatchGatewayCall(input, body.data, remainingMs);
}

async function dispatchGatewayCall(
  input: ExecuteGatewayCallInput,
  body: WebGatewaySearchRequest | WebGatewayFetchRequest,
  remainingMs: number,
): Promise<GatewayCallOutcome> {
  const deadline = new AbortController();
  const onCallerAbort = () => deadline.abort(new Error("gateway call aborted"));
  input.signal.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => deadline.abort(new Error("gateway call deadline exceeded")), remainingMs);
  timer.unref?.();
  try {
    if (input.signal.aborted) return abortedOutcome();
    const outcome = await settleDispatch(
      input.dispatch(buildDispatchInput(input.operation, body, remainingMs), deadline.signal),
      deadline.signal,
    );
    if (outcome.kind === "aborted") return abortOrTimeoutOutcome(input.signal);
    return { status: 200, body: JSON.stringify(outcome.value) };
  } catch (error) {
    return mapDispatchError(error, input, deadline.signal);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onCallerAbort);
  }
}

function buildDispatchInput(
  operation: "search" | "fetch",
  body: WebGatewaySearchRequest | WebGatewayFetchRequest,
  remainingMs: number,
): Parameters<WebGatewayDispatch>[0] {
  if (operation === "search") {
    return {
      operation: "search",
      toolCallId: (body as WebGatewaySearchRequest).toolCallId,
      remainingMs,
      params: searchParams(body as WebGatewaySearchRequest),
    };
  }
  return {
    operation: "fetch",
    toolCallId: (body as WebGatewayFetchRequest).toolCallId,
    remainingMs,
    params: fetchParams(body as WebGatewayFetchRequest),
  };
}

function abortedOutcome(): GatewayCallOutcome {
  return errorOutcome(499, "aborted", "The web gateway request was aborted");
}

function abortOrTimeoutOutcome(callerSignal: AbortSignal): GatewayCallOutcome {
  return callerSignal.aborted
    ? abortedOutcome()
    : errorOutcome(504, "timeout", "The web request budget was exhausted", true);
}

function mapDispatchError(
  error: unknown,
  input: ExecuteGatewayCallInput,
  deadlineSignal: AbortSignal,
): GatewayCallOutcome {
  if (error instanceof WebGatewayDispatchError) {
    return errorOutcome(ERROR_STATUS[error.code] ?? 500, error.code, error.message, error.retryable);
  }
  if (deadlineSignal.aborted) return abortOrTimeoutOutcome(input.signal);
  try {
    input.logger?.warn({ code: "web_gateway_dispatch_failed", error: errorName(error) }, "Web gateway dispatch failed");
  } catch {
    // Logging must never replace the error response.
  }
  return errorOutcome(500, "unknown", "The web gateway request failed");
}

type DispatchOutcome =
  | { readonly kind: "value"; readonly value: WebSearchResult | WebFetchResult }
  | { readonly kind: "aborted" };

/** Race one dispatch promise against the shared deadline without leaking listeners. */
function settleDispatch(
  promise: Promise<WebSearchResult | WebFetchResult>,
  signal: AbortSignal,
): Promise<DispatchOutcome> {
  return new Promise((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ kind: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "value", value });
      },
      (error: unknown) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function searchParams(body: WebGatewaySearchRequest): WebSearchParams {
  const { protocolVersion: _protocol, toolCallId: _call, ...params } = body;
  return params;
}

function fetchParams(body: WebGatewayFetchRequest): WebFetchParams {
  const { protocolVersion: _protocol, toolCallId: _call, ...params } = body;
  return params;
}

/**
 * The per-execution trusted web gateway: an HTTP/1.1 server on a fresh, owned Unix socket
 * offering exactly `/web/search` and `/web/fetch`. Local (trusted Client) it lives on a short
 * private per-execution path; native it lives inside the Sandbox namespace and its traffic rides
 * the dedicated exec pipe — no network listener anywhere. Bodies are bounded and read under the
 * same decreasing deadline as the dispatch itself.
 */
export class WebToolsGatewayServer {
  readonly #server: http.Server;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  #ownedIdentity: { dev: number; ino: number } | undefined;
  #closed = false;

  private constructor(server: http.Server, socketPath: string) {
    this.#server = server;
    this.#socketPath = socketPath;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  static async start(options: WebToolsGatewayServerOptions): Promise<WebToolsGatewayServer> {
    if (Buffer.byteLength(options.socketPath) > SOCKET_PATH_MAX_BYTES) {
      throw new Error("The web gateway socket path exceeds the platform bound");
    }
    await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.socketPath), 0o700);
    // A fresh per-execution path is the ownership proof: an existing filesystem object at the
    // path (stale socket or anything else) is refused instead of being unlinked or clobbered.
    const existing = await lstat(options.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) throw new Error("The web gateway socket path is occupied");
    const logger = options.logger ?? createLogger("web-tools-gateway");
    const now = options.now ?? Date.now;
    const server = http.createServer((request, response) => {
      void handleGatewayRequest(request, response, options.dispatch, logger, now).catch((error: unknown) => {
        try {
          logger.debug({ code: "web_gateway_request_failed", error: errorName(error) }, "Web gateway request failed");
        } catch {
          // Logging must never break the gateway loop.
        }
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "unknown", message: "The web gateway request failed" } }));
        } else response.end();
      });
    });
    // One owned instance only: the connection listener and close() must share the same tracking
    // state, so the instance that owns the server is created before listeners are attached.
    const gateway = new WebToolsGatewayServer(server, options.socketPath);
    server.on("connection", (socket: Socket) => {
      if (gateway.#closed) {
        socket.destroy();
        return;
      }
      gateway.#sockets.add(socket);
      socket.on("close", () => gateway.#sockets.delete(socket));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(options.socketPath, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      await chmod(options.socketPath, 0o600);
      const owned = await lstat(options.socketPath);
      if (!owned.isSocket()) throw new Error("The web gateway socket path is not a socket after bind");
      gateway.#ownedIdentity = { dev: owned.dev, ino: owned.ino };
      return gateway;
    } catch (error) {
      gateway.#closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      throw error;
    }
  }

  /** Stop listening, destroy in-flight connections, and remove only the socket we created. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of [...this.#sockets]) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    const ownedIdentity = this.#ownedIdentity;
    this.#ownedIdentity = undefined;
    if (!ownedIdentity) return;
    const current = await lstat(this.#socketPath).catch(() => undefined);
    if (current?.isSocket() && current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino) {
      await rm(this.#socketPath, { force: true }).catch(() => undefined);
    }
  }
}

export interface WebToolsGatewayServerOptions {
  /** Exact Unix socket path (the nonsecret endpoint descriptor). Fresh and owned per bind. */
  readonly socketPath: string;
  readonly dispatch: WebGatewayDispatch;
  readonly logger?: Pick<ClientLogger, "debug" | "warn">;
  /** Test seam: clock for the remaining-budget arithmetic. */
  readonly now?: () => number;
}

async function handleGatewayRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  dispatch: WebGatewayDispatch,
  logger: Pick<ClientLogger, "debug" | "warn">,
  now: () => number,
): Promise<void> {
  const ingressAtMs = now();
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort(new Error("request aborted"));
  const onResponseClose = () => {
    // A response-side close before completion is a real downstream disconnect.
    if (!response.writableFinished) abort.abort(new Error("response closed"));
  };
  // Keep a no-op transport error listener for the lifetime of the exchange: destroy/abort paths
  // emit 'error' asynchronously after the reader detaches, and an unheard 'error' would crash.
  const swallowTransportError = () => undefined;
  request.on("aborted", onRequestAbort);
  request.on("error", swallowTransportError);
  response.on("close", onResponseClose);
  try {
    const operation =
      request.method === "POST" && request.url === WEB_GATEWAY_SEARCH_PATH
        ? ("search" as const)
        : request.method === "POST" && request.url === WEB_GATEWAY_FETCH_PATH
          ? ("fetch" as const)
          : undefined;
    if (!operation) {
      sendGatewayError(response, 404, "invalid_request", "Unknown web gateway operation");
      return;
    }
    const rawRemaining = headerValue(request.headers[WEB_GATEWAY_REMAINING_HEADER]);
    const budgetMs = resolveWebBudgetHeader(operation, rawRemaining);
    if (budgetMs === undefined) {
      sendGatewayError(response, 400, "invalid_request", "The remaining-budget header is invalid");
      return;
    }
    const deadlineAtMs = ingressAtMs + budgetMs;
    if (deadlineAtMs - now() <= 0) {
      sendGatewayError(response, 504, "timeout", "The web request budget was exhausted", true);
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBoundedRequest(request, WEB_REQUEST_MAX_BYTES, abort.signal, deadlineAtMs, now);
    } catch (error) {
      if (abort.signal.aborted) sendGatewayError(response, 499, "aborted", "The web gateway request was aborted");
      else if (error instanceof GatewayBodyTimeoutError) {
        sendGatewayError(response, 504, "timeout", "The web gateway request body stalled", true);
      } else {
        sendGatewayError(response, 413, "invalid_request", "The web gateway request exceeds the bound");
      }
      return;
    }
    const outcome = await executeGatewayCall({
      operation,
      rawBody: raw,
      remainingHeader: rawRemaining,
      dispatch,
      signal: abort.signal,
      now,
      ingressAtMs,
      logger,
    });
    sendGatewayOutcome(response, outcome);
  } finally {
    request.off("aborted", onRequestAbort);
    response.off("close", onResponseClose);
  }
}

function sendGatewayOutcome(response: http.ServerResponse, outcome: GatewayCallOutcome): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (response.destroyed) return;
  response.writeHead(outcome.status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(outcome.body);
}

function errorOutcome(
  status: number,
  code: GatewayWebToolErrorCode,
  message: string,
  retryable?: boolean,
): GatewayCallOutcome {
  return {
    status,
    body: JSON.stringify({
      error: { code, message: message.slice(0, 256), ...(retryable !== undefined ? { retryable } : {}) },
    }),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

class GatewayBodyTimeoutError extends Error {
  constructor() {
    super("The web gateway request body stalled");
    this.name = "GatewayBodyTimeoutError";
  }
}

type ChunkOutcome =
  | { readonly kind: "chunk"; readonly chunk: Buffer }
  | { readonly kind: "end" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

/**
 * Bounded body read under the request's absolute deadline. Every wait attaches and removes its
 * own listeners and timer, so an aborted client or a stalled body settles deterministically
 * instead of leaving a hung async iterator or a leaked timer.
 */
async function readBoundedRequest(
  request: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
  deadlineAtMs: number,
  now: () => number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) throw new Error("aborted");
    const remaining = deadlineAtMs - now();
    if (remaining <= 0) throw new GatewayBodyTimeoutError();
    const outcome = await readOneChunk(request, remaining, signal);
    if (outcome.kind === "end") break;
    if (outcome.kind === "timeout") throw new GatewayBodyTimeoutError();
    if (outcome.kind === "aborted") throw new Error("aborted");
    total += outcome.chunk.byteLength;
    if (total > maxBytes) {
      request.pause();
      throw new Error("The web gateway request exceeds the bound");
    }
    chunks.push(outcome.chunk);
  }
  return Buffer.concat(chunks);
}

function readOneChunk(request: http.IncomingMessage, waitMs: number, signal: AbortSignal): Promise<ChunkOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let ended = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("close", onClose);
      request.off("aborted", onAborted);
      signal.removeEventListener("abort", onSignalAbort);
      if (!ended) request.pause();
    };
    const settle = (outcome: ChunkOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const onData = (chunk: Buffer) => settle({ kind: "chunk", chunk });
    const onEnd = () => {
      ended = true;
      settle({ kind: "end" });
    };
    const onClose = () => settle({ kind: "aborted" });
    const onAborted = () => settle({ kind: "aborted" });
    const onSignalAbort = () => {
      request.destroy();
      settle({ kind: "aborted" });
    };
    const timer = setTimeout(() => settle({ kind: "timeout" }), Math.max(1, waitMs));
    timer.unref?.();
    request.on("data", onData);
    // An explicit pause() earlier in the chain is sticky: adding a 'data' listener no longer
    // resumes the stream, so the next chunk wait must resume explicitly.
    request.resume();
    request.once("end", onEnd);
    request.once("close", onClose);
    request.once("aborted", onAborted);
    signal.addEventListener("abort", onSignalAbort, { once: true });
    if (signal.aborted) onSignalAbort();
  });
}

function sendGatewayError(
  response: http.ServerResponse,
  status: number,
  code: GatewayWebToolErrorCode,
  message: string,
  retryable?: boolean,
): void {
  sendGatewayOutcome(response, errorOutcome(status, code, message, retryable));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}
