import {
  AgentRuntimeConfigSchema,
  type ContextTreeConnection,
  type CreateAgentRuntimeConfig,
  OPENTAG_PLATFORM_INSTRUCTIONS,
} from "@opentag/shared";

export { OPENTAG_PLATFORM_INSTRUCTIONS };

export const DEFAULT_AGENT_INSTRUCTIONS = "";

export const DEFAULT_AGENT_RUNTIME_CONFIG = Object.freeze({
  contextTrees: [],
  model: null,
  reasoningEffort: null,
  instructions: DEFAULT_AGENT_INSTRUCTIONS,
  maxDurationMs: null,
}) satisfies Readonly<Required<CreateAgentRuntimeConfig> & { contextTrees: ContextTreeConnection[] }>;

export function resolveAgentRuntimeConfig(
  input: (CreateAgentRuntimeConfig & { contextTrees?: ContextTreeConnection[] }) | undefined,
): Readonly<Required<CreateAgentRuntimeConfig> & { contextTrees: ContextTreeConnection[] }> {
  return AgentRuntimeConfigSchema.omit({ revision: true }).parse({
    ...DEFAULT_AGENT_RUNTIME_CONFIG,
    ...input,
  });
}
