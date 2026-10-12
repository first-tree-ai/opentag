import { browserApi } from "../../api.js";

/** Remove only a mount this journey created, and preserve credentials from a late successful callback. */
export async function discardMcpSetup(agentId: string, serverId: string, detach: (id: string) => Promise<unknown>) {
  const current = (await browserApi.agentMcpServers(agentId)).servers.find((entry) => entry.mcpServerId === serverId);
  const auth = current?.authorization;
  const keepCredential = auth?.hasCredential && auth.status === "active" && auth.probeState !== "failed";
  if (!current) return true;
  if (keepCredential) return false;
  await detach(serverId);
  return true;
}
