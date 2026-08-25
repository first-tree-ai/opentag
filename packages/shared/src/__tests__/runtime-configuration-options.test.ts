import { describe, expect, it } from "vitest";
import { AGENT_RUNTIME_PROVIDERS } from "../agent.js";
import { getRuntimeConfigurationOptions } from "../runtime-configuration-options.js";

describe("getRuntimeConfigurationOptions", () => {
  it.each([
    [
      "codex",
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.3-codex"],
      ["minimal", "low", "medium", "high", "xhigh"],
    ],
    [
      "claude-code",
      ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
      ["low", "medium", "high", "xhigh", "max", "ultracode"],
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
