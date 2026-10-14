import { createFileRoute, useLocation } from "@tanstack/react-router";
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
  const slackProvision = useLocation({
    select: ({ pathname, search }) => {
      const value = (search as Record<string, unknown>).slackProvision;
      return pathname === "/account" && (value === true || value === "true");
    },
  });
  const slackOAuthError = new URLSearchParams(window.location.search).get("slack_oauth_error") ?? undefined;
  if (!me.setupCompletedAt && !slackProvision) {
    return (
      <Redirect replace search={slackOAuthError ? { slack_oauth_error: slackOAuthError } : {}} to="/agents/setup" />
    );
  }
  return <AppShell />;
}
