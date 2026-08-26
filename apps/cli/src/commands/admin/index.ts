import type { Command } from "commander";
import { formatWorkspaceAdmins } from "../../core/admin/formatting.js";
import { runAdminList, runAdminRevoke } from "../../core/admin/operations.js";

function workspaceOption(command: Command): Command {
  return command.option("--workspace <name-or-id>", "Workspace canonical name or UUID");
}

export function registerAdminCommand(program: Command): void {
  const admin = program.command("admin").description("Manage equal Workspace Admin grants");
  workspaceOption(admin.command("list").description("List Workspace Admins")).action(async (options) => {
    process.stdout.write(`${formatWorkspaceAdmins(await runAdminList({ workspaceName: options.workspace }))}\n`);
  });
  workspaceOption(
    admin.command("revoke").argument("<account-id>").description("Revoke a Workspace Admin grant"),
  ).action(async (accountId, options) => {
    process.stdout.write(`${await runAdminRevoke(accountId, { workspaceName: options.workspace })}\n`);
  });
}
