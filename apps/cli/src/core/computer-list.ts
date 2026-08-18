import { AccessTokenProvider, OpenTagApi, readCredentials, resolveOpenTagHome } from "@opentag/client";
import type { ListComputersResponse } from "@opentag/shared";

export async function listComputers(home = resolveOpenTagHome()): Promise<ListComputersResponse> {
  const credentials = await readCredentials(home);
  if (!credentials) throw new Error("OpenTag is not logged in; run login first");
  const accessToken = await new AccessTokenProvider({ home }).getAccessToken();
  return new OpenTagApi(credentials.serverUrl).listComputers(accessToken);
}

export function formatComputerList(response: ListComputersResponse): string {
  if (response.computers.length === 0) return "No Computers registered";
  return response.computers
    .map((computer) =>
      [
        computer.displayName,
        computer.id,
        computer.connectionStatus,
        `${computer.platform}/${computer.arch}`,
        computer.clientVersion,
        computer.lastSeenAt,
      ].join("\t"),
    )
    .join("\n");
}
