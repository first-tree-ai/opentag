import { AccessTokenProvider, OpenTagApi, readCredentials, resolveOpenTagHome } from "@opentag/client";
import type { ListComputersResponse } from "@opentag/shared";

export async function listComputers(home = resolveOpenTagHome()): Promise<ListComputersResponse> {
  const credentials = await readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  const accessToken = await new AccessTokenProvider({ home }).getAccessToken();
  return new OpenTagApi(credentials.serverUrl).listComputers(accessToken);
}
