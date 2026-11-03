import {
  AgentInstructionsSchema,
  AgentRuntimeConfigSchema,
  type ContextTreeConnection,
  type CreateAgentRuntimeConfig,
  DEFAULT_AGENT_PERMISSIONS,
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
  permissions: DEFAULT_AGENT_PERMISSIONS,
}) satisfies Readonly<Required<CreateAgentRuntimeConfig> & { contextTrees: ContextTreeConnection[] }>;

export function resolveAgentRuntimeConfig(
  input: (CreateAgentRuntimeConfig & { contextTrees?: ContextTreeConnection[] }) | undefined,
): Readonly<Required<CreateAgentRuntimeConfig> & { contextTrees: ContextTreeConnection[] }> {
  // A new configuration is a write, so its instructions take the write reserve, not the stored bound.
  return AgentRuntimeConfigSchema.omit({ revision: true })
    .extend({ instructions: AgentInstructionsSchema })
    .parse({
      ...DEFAULT_AGENT_RUNTIME_CONFIG,
      ...input,
      permissions: input?.permissions ?? DEFAULT_AGENT_PERMISSIONS,
    });
}
