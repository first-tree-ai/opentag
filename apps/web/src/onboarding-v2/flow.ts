export const RUNTIMES = ["codex", "claude-code"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type Destination = "local" | "cloud";

export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const AGENT_NAME_MAX_LENGTH = 64;
export const DEFAULT_AGENT_NAME = "opentag";

export interface AgentDraft {
  readonly destination: Destination | undefined;
  readonly name: string;
  readonly runtime: Runtime | undefined;
}

export const STEP_IDS = ["agent", "computer", "messaging"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = "complete" | "current" | "upcoming";

export interface FlowState {
  readonly steps: readonly { readonly id: StepId; readonly status: StepStatus }[];
}

/**
 * The first predictable OpenTag name this Account does not already hold.
 *
 * A stable sequence is easier to recognize and edit than a random suffix. The Server remains the
 * authority if two creation pages race, but the ordinary additional-Agent path should not begin
 * with a name it already knows cannot be submitted.
 */
export function availableDefaultAgentName(existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  if (!taken.has(DEFAULT_AGENT_NAME)) return DEFAULT_AGENT_NAME;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${DEFAULT_AGENT_NAME}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function emptyDraft(existingNames: readonly string[] = []): AgentDraft {
  return {
    destination: undefined,
    name: availableDefaultAgentName(existingNames),
    runtime: undefined,
  };
}

export type AgentNameError = "empty" | "too-long" | "charset";

export function validateAgentName(value: string): AgentNameError | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.length > AGENT_NAME_MAX_LENGTH) return "too-long";
  if (!AGENT_NAME_PATTERN.test(trimmed)) return "charset";
  return undefined;
}

export function draftIsSubmittable(draft: AgentDraft): boolean {
  return draft.destination === "local" && draft.runtime !== undefined && validateAgentName(draft.name) === undefined;
}
