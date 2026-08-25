import type { AdminInvitation, WorkspaceAdminSummary } from "@opentag/shared";

export function formatWorkspaceAdmins(admins: WorkspaceAdminSummary[]): string {
  if (admins.length === 0) return "No Workspace Admins found.";
  return admins.map((admin) => `${admin.userId}\t${admin.displayName}\t${admin.grantedAt}`).join("\n");
}

export function formatAdminInvitation(invitation: AdminInvitation): string {
  return `${invitation.inviteUrl}\nExpires: ${invitation.expiresAt}`;
}
