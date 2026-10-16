import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { ApiError, browserApi } from "../../api.js";

/** Delete this installation; a definition still used by another Agent stays intact. */
export async function deleteMcpInstallation(
  agentId: string,
  serverId: string,
  detach: (id: string) => Promise<unknown> = (id) => browserApi.detachMcpServer(agentId, id),
) {
  try {
    await detach(serverId);
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      (error.code !== MCP_ERROR_CODES.BINDING_NOT_FOUND && error.code !== MCP_ERROR_CODES.SERVER_NOT_FOUND)
    )
      throw error;
  }
  try {
    await browserApi.removeMcpServer(serverId);
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      (error.code !== MCP_ERROR_CODES.SERVER_IN_USE && error.code !== MCP_ERROR_CODES.SERVER_NOT_FOUND)
    )
      throw error;
  }
}

/** Remove only a mount this journey created, and preserve credentials from a late successful callback. */
export async function discardMcpSetup(
  agentId: string,
  serverId: string,
  detach: (id: string) => Promise<unknown>,
  oauthState?: string,
) {
  let current = (await browserApi.agentMcpServers(agentId)).servers.find((entry) => entry.mcpServerId === serverId);
  if (current?.authorization?.status === "pending" && oauthState) {
    try {
      await browserApi.revokeMcpAuthorization(agentId, serverId, oauthState);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== MCP_ERROR_CODES.OAUTH_FLOW_INVALID) throw error;
      return false;
    }
    current = (await browserApi.agentMcpServers(agentId)).servers.find((entry) => entry.mcpServerId === serverId);
  }
  const auth = current?.authorization;
  const keepCredential = auth?.status === "active";
  if (!current) return true;
  if (keepCredential || auth?.status === "pending") return false;
  await deleteMcpInstallation(agentId, serverId, detach);
  return true;
}
