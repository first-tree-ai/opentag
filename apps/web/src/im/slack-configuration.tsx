import { type ReactNode, useEffect, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { Banner } from "../ui/design-system.js";

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
        {saved ? <Banner variant="secondary" role="status" description={m.im_slack_connected()} /> : null}
        {error ? <Banner variant="error" role="alert" description={error} /> : null}
      </>
    ),
  });
}

function normalizeSlackConfigurationError(cause: unknown): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  return code ? slackConfigurationMessage(code) : m.im_slack_authorization_failed();
}

function slackConfigurationMessage(code: string): string {
  if (code === "AGENT_COMPUTER_NOT_BOUND") return m.im_slack_agent_computer_not_bound();
  if (code === "SLACK_SCOPE_REAUTH_REQUIRED" || code === "SLACK_TOKEN_REVOKED") {
    return m.im_slack_permissions_missing();
  }
  if (code === "SLACK_UPSTREAM_UNAVAILABLE") return m.im_slack_unavailable();
  return m.im_slack_authorization_failed();
}
