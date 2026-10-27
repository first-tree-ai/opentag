import type { ServerResponse } from "node:http";
import { CLOUD_MODEL_CHAT_COMPLETIONS_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { CloudCallContext } from "../cloud-call-contracts.js";
import type { CloudModelConfig } from "../cloud-model-config.js";
import { normalizeInitialModelStream } from "../cloud-model-initial-stream.js";
import {
  applyCloudModelOutputBudget,
  CLOUD_MODEL_ERROR_BODY_MAX_BYTES,
  CloudModelRequestSchema,
} from "../cloud-model-request.js";
import { cloudModelRetryAfter, cloudModelRetryDelay, waitForCloudModelRetry } from "../cloud-model-retry.js";
import type { CloudModelService } from "../services/cloud-model-service.js";
import { readBoundedResponseText } from "../services/sandboxes/cloud-model-catalog.js";
import type { CloudModelGrantService } from "../services/sandboxes/cloud-model-grants.js";

/**
 * E4 controlled model path. Sandboxes call exactly one OpenAI-compatible operation with an
 * execution-scoped token; the Server binds the request to the token's allowlisted model, bounds
 * bodies and streams, forwards to the single configured fixed upstream with the platform master
 * key, and aborts in-flight upstream calls on revocation. The token, the master key, and upstream
 * error bodies are never logged or relayed; arbitrary URLs, paths, and models are rejected by
 * construction (no path parameter exists — the route is the whole allowlist). The request body is
 * a STRICT field allowlist: exactly the standard chat-completion fields the image-pinned Pi
 * (`scripts/runner/pi`: @earendil-works/pi-coding-agent 0.84.2, pi-ai openai-completions) emits,
 * plus the bounded reasoning echo fields (`reasoning_content`, `reasoning`, `reasoning_text`) and
 * the bounded encrypted `reasoning_details` Pi replays for signed tool calls. Router/credential
 * overrides (`route`, `models`, `provider`, `api_base`, `api_key`, …) are rejected before any
 * upstream call, `n` is bounded to a single choice, and every request carries a bounded output
 * budget.
 *
 * Responsibility boundaries:
 * - Client disconnect is detected on the RESPONSE socket (`reply.raw` close before the response
 *   finished), never on the fully-read request socket.
 * - Backpressure waits race drain against abort/close/error, so a disconnected client can never
 *   pin an admission slot until the request timeout.
 * - Upstream response headers are written only once the first body chunk arrived, so a stalled
 *   upstream can still be answered with a sanitized 504 instead of a clean empty 200.
 * - A truncated or oversized upstream body destroys the client socket instead of ending an
 *   apparently successful answer; non-2xx upstream bodies are replaced by a generic error envelope.
 * - The route owns a `preClose` hook that aborts every in-flight upstream call and closes the
 *   grant service, so `app.close()` cannot wait indefinitely on an open model stream.
 */

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";
/** Matches the Runner wire bound for one model token. */
const MAX_TOKEN_CHARS = 4_096;

export interface CloudModelProxyRouteOptions {
  config: Extract<CloudModelConfig, { enabled: true }>;
  grants: CloudModelGrantService;
  modelService: CloudModelService;
  contextForExecution: (claims: GrantClaims) => Promise<CloudCallContext | undefined>;
  now?: () => number;
}

type GrantClaims = NonNullable<Awaited<ReturnType<CloudModelGrantService["verify"]>>>;

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 && token.length <= MAX_TOKEN_CHARS ? token : undefined;
}

async function fail(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  upstreamStatus?: number,
  retryAfter?: string,
): Promise<FastifyReply> {
  if (reply.raw.destroyed || reply.raw.writableEnded || reply.raw.headersSent) return reply;
  reply.header("cache-control", "no-store");
  if (retryAfter !== undefined) reply.header("retry-after", retryAfter);
  return reply.code(statusCode).send({
    error: {
      code,
      message,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    },
  });
}

function isResponseClosed(reply: FastifyReply): boolean {
  return reply.raw.destroyed || reply.raw.writableEnded;
}

/** Authorize the request: token valid, body parseable, model bound to the token. */
async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CloudModelProxyRouteOptions,
): Promise<{ claims: GrantClaims; body: z.infer<typeof CloudModelRequestSchema> } | undefined> {
  const token = bearerToken(request);
  if (!token) {
    await fail(reply, 401, "CLOUD_MODEL_TOKEN_INVALID", "A model call token is required");
    return undefined;
  }
  const claims = await options.grants.verify(token);
  if (!claims) {
    await fail(reply, 401, "CLOUD_MODEL_TOKEN_INVALID", "The model call token is invalid or expired");
    return undefined;
  }
  const parsed = CloudModelRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    await fail(reply, 400, "CLOUD_MODEL_REQUEST_INVALID", "The chat completions request body is invalid");
    return undefined;
  }
  if (parsed.data.model !== claims.model) {
    await fail(reply, 403, "CLOUD_MODEL_MODEL_DENIED", "The token does not cover the requested model");
    return undefined;
  }
  return { claims, body: applyCloudModelOutputBudget(parsed.data, claims.maxTokens) };
}

/** Call the fixed upstream with the platform master key; bounded by timeout and revocation. */
async function callUpstream(
  options: CloudModelProxyRouteOptions,
  model: string,
  body: z.infer<typeof CloudModelRequestSchema>,
  signal: AbortSignal,
  claims: GrantClaims,
): Promise<Response | undefined> {
  const context = await options.contextForExecution(claims);
  if (!context) throw new Error("Cloud execution has no owner");
  return options.modelService.request({ ...body, model }, signal, options.config, context);
}

/** Wait for socket drain, but never past a close, error, or abort. */
function waitForDrain(raw: ServerResponse, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || raw.destroyed || raw.writableEnded) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      raw.off("drain", onDrain);
      raw.off("close", onClose);
      raw.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const onError = (): void => settle(false);
    const onAbort = (): void => settle(false);
    raw.once("drain", onDrain);
    raw.once("close", onClose);
    raw.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || raw.destroyed || raw.writableEnded) settle(false);
  });
}

type PipelineOutcome = "completed" | "started_truncated" | "not_started";

/**
 * Relay the upstream body with a hard byte cap. Headers are written with the first chunk, so a
 * pre-body failure can still be sanitized. Overflow, upstream failure, timeout, revocation, and
 * client disconnect destroy the socket instead of ending a truncated answer cleanly.
 */
async function pipeUpstreamBody(
  reply: FastifyReply,
  upstream: Response,
  options: CloudModelProxyRouteOptions,
  signal: AbortSignal,
): Promise<PipelineOutcome> {
  const reader = upstream.body?.getReader();
  if (!reader) return "not_started";
  let result: "completed" | "truncated";
  try {
    result = await pumpUpstreamChunks(reply, reader, upstream, options.config.maxResponseBytes, signal);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The reader is already closed/cancelled; nothing left to release.
    }
  }
  if (!reply.raw.headersSent) return "not_started";
  if (result === "completed") {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    return "completed";
  }
  if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.destroy();
  return "started_truncated";
}

function startStreamingResponse(reply: FastifyReply, upstream: Response): void {
  if (reply.raw.headersSent) return;
  reply.hijack();
  reply.raw.writeHead(upstream.status, {
    "cache-control": "no-store",
    "content-type": upstream.headers.get("content-type") ?? JSON_CONTENT_TYPE,
    "x-content-type-options": "nosniff",
  });
}

async function writeChunk(raw: ServerResponse, chunk: Uint8Array, signal: AbortSignal): Promise<boolean> {
  if (raw.write(chunk)) return true;
  return waitForDrain(raw, signal);
}

async function pumpUpstreamChunks(
  reply: FastifyReply,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  upstream: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<"completed" | "truncated"> {
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return signal.aborted ? "truncated" : "completed";
      if (signal.aborted) return "truncated";
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) return "truncated";
      startStreamingResponse(reply, upstream);
      if (!(await writeChunk(reply.raw, chunk.value, signal))) return "truncated";
    }
  } catch {
    // Upstream read/write failed or the signal aborted: finalize as truncated by the caller.
    return "truncated";
  }
}

async function discardUpstreamBody(upstream: Response): Promise<void> {
  try {
    await upstream.body?.cancel();
  } catch {
    // Best-effort release of the fixed-upstream socket.
  }
}

function declaredContentLength(upstream: Response): number | undefined {
  const raw = upstream.headers.get("content-length");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

interface UpstreamRejection {
  code: string;
  message: string;
  status: number;
  upstreamStatus?: number;
  retryAfter?: string;
}

/**
 * An upstream error envelope is tiny; anything larger is not an error document. The body is read
 * under this cap exactly once for classification and is never relayed or logged: a provider or
 * Router error may echo secret-bearing request material in its message or param fields.
 */
const UPSTREAM_ERROR_BODY_MAX_BYTES = CLOUD_MODEL_ERROR_BODY_MAX_BYTES;

/**
 * The safe upstream error classification. Only the confirmed classes below change the answer; an
 * unparseable, oversized, or unrecognized error body — and every unknown 400 — stays the generic
 * sanitized rejection, never a false context overflow. The fixed codes and messages are chosen so
 * the pinned Pi's own recognizers behave correctly on the literal envelope Pi receives
 * (`<status>: {"code":..., "message":...}` inside the assistant errorMessage):
 * `context_length_exceeded` matches Pi's overflow patterns (native compact-and-retry), the rate
 * limit text matches Pi's bounded retry pattern, and the billing text matches Pi's non-retryable
 * quota pattern. No upstream message or param text is ever reflected.
 */
type UpstreamErrorClass = "context_overflow" | "billing" | "rate_limit" | "authentication" | "invalid_request";

const UPSTREAM_CONTEXT_OVERFLOW_CODE = "context_length_exceeded";
const UPSTREAM_BILLING_CODES = new Set(["insufficient_credit", "insufficient_quota", "billing_error"]);
const UPSTREAM_RATE_LIMIT_CODE = "rate_limit_exceeded";
const UPSTREAM_AUTH_CODES = new Set([
  "invalid_api_key",
  "authentication_error",
  "permission_denied",
  "model_not_permitted",
]);
const UPSTREAM_INVALID_REQUEST = "invalid_request_error";

/** Read the bounded error envelope's declared code/type; undefined for anything else. */
function upstreamErrorEnvelope(bodyText: string | undefined): { code?: string; type?: string } | undefined {
  if (bodyText === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const error = (raw as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const { code, type } = error as Record<string, unknown>;
  return {
    ...(typeof code === "string" && code.length > 0 && code.length <= 128 ? { code } : {}),
    ...(typeof type === "string" && type.length > 0 && type.length <= 128 ? { type } : {}),
  };
}

/**
 * Classify one rejected upstream response. Classification keys only on the HTTP status and the
 * bounded envelope's own `code`/`type` fields — never on free-text messages. Context overflow
 * requires the explicit confirmed code on a client-error status; rate limit is the 429 contract;
 * billing, authentication, and permanent invalid requests keep their permanent classes.
 */
function classifyUpstreamError(status: number, bodyText: string | undefined): UpstreamErrorClass | undefined {
  const envelope = upstreamErrorEnvelope(bodyText);
  if (
    (status === 400 || status === 413) &&
    (envelope?.code === UPSTREAM_CONTEXT_OVERFLOW_CODE || envelope?.type === UPSTREAM_CONTEXT_OVERFLOW_CODE)
  ) {
    return "context_overflow";
  }
  if (status === 402 || (envelope?.code !== undefined && UPSTREAM_BILLING_CODES.has(envelope.code))) {
    return "billing";
  }
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403 || (envelope?.code !== undefined && UPSTREAM_AUTH_CODES.has(envelope.code))) {
    return "authentication";
  }
  if (status === 400 && (envelope?.type === UPSTREAM_INVALID_REQUEST || envelope?.code === UPSTREAM_INVALID_REQUEST)) {
    return "invalid_request";
  }
  return undefined;
}

/** The fixed client-facing rejection for one confirmed class; the upstream body never crosses. */
function classifiedRejection(kind: UpstreamErrorClass, upstreamStatus: number, retryAfter?: string): UpstreamRejection {
  switch (kind) {
    case "context_overflow":
      return {
        code: UPSTREAM_CONTEXT_OVERFLOW_CODE,
        message: "The request exceeds the model context window",
        status: 400,
        upstreamStatus,
      };
    case "billing":
      return {
        code: "billing_error",
        message: "The model upstream reports a billing or quota limit",
        status: 402,
        upstreamStatus,
      };
    case "rate_limit":
      return {
        code: UPSTREAM_RATE_LIMIT_CODE,
        message: "The model upstream rate limit was reached",
        status: 429,
        upstreamStatus,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      };
    case "authentication":
      return {
        code: "authentication_error",
        message: "The model upstream rejected the platform model access credential",
        status: upstreamStatus === 401 || upstreamStatus === 403 ? upstreamStatus : 403,
        upstreamStatus,
      };
    case "invalid_request":
      return {
        code: UPSTREAM_INVALID_REQUEST,
        message: "The model upstream rejected the request as permanently invalid",
        status: 400,
        upstreamStatus,
      };
  }
}

/** Reject non-2xx responses (classified safely) and unusable 2xx shapes. */
async function rejectUnusableUpstream(
  upstream: Response,
  body: z.infer<typeof CloudModelRequestSchema>,
  maxResponseBytes: number,
): Promise<UpstreamRejection | undefined> {
  if (upstream.status < 200 || upstream.status >= 300) {
    // Read the bounded error body for classification; the reader releases the socket either way.
    // Preserve the upstream status class for retry semantics, but never its body or headers: a
    // broken upstream may echo the platform key in either.
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    const classified = classifyUpstreamError(
      upstream.status,
      await readBoundedResponseText(upstream, UPSTREAM_ERROR_BODY_MAX_BYTES),
    );
    if (classified)
      return classifiedRejection(
        classified,
        upstream.status,
        cloudModelRetryAfter(upstream.headers.get("retry-after")),
      );
    return {
      code: "CLOUD_MODEL_UPSTREAM_ERROR",
      message: "The model upstream rejected the request",
      status,
      upstreamStatus: upstream.status,
    };
  }
  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const declaredLength = declaredContentLength(upstream);
  const oversized = declaredLength !== undefined && declaredLength > maxResponseBytes;
  if (oversized || !isSupportedUpstreamContentType(contentType, body.stream === true)) {
    await discardUpstreamBody(upstream);
    return {
      code: "CLOUD_MODEL_UPSTREAM_INVALID",
      message: "The model upstream returned an unsupported response",
      status: 502,
    };
  }
  return undefined;
}

/**
 * Only the two model response shapes are relayed. A stream request must receive SSE — a JSON 200
 * there would look like a successful empty answer to an SSE parser — while a non-stream request
 * accepts either the JSON answer or an upstream that streamed anyway (which fails visibly in the
 * caller's JSON parser rather than looking complete).
 */
function isSupportedUpstreamContentType(contentType: string, expectsSse: boolean): boolean {
  if (contentType.startsWith(SSE_CONTENT_TYPE)) return true;
  if (!contentType.startsWith(JSON_CONTENT_TYPE)) return false;
  return !expectsSse;
}

function upstreamUnavailableRejection(signal: AbortSignal, timedOut: () => boolean): UpstreamRejection {
  if (timedOut()) {
    return { status: 504, code: "CLOUD_MODEL_UPSTREAM_TIMEOUT", message: "The model upstream did not respond in time" };
  }
  if (signal.aborted) {
    return { status: 401, code: "CLOUD_MODEL_TOKEN_INVALID", message: "The model call permission was revoked" };
  }
  return { status: 502, code: "CLOUD_MODEL_UPSTREAM_UNAVAILABLE", message: "The model upstream could not be reached" };
}

function finalizeUpstreamUnavailable(
  reply: FastifyReply,
  signal: AbortSignal,
  timedOut: () => boolean,
): FastifyReply | Promise<FastifyReply> {
  const rejection = upstreamUnavailableRejection(signal, timedOut);
  return fail(reply, rejection.status, rejection.code, rejection.message);
}

function finalizePipedOutcome(
  reply: FastifyReply,
  outcome: PipelineOutcome,
  signal: AbortSignal,
  timedOut: () => boolean,
): FastifyReply | Promise<FastifyReply> {
  if (outcome !== "not_started") return reply;
  if (isResponseClosed(reply)) return reply;
  if (timedOut()) {
    return fail(reply, 504, "CLOUD_MODEL_UPSTREAM_TIMEOUT", "The model upstream did not respond in time");
  }
  if (signal.aborted) {
    return fail(reply, 401, "CLOUD_MODEL_TOKEN_INVALID", "The model call permission was revoked");
  }
  return fail(reply, 502, "CLOUD_MODEL_UPSTREAM_INVALID", "The model upstream ended without a complete response");
}

function billingFailure(error: unknown): UpstreamRejection | undefined {
  if (!(error instanceof Error)) return undefined;
  if ("code" in error && error.code === "usage_pending")
    return { status: 503, code: "usage_pending", message: "Cloud usage is awaiting settlement" };
  const status = "statusCode" in error ? error.statusCode : undefined;
  if (status === 402) return { status, code: "insufficient_credit", message: "Cloud credit is exhausted" };
  if (status === 429) return { status, code: "rate_limit_exceeded", message: "Too many concurrent cloud calls" };
  if (status === 403) return { status, code: "authentication_error", message: "Cloud credit requires payment review" };
  return undefined;
}

type ModelAttempt = { ok: true; upstream: Response } | { ok: false; upstream?: Response; rejection: UpstreamRejection };

async function requestModelAttempt(
  options: CloudModelProxyRouteOptions,
  claims: GrantClaims,
  body: z.infer<typeof CloudModelRequestSchema>,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<ModelAttempt> {
  let upstream: Response | undefined;
  try {
    upstream = await callUpstream(options, claims.model, body, signal, claims);
    if (upstream) upstream = await normalizeInitialModelStream(upstream);
  } catch (error) {
    // An accepted stream's missing outcome does not prove that replay is safe.
    if (upstream && (!signal.aborted || timedOut())) {
      return {
        ok: false,
        rejection: {
          status: 400,
          code: "CLOUD_MODEL_UPSTREAM_UNCERTAIN",
          message: "The model upstream stream failed with an uncertain outcome",
        },
      };
    }
    return { ok: false, rejection: billingFailure(error) ?? upstreamUnavailableRejection(signal, timedOut) };
  }
  if (!upstream) return { ok: false, rejection: upstreamUnavailableRejection(signal, timedOut) };
  const rejection = await rejectUnusableUpstream(upstream, body, options.config.maxResponseBytes);
  return rejection ? { ok: false, upstream, rejection } : { ok: true, upstream };
}

/** Own the single retry budget; every ambiguous failure and exhausted response is terminal. */
async function forwardChatCompletions(
  options: CloudModelProxyRouteOptions,
  reply: FastifyReply,
  claims: GrantClaims,
  body: z.infer<typeof CloudModelRequestSchema>,
  signal: AbortSignal,
  timedOut: () => boolean,
  proxyOwnsRetry: boolean,
): Promise<FastifyReply> {
  for (let retries = 0; ; retries += 1) {
    if (signal.aborted) return finalizeUpstreamUnavailable(reply, signal, timedOut);
    const attempt = await requestModelAttempt(options, claims, body, signal, timedOut);
    if (attempt.ok) {
      const outcome = await pipeUpstreamBody(reply, attempt.upstream, options, signal);
      return finalizePipedOutcome(reply, outcome, signal, timedOut);
    }
    const { upstream, rejection } = attempt;
    const delayMs =
      proxyOwnsRetry && upstream?.status === 429 && rejection.code === UPSTREAM_RATE_LIMIT_CODE
        ? cloudModelRetryDelay(rejection.retryAfter, retries)
        : undefined;
    if (rejection.code === UPSTREAM_RATE_LIMIT_CODE) {
      reply.log.info(
        { code: "CLOUD_MODEL_RATE_LIMIT", attempt: retries + 1, retryDelayMs: delayMs, proxyOwnsRetry },
        "Cloud model request rate limited",
      );
    }
    if (delayMs === undefined) {
      return fail(
        reply,
        rejection.status,
        rejection.code,
        rejection.message,
        rejection.upstreamStatus,
        rejection.retryAfter,
      );
    }
    if (!(await waitForCloudModelRetry(delayMs, signal))) return finalizeUpstreamUnavailable(reply, signal, timedOut);
  }
}

export function registerCloudModelProxyRoutes(app: FastifyInstance, options: CloudModelProxyRouteOptions): void {
  const active = new Set<AbortController>();

  /*
   * `preClose` runs before Fastify waits for open requests. Aborting here tears down hijacked
   * upstream streams (and the grant service) so a long model answer cannot keep server close
   * pending; `onClose` alone would run after that wait.
   */
  app.addHook("preClose", async () => {
    for (const controller of [...active]) controller.abort(new Error("cloud_model_server_shutdown"));
    options.grants.close();
    await options.modelService.close();
  });

  app.post(CLOUD_MODEL_CHAT_COMPLETIONS_PATH, { bodyLimit: options.config.maxRequestBytes }, async (request, reply) => {
    const authorized = await authorize(request, reply, options);
    if (!authorized) return reply;
    const admission = options.grants.beginRequest(authorized.claims.jti);
    if (!admission) {
      return fail(reply, 429, "CLOUD_MODEL_STREAMS_EXHAUSTED", "The token has too many in-flight requests");
    }
    const controller = new AbortController();
    active.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("cloud_model_upstream_timeout"));
    }, options.config.requestTimeoutMs);
    timer.unref?.();
    const onResponseClose = (): void => {
      if (!reply.raw.writableFinished) controller.abort(new Error("cloud_model_client_disconnected"));
    };
    const onResponseError = (): void => {
      controller.abort(new Error("cloud_model_response_error"));
    };
    reply.raw.once("close", onResponseClose);
    reply.raw.on("error", onResponseError);
    const signal = AbortSignal.any([admission.signal, controller.signal]);
    try {
      return await forwardChatCompletions(
        options,
        reply,
        authorized.claims,
        authorized.body,
        signal,
        () => timedOut,
        request.headers["x-opentag-model-retry-owner"] === "proxy",
      );
    } finally {
      clearTimeout(timer);
      // Keep the error listener: a hijacked response can emit a late socket error after the
      // handler settles, and an unhandled 'error' event would crash the process.
      reply.raw.off("close", onResponseClose);
      active.delete(controller);
      admission.release();
    }
  });
}
