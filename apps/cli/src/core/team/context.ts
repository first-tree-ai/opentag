import { AccessTokenProvider, OpenTagApi, readCredentials, resolveOpenTagHome } from "@opentag/client";

export interface TeamApiClient
  extends Pick<
    OpenTagApi,
    | "getTeamInvitation"
    | "leaveTeam"
    | "listTeamMembers"
    | "me"
    | "removeTeamMember"
    | "restoreTeamMember"
    | "rotateTeamInvitation"
    | "updateTeamMember"
  > {}

export interface TeamCommandDependencies {
  accessToken?: string;
  api?: TeamApiClient;
  home?: string;
}

export async function resolveTeamCommandContext(
  options: TeamCommandDependencies,
): Promise<{ accessToken: string; api: TeamApiClient }> {
  if (options.api && options.accessToken) return { api: options.api, accessToken: options.accessToken };
  if (options.api || options.accessToken)
    throw new Error("Team command test dependencies must provide both api and accessToken");
  const home = options.home ?? resolveOpenTagHome();
  const credentials = await readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  return {
    api: new OpenTagApi(credentials.serverUrl),
    accessToken: await new AccessTokenProvider({ home }).getAccessToken(),
  };
}
