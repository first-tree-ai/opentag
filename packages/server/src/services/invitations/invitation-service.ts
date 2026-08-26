import type { InvitationAcceptanceResponse, InvitationPreview } from "@opentag/shared";
import type { DatabaseClient } from "../../db/client.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";

/**
 * Route-facing invitation facade; grant and invitation lifecycle stays in WorkspaceAdminAccess.
 * Redemption only: OpenTag no longer creates Admin invitations.
 */
export class InvitationService {
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(database: DatabaseClient, options: { now?: () => Date; workspaceAdmins?: WorkspaceAdminAccess } = {}) {
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(database, { now: options.now });
  }

  preview(rawToken: string): Promise<InvitationPreview> {
    return this.#workspaceAdmins.previewInvitation(rawToken);
  }

  accept(accountId: string, rawToken: string): Promise<InvitationAcceptanceResponse> {
    return this.#workspaceAdmins.acceptInvitation(accountId, rawToken);
  }
}
