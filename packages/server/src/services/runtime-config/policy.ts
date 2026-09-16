import {
  AgentRuntimeConfigSchema,
  type CreateAgentRuntimeConfig,
  OPENTAG_PLATFORM_INSTRUCTIONS,
} from "@opentag/shared";

export { OPENTAG_PLATFORM_INSTRUCTIONS };

export const DEFAULT_AGENT_INSTRUCTIONS = "";

export const DEFAULT_AGENT_RUNTIME_CONFIG = Object.freeze({
  contextTreeRepository: null,
  model: null,
  reasoningEffort: null,
  instructions: DEFAULT_AGENT_INSTRUCTIONS,
  maxDurationMs: null,
}) satisfies Readonly<Required<CreateAgentRuntimeConfig> & { contextTreeRepository: string | null }>;

export function resolveAgentRuntimeConfig(
  input: (CreateAgentRuntimeConfig & { contextTreeRepository?: string | null }) | undefined,
): Readonly<Required<CreateAgentRuntimeConfig> & { contextTreeRepository: string | null }> {
  return AgentRuntimeConfigSchema.omit({ revision: true }).parse({
    ...DEFAULT_AGENT_RUNTIME_CONFIG,
    ...input,
  });
}
