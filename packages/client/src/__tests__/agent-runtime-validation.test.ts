import { describe, expect, it, vi } from "vitest";
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
  assertHostedTools,
  assertIdentifier,
  assertJsonValue,
  assertPromptRequest,
  runWithAbortSignal,
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

  it("requires an exact, unique hosted tool definition set for allow-list policies", () => {
    const policy = {
      fileSystem: "workspace-write" as const,
      network: "disabled" as const,
      approvals: "never" as const,
      tools: { mode: "allow-list" as const, names: ["send"] },
    };
    const hostedTools = {
      definitions: [
        {
          name: "send",
          description: "Send a message",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              payload: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
            required: ["payload"],
          },
        },
      ],
      handler: async () => ({ success: true, content: [] }),
    };
    expect(() => assertHostedTools(policy, hostedTools)).not.toThrow();
    for (const propertySchema of [
      { type: "string", format: "uuid", description: "Identifier" },
      { type: "number" },
      { type: "integer" },
      { type: "boolean" },
      { type: "null" },
      { type: "array", items: { type: "string" } },
    ]) {
      expect(() =>
        assertHostedTools(policy, {
          ...hostedTools,
          definitions: [
            {
              name: "send",
              inputSchema: { type: "object", properties: { value: propertySchema } },
            },
          ],
        } as never),
      ).not.toThrow();
    }
    expect(() =>
      assertHostedTools({ ...policy, tools: { mode: "allow-list", names: ["send", "send"] } }, hostedTools),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
    expect(() => assertHostedTools({ ...policy, tools: { mode: "provider-default" } }, hostedTools)).toThrowError(
      expect.objectContaining({ code: "configuration_invalid" }),
    );
    for (const candidate of [
      undefined,
      { ...hostedTools, definitions: [null] },
      { ...hostedTools, definitions: [] },
      { ...hostedTools, definitions: [...hostedTools.definitions, hostedTools.definitions[0]] },
      { ...hostedTools, definitions: [{ name: "other", inputSchema: { type: "object" } }] },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: [] }] },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: { type: "string" } }] },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: { type: "object", required: "text" } }] },
      {
        ...hostedTools,
        definitions: [{ name: "send", inputSchema: { type: "object", properties: { text: 42 } } }],
      },
      {
        ...hostedTools,
        definitions: [
          {
            name: "send",
            inputSchema: {
              type: "object",
              properties: { nested: { type: "object", properties: {}, required: ["missing"] } },
            },
          },
        ],
      },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: { type: "object", unknown: true } }] },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: { type: "object", description: 1 } }] },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: { type: "object", description: "" } }] },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: { type: "object", items: {} } }] },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: { type: "object", format: "uuid" } }] },
      {
        ...hostedTools,
        definitions: [{ name: "send", inputSchema: { type: "object", additionalProperties: {} } }],
      },
      { ...hostedTools, definitions: [{ name: "send", inputSchema: { type: "object", properties: [] } }] },
      {
        ...hostedTools,
        definitions: [
          { name: "send", inputSchema: { type: "object", properties: { "bad name": { type: "string" } } } },
        ],
      },
      {
        ...hostedTools,
        definitions: [{ name: "send", inputSchema: { type: "object", required: [1] } }],
      },
      {
        ...hostedTools,
        definitions: [
          {
            name: "send",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text", "text"] },
          },
        ],
      },
      {
        ...hostedTools,
        definitions: [{ name: "send", inputSchema: { type: "object", properties: { value: { type: "unknown" } } } }],
      },
      {
        ...hostedTools,
        definitions: [
          { name: "send", inputSchema: { type: "object", properties: { value: { type: "number", format: "uuid" } } } },
        ],
      },
      {
        ...hostedTools,
        definitions: [
          {
            name: "send",
            inputSchema: { type: "object", properties: { value: { type: "string", items: { type: "string" } } } },
          },
        ],
      },
      {
        ...hostedTools,
        definitions: [{ name: "send", inputSchema: { type: "object", properties: { value: { type: "array" } } } }],
      },
      {
        ...hostedTools,
        definitions: [
          { name: "send", inputSchema: { type: "object", properties: { value: { type: "array", items: [] } } } },
        ],
      },
      {
        ...hostedTools,
        definitions: [
          { name: "send", inputSchema: { type: "object", properties: { value: { type: "string", properties: {} } } } },
        ],
      },
    ]) {
      expect(() => assertHostedTools(policy, candidate as never)).toThrowError(
        expect.objectContaining({ code: "configuration_invalid" }),
      );
    }
    for (const name of ["bad name", "_private", "line\nbreak", "x".repeat(65)]) {
      expect(() =>
        assertHostedTools({ ...policy, tools: { mode: "allow-list", names: [name] } }, {
          ...hostedTools,
          definitions: [{ ...hostedTools.definitions[0], name }],
        } as never),
      ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
    }
    expect(() =>
      assertHostedTools({ ...policy, tools: { mode: "allow-list", names: [1 as never] } }, hostedTools),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
    let tooDeep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 18; index += 1) {
      tooDeep = { type: "array", items: tooDeep };
    }
    expect(() =>
      assertHostedTools(policy, {
        ...hostedTools,
        definitions: [{ name: "send", inputSchema: { type: "object", properties: { value: tooDeep } } }],
      } as never),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });

  it("accepts JSON values and rejects non-finite, unsupported, and cyclic values", () => {
    for (const value of [null, "text", true, false, 0, -1, { value: [1, "two", null] }]) {
      expect(() => assertJsonValue(value, "value")).not.toThrow();
    }
    const shared = { value: true };
    expect(() => assertJsonValue({ left: shared, right: shared }, "value")).not.toThrow();
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { value: true });
    expect(() => assertJsonValue(nullPrototype, "value")).not.toThrow();

    class CustomJsonObject {
      value = true;
    }
    const withGetter = Object.defineProperty({}, "value", { enumerable: true, get: () => true });
    let arrayGetterReads = 0;
    const arrayWithGetter = Object.defineProperty([true], "0", {
      enumerable: true,
      get: () => {
        arrayGetterReads += 1;
        return true;
      },
    });
    const withHidden = Object.defineProperty({}, "value", { enumerable: false, value: true });
    const withSymbol = { [Symbol("value")]: true };
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = true;
    const customArray = [true] as unknown[] & { extra?: boolean };
    customArray.extra = true;
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      () => undefined,
      new Date(),
      new Map(),
      new CustomJsonObject(),
      withGetter,
      arrayWithGetter,
      withHidden,
      withSymbol,
      sparse,
      customArray,
    ]) {
      expect(() => assertJsonValue(value, "value")).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
    expect(arrayGetterReads).toBe(0);
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
    expect(
      sameBinding(
        { providerId: "test", schemaVersion: 1, payload: { first: 1, second: [true, null] } },
        { schemaVersion: 1, providerId: "test", payload: { second: [true, null], first: 1 } },
      ),
    ).toBe(true);
    expect(sameBinding(binding, { ...binding, payload: { id: "two" } })).toBe(false);
    expect(sameBinding(binding, { ...binding, payload: { id: "one", extra: true } })).toBe(false);
    expect(
      sameBinding({ ...binding, payload: [0, { value: true }] }, { ...binding, payload: [0, { value: false }] }),
    ).toBe(false);
    expect(sameBinding({ ...binding, payload: [0] }, { ...binding, payload: [0, 1] })).toBe(false);
    expect(sameBinding({ ...binding, payload: 0 }, { ...binding, payload: -0 })).toBe(true);
    expect(sameBinding({ ...binding, payload: null }, { ...binding, payload: {} })).toBe(false);
  });

  it("runs probes with cooperative and enforced AbortSignal cancellation", async () => {
    await expect(runWithAbortSignal(async () => "without-signal")).resolves.toBe("without-signal");

    const completed = new AbortController();
    const operation = vi.fn(async (signal?: AbortSignal) => signal);
    await expect(runWithAbortSignal(operation, completed.signal)).resolves.toBe(completed.signal);
    expect(operation).toHaveBeenCalledWith(completed.signal);

    const preAborted = new AbortController();
    preAborted.abort(new Error("already stopped"));
    await expect(runWithAbortSignal(async () => "unreachable", preAborted.signal)).rejects.toThrow("already stopped");

    const inFlight = new AbortController();
    const hanging = runWithAbortSignal(() => new Promise<never>(() => undefined), inFlight.signal);
    inFlight.abort(new Error("stop now"));
    await expect(hanging).rejects.toThrow("stop now");
  });
});
