import type { MeResponse, MeWorkspace } from "@opentag/shared";

export function selectWorkspace(me: MeResponse, requestedWorkspaceName?: string): MeWorkspace {
  if (requestedWorkspaceName) {
    const selected = me.workspaces.find(
      (workspace) => workspace.name === requestedWorkspaceName || workspace.id === requestedWorkspaceName,
    );
    if (!selected) throw new Error(`Workspace "${requestedWorkspaceName}" is not available to the current user`);
    return selected;
  }
  if (me.workspaces.length === 1) {
    const selected = me.workspaces[0];
    if (!selected) throw new Error("No Workspace administration access is available");
    return selected;
  }
  if (me.workspaces.length === 0) throw new Error("No Workspace administration access is available");
  const names = me.workspaces
    .map((workspace) => workspace.name)
    .sort()
    .join(", ");
  throw new Error(`Multiple Workspaces are available; use --workspace <name>. Available Workspaces: ${names}`);
}
