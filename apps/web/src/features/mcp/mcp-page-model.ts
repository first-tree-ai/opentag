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
  authorizationKind: MCPAuthKind | "none";
  authorizationStatus: MCPAuthorizationSummary["status"] | "none";
  probe: "pending" | "succeeded" | "failed" | "unknown";
}

export function rowStates(entry: MCPAgentServer): McpRowStates {
  const authorization = entry.authorization;
  return {
    mount: entry.enabled ? "enabled" : "disabled",
    authorizationKind: authorization?.kind ?? "none",
    authorizationStatus: authorization?.status ?? "none",
    probe: authorization?.probeState ?? "unknown",
  };
}

/** Whether the row can be disabled: only a mounted Server has a switch to flip. */
export function canToggleMount(): boolean {
  return true;
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

/** A Server already authorized can be re-authorized; one that never was can be authorized. */
export function authorizationActionLabel(entry: MCPAgentServer): "authorize" | "reauthorize" {
  return entry.authorization ? "reauthorize" : "authorize";
}

/**
 * Which effective fields this Agent overrides, for the editor's provenance display. A user cannot
 * guess what a Server actually receives unless the page tells them which values are inherited.
 */
export function overrideSummary(entry: MCPAgentServer): { field: string; overridden: boolean }[] {
  return [
    { field: "url", overridden: entry.overridden.url },
    { field: "authHeader", overridden: entry.overridden.authHeader },
    { field: "authScheme", overridden: entry.overridden.authScheme },
    { field: "extraHeaders", overridden: entry.overridden.extraHeaders },
  ];
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

/** Whether deleting the definition is offered: only when nothing else uses it. */
export function canDeleteDefinition(
  detail: { server: { boundAgentCount: number } },
  agentId: string,
  mountedHere: boolean,
): boolean {
  const others = detail.server.boundAgentCount - (mountedHere ? 1 : 0);
  void agentId;
  return others <= 0;
}
