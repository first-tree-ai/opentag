import { createHash } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  OPENTAG_MESSAGE_TOOLS,
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
const TOOL_TEXT_MAX_BYTES = 24 * 1024;
const OPENTAG_TOOL_SET: ReadonlySet<string> = new Set(OPENTAG_MESSAGE_TOOLS);

interface PendingTool {
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
    const active: ActiveRun = { allowedTools: allowed, calls: new Map(), delivery };
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
    const promise = this.#executeActive(active.delivery, call);
    active.calls.set(call.toolCallId, { hash, promise });
    return promise;
  }

  close(): void {
    this.#unsubscribe();
    this.#activeRuns.clear();
    const error = new Error("OpenTag runtime tool host stopped");
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#pending.clear();
  }

  async #executeActive(
    delivery: DirectImMessageDeliveryRequest,
    call: AgentHostedToolCall,
  ): Promise<AgentHostedToolResult> {
    try {
      const request = buildToolRequest(delivery, call);
      const result = await this.#request(request, call.signal);
      const text = JSON.stringify({
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
      return failedToolResult(
        call.signal.aborted ? "tool_call_cancelled" : "tool_call_failed",
        error instanceof Error ? error.message : "OpenTag runtime tool call failed.",
      );
    }
  }

  async #request(request: RuntimeImToolRequest, signal: AbortSignal): Promise<RuntimeImToolResult> {
    if (signal.aborted) throw new Error("OpenTag runtime tool call was aborted");
    const hash = requestHash(request);
    const existing = this.#pending.get(request.requestId);
    if (existing) {
      if (existing.hash !== hash) throw new Error("OpenTag runtime tool request ID conflicts with another intent");
      return withCallerAbort(existing.promise, signal);
    }
    let resolveResult!: (result: RuntimeImToolResult) => void;
    let rejectResult!: (error: Error) => void;
    const promise = new Promise<RuntimeImToolResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timer = setTimeout(() => rejectResult(new Error("OpenTag runtime tool call timed out")), TOOL_TIMEOUT_MS);
    timer.unref();
    const pending: PendingTool = {
      hash,
      promise,
      timer,
      resolve: resolveResult,
      reject: rejectResult,
    };
    this.#pending.set(request.requestId, pending);
    const cleanup = () => {
      if (this.#pending.get(request.requestId) !== pending) return;
      clearTimeout(timer);
      this.#pending.delete(request.requestId);
    };
    void promise.then(cleanup, cleanup);
    void (async () => this.#connection.send(request, { priority: "result" }))().catch((error: unknown) => {
      pending.reject(error instanceof Error ? error : new Error("Runtime send failed"));
    });
    return withCallerAbort(promise, signal);
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
  const requestId = {
    type: "string",
    format: "uuid",
    description: "Stable operation ID. Reuse it when retrying the same logical write.",
  } as const;
  if (name === "opentag_message_react") {
    return {
      name,
      description: "Add an emoji reaction to a visible OpenTag IM message.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          requestId,
          targetImMessageId: { type: "string", format: "uuid" },
          emoji: { type: "string" },
        },
        required: ["requestId", "targetImMessageId", "emoji"],
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
          requestId,
          replyToImMessageId: { type: "string", format: "uuid" },
          text: { type: "string" },
        },
        required: ["requestId", "replyToImMessageId", "text"],
      },
    };
  }
  return {
    name,
    description: "Send a new message to the current OpenTag IM conversation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { requestId, text: { type: "string" } },
      required: ["requestId", "text"],
    },
  };
}

function failedToolResult(code: string, message: string): AgentHostedToolResult {
  return { success: false, content: [{ type: "text", text: message }], error: { code, message } };
}

function requestHash(request: unknown): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function withCallerAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("OpenTag runtime tool call was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function buildToolRequest(delivery: DirectImMessageDeliveryRequest, call: AgentHostedToolCall): RuntimeImToolRequest {
  const input = requireRecord(call.input);
  const base = {
    type: "im:tool" as const,
    requestId: requireUuid(input.requestId),
    sessionId: delivery.sessionId,
    agentId: delivery.agentId,
    placementGeneration: delivery.placementGeneration,
    expectedLatestImMessageId: delivery.imMessageId,
  };
  if (call.name === "opentag_message_send") {
    return { ...base, operation: "send", text: requireText(input.text) };
  }
  if (call.name === "opentag_message_reply") {
    return {
      ...base,
      operation: "reply",
      text: requireText(input.text),
      replyToImMessageId: requireUuid(input.replyToImMessageId),
    };
  }
  return {
    ...base,
    operation: "react",
    targetImMessageId: requireUuid(input.targetImMessageId),
    emoji: requireString(input.emoji, 128),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OpenTag runtime tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown): string {
  const text = requireString(value, TOOL_TEXT_MAX_BYTES);
  if (text.trim().length === 0) throw new Error("OpenTag message text cannot be empty");
  return text;
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
