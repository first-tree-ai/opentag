import type { MCPAgentServer } from "@opentag/shared/browser";

/** A previous completed read remains visible while its replacement is pending. */
export function hasMcpToolSnapshot(entry: MCPAgentServer): boolean {
  return Boolean(entry.authorization?.probedAt && entry.snapshot?.tools);
}
