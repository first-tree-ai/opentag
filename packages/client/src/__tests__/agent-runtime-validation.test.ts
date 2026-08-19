import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_BINDING_MAX_BYTES,
  AGENT_RUNTIME_ID_MAX_BYTES,
  AGENT_RUNTIME_TEXT_MAX_BYTES,
  type AgentPromptRequest,
  type AgentRuntimeBinding,
} from "../agent-runtime/types.js";
import {
  assertAgentInput,
  assertBinding,
  assertIdentifier,
  assertJsonValue,
  assertPromptRequest,
  sameBinding,
} from "../agent-runtime/validation.js";

const manifest = {
  providerId: "test",
  displayName: "Test",
  contractVersion: 1 as const,
  bindingSchemaVersion: 1,
};

describe("Agent Runtime validation", () => {
  it("accepts bounded identifiers and rejects every invalid identifier shape", () => {
    expect(() => assertIdentifier("run-1", "runId")).not.toThrow();
    expect(() => assertIdentifier("界".repeat(Math.floor(AGENT_RUNTIME_ID_MAX_BYTES / 3)), "runId")).not.toThrow();

    for (const value of [undefined, 1, "", "   ", "x".repeat(AGENT_RUNTIME_ID_MAX_BYTES + 1)]) {
      expect(() => assertIdentifier(value as string, "runId")).toThrowError(
        expect.objectContaining({ code: "invalid_request" }),
      );
    }
  });

  it("accepts text input and rejects missing, malformed, empty, and oversized items", () => {
    expect(() => assertAgentInput({ items: [{ type: "text", text: "hello" }] })).not.toThrow();
    for (const candidate of [
      undefined,
      {},
      { items: "text" },
      { items: [] },
      { items: [undefined] },
      { items: [{ type: "image", text: "x" }] },
      { items: [{ type: "text", text: 1 }] },
      { items: [{ type: "text", text: "" }] },
      { items: [{ type: "text", text: "x".repeat(AGENT_RUNTIME_TEXT_MAX_BYTES + 1) }] },
    ]) {
      expect(() => assertAgentInput(candidate as never)).toThrowError(
        expect.objectContaining({ code: "invalid_request" }),
      );
    }
  });

  it("validates prompt signals and every optional configuration field", () => {
    const valid: AgentPromptRequest = {
      runId: "run-1",
      input: { items: [{ type: "text", text: "hello" }] },
      configuration: {
        model: "model",
        reasoningEffort: "high",
        provider: { nested: [null, true, 1, "value"] },
      },
    };
    expect(() => assertPromptRequest(valid)).not.toThrow();
    expect(() => assertPromptRequest(undefined as never)).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );

    const controller = new AbortController();
    controller.abort();
    expect(() => assertPromptRequest({ ...valid, signal: controller.signal })).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(() => assertPromptRequest({ ...valid, configuration: { model: "" } })).toThrow();
    expect(() => assertPromptRequest({ ...valid, configuration: { reasoningEffort: "" } })).toThrow();
    expect(() => assertPromptRequest({ ...valid, configuration: { provider: Number.NaN } })).toThrow();
    expect(() => assertPromptRequest({ runId: "run-2", input: valid.input })).not.toThrow();
  });

  it("validates binding identity, JSON shape, and encoded size", () => {
    const valid: AgentRuntimeBinding = { providerId: "test", schemaVersion: 1, payload: { threadId: "one" } };
    expect(() => assertBinding(valid, manifest)).not.toThrow();
    expect(() => assertBinding(undefined as never, manifest)).toThrowError(
      expect.objectContaining({ code: "binding_incompatible" }),
    );
    expect(() => assertBinding({ ...valid, providerId: "other" }, manifest)).toThrowError(
      expect.objectContaining({ code: "binding_incompatible" }),
    );
    expect(() => assertBinding({ ...valid, schemaVersion: 2 }, manifest)).toThrowError(
      expect.objectContaining({ code: "binding_incompatible" }),
    );
    expect(() => assertBinding({ ...valid, payload: Number.POSITIVE_INFINITY }, manifest)).toThrowError(
      expect.objectContaining({ code: "binding_incompatible" }),
    );
    expect(() =>
      assertBinding({ ...valid, payload: { value: "x".repeat(AGENT_RUNTIME_BINDING_MAX_BYTES) } }, manifest),
    ).toThrowError(expect.objectContaining({ code: "binding_incompatible" }));
  });

  it("accepts JSON values and rejects non-finite, unsupported, and cyclic values", () => {
    for (const value of [null, "text", true, false, 0, -1, { value: [1, "two", null] }]) {
      expect(() => assertJsonValue(value, "value")).not.toThrow();
    }
    const shared = { value: true };
    expect(() => assertJsonValue({ left: shared, right: shared }, "value")).not.toThrow();

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n, () => undefined]) {
      expect(() => assertJsonValue(value, "value")).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => assertJsonValue(cycle, "value", "binding_incompatible")).toThrowError(
      expect.objectContaining({ code: "binding_incompatible" }),
    );
  });

  it("compares bindings structurally", () => {
    const binding: AgentRuntimeBinding = { providerId: "test", schemaVersion: 1, payload: { id: "one" } };
    expect(sameBinding(undefined, binding)).toBe(false);
    expect(sameBinding(binding, { ...binding, payload: { id: "one" } })).toBe(true);
    expect(sameBinding(binding, { ...binding, payload: { id: "two" } })).toBe(false);
  });
});
