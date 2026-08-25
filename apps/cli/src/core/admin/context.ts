import { AccessTokenProvider, OpenTagApi, readCredentials, resolveOpenTagHome } from "@opentag/client";

export interface AdminApiClient
  extends Pick<OpenTagApi, "createWorkspaceAdminInvitation" | "listWorkspaceAdmins" | "me" | "revokeWorkspaceAdmin"> {}

export interface AdminCommandDependencies {
  accessToken?: string;
  api?: AdminApiClient;
  home?: string;
}

export async function resolveAdminCommandContext(
  options: AdminCommandDependencies,
): Promise<{ accessToken: string; api: AdminApiClient }> {
  if (options.api && options.accessToken) return { api: options.api, accessToken: options.accessToken };
  if (options.api || options.accessToken)
    throw new Error("Admin command test dependencies must provide both api and accessToken");
  const home = options.home ?? resolveOpenTagHome();
  const credentials = await readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  return {
    api: new OpenTagApi(credentials.serverUrl),
    accessToken: await new AccessTokenProvider({ home }).getAccessToken(),
  };
}
