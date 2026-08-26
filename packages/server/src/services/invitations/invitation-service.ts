import type { InvitationAcceptanceResponse, InvitationPreview } from "@opentag/shared";
import type { DatabaseClient } from "../../db/client.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";

/** Redemption-only facade for outstanding invitations issued before creation was retired. */
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
