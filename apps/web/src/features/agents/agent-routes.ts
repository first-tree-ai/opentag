import type { AgentSettingsSection } from "./agent-settings/sections.js";

/**
 * Typed destinations for the Agent surfaces. Presentation helpers hand these to `Link` and
 * `navigate` instead of building path strings, so a renamed route fails to compile rather than
 * producing a dead link at runtime.
 */
export type AgentSettingsSectionLink = ReturnType<typeof agentSettingsSectionLink>;

export function agentDetailLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId" } as const;
}

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

export function agentIntegrationsLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/integrations" } as const;
}

export function agentSettingsLink(agentId: string) {
  return { params: { agentId }, to: "/agents/$agentId/settings" } as const;
}

export function agentSettingsSectionLink(agentId: string, section: AgentSettingsSection) {
  return { params: { agentId, section }, to: "/agents/$agentId/settings/$section" } as const;
}
