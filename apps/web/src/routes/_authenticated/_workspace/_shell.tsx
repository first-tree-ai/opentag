import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../features/navigation/redirect.js";
import { useAccount } from "../../../features/session/session-context.js";
import { AppShell } from "../../../features/shell/app-shell.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell")({
  component: AccountShell,
});

/**
 * The application surface. An Account that has not finished setup is sent back to onboarding, which
 * is the direction the onboarding route mirrors.
 */
function AccountShell() {
  const { me } = useAccount();
  if (!me.setupCompletedAt) return <Redirect replace to="/onboarding" />;
  return <AppShell />;
}
