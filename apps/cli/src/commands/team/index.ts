import type { Command } from "commander";
import { formatTeamInvitation, formatTeamMember, formatTeamMembers } from "../../core/team/formatting.js";
import {
  runTeamInvitationRotate,
  runTeamInvitationShow,
  runTeamLeave,
  runTeamMemberList,
  runTeamMemberRemove,
  runTeamMemberRestore,
  runTeamMemberRole,
} from "../../core/team/operations.js";

function teamOption(command: Command): Command {
  return command.option("--team <name-or-id>", "Team canonical name or UUID");
}

export function registerTeamCommand(program: Command): void {
  const team = program.command("team").description("Manage Team membership and invitations");
  const member = team.command("member").description("Manage Team members");

  teamOption(member.command("list"))
    .description("List Team members")
    .action(async (options) => {
      process.stdout.write(`${formatTeamMembers(await runTeamMemberList({ teamName: options.team }))}\n`);
    });

  teamOption(
    member.command("role").argument("<user-id>").requiredOption("--role <role>", "Team role (admin or member)"),
  ).action(async (userId, options) => {
    process.stdout.write(
      `${formatTeamMember(await runTeamMemberRole(userId, options.role, { teamName: options.team }))}\n`,
    );
  });

  teamOption(member.command("remove").argument("<user-id>")).action(async (userId, options) => {
    process.stdout.write(`${await runTeamMemberRemove(userId, { teamName: options.team })}\n`);
  });

  teamOption(
    member.command("restore").argument("<user-id>").requiredOption("--role <role>", "Team role (admin or member)"),
  ).action(async (userId, options) => {
    process.stdout.write(
      `${formatTeamMember(await runTeamMemberRestore(userId, options.role, { teamName: options.team }))}\n`,
    );
  });

  teamOption(team.command("leave").description("Leave a Team")).action(async (options) => {
    process.stdout.write(`${await runTeamLeave({ teamName: options.team })}\n`);
  });

  const invitation = team.command("invitation").description("Manage the Team invitation link");
  teamOption(invitation.command("show")).action(async (options) => {
    process.stdout.write(`${formatTeamInvitation(await runTeamInvitationShow({ teamName: options.team }))}\n`);
  });
  teamOption(invitation.command("rotate")).action(async (options) => {
    process.stdout.write(`${formatTeamInvitation(await runTeamInvitationRotate({ teamName: options.team }))}\n`);
  });
}
