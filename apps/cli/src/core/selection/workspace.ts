import type { MeResponse, MeWorkspace } from "@opentag/shared";

export function selectWorkspace(me: MeResponse, requestedWorkspaceName?: string): MeWorkspace {
  if (requestedWorkspaceName) {
    const selected = me.workspaces.find(
      (workspace) => workspace.name === requestedWorkspaceName || workspace.id === requestedWorkspaceName,
    );
    if (!selected)
      throw new Error(`Internal scope "${requestedWorkspaceName}" is not available to the current Account`);
    return selected;
  }
  if (me.workspaces.length === 1) {
    const selected = me.workspaces[0];
    if (!selected) throw new Error("No internal scope is available to the current Account");
    return selected;
  }
  if (me.workspaces.length === 0) throw new Error("No internal scope is available to the current Account");
  const names = me.workspaces
    .map((workspace) => workspace.name)
    .sort()
    .join(", ");
  throw new Error(
    `Multiple internal scopes are available; use the legacy --workspace <name> selector. Available internal scopes: ${names}`,
  );
}
