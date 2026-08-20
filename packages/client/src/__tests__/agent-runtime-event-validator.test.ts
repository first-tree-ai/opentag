import { describe, expect, it } from "vitest";
import { AgentRunEventValidator } from "../agent-runtime/event-validator.js";
import { AGENT_RUNTIME_TEXT_MAX_BYTES, type AgentProviderRunEvent } from "../agent-runtime/types.js";

describe("AgentRunEventValidator", () => {
  it("accepts the complete provider-neutral grammar with optional model turns and parallel tools", () => {
    const validator = new AgentRunEventValidator();
    for (const event of [
      { type: "model_turn_started", modelTurnId: "turn-1" },
      { type: "message_started", messageId: "message-1" },
      { type: "message_delta", messageId: "message-1", delta: "" },
      { type: "message_completed", messageId: "message-1", text: "answer" },
      { type: "tool_started", toolCallId: "tool-1", name: "read", input: { path: "one" } },
      { type: "tool_started", toolCallId: "tool-2", name: "write" },
      { type: "tool_updated", toolCallId: "tool-2", update: { progress: 1 } },
      { type: "tool_completed", toolCallId: "tool-2", name: "write", status: "completed", output: null },
      { type: "tool_completed", toolCallId: "tool-1", name: "read", status: "completed" },
      { type: "usage_updated", usage: { inputTokens: 0, cachedInputTokens: 1, outputTokens: 2 } },
      { type: "usage_updated", usage: {} },
      { type: "provider_warning", code: "notice", message: "warning" },
      { type: "provider_event", providerId: "test", schemaVersion: 1, payload: { value: true } },
      { type: "model_turn_completed", modelTurnId: "turn-1" },
    ] satisfies AgentProviderRunEvent[]) {
      expect(() => validator.accept(event)).not.toThrow();
    }
    expect(() => validator.assertSettled({ status: "completed" })).not.toThrow();

    const withoutTurns = new AgentRunEventValidator();
    withoutTurns.accept({ type: "message_started", messageId: "message" });
    withoutTurns.accept({ type: "message_completed", messageId: "message", text: "done" });
    expect(() => withoutTurns.assertSettled({ status: "completed" })).not.toThrow();
  });

  it.each([
    [{ type: "model_turn_completed", modelTurnId: "missing" }],
    [
      { type: "model_turn_started", modelTurnId: "duplicate" },
      { type: "model_turn_started", modelTurnId: "duplicate" },
    ],
    [{ type: "message_delta", messageId: "missing", delta: "x" }],
    [{ type: "message_completed", messageId: "missing", text: "x" }],
    [
      { type: "message_started", messageId: "duplicate" },
      { type: "message_completed", messageId: "duplicate", text: "x" },
      { type: "message_started", messageId: "duplicate" },
    ],
    [{ type: "tool_updated", toolCallId: "missing", update: null }],
    [{ type: "tool_completed", toolCallId: "missing", name: "read", status: "completed" }],
    [
      { type: "tool_started", toolCallId: "duplicate", name: "read" },
      { type: "tool_completed", toolCallId: "duplicate", name: "read", status: "completed" },
      { type: "tool_started", toolCallId: "duplicate", name: "read" },
    ],
    [
      { type: "tool_started", toolCallId: "renamed", name: "read" },
      { type: "tool_completed", toolCallId: "renamed", name: "write", status: "completed" },
    ],
  ] as AgentProviderRunEvent[][])("rejects invalid lifecycle sequence %#", (...events: AgentProviderRunEvent[]) => {
    const validator = new AgentRunEventValidator();
    expect(() => {
      for (const event of events) validator.accept(event);
    }).toThrowError(expect.objectContaining({ code: "provider_protocol_error" }));
  });

  it.each([
    null,
    { type: "unknown" },
    { type: "model_turn_started", modelTurnId: "" },
    { type: "message_started", messageId: "" },
    { type: "tool_started", toolCallId: "tool", name: "", input: null },
    { type: "tool_started", toolCallId: "tool", name: "read", input: new Date() },
    { type: "usage_updated", usage: null },
    { type: "usage_updated", usage: { inputTokens: -1 } },
    { type: "usage_updated", usage: { outputTokens: 1.5 } },
    { type: "provider_warning", code: "", message: "warning" },
    { type: "provider_warning", code: "warning", message: "x".repeat(AGENT_RUNTIME_TEXT_MAX_BYTES + 1) },
    { type: "provider_event", providerId: "", schemaVersion: 1, payload: null },
    { type: "provider_event", providerId: "test", schemaVersion: 0, payload: null },
    { type: "provider_event", providerId: "test", schemaVersion: 1.5, payload: null },
    { type: "provider_event", providerId: "test", schemaVersion: 1, payload: new Map() },
  ])("rejects malformed event %#", (event) => {
    const validator = new AgentRunEventValidator();
    expect(() => validator.accept(event as AgentProviderRunEvent)).toThrowError(
      expect.objectContaining({ code: "provider_protocol_error" }),
    );
  });

  it("rejects oversized message content", () => {
    const validator = new AgentRunEventValidator();
    validator.accept({ type: "message_started", messageId: "message" });
    expect(() =>
      validator.accept({
        type: "message_delta",
        messageId: "message",
        delta: "x".repeat(AGENT_RUNTIME_TEXT_MAX_BYTES + 1),
      }),
    ).toThrowError(expect.objectContaining({ code: "provider_protocol_error" }));
  });

  it("rejects invalid tool update and output payloads", () => {
    const update = new AgentRunEventValidator();
    update.accept({ type: "tool_started", toolCallId: "tool", name: "read" });
    expect(() => update.accept({ type: "tool_updated", toolCallId: "tool", update: new Date() as never })).toThrow();

    const output = new AgentRunEventValidator();
    output.accept({ type: "tool_started", toolCallId: "tool", name: "read" });
    expect(() =>
      output.accept({
        type: "tool_completed",
        toolCallId: "tool",
        name: "read",
        status: "completed",
        output: new Date() as never,
      }),
    ).toThrow();
  });

  it("normalizes non-Error validation failures into protocol errors", () => {
    const event = new Proxy<AgentProviderRunEvent>(
      { type: "message_started", messageId: "message" },
      {
        get() {
          throw "invalid provider object";
        },
      },
    );
    expect(() => new AgentRunEventValidator().accept(event)).toThrowError(
      expect.objectContaining({ code: "provider_protocol_error", message: "provider emitted an invalid event" }),
    );
  });

  it("requires successful runs to close every lifecycle and lets failed or aborted runs truncate them", () => {
    for (const event of [
      { type: "model_turn_started", modelTurnId: "turn" },
      { type: "message_started", messageId: "message" },
      { type: "tool_started", toolCallId: "tool", name: "read" },
    ] satisfies AgentProviderRunEvent[]) {
      const validator = new AgentRunEventValidator();
      validator.accept(event);
      expect(() => validator.assertSettled({ status: "completed" })).toThrowError(
        expect.objectContaining({ code: "provider_protocol_error" }),
      );
      expect(() => validator.assertSettled({ status: "failed" })).not.toThrow();
      expect(() => validator.assertSettled({ status: "aborted" })).not.toThrow();
    }
  });
});
