import {
  ConnectCodeIssueResponseSchema,
  HTTP_PATHS,
  ListComputersResponseSchema,
  ListTeamComputersResponseSchema,
  teamComputersPath,
} from "@opentag/shared/browser";
import type { BrowserTransport } from "./transport.js";

export function createComputersApi(transport: BrowserTransport) {
  return {
    listForTeam: (teamId: string) => transport.request(teamComputersPath(teamId), ListTeamComputersResponseSchema),
    listMine: () => transport.request(HTTP_PATHS.meComputers, ListComputersResponseSchema),
    issueConnectCode: (teamId: string) =>
      transport.request(HTTP_PATHS.meConnectCodes, ConnectCodeIssueResponseSchema, {
        method: "POST",
        body: JSON.stringify({ teamId }),
        headers: { "content-type": "application/json", ...transport.csrfHeaders() },
      }),
  };
}
