import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../features/navigation/redirect.js";
import { useAccount } from "../../../features/session/session-context.js";
import { AppShell } from "../../../features/shell/app-shell.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell")({
  component: AccountShell,
});

/**
 * The application surface. An Account that has not finished admission is sent to Agent Setup.
 */
function AccountShell() {
  const { me } = useAccount();
  if (!me.setupCompletedAt) return <Redirect replace to="/agents/setup" />;
  return <AppShell />;
}
