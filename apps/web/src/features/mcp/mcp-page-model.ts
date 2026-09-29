import type { MCPAgentServer } from "@opentag/shared/browser";

/**
 * Whether the credential can be revoked: revoking an anonymous Server would leave the pair with no
 * authorization row at all, so `none` is shown as a method, not as something to remove.
 */
export function canRevoke(entry: MCPAgentServer): boolean {
  const authorization = entry.authorization;
  if (!authorization) return false;
  return authorization.kind !== "none" && authorization.status !== "revoked";
}
