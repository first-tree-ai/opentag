import { describe, expect, it } from "vitest";
import { AGENT_RUNTIME_PROVIDERS } from "../agent.js";
import { getRuntimeConfigurationOptions } from "../runtime-configuration-options.js";

describe("getRuntimeConfigurationOptions", () => {
  it.each([
    [
      "codex",
      ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    ],
    [
      "claude-code",
      ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      ["low", "medium", "high", "xhigh", "max"],
    ],
    [
      "pi",
      ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol"],
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    ],
  ] as const)("returns the complete %s options", (provider, modelSuggestions, reasoningEffortAllowedValues) => {
    expect(getRuntimeConfigurationOptions(provider)).toEqual({ modelSuggestions, reasoningEffortAllowedValues });
  });

  it("defines options for every Agent runtime provider", () => {
    expect(AGENT_RUNTIME_PROVIDERS.map((provider) => getRuntimeConfigurationOptions(provider))).toHaveLength(
      AGENT_RUNTIME_PROVIDERS.length,
    );
  });
});
