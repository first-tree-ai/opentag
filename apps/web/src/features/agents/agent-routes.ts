import type { AgentSettingsSection } from "./agent-settings/sections.js";

/**
 * Typed destinations for the Agent surfaces. Presentation helpers hand these to `Link` and
 * `navigate` instead of building path strings, so a renamed route fails to compile rather than
 * producing a dead link at runtime.
 */
export type AgentSettingsSectionLink = ReturnType<typeof agentSettingsSectionLink>;
export type AgentSetupLink = ReturnType<typeof agentSetupLink> | ReturnType<typeof agentSetupSignInLink>;

export function agentDetailLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId" } as const;
}

export function agentScheduleDetailLink(agentId: string, scheduleId: string) {
  return { params: { agentId }, search: { schedule: scheduleId }, to: "/agents/$agentId" } as const;
}

export function agentCreateLink() {
  return { search: { action: "create" }, to: "/agents/setup" } as const;
}

export function agentSetupLink(agentId: string) {
  return { search: { agentId }, to: "/agents/setup" } as const;
}

/** Setup for this Agent with its runtime sign-in steps already open. */
export function agentSetupSignInLink(agentId: string) {
  return { hash: RUNTIME_SIGN_IN_HASH, search: { agentId }, to: "/agents/setup" } as const;
}

/** The setup page opens its runtime sign-in steps when it is reached with this fragment. */
export const RUNTIME_SIGN_IN_HASH = "sign-in";

export function agentUsageLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/usage" } as const;
}

export function agentTasksLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/tasks" } as const;
}

export function agentTaskDetailLink(agentId: string, taskId: string) {
  return { params: { agentId, taskId }, to: "/agents/$agentId/tasks/$taskId" } as const;
}

export function agentSkillsLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/skills" } as const;
}

export function agentMcpLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/mcp" } as const;
}

export function agentInstructionsLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/instructions" } as const;
}

export function agentContextTreeLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/context-tree" } as const;
}

export function agentSettingsLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/settings" } as const;
}

export function agentSettingsSectionLink(agentId: string, section: AgentSettingsSection) {
  return { params: { agentId, section }, to: "/agents/$agentId/settings/$section" } as const;
}

/** Account-owned Computer management, with an optional originating Agent. */
export function accountComputerLink(computerId?: string, fromAgent?: string) {
  return { to: "/agents/computers", search: { computerId, fromAgent } } as const;
}

/** Starts a new Computer connection on the Account Computers page, keeping the way back to the Agent. */
export function connectAnotherComputerLink(fromAgent?: string) {
  return { to: "/agents/computers", search: { connect: "another", fromAgent } } as const;
}
