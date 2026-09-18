import type { MCPAgentServer, MCPAuthKind, MCPAuthorizationSummary } from "@opentag/shared/browser";

/**
 * The four states one row shows, kept as four independent values.
 *
 * They are deliberately not combined into one status. "Disabled" and "not authorized" are different
 * problems with different fixes: a disabled Server keeps its credential and needs no reauthorization,
 * while an unauthorized one does. A single status column would send a user to reauthorize a Server
 * that was only switched off.
 */
export interface McpRowStates {
  mount: "enabled" | "disabled";
  /**
   * `unauthorized` is a mount with no authorization row at all, and it is not the same as `none`:
   * `none` is a real anonymous authorization this Agent has been granted, while `unauthorized` means
   * there is nothing yet. Rendering both as "Anonymous" put that label beside "Not authorized", which
   * contradicts itself and hides the difference between "can use it anonymously" and "must authorize
   * first".
   */
  authorizationKind: MCPAuthKind | "none" | "unauthorized";
  authorizationStatus: MCPAuthorizationSummary["status"] | "none";
  probe: "pending" | "succeeded" | "failed" | "unknown";
}

export function rowStates(entry: MCPAgentServer): McpRowStates {
  const authorization = entry.authorization;
  return {
    mount: entry.enabled ? "enabled" : "disabled",
    authorizationKind: authorization?.kind ?? "unauthorized",
    authorizationStatus: authorization?.status ?? "none",
    probe: authorization?.probeState ?? "unknown",
  };
}

/**
 * Whether the credential can be revoked: revoking an anonymous Server would leave the pair with no
 * authorization row at all, so `none` is shown as a method, not as something to remove.
 */
export function canRevoke(entry: MCPAgentServer): boolean {
  const authorization = entry.authorization;
  if (!authorization) return false;
  return authorization.kind !== "none" && authorization.status !== "revoked";
}

/**
 * The impact warning for a shared-definition edit. The list is the same set the Server uses for its
 * `boundAgentCount`, so the number the user is shown is the number of Agents that will actually
 * change — and it excludes Agents that were deleted, which no longer use anything.
 */
export function sharedDefinitionImpact(detail: {
  server: { boundAgentCount: number };
  agents: { agentDisplayName: string }[];
}): { count: number; names: string[] } {
  return {
    count: detail.server.boundAgentCount,
    names: detail.agents.map((agent) => agent.agentDisplayName),
  };
}
