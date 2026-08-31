import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_INSTRUCTIONS, DEFAULT_AGENT_RUNTIME_CONFIG, resolveAgentRuntimeConfig } from "./policy.js";

describe("runtime configuration policy", () => {
  it("keeps the default configuration immutable", () => {
    expect(DEFAULT_AGENT_RUNTIME_CONFIG).toEqual({
      model: null,
      reasoningEffort: null,
      instructions: DEFAULT_AGENT_INSTRUCTIONS,
      maxDurationMs: null,
    });
    expect(Object.isFrozen(DEFAULT_AGENT_RUNTIME_CONFIG)).toBe(true);
  });

  it.each([
    [undefined, DEFAULT_AGENT_RUNTIME_CONFIG],
    [{}, DEFAULT_AGENT_RUNTIME_CONFIG],
    [
      { model: "gpt-5", reasoningEffort: "high", maxDurationMs: 10_000 },
      {
        model: "gpt-5",
        reasoningEffort: "high",
        instructions: DEFAULT_AGENT_INSTRUCTIONS,
        maxDurationMs: 10_000,
      },
    ],
    [
      { instructions: "Use the managed tools.", model: null },
      {
        model: null,
        reasoningEffort: null,
        instructions: "Use the managed tools.",
        maxDurationMs: null,
      },
    ],
  ] as const)("merges %j over the managed defaults", (input, expected) => {
    expect(resolveAgentRuntimeConfig(input)).toEqual(expected);
  });

  it.each([
    [{ model: "" }, "model"],
    [{ reasoningEffort: "" }, "reasoningEffort"],
    [{ maxDurationMs: 0 }, "maxDurationMs"],
    [{ maxDurationMs: 86_400_001 }, "maxDurationMs"],
    [{ unexpected: true } as never, "Unrecognized key"],
  ] as const)("rejects invalid %s input", (input, message) => {
    expect(() => resolveAgentRuntimeConfig(input)).toThrow(message);
  });
});
