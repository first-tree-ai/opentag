import type { AgentUsageWindowDays } from "@opentag/shared/browser";

/**
 * Every cache key the application reads, in one place so that the writes which invalidate them can
 * name the same thing the reads named.
 *
 * Everything belonging to one Agent shares the `["agents", agentId]` prefix, so a change to the
 * Agent itself can invalidate its detail, config and binding together without listing them.
 */
export const queryKeys = {
  me: () => ["me"] as const,
  authProviders: () => ["authProviders"] as const,
  internalToolsOffered: () => ["internalToolsOffered"] as const,
  internalNavigationVisibility: () => ["internalNavigationVisibility"] as const,
  /** The Account's Computers. The request takes no argument — the Server scopes it to the session. */
  computers: () => ["computers"] as const,
  computerConnectCode: (connectCodeId: string) => ["computerConnectCodes", connectCodeId] as const,
  agentSetup: (agentId: string) => ["agentSetup", agentId] as const,
  /** Every Setup snapshot read, for a write that must retire whichever one is still in flight. */
  agentSetupRoot: () => ["agentSetup"] as const,

  agents: {
    listRoot: () => ["agents", "list"] as const,
    list: (accountId: string) => ["agents", "list", accountId] as const,
    detail: (agentId: string) => ["agents", agentId, "detail"] as const,
    config: (agentId: string) => ["agents", agentId, "config"] as const,
    imBinding: (agentId: string) => ["agents", agentId, "imBinding"] as const,
    imBindingHandoff: (agentId: string) => ["agents", agentId, "imBindingHandoff"] as const,
    usage: (agentId: string, windowDays: AgentUsageWindowDays) => ["agents", agentId, "usage", windowDays] as const,
    /** Everything held for one Agent, for a write that invalidates the Agent as a whole. */
    all: (agentId: string) => ["agents", agentId] as const,
  },

  tasks: {
    all: () => ["tasks"] as const,
    list: () => ["tasks", "list"] as const,
    /** One Agent's own Tasks. A sibling of the Account task list, so neither invalidates the other. */
    byAgent: (agentId: string) => ["tasks", "byAgent", agentId] as const,
    detail: (taskId: string) => ["tasks", taskId, "detail"] as const,
  },

  feishuSetupAttempt: (attemptId: string) => ["feishuSetupAttempts", attemptId] as const,

  /**
   * MCP management. The Account pool and each Agent's own mounts are separate roots so a write to
   * one Agent's override does not invalidate every other Agent's view.
   */
  mcp: {
    servers: () => ["mcp", "servers"] as const,
    serverRoot: () => ["mcp", "server"] as const,
    server: (mcpServerId: string) => ["mcp", "server", mcpServerId] as const,
    agentServers: (agentId: string) => ["mcp", "agents", agentId] as const,
    availableServers: (agentId: string) => ["mcp", "agents", agentId, "available"] as const,
  },

  /**
   * Agent Skills. A Skill belongs to exactly one Agent, so the Agent-scoped list is the root and each
   * Skill detail hangs off it; invalidating the list therefore also retires every detail for that
   * Agent, which is what a write needs.
   */
  skills: {
    agentSkills: (agentId: string) => ["skills", "agents", agentId] as const,
    skill: (agentId: string, skillId: string) => ["skills", "agents", agentId, "skill", skillId] as const,
  },
} as const;
