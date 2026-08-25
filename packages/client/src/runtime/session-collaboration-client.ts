import { randomUUID } from "node:crypto";
import {
  type InternalSessionCreateRequest,
  InternalSessionCreateRequestSchema,
  RUNTIME_CAPABILITY,
  type SessionCollaborationCommandResult,
  type SessionMessageDeliveryResult,
  type SessionMessageSendRequest,
  SessionMessageSendRequestSchema,
} from "@opentag/shared";
import type {
  AgentHostedToolCall,
  AgentHostedToolResult,
  AgentHostedTools,
  JsonValue,
} from "../agent-runtime/types.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import type { SessionMessageInbox } from "./session-message-inbox.js";

interface SourceSessionBinding {
  agentId: string;
  sessionId: string;
  placementGeneration: number;
  sessionKind: "visible" | "internal";
}

interface PendingCommand {
  messageId: string;
  resolve(result: AgentVisibleCollaborationResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentVisibleCollaborationResult {
  status: "accepted" | "unreachable" | "unknown" | "rejected";
  messageId: string;
  sessionId?: string;
  code?: string;
}

export interface SessionCollaborationClientOptions {
  connection: Pick<RuntimeConnection, "send" | "supportsCapability">;
  inbox: Pick<SessionMessageInbox, "accept">;
  requestTimeoutMs?: number;
}

export class SessionCollaborationClient {
  readonly #connection: SessionCollaborationClientOptions["connection"];
  readonly #inbox: SessionCollaborationClientOptions["inbox"];
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingCommand>();
  #closed = false;

  constructor(options: SessionCollaborationClientOptions) {
    this.#connection = options.connection;
    this.#inbox = options.inbox;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be a positive safe integer");
    }
  }

  hostedToolsForSession(binding: SourceSessionBinding): AgentHostedTools | undefined {
    if (!this.#connection.supportsCapability(RUNTIME_CAPABILITY.sessionCollaboration)) return undefined;
    return {
      definitions: [
        {
          name: "create_internal_session",
          description:
            "Create a reusable internal Session for parallel or context-isolated delegated work. Simple work does not need a child Session. accepted means queued, not completed. After unknown or unreachable, retry with the returned messageId and the exact same initialMessage and overrides.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["initialMessage"],
            properties: {
              initialMessage: { type: "string", minLength: 1, maxLength: 16384 },
              messageId: { type: "string", format: "uuid" },
              overrides: {
                type: "object",
                additionalProperties: false,
                properties: {
                  model: { type: "string", minLength: 1, maxLength: 128 },
                  reasoningEffort: { type: "string", minLength: 1, maxLength: 64 },
                  maxDurationMs: { type: "integer", minimum: 1, maximum: 86400000 },
                },
              },
            },
          },
        },
        {
          name: "send_session_message",
          description:
            "Send progress, results, questions, or follow-up instructions to another active Session in the same collaboration scope. accepted means queued for later processing. After unknown or unreachable, retry with the returned messageId and the exact same targetSessionId and message.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["targetSessionId", "message"],
            properties: {
              targetSessionId: { type: "string", format: "uuid" },
              message: { type: "string", minLength: 1, maxLength: 16384 },
              messageId: { type: "string", format: "uuid" },
            },
          },
        },
      ],
      handler: (call) => this.#handleTool(binding, call),
    };
  }

  async handleCommandResult(result: SessionCollaborationCommandResult): Promise<void> {
    const pending = this.#pending.get(result.requestId);
    if (!pending || pending.messageId !== result.messageId) return;
    if (result.status === "local" && result.delivery) {
      let deliveryResult: SessionMessageDeliveryResult;
      try {
        const accepted = this.#inbox.accept(result.delivery);
        deliveryResult = {
          type: "session:message:deliver:result",
          requestId: result.delivery.requestId,
          messageId: result.messageId,
          targetSessionId: result.delivery.targetSessionId,
          placementGeneration: result.delivery.placementGeneration,
          status: accepted.status,
          ...(accepted.reason ? { reason: accepted.reason } : {}),
        };
      } catch {
        deliveryResult = {
          type: "session:message:deliver:result",
          requestId: result.delivery.requestId,
          messageId: result.messageId,
          targetSessionId: result.delivery.targetSessionId,
          placementGeneration: result.delivery.placementGeneration,
          status: "rejected",
          reason: "invalid_input",
        };
      }
      await this.#connection.send(deliveryResult, { priority: "result" }).catch(() => {
        this.#settle(result.requestId, {
          status: "unknown",
          messageId: result.messageId,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          code: "connection_lost",
        });
      });
      return;
    }
    this.#settle(result.requestId, {
      status: result.status === "local" ? "rejected" : result.status,
      messageId: result.messageId,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.code ? { code: result.code } : {}),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [requestId, pending] of this.#pending) {
      this.#settle(requestId, {
        status: "unknown",
        messageId: pending.messageId,
        code: "connection_lost",
      });
    }
  }

  async #handleTool(binding: SourceSessionBinding, call: AgentHostedToolCall): Promise<AgentHostedToolResult> {
    if (!this.#connection.supportsCapability(RUNTIME_CAPABILITY.sessionCollaboration)) {
      return toolResult({ status: "rejected", messageId: randomUUID(), code: "configuration_unsupported" });
    }
    try {
      const input = record(call.input);
      if (!input) throw new Error("Tool input must be an object");
      if (call.name === "create_internal_session") {
        const initialMessage = stringValue(input.initialMessage);
        const overrides = optionalRecord(input.overrides);
        const request = InternalSessionCreateRequestSchema.parse({
          type: "session:internal:create",
          requestId: randomUUID(),
          sourceSessionId: binding.sessionId,
          sourcePlacementGeneration: binding.placementGeneration,
          initialMessage: {
            messageId: input.messageId === undefined ? randomUUID() : stringValue(input.messageId),
            text: initialMessage,
          },
          ...(overrides
            ? {
                overrides: {
                  ...(overrides.model !== undefined ? { model: stringValue(overrides.model) } : {}),
                  ...(overrides.reasoningEffort !== undefined
                    ? { reasoningEffort: stringValue(overrides.reasoningEffort) }
                    : {}),
                  ...(overrides.maxDurationMs !== undefined
                    ? { maxDurationMs: numberValue(overrides.maxDurationMs) }
                    : {}),
                },
              }
            : {}),
        });
        return toolResult(await this.#command(request));
      }
      if (call.name === "send_session_message") {
        const request: SessionMessageSendRequest = SessionMessageSendRequestSchema.parse({
          type: "session:message",
          requestId: randomUUID(),
          messageId: input.messageId === undefined ? randomUUID() : stringValue(input.messageId),
          sourceSessionId: binding.sessionId,
          sourcePlacementGeneration: binding.placementGeneration,
          targetSessionId: stringValue(input.targetSessionId),
          content: { kind: "text", text: stringValue(input.message) },
        });
        return toolResult(await this.#command(request));
      }
      throw new Error("Unknown hosted tool");
    } catch (error) {
      return {
        success: false,
        content: [],
        error: { code: "invalid_input", message: error instanceof Error ? error.message : "Tool input is invalid" },
      };
    }
  }

  #command(
    request: InternalSessionCreateRequest | SessionMessageSendRequest,
  ): Promise<AgentVisibleCollaborationResult> {
    if (this.#closed) {
      return Promise.resolve({ status: "unreachable", messageId: messageId(request), code: "runtime_unavailable" });
    }
    const id = request.requestId;
    const logicalMessageId = messageId(request);
    return new Promise<AgentVisibleCollaborationResult>((resolve) => {
      const timer = setTimeout(
        () => this.#settle(id, { status: "unknown", messageId: logicalMessageId, code: "delivery_timeout" }),
        this.#requestTimeoutMs,
      );
      timer.unref();
      this.#pending.set(id, { messageId: logicalMessageId, resolve, timer });
      void this.#connection.send(request, { priority: "result" }).catch(() => {
        this.#settle(id, { status: "unreachable", messageId: logicalMessageId, code: "runtime_unavailable" });
      });
    });
  }

  #settle(requestId: string, result: AgentVisibleCollaborationResult): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
}

function toolResult(result: AgentVisibleCollaborationResult): AgentHostedToolResult {
  return { success: true, content: [{ type: "text", text: JSON.stringify(result) }] };
}

function messageId(request: { type: string; messageId?: string; initialMessage?: { messageId: string } }): string {
  return request.type === "session:internal:create"
    ? (request.initialMessage?.messageId ?? "")
    : (request.messageId ?? "");
}

function record(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function optionalRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined;
  const parsed = record(value);
  if (!parsed) throw new Error("overrides must be an object");
  return parsed;
}

function stringValue(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("Expected a string value");
  return value;
}

function numberValue(value: JsonValue | undefined): number {
  if (typeof value !== "number") throw new Error("Expected a number value");
  return value;
}
