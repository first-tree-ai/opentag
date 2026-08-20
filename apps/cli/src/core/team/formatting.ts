import type { TeamInvitation, TeamMemberAdminConfig } from "@opentag/shared";

export function formatTeamMembers(members: TeamMemberAdminConfig[]): string {
  if (members.length === 0) return "No Team members found.";
  return members
    .map((member) => `${member.userId}\t${member.displayName}\t${member.email}\t${member.role}\t${member.status}`)
    .join("\n");
}

export function formatTeamMember(member: TeamMemberAdminConfig): string {
  return `${member.userId}\t${member.displayName}\t${member.role}\t${member.status}`;
}

export function formatTeamInvitation(invitation: TeamInvitation): string {
  return `${invitation.inviteUrl}\nExpires: ${invitation.expiresAt}`;
}
