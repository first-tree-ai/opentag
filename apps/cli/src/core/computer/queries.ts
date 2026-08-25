import { AccessTokenProvider, OpenTagApi, readCredentials, resolveOpenTagHome } from "@opentag/client";
import type { ListWorkspaceComputersResponse } from "@opentag/shared";
import { selectWorkspace } from "../selection/workspace.js";

export async function listComputers(
  workspaceName?: string,
  home = resolveOpenTagHome(),
): Promise<ListWorkspaceComputersResponse> {
  const credentials = await readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  const accessToken = await new AccessTokenProvider({ home }).getAccessToken();
  const api = new OpenTagApi(credentials.serverUrl);
  const workspace = selectWorkspace(await api.me(accessToken), workspaceName);
  return api.listWorkspaceComputers(accessToken, workspace.id);
}
