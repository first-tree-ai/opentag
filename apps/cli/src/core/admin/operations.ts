import type { AdminInvitation, WorkspaceAdminSummary } from "@opentag/shared";
import { selectWorkspace } from "../selection/workspace.js";
import { type AdminCommandDependencies, resolveAdminCommandContext } from "./context.js";

export interface AdminSelectionOptions extends AdminCommandDependencies {
  workspaceName?: string;
}

async function context(options: AdminSelectionOptions) {
  const { api, accessToken } = await resolveAdminCommandContext(options);
  const workspace = selectWorkspace(await api.me(accessToken), options.workspaceName);
  return { api, accessToken, workspace };
}

export async function runAdminList(options: AdminSelectionOptions = {}): Promise<WorkspaceAdminSummary[]> {
  const value = await context(options);
  return (await value.api.listWorkspaceAdmins(value.accessToken, value.workspace.id)).admins;
}

export async function runAdminInvite(options: AdminSelectionOptions = {}): Promise<AdminInvitation> {
  const value = await context(options);
  return value.api.createWorkspaceAdminInvitation(value.accessToken, value.workspace.id);
}

export async function runAdminRevoke(accountId: string, options: AdminSelectionOptions = {}): Promise<string> {
  const value = await context(options);
  await value.api.revokeWorkspaceAdmin(value.accessToken, value.workspace.id, accountId);
  return `Revoked Workspace Admin ${accountId}`;
}
