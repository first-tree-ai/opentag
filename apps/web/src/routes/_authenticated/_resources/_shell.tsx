import { createFileRoute } from "@tanstack/react-router";
import { Redirect } from "../../../features/navigation/redirect.js";
import { useAccount } from "../../../features/session/session-context.js";
import { AppShell } from "../../../features/shell/app-shell.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell")({
  component: AccountShell,
});

/**
 * The application surface. An Account with no Agent is sent to Agent Setup, because there is
 * nothing here for it to manage yet. Only the count decides: an Agent that still needs a Computer
 * or a messaging app is the Agent list's business to report, not a reason to send someone off to
 * make a second one.
 */
function AccountShell() {
  const { me } = useAccount();
  const slackOAuthError = new URLSearchParams(window.location.search).get("slack_oauth_error") ?? undefined;
  if (!me.hasActiveAgent) {
    return (
      <Redirect replace search={slackOAuthError ? { slack_oauth_error: slackOAuthError } : {}} to="/agents/setup" />
    );
  }
  return <AppShell />;
}
