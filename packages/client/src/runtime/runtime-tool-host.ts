import { createHash } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  type RuntimeImToolRequest,
  type RuntimeImToolResult,
  RuntimeImToolResultSchema,
} from "@opentag/shared";
import type { CodexDynamicToolCall, CodexDynamicToolResult } from "../providers/codex/app-server-wire.js";
import type { RuntimeConnection } from "./runtime-connection.js";

const TOOL_TIMEOUT_MS = 60_000;
const TOOL_TEXT_MAX_BYTES = 24 * 1024;

interface PendingTool {
  hash: string;
  promise: Promise<RuntimeImToolResult>;
  reject(error: Error): void;
  resolve(result: RuntimeImToolResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RuntimeToolHost {
  readonly #connection: Pick<RuntimeConnection, "send" | "subscribeBusinessFrames">;
  readonly #pending = new Map<string, PendingTool>();
  readonly #unsubscribe: () => void;

  constructor(connection: Pick<RuntimeConnection, "send" | "subscribeBusinessFrames">) {
    this.#connection = connection;
    this.#unsubscribe = connection.subscribeBusinessFrames((frame) => this.#handleResult(frame));
  }

  async execute(
    delivery: DirectImMessageDeliveryRequest,
    call: CodexDynamicToolCall,
    signal?: AbortSignal,
  ): Promise<CodexDynamicToolResult> {
    const request = buildToolRequest(delivery, call);
    const result = await this.#request(request, signal);
    return {
      success: result.state === "succeeded",
      text: JSON.stringify({
        state: result.state,
        ...(result.code ? { code: result.code } : {}),
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
        ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      }),
    };
  }

  close(): void {
    this.#unsubscribe();
    const error = new Error("OpenTag runtime tool host stopped");
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#pending.clear();
  }

  async #request(request: RuntimeImToolRequest, signal?: AbortSignal): Promise<RuntimeImToolResult> {
    if (signal?.aborted) throw new Error("OpenTag runtime tool call was aborted");
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

function requestHash(request: RuntimeImToolRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("OpenTag runtime tool call was aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("OpenTag runtime tool call was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function buildToolRequest(delivery: DirectImMessageDeliveryRequest, call: CodexDynamicToolCall): RuntimeImToolRequest {
  const input = requireRecord(call.arguments);
  const base = {
    type: "im:tool" as const,
    requestId: requireUuid(input.requestId),
    sessionId: delivery.sessionId,
    agentId: delivery.agentId,
    placementGeneration: delivery.placementGeneration,
    expectedLatestImMessageId: delivery.imMessageId,
  };
  if (call.tool === "opentag_message_send") {
    return { ...base, operation: "send", text: requireText(input.text) };
  }
  if (call.tool === "opentag_message_reply") {
    return {
      ...base,
      operation: "reply",
      text: requireText(input.text),
      replyToImMessageId: requireUuid(input.replyToImMessageId),
    };
  }
  if (call.tool === "opentag_message_react") {
    return {
      ...base,
      operation: "react",
      targetImMessageId: requireUuid(input.targetImMessageId),
      emoji: requireString(input.emoji, 128),
    };
  }
  throw new Error("OpenTag rejected an unknown runtime tool");
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
