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

type RuntimeConfigInput = (CreateAgentRuntimeConfig & { contextTrees?: ContextTreeConnection[] }) | undefined;
type ResolvedRuntimeConfig = Readonly<Required<CreateAgentRuntimeConfig> & { contextTrees: ContextTreeConnection[] }>;

const StoredRuntimeConfigSchema = AgentRuntimeConfigSchema.omit({ revision: true });

function withDefaults(input: RuntimeConfigInput) {
  return { ...DEFAULT_AGENT_RUNTIME_CONFIG, ...input, permissions: input?.permissions ?? DEFAULT_AGENT_PERMISSIONS };
}

/** A new Agent's configuration. Every field is a write, so instructions take the write reserve. */
export function resolveAgentRuntimeConfig(input: RuntimeConfigInput): ResolvedRuntimeConfig {
  return StoredRuntimeConfigSchema.extend({ instructions: AgentInstructionsSchema }).parse(withDefaults(input));
}

/**
 * An existing Agent's configuration after an update, merged from stored values and the fields the
 * request sets. The merge is checked in the stored shape: instructions the request did not send
 * were valid when written and must not be re-judged against a later, wider write reserve, or an
 * unrelated update (display name, model) would fail. Instructions the request does send take the
 * write reserve — `newInstructions` is that value, and it is checked again here.
 */
export function resolveUpdatedAgentRuntimeConfig(
  merged: RuntimeConfigInput,
  newInstructions: string | undefined,
): ResolvedRuntimeConfig {
  if (newInstructions !== undefined) AgentInstructionsSchema.parse(newInstructions);
  return StoredRuntimeConfigSchema.parse(withDefaults(merged));
}
