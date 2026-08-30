import { AccessTokenProvider, OpenTagApi, readCredentials, resolveOpenTagHome } from "@opentag/client";
import type { ListAccountComputersResponse } from "@opentag/shared";

export async function listComputers(home = resolveOpenTagHome()): Promise<ListAccountComputersResponse> {
  const credentials = await readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  const accessToken = await new AccessTokenProvider({ home }).getAccessToken();
  const api = new OpenTagApi(credentials.serverUrl);
  return api.listAccountComputers(accessToken);
}
