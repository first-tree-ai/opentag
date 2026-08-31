import {
  type CreateAgentRuntimeConfig,
  CreateAgentRuntimeConfigSchema,
  OPENTAG_PLATFORM_INSTRUCTIONS,
} from "@opentag/shared";

export { OPENTAG_PLATFORM_INSTRUCTIONS };

export const DEFAULT_AGENT_INSTRUCTIONS = "";

export const DEFAULT_AGENT_RUNTIME_CONFIG = Object.freeze({
  model: null,
  reasoningEffort: null,
  instructions: DEFAULT_AGENT_INSTRUCTIONS,
  maxDurationMs: null,
}) satisfies Readonly<Required<CreateAgentRuntimeConfig>>;

export function resolveAgentRuntimeConfig(
  input: CreateAgentRuntimeConfig | undefined,
): Readonly<Required<CreateAgentRuntimeConfig>> {
  return CreateAgentRuntimeConfigSchema.required().parse({
    ...DEFAULT_AGENT_RUNTIME_CONFIG,
    ...input,
  });
}
