import type { AdminInvitation, InvitationAcceptanceResponse, InvitationPreview } from "@opentag/shared";
import type { DatabaseClient } from "../../db/client.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";

/** Route-facing invitation facade; grant and invitation lifecycle stays in WorkspaceAdminAccess. */
export class InvitationService {
  readonly #publicUrl: URL;
  readonly #ttlMs: number;
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(
    database: DatabaseClient,
    publicUrl: string,
    options: { now?: () => Date; ttlMs?: number; workspaceAdmins?: WorkspaceAdminAccess } = {},
  ) {
    this.#publicUrl = new URL(publicUrl);
    this.#ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(database, { now: options.now });
  }

  create(accountId: string, workspaceId: string): Promise<AdminInvitation> {
    return this.#workspaceAdmins.createInvitation(accountId, workspaceId, this.#publicUrl, this.#ttlMs);
  }

  preview(rawToken: string): Promise<InvitationPreview> {
    return this.#workspaceAdmins.previewInvitation(rawToken);
  }

  accept(accountId: string, rawToken: string): Promise<InvitationAcceptanceResponse> {
    return this.#workspaceAdmins.acceptInvitation(accountId, rawToken);
  }
}
