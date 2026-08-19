import {
  type CreateAgentRuntimeConfig,
  CreateAgentRuntimeConfigSchema,
  OPENTAG_MESSAGE_TOOLS,
  OPENTAG_PLATFORM_INSTRUCTIONS,
} from "@opentag/shared";

export { OPENTAG_PLATFORM_INSTRUCTIONS };

export const DEFAULT_AGENT_INSTRUCTIONS =
  "Act as the configured OpenTag Agent and follow the managed workspace instructions.";

export const DEFAULT_AGENT_RUNTIME_CONFIG = Object.freeze({
  model: null,
  reasoningEffort: null,
  instructions: DEFAULT_AGENT_INSTRUCTIONS,
  allowedTools: [...OPENTAG_MESSAGE_TOOLS].sort(),
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
