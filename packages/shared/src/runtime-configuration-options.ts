import type { AgentRuntimeProvider } from "./agent.js";

export interface RuntimeConfigurationOptions {
  readonly modelSuggestions: readonly string[];
  readonly reasoningEffortAllowedValues: readonly string[];
}

const RUNTIME_CONFIGURATION_OPTIONS = {
  codex: {
    modelSuggestions: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.3-codex"],
    reasoningEffortAllowedValues: ["minimal", "low", "medium", "high", "xhigh"],
  },
  "claude-code": {
    modelSuggestions: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    reasoningEffortAllowedValues: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  },
} as const satisfies Record<AgentRuntimeProvider, RuntimeConfigurationOptions>;

export function getRuntimeConfigurationOptions(provider: AgentRuntimeProvider): RuntimeConfigurationOptions {
  return RUNTIME_CONFIGURATION_OPTIONS[provider];
}
