import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { Redirect } from "../../../features/navigation/redirect.js";
import { useAccount } from "../../../features/session/session-context.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell")({
  component: AccountShell,
});

/**
 * The application surface. An Account that has not finished admission is sent to Agent Setup, except
 * when it opens a link from an IM card: anyone in the conversation may follow it, and the page only
 * says who owns the Agent.
 */
function AccountShell() {
  const { me } = useAccount();
  const slackProvision = useLocation({
    select: ({ pathname, search }) => {
      const value = (search as Record<string, unknown>).slackProvision;
      return pathname === "/account" && (value === true || value === "true");
    },
  });
  const cardLink = useLocation({
    select: ({ pathname, search }) =>
      pathname.startsWith("/im-feedback/") && typeof (search as Record<string, unknown>).open === "string",
  });
  const slackOAuthError = new URLSearchParams(window.location.search).get("slack_oauth_error") ?? undefined;
  if (!me.setupCompletedAt && !slackProvision && !cardLink) {
    return (
      <Redirect replace search={slackOAuthError ? { slack_oauth_error: slackOAuthError } : {}} to="/agents/setup" />
    );
  }
  return <Outlet />;
}
