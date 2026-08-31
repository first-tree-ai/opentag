export type AgentSettingsSection = "identity" | "messaging" | "computer" | "execution" | "instructions" | "manage";

/*
 * The blocks of the Agent settings screen, in the order a viewer thinks about an Agent -- who it is,
 * how it is reached, where it runs, how it works -- with the irreversible actions held apart at the
 * end rather than sorted among them.
 *
 * Each key is also a URL segment: `/settings/<key>` opens this screen at that block, which is what
 * keeps the failure-state exits on the Agent cards pointing somewhere. The keys are therefore the
 * ones those exits already use, and are not renamed to match a heading.
 *
 * There are deliberately no labels here. A heading written beside a key is a second copy of the one
 * the block itself renders, and the two drift: "Model & reasoning" outlived the block that had
 * already been renamed to "Model". Each block owns its own heading, and this list owns only order
 * and identity.
 */
export const agentSettingsSections = [
  "identity",
  "messaging",
  "computer",
  "execution",
  "instructions",
  "manage",
] as const satisfies readonly AgentSettingsSection[];

export function isAgentSettingsSection(value: string): value is AgentSettingsSection {
  return (agentSettingsSections as readonly string[]).includes(value);
}

/** The element a `/settings/<section>` deep link moves to, shared by the anchor and the block. */
export function agentSettingsAnchorId(section: AgentSettingsSection): string {
  return `agent-settings-${section}`;
}
