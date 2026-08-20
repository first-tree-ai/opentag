import { createHash, randomUUID } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  OPENTAG_MESSAGE_TOOLS,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  type RuntimeImToolRequest,
  type RuntimeImToolResult,
  RuntimeImToolResultSchema,
} from "@opentag/shared";
import type {
  AgentHostedToolCall,
  AgentHostedToolDefinition,
  AgentHostedToolResult,
  AgentHostedTools,
} from "../agent-runtime/types.js";
import type { RuntimeConnection } from "./runtime-connection.js";

const TOOL_TIMEOUT_MS = 60_000;
const RETRYABLE_UNKNOWN_LIMIT = 64;
const OPENTAG_TOOL_SET: ReadonlySet<string> = new Set(OPENTAG_MESSAGE_TOOLS);

interface PendingTool {
  definiteResult: boolean;
  hash: string;
  promise: Promise<RuntimeImToolResult>;
  reject(error: Error): void;
  resolve(result: RuntimeImToolResult): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
  readonly allowedTools: ReadonlySet<string>;
  readonly calls: Map<string, { readonly hash: string; readonly promise: Promise<AgentHostedToolResult> }>;
  readonly delivery: DirectImMessageDeliveryRequest;
  readonly retryableUnknown: Map<string, string>;
}

interface BuiltToolRequest {
  readonly request: RuntimeImToolRequest;
  readonly retryRequested: boolean;
}

class RuntimeToolRequestError extends Error {
  constructor(
    readonly state: "deterministic_failed" | "unknown",
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeToolRequestError";
  }
}

export class RuntimeToolHost {
  readonly #connection: Pick<RuntimeConnection, "send" | "subscribeBusinessFrames">;
  readonly #pending = new Map<string, PendingTool>();
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #unsubscribe: () => void;

  constructor(connection: Pick<RuntimeConnection, "send" | "subscribeBusinessFrames">) {
    this.#connection = connection;
    this.#unsubscribe = connection.subscribeBusinessFrames((frame) => this.#handleResult(frame));
  }

  hostedTools(allowedTools: readonly string[]): AgentHostedTools {
    return {
      definitions: openTagHostedToolDefinitions(allowedTools),
      handler: (call) => this.execute(call),
    };
  }

  activateRun(runId: string, delivery: DirectImMessageDeliveryRequest, allowedTools: readonly string[]): () => void {
    if (this.#activeRuns.has(runId)) throw new Error("OpenTag runtime tool run is already active");
    const allowed = new Set(allowedTools);
    if (allowed.size !== allowedTools.length || [...allowed].some((name) => !OPENTAG_TOOL_SET.has(name))) {
      throw new Error("OpenTag runtime tool allow-list is invalid");
    }
    const active: ActiveRun = { allowedTools: allowed, calls: new Map(), delivery, retryableUnknown: new Map() };
    this.#activeRuns.set(runId, active);
    return () => {
      if (this.#activeRuns.get(runId) === active) this.#activeRuns.delete(runId);
    };
  }

  async execute(call: AgentHostedToolCall): Promise<AgentHostedToolResult> {
    const active = this.#activeRuns.get(call.runId);
    if (!active?.allowedTools.has(call.name)) {
      return failedToolResult("tool_not_authorized", "OpenTag rejected a tool outside the active Run allow-list.");
    }
    const hash = requestHash({ name: call.name, input: call.input });
    const existing = active.calls.get(call.toolCallId);
    if (existing) {
      if (existing.hash !== hash) {
        return failedToolResult("tool_call_conflict", "OpenTag rejected conflicting reuse of a tool call ID.");
      }
      return existing.promise;
    }
    const promise = this.#executeActive(active, call);
    active.calls.set(call.toolCallId, { hash, promise });
    return promise;
  }

  close(): void {
    this.#unsubscribe();
    this.#activeRuns.clear();
    const error = new RuntimeToolRequestError(
      "unknown",
      "tool_host_closed",
      "OpenTag runtime tool host stopped before the Server result arrived",
    );
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#pending.clear();
  }

  async #executeActive(active: ActiveRun, call: AgentHostedToolCall): Promise<AgentHostedToolResult> {
    let built: BuiltToolRequest | undefined;
    let intentHash: string | undefined;
    try {
      built = buildToolRequest(active.delivery, call);
      intentHash = requestHash(built.request);
      if (built.retryRequested) assertRetryableUnknown(active, built.request.requestId, intentHash);
      const result = await this.#request(active, built.request, intentHash, call.signal);
      const text = JSON.stringify({
        requestId: result.requestId,
        state: result.state,
        ...(result.code ? { code: result.code } : {}),
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
        ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      });
      return result.state === "succeeded"
        ? { success: true, content: [{ type: "text", text }] }
        : {
            success: false,
            content: [{ type: "text", text }],
            error: { code: result.code ?? result.state, message: "OpenTag message operation did not succeed." },
          };
    } catch (error) {
      if (built && error instanceof RuntimeToolRequestError) {
        return failedRequestResult(built.request.requestId, error.state, error.code, error.message);
      }
      return failedToolResult(
        call.signal.aborted ? "tool_call_cancelled" : "tool_call_failed",
        error instanceof Error ? error.message : "OpenTag runtime tool call failed.",
      );
    }
  }

  async #request(
    active: ActiveRun,
    request: RuntimeImToolRequest,
    hash: string,
    signal: AbortSignal,
  ): Promise<RuntimeImToolResult> {
    if (signal.aborted) {
      throw new RuntimeToolRequestError(
        "deterministic_failed",
        "tool_call_cancelled",
        "OpenTag runtime tool call was aborted before dispatch",
      );
    }
    const existing = this.#pending.get(request.requestId);
    if (existing) {
      /* v8 ignore next 7 -- supplied retry IDs are hash-checked against the Run ledger before this method; only an unforgeable randomUUID collision can reach this defense. */
      if (existing.hash !== hash) {
        throw new RuntimeToolRequestError(
          "deterministic_failed",
          "request_id_conflict",
          "OpenTag runtime tool request ID conflicts with another intent",
        );
      }
      return withCallerAbort(existing.promise, signal, () => {
        if (existing.definiteResult) return false;
        rememberRetryableUnknown(active, request.requestId, hash);
        return true;
      });
    }
    let resolveResult!: (result: RuntimeImToolResult) => void;
    let rejectResult!: (error: Error) => void;
    const promise = new Promise<RuntimeImToolResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let pending!: PendingTool;
    const timer = setTimeout(
      () =>
        pending.reject(
          new RuntimeToolRequestError(
            "unknown",
            "tool_result_timeout",
            "OpenTag runtime tool result timed out after dispatch",
          ),
        ),
      TOOL_TIMEOUT_MS,
    );
    timer.unref();
    pending = {
      definiteResult: false,
      hash,
      promise,
      timer,
      resolve: (result) => {
        if (result.state === "unknown") {
          if (!pending.definiteResult) rememberRetryableUnknown(active, request.requestId, hash);
        } else {
          pending.definiteResult = true;
          active.retryableUnknown.delete(request.requestId);
        }
        resolveResult(result);
      },
      reject: (error) => {
        if (error instanceof RuntimeToolRequestError && error.state === "unknown") {
          if (!pending.definiteResult) rememberRetryableUnknown(active, request.requestId, hash);
        }
        rejectResult(error);
      },
    };
    this.#pending.set(request.requestId, pending);
    const cleanup = () => {
      if (this.#pending.get(request.requestId) !== pending) return;
      clearTimeout(timer);
      this.#pending.delete(request.requestId);
    };
    void promise.then(cleanup, cleanup);
    void (async () => this.#connection.send(request, { priority: "result" }))().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "Runtime send failed";
      pending.reject(new RuntimeToolRequestError("unknown", "runtime_send_failed", detail));
    });
    return withCallerAbort(promise, signal, () => {
      if (pending.definiteResult) return false;
      rememberRetryableUnknown(active, request.requestId, hash);
      return true;
    });
  }

  #handleResult(input: unknown): void {
    const parsed = RuntimeImToolResultSchema.safeParse(input);
    if (!parsed.success) return;
    this.#pending.get(parsed.data.requestId)?.resolve(parsed.data);
  }
}

export function openTagHostedToolDefinitions(allowedTools: readonly string[]): readonly AgentHostedToolDefinition[] {
  const requested = new Set(allowedTools);
  if (requested.size !== allowedTools.length || [...requested].some((name) => !OPENTAG_TOOL_SET.has(name))) {
    throw new Error("OpenTag runtime tool allow-list is invalid");
  }
  return OPENTAG_MESSAGE_TOOLS.filter((name) => requested.has(name)).map((name) => toolDefinition(name));
}

function toolDefinition(name: (typeof OPENTAG_MESSAGE_TOOLS)[number]): AgentHostedToolDefinition {
  const retryRequestId = {
    type: "string",
    format: "uuid",
    description: "Only reuse the requestId returned by an unknown result when explicitly retrying the same payload.",
  } as const;
  if (name === "opentag_message_react") {
    return {
      name,
      description: "Add an emoji reaction to a visible OpenTag IM message.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          retryRequestId,
          targetImMessageId: { type: "string", format: "uuid" },
          emoji: { type: "string" },
        },
        required: ["targetImMessageId", "emoji"],
      },
    };
  }
  if (name === "opentag_message_reply") {
    return {
      name,
      description: "Reply to a visible OpenTag IM message in the current conversation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          retryRequestId,
          replyToImMessageId: { type: "string", format: "uuid" },
          text: { type: "string" },
        },
        required: ["replyToImMessageId", "text"],
      },
    };
  }
  return {
    name,
    description: "Send a new message to the current OpenTag IM conversation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { retryRequestId, text: { type: "string" } },
      required: ["text"],
    },
  };
}

function failedToolResult(code: string, message: string): AgentHostedToolResult {
  return { success: false, content: [{ type: "text", text: message }], error: { code, message } };
}

function failedRequestResult(
  requestId: string,
  state: "deterministic_failed" | "unknown",
  code: string,
  message: string,
): AgentHostedToolResult {
  return {
    success: false,
    content: [{ type: "text", text: JSON.stringify({ requestId, state, code }) }],
    error: { code, message },
  };
}

function requestHash(request: unknown): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function assertRetryableUnknown(active: ActiveRun, requestId: string, intentHash: string): void {
  const retryableHash = active.retryableUnknown.get(requestId);
  if (!retryableHash) {
    throw new RuntimeToolRequestError(
      "deterministic_failed",
      "retry_request_not_unknown",
      "OpenTag rejected a retry request ID that is not retryable in the active Run",
    );
  }
  if (retryableHash !== intentHash) {
    throw new RuntimeToolRequestError(
      "deterministic_failed",
      "request_id_conflict",
      "OpenTag runtime tool request ID conflicts with the original unknown intent",
    );
  }
}

function rememberRetryableUnknown(active: ActiveRun, requestId: string, intentHash: string): void {
  active.retryableUnknown.delete(requestId);
  active.retryableUnknown.set(requestId, intentHash);
  if (active.retryableUnknown.size <= RETRYABLE_UNKNOWN_LIMIT) return;
  const oldestRequestId = active.retryableUnknown.keys().next().value as string;
  active.retryableUnknown.delete(oldestRequestId);
}

function withCallerAbort<T>(promise: Promise<T>, signal: AbortSignal, shouldAbort: () => boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!shouldAbort()) return;
      reject(
        new RuntimeToolRequestError(
          "unknown",
          "tool_call_cancelled",
          "OpenTag runtime tool call was aborted after dispatch",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function buildToolRequest(delivery: DirectImMessageDeliveryRequest, call: AgentHostedToolCall): BuiltToolRequest {
  const input = requireRecord(call.input);
  if (call.name === "opentag_message_send") {
    requireOnlyKeys(input, ["retryRequestId", "text"]);
    const text = requireText(input.text);
    const retryRequestId = input.retryRequestId;
    return {
      request: { ...toolRequestBase(delivery, retryRequestId), operation: "send", text },
      retryRequested: retryRequestId !== undefined,
    };
  }
  if (call.name === "opentag_message_reply") {
    requireOnlyKeys(input, ["replyToImMessageId", "retryRequestId", "text"]);
    const text = requireText(input.text);
    const replyToImMessageId = requireUuid(input.replyToImMessageId);
    const retryRequestId = input.retryRequestId;
    return {
      request: {
        ...toolRequestBase(delivery, retryRequestId),
        operation: "reply",
        text,
        replyToImMessageId,
      },
      retryRequested: retryRequestId !== undefined,
    };
  }
  requireOnlyKeys(input, ["emoji", "retryRequestId", "targetImMessageId"]);
  const targetImMessageId = requireUuid(input.targetImMessageId);
  const emoji = requireString(input.emoji, 128);
  const retryRequestId = input.retryRequestId;
  return {
    request: {
      ...toolRequestBase(delivery, retryRequestId),
      operation: "react",
      targetImMessageId,
      emoji,
    },
    retryRequested: retryRequestId !== undefined,
  };
}

function toolRequestBase(delivery: DirectImMessageDeliveryRequest, retryRequestId: unknown) {
  return {
    type: "im:tool" as const,
    requestId: retryRequestId === undefined ? randomUUID() : requireUuid(retryRequestId),
    sessionId: delivery.sessionId,
    agentId: delivery.agentId,
    placementGeneration: delivery.placementGeneration,
    expectedLatestImMessageId: delivery.imMessageId,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OpenTag runtime tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown): string {
  const text = requireString(value, RUNTIME_DIRECT_TEXT_MAX_BYTES);
  if (text.trim().length === 0) throw new Error("OpenTag message text cannot be empty");
  return text;
}

function requireOnlyKeys(input: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("OpenTag runtime tool arguments contain an unsupported field");
  }
}

function requireString(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("OpenTag runtime tool argument is invalid");
  }
  return value;
}

function requireUuid(value: unknown): string {
  const text = requireString(value, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error("OpenTag message ID is invalid");
  }
  return text;
}
