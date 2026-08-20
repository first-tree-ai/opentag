import {
  ListTeamMembersResponseSchema,
  TeamInvitationSchema,
  TeamProfileSchema,
  teamByIdPath,
  teamInvitationPath,
  teamMembersPath,
  type UpdateTeamProfileRequest,
} from "@opentag/shared/browser";
import type { BrowserTransport } from "./transport.js";

export function createTeamsApi(transport: BrowserTransport) {
  return {
    members: (teamId: string) => transport.request(teamMembersPath(teamId), ListTeamMembersResponseSchema),
    update: (teamId: string, input: UpdateTeamProfileRequest) =>
      transport.request(teamByIdPath(teamId), TeamProfileSchema, {
        method: "PATCH",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json", ...transport.csrfHeaders() },
      }),
    invitation: (teamId: string) => transport.requestOptional(teamInvitationPath(teamId), TeamInvitationSchema),
    createInvitation: (teamId: string) =>
      transport.request(teamInvitationPath(teamId), TeamInvitationSchema, {
        method: "POST",
        headers: transport.csrfHeaders(),
      }),
  };
}
