import { z } from "zod";
import type { AgentRuntimeProvider } from "./agent.js";
import { RuntimeModelSchema, RuntimeReasoningEffortSchema } from "./runtime-config.js";

export const AgentRuntimeOptionsQuerySchema = z.object({ model: RuntimeModelSchema.optional() }).strict();
export const AgentRuntimeOptionsSchema = z
  .object({
    modelSuggestions: z.array(RuntimeModelSchema).max(4096),
    reasoningEffortAllowedValues: z.array(RuntimeReasoningEffortSchema).max(64).nullable(),
  })
  .strict();
export type AgentRuntimeOptions = z.infer<typeof AgentRuntimeOptionsSchema>;

export interface RuntimeConfigurationOptions {
  readonly modelSuggestions: readonly string[];
  readonly reasoningEffortAllowedValues: readonly string[];
}

const RUNTIME_CONFIGURATION_OPTIONS = {
  codex: {
    modelSuggestions: [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ],
    reasoningEffortAllowedValues: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  },
  "claude-code": {
    modelSuggestions: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    reasoningEffortAllowedValues: ["low", "medium", "high", "xhigh", "max"],
  },
  pi: {
    modelSuggestions: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol"],
    reasoningEffortAllowedValues: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
} as const satisfies Record<AgentRuntimeProvider, RuntimeConfigurationOptions>;

export function getRuntimeConfigurationOptions(provider: AgentRuntimeProvider): RuntimeConfigurationOptions {
  return RUNTIME_CONFIGURATION_OPTIONS[provider];
}
