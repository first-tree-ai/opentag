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
  onboardingLabOffered: () => ["onboardingLabOffered"] as const,
  /** The Account's Computers. The request takes no argument — the Server scopes it to the session. */
  computers: () => ["computers"] as const,

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
    list: () => ["tasks", "list"] as const,
    /** One Agent's own Tasks. A sibling of the workspace list, so neither invalidates the other. */
    byAgent: (agentId: string) => ["tasks", "byAgent", agentId] as const,
    detail: (taskId: string) => ["tasks", taskId, "detail"] as const,
  },

  feishuSetupAttempt: (attemptId: string) => ["feishuSetupAttempts", attemptId] as const,
} as const;
