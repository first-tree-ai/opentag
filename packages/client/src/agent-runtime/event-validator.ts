import { createLogger } from "../observability/logger.js";
import { AgentProviderError } from "./errors.js";
import type { AgentProviderRunEvent, AgentProviderRunResult, AgentUsage } from "./types.js";
import { AGENT_RUNTIME_TEXT_MAX_BYTES } from "./types.js";
import { assertIdentifier, assertJsonValue } from "./validation.js";

interface ToolLifecycle {
  readonly name: string;
}

const TOOL_COMPLETION_STATUSES: ReadonlySet<unknown> = new Set(["completed", "failed", "declined"]);
const logger = createLogger("agent-runtime-event-validator");

/**
 * Validates the provider-neutral event grammar for one Run. Provider adapters
 * remain responsible only for translating their wire protocol into this grammar.
 * Model turns are optional because some providers do not expose that boundary.
 */
export class AgentRunEventValidator {
  readonly #activeMessages = new Set<string>();
  readonly #activeModelTurns = new Set<string>();
  readonly #activeTools = new Map<string, ToolLifecycle>();
  readonly #seenMessages = new Set<string>();
  readonly #seenModelTurns = new Set<string>();
  readonly #seenTools = new Set<string>();

  accept(event: AgentProviderRunEvent): void {
    try {
      this.#accept(event);
    } catch (error) {
      if (error instanceof AgentProviderError) throw error;
      logger.debug({ code: "event_validation_failed", error: String(error) }, "Provider event validation failed");
      throw protocolError(error instanceof Error ? error.message : "provider emitted an invalid event");
    }
  }

  assertSettled(result: AgentProviderRunResult): void {
    if (result.status !== "completed") return;
    if (this.#activeModelTurns.size > 0 || this.#activeMessages.size > 0 || this.#activeTools.size > 0) {
      throw protocolError("provider completed a run with unfinished event lifecycles");
    }
  }

  #accept(event: AgentProviderRunEvent): void {
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      throw protocolError("provider emitted an invalid event");
    }
    switch (event.type) {
      case "model_turn_started":
        this.#start(event.modelTurnId, "modelTurnId", this.#seenModelTurns, this.#activeModelTurns);
        return;
      case "model_turn_completed":
        this.#complete(event.modelTurnId, "modelTurnId", this.#activeModelTurns);
        return;
      case "message_started":
        this.#start(event.messageId, "messageId", this.#seenMessages, this.#activeMessages);
        return;
      case "message_delta":
        this.#requireActive(event.messageId, "messageId", this.#activeMessages);
        assertText(event.delta, "message delta");
        return;
      case "message_completed":
        this.#complete(event.messageId, "messageId", this.#activeMessages);
        assertText(event.text, "message text");
        return;
      case "tool_started":
        assertIdentifier(event.toolCallId, "toolCallId");
        assertIdentifier(event.name, "tool name");
        if (this.#seenTools.has(event.toolCallId)) throw protocolError("provider reused a toolCallId");
        if (event.input !== undefined) assertJsonValue(event.input, "tool input");
        this.#seenTools.add(event.toolCallId);
        this.#activeTools.set(event.toolCallId, { name: event.name });
        return;
      case "tool_updated":
        this.#requireTool(event.toolCallId);
        assertJsonValue(event.update, "tool update");
        return;
      case "tool_completed": {
        const tool = this.#requireTool(event.toolCallId);
        assertIdentifier(event.name, "tool name");
        if (tool.name !== event.name) throw protocolError("provider changed a tool name during its lifecycle");
        if (!TOOL_COMPLETION_STATUSES.has(event.status)) {
          throw protocolError("provider emitted an invalid tool completion status");
        }
        if (event.output !== undefined) assertJsonValue(event.output, "tool output");
        this.#activeTools.delete(event.toolCallId);
        return;
      }
      case "usage_updated":
        assertUsage(event.usage);
        return;
      case "provider_warning":
        assertIdentifier(event.code, "provider warning code");
        assertText(event.message, "provider warning message");
        return;
      case "provider_event":
        assertIdentifier(event.providerId, "provider event providerId");
        if (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1) {
          throw protocolError("provider event schemaVersion must be a positive safe integer");
        }
        assertJsonValue(event.payload, "provider event payload");
        return;
      default:
        throw protocolError("provider emitted an unknown event type");
    }
  }

  #start(id: string, field: string, seen: Set<string>, active: Set<string>): void {
    assertIdentifier(id, field);
    if (seen.has(id)) throw protocolError(`provider reused a ${field}`);
    seen.add(id);
    active.add(id);
  }

  #complete(id: string, field: string, active: Set<string>): void {
    this.#requireActive(id, field, active);
    active.delete(id);
  }

  #requireActive(id: string, field: string, active: Set<string>): void {
    assertIdentifier(id, field);
    if (!active.has(id)) throw protocolError(`provider referenced an inactive ${field}`);
  }

  #requireTool(toolCallId: string): ToolLifecycle {
    assertIdentifier(toolCallId, "toolCallId");
    const tool = this.#activeTools.get(toolCallId);
    if (!tool) throw protocolError("provider referenced an inactive toolCallId");
    return tool;
  }
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > AGENT_RUNTIME_TEXT_MAX_BYTES) {
    throw protocolError(`${field} must be bounded text`);
  }
}

function assertUsage(usage: AgentUsage): void {
  if (!usage || typeof usage !== "object") throw protocolError("provider usage must be an object");
  for (const value of [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw protocolError("provider usage must contain non-negative safe integers");
    }
  }
}

function protocolError(message: string): AgentProviderError {
  return new AgentProviderError("provider_protocol_error", message);
}
