import { type ReactNode, useEffect, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { Banner } from "../ui/design-system.js";
import { messagingProviderLabel } from "./provider-label.js";

type SlackOAuthIntent = "create" | "reauthorize";

export interface SlackConfigurationControl {
  /** Starts the first-party OpenTag Slack OAuth install when the server has configured it. */
  startOAuth: (intent?: SlackOAuthIntent) => Promise<boolean>;
  loading: boolean;
  feedback: ReactNode;
}

interface SlackConfigurationProps {
  agentId: string;
  children: (control: SlackConfigurationControl) => ReactNode;
  onSuccess: () => void;
}

export function SlackConfiguration({ agentId, children, onSuccess }: SlackConfigurationProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("slack_oauth_error");
    const oauthResult = params.get("slack_oauth");
    if (!oauthError && oauthResult !== "success") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("slack_oauth_error");
    url.searchParams.delete("slack_oauth");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    if (oauthError) {
      setError(slackConfigurationMessage(oauthError));
      return;
    }
    setSaved(true);
    onSuccess();
  }, [onSuccess]);

  async function startOAuth(nextIntent: SlackOAuthIntent = "create"): Promise<boolean> {
    if (loading) return false;
    setLoading(true);
    setError(undefined);
    setSaved(false);
    try {
      const started = await browserApi.startSlackOAuth(agentId, { intent: nextIntent });
      window.location.assign(started.authorizationUrl);
      return true;
    } catch (cause) {
      setError(normalizeSlackConfigurationError(cause));
      return false;
    } finally {
      setLoading(false);
    }
  }

  return children({
    loading,
    startOAuth,
    feedback: (
      <>
        {saved ? (
          <Banner
            variant="secondary"
            role="status"
            description={m.im_slack_connected({ provider: messagingProviderLabel("slack") })}
          />
        ) : null}
        {error ? <Banner variant="error" role="alert" description={error} /> : null}
      </>
    ),
  });
}

function normalizeSlackConfigurationError(cause: unknown): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  return code
    ? slackConfigurationMessage(code)
    : m.im_slack_authorization_failed({ provider: messagingProviderLabel("slack") });
}

function slackConfigurationMessage(code: string): string {
  // An Agent with no Computer has nowhere to run, so nothing is installed for it and no route is
  // claimed. That is a different repair from a Slack permission problem, and saying so is the only
  // way the reader learns the fix is on the Agent rather than in Slack.
  if (code === "AGENT_COMPUTER_NOT_BOUND")
    return m.im_slack_agent_computer_not_bound({ provider: messagingProviderLabel("slack") });
  if (code === "SLACK_SCOPE_REAUTH_REQUIRED" || code === "SLACK_TOKEN_REVOKED") {
    return m.im_slack_permissions_missing({ provider: messagingProviderLabel("slack") });
  }
  if (code === "SLACK_UPSTREAM_UNAVAILABLE")
    return m.im_slack_unavailable({ provider: messagingProviderLabel("slack") });
  return m.im_slack_authorization_failed({ provider: messagingProviderLabel("slack") });
}
