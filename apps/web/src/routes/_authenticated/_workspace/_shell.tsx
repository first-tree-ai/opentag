import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../features/navigation/redirect.js";
import { useWorkspace } from "../../../features/session/session-context.js";
import { AppShell } from "../../../features/shell/app-shell.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell")({
  component: WorkspaceShell,
});

/**
 * The application surface. An Account that has not finished setup is sent back to onboarding, which
 * is the direction the onboarding route mirrors.
 */
function WorkspaceShell() {
  const { membership } = useWorkspace();
  if (!membership.setupCompletedAt) return <Redirect replace to="/onboarding" />;
  return <AppShell />;
}
