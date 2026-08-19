import { MembershipRoleSchema, type TeamInvitation, type TeamMember } from "@opentag/shared";
import { selectTeam } from "../selection/team.js";
import { resolveTeamCommandContext, type TeamCommandDependencies } from "./context.js";

export interface TeamSelectionOptions extends TeamCommandDependencies {
  teamName?: string;
}

async function context(options: TeamSelectionOptions) {
  const { api, accessToken } = await resolveTeamCommandContext(options);
  const team = selectTeam(await api.me(accessToken), options.teamName);
  return { api, accessToken, team };
}

export async function runTeamMemberList(options: TeamSelectionOptions = {}): Promise<TeamMember[]> {
  const value = await context(options);
  return (await value.api.listTeamMembers(value.accessToken, value.team.teamId)).members;
}

export async function runTeamMemberRole(
  userId: string,
  role: string,
  options: TeamSelectionOptions = {},
): Promise<TeamMember> {
  const value = await context(options);
  return value.api.updateTeamMember(value.accessToken, value.team.teamId, userId, {
    role: MembershipRoleSchema.parse(role),
  });
}

export async function runTeamMemberRemove(userId: string, options: TeamSelectionOptions = {}): Promise<string> {
  const value = await context(options);
  await value.api.removeTeamMember(value.accessToken, value.team.teamId, userId);
  return `Removed Team member ${userId}`;
}

export async function runTeamMemberRestore(
  userId: string,
  role: string,
  options: TeamSelectionOptions = {},
): Promise<TeamMember> {
  const value = await context(options);
  return value.api.restoreTeamMember(value.accessToken, value.team.teamId, userId, {
    role: MembershipRoleSchema.parse(role),
  });
}

export async function runTeamLeave(options: TeamSelectionOptions = {}): Promise<string> {
  const value = await context(options);
  await value.api.leaveTeam(value.accessToken, value.team.teamId);
  return `Left Team ${value.team.teamName}`;
}

export async function runTeamInvitationShow(options: TeamSelectionOptions = {}): Promise<TeamInvitation> {
  const value = await context(options);
  return value.api.getTeamInvitation(value.accessToken, value.team.teamId);
}

export async function runTeamInvitationRotate(options: TeamSelectionOptions = {}): Promise<TeamInvitation> {
  const value = await context(options);
  return value.api.rotateTeamInvitation(value.accessToken, value.team.teamId);
}
