import type { ServerResponse } from "node:http";
import { CLOUD_MODEL_CHAT_COMPLETIONS_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CloudModelConfig } from "../cloud-model-config.js";
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

/**
 * Platform ceiling for one completion's output budget, above the image-pinned Pi custom-provider
 * default of 16,384. Values above it are clamped so an oversized budget need not fail the Turn;
 * when neither field is supplied, the proxy supplies the standard max_tokens limit itself.
 */
export const CLOUD_MODEL_MAX_OUTPUT_TOKENS = 65_536;

/** Chat history for one turn stays far below these bounds; the HTTP body byte cap bounds sizes. */
const MAX_MESSAGES_PER_REQUEST = 1_024;
const MAX_CONTENT_PARTS_PER_MESSAGE = 64;
const MAX_TOOLS_PER_REQUEST = 128;
const MAX_TOOL_CALLS_PER_MESSAGE = 128;
const MAX_REASONING_DETAILS_PER_MESSAGE = 128;
const MAX_REASONING_DETAIL_CHARS = 64 * 1_024;
const MAX_REASONING_DETAIL_FIELDS = 8;

/** Clamp an output budget to the fixed ceiling; absent stays absent. */
const outputTokenBudget = z
  .number()
  .int()
  .min(1)
  .optional()
  .transform((value) => (value === undefined ? undefined : Math.min(value, CLOUD_MODEL_MAX_OUTPUT_TOKENS)));

const textContentPart = z.object({ type: z.literal("text"), text: z.string() }).strict();
const imageContentPart = z
  .object({ type: z.literal("image_url"), image_url: z.object({ url: z.string().min(1) }).strict() })
  .strict();

const functionToolCall = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1).max(128), arguments: z.string() }).strict(),
  })
  .strict();

/**
 * One encrypted reasoning detail the pinned Pi re-emits: it JSON-parses each signed tool call's
 * `thoughtSignature` (an upstream `reasoning.encrypted` object) and writes the parsed object back
 * verbatim, so the opaque `id`/`data` and any provider metadata must round-trip unchanged. The
 * signed payload is preserved; the object stays bounded and only exists inside an assistant
 * message's `reasoning_details` — never at the request or message top level.
 */
const reasoningDetailScalar = z.union([
  z.string().max(MAX_REASONING_DETAIL_CHARS),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const encryptedReasoningDetail = z
  .object({
    type: z.literal("reasoning.encrypted"),
    id: z.string().min(1).max(512),
    data: z.string().min(1).max(MAX_REASONING_DETAIL_CHARS),
  })
  .catchall(reasoningDetailScalar)
  .refine((detail) => Object.keys(detail).length <= MAX_REASONING_DETAIL_FIELDS, {
    message: "too many reasoning detail fields",
  });

/**
 * The exact message shapes the pinned Pi's openai-completions conversion emits (system/user text,
 * assistant text-or-null with function tool calls, the upstream reasoning echo under whichever of
 * `reasoning_content`/`reasoning`/`reasoning_text` the provider streamed, encrypted
 * `reasoning_details` for signed tool calls, tool results, and text/image user content parts).
 * `developer` covers the OpenAI reasoning-model role.
 */
const chatMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("developer"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("user"),
      content: z.union([
        z.string(),
        z
          .array(z.union([textContentPart, imageContentPart]))
          .min(1)
          .max(MAX_CONTENT_PARTS_PER_MESSAGE),
      ]),
    })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string().nullable().optional(),
      tool_calls: z.array(functionToolCall).min(1).max(MAX_TOOL_CALLS_PER_MESSAGE).optional(),
      // Pi tracks whichever reasoning field the upstream streamed (`reasoning_content`,
      // `reasoning`, or `reasoning_text`) and echoes it under that same key on the next call.
      reasoning_content: z.string().optional(),
      reasoning: z.string().optional(),
      reasoning_text: z.string().optional(),
      // Signed tool-call thinking: the parsed `thoughtSignature` objects, verbatim.
      reasoning_details: z.array(encryptedReasoningDetail).min(1).max(MAX_REASONING_DETAILS_PER_MESSAGE).optional(),
    })
    .strict(),
  z.object({ role: z.literal("tool"), content: z.string(), tool_call_id: z.string().min(1).max(256) }).strict(),
]);

const chatTool = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1).max(128),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const chatToolChoice = z.union([
  z.enum(["none", "auto", "required"]),
  z
    .object({
      type: z.literal("function"),
      function: z.object({ name: z.string().min(1).max(128) }).strict(),
    })
    .strict(),
]);

/**
 * Strict request allowlist: exactly the fields the pinned Pi openai-completions path can emit for
 * the Sandbox's custom provider (model/messages/stream/stream_options/store/max_completion_tokens
 * or max_tokens/temperature/tools/tool_choice), the standard `top_p`/`n` knobs, and the bounded
 * DeepSeek reasoning fields (`thinking`, `reasoning_effort`, message-level `reasoning_content`).
 * Everything else — above all router/credential overrides — is rejected. `n` is bounded to a
 * single choice: Pi never sets it and `n > 1` would multiply completions on the master key.
 */
const ChatCompletionsBodySchema = z
  .object({
    model: z.string().min(1).max(128),
    messages: z.array(chatMessage).min(1).max(MAX_MESSAGES_PER_REQUEST),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
    store: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: outputTokenBudget,
    max_completion_tokens: outputTokenBudget,
    n: z.literal(1).optional(),
    tools: z.array(chatTool).max(MAX_TOOLS_PER_REQUEST).optional(),
    tool_choice: chatToolChoice.optional(),
    reasoning_effort: z.string().min(1).max(32).optional(),
    thinking: z
      .object({ type: z.enum(["enabled", "disabled"]) })
      .strict()
      .optional(),
  })
  .strict()
  .transform((body) => {
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
      return { ...body, max_tokens: CLOUD_MODEL_MAX_OUTPUT_TOKENS };
    }
    return body;
  });

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";
/** Matches the Runner wire bound for one model token. */
const MAX_TOKEN_CHARS = 4_096;

export interface CloudModelProxyRouteOptions {
  config: Extract<CloudModelConfig, { enabled: true }>;
  grants: CloudModelGrantService;
  fetchImpl?: typeof fetch;
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
): Promise<FastifyReply> {
  if (reply.raw.destroyed || reply.raw.writableEnded || reply.raw.headersSent) return reply;
  reply.header("cache-control", "no-store");
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
): Promise<{ claims: GrantClaims; body: z.infer<typeof ChatCompletionsBodySchema> } | undefined> {
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
  const parsed = ChatCompletionsBodySchema.safeParse(request.body);
  if (!parsed.success) {
    await fail(reply, 400, "CLOUD_MODEL_REQUEST_INVALID", "The chat completions request body is invalid");
    return undefined;
  }
  if (parsed.data.model !== claims.model) {
    await fail(reply, 403, "CLOUD_MODEL_MODEL_DENIED", "The token does not cover the requested model");
    return undefined;
  }
  return { claims, body: parsed.data };
}

/** Call the fixed upstream with the platform master key; bounded by timeout and revocation. */
async function callUpstream(
  options: CloudModelProxyRouteOptions,
  model: string,
  body: z.infer<typeof ChatCompletionsBodySchema>,
  signal: AbortSignal,
): Promise<Response | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await fetchImpl(`${options.config.upstreamBaseUrl}/chat/completions`, {
      body: JSON.stringify({ ...body, model }),
      headers: {
        accept: body.stream === true ? SSE_CONTENT_TYPE : JSON_CONTENT_TYPE,
        // Byte accounting and size caps apply to the bytes actually read, not a decompression ratio.
        "accept-encoding": "identity",
        authorization: `Bearer ${options.config.masterKey}`,
        "content-type": JSON_CONTENT_TYPE,
      },
      method: "POST",
      // A redirect from the fixed upstream must never steer the proxy to another origin.
      redirect: "error",
      signal,
    });
  } catch {
    return undefined;
  }
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
}

/** Reject non-2xx responses (upstream error bodies are never relayed) and unusable 2xx shapes. */
async function rejectUnusableUpstream(
  upstream: Response,
  body: z.infer<typeof ChatCompletionsBodySchema>,
  maxResponseBytes: number,
): Promise<UpstreamRejection | undefined> {
  if (upstream.status < 200 || upstream.status >= 300) {
    await discardUpstreamBody(upstream);
    // Preserve the upstream status class for retry semantics, but never its body or headers: a
    // broken upstream may echo the platform key in either.
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
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

function finalizeUpstreamUnavailable(
  reply: FastifyReply,
  signal: AbortSignal,
  timedOut: () => boolean,
): FastifyReply | Promise<FastifyReply> {
  if (isResponseClosed(reply)) return reply;
  if (timedOut()) {
    return fail(reply, 504, "CLOUD_MODEL_UPSTREAM_TIMEOUT", "The model upstream did not respond in time");
  }
  if (signal.aborted) {
    return fail(reply, 401, "CLOUD_MODEL_TOKEN_INVALID", "The model call permission was revoked");
  }
  return fail(reply, 502, "CLOUD_MODEL_UPSTREAM_UNAVAILABLE", "The model upstream could not be reached");
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

/** Forward one authorized request and finalize the client response in every path. */
async function forwardChatCompletions(
  options: CloudModelProxyRouteOptions,
  reply: FastifyReply,
  claims: GrantClaims,
  body: z.infer<typeof ChatCompletionsBodySchema>,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<FastifyReply> {
  const upstream = await callUpstream(options, claims.model, body, signal);
  if (!upstream) return finalizeUpstreamUnavailable(reply, signal, timedOut);
  const rejection = await rejectUnusableUpstream(upstream, body, options.config.maxResponseBytes);
  if (rejection) {
    if (isResponseClosed(reply)) return reply;
    return fail(reply, rejection.status, rejection.code, rejection.message, rejection.upstreamStatus);
  }
  const outcome = await pipeUpstreamBody(reply, upstream, options, signal);
  return finalizePipedOutcome(reply, outcome, signal, timedOut);
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
      return await forwardChatCompletions(options, reply, authorized.claims, authorized.body, signal, () => timedOut);
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
