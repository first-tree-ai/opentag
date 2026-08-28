import { type ReactNode, useEffect, useState } from "react";
import { ApiError, browserApi } from "../api.js";

type SlackOAuthIntent = "create" | "reauthorize";

const SLACK_CONFIGURATION_MESSAGES: Record<string, string> = {
  AUTH_INVALID_TOKEN: "Sign in again, then retry adding OpenTag to Slack.",
  IM_BINDING_FORBIDDEN: "Only the Account owner can manage this Slack configuration.",
  IM_BINDING_PROVIDER_IMMUTABLE:
    "This Agent is connected to a different IM provider. Disable that binding before connecting Slack.",
  SLACK_APP_TEAM_ALREADY_BOUND:
    "This Slack App installation is already connected to another OpenTag workspace. Disconnect that workspace first, or use a different Slack workspace.",
  SLACK_AUTH_IDENTITY_INCOMPLETE:
    "Slack did not identify this authorization as an installed Bot. Start OpenTag Slack again from this Agent.",
  SLACK_AUTH_INVALID: "Slack rejected this authorization. Start OpenTag Slack again from this Agent.",
  SLACK_BINDING_IDENTITY_MISMATCH:
    "The Slack App, Team, or Bot identity does not match this operation. Reauthorize the current OpenTag Slack installation.",
  SLACK_CONFIGURATION_CONFLICT: "The Slack binding changed. Start OpenTag Slack again from this Agent.",
  SLACK_OAUTH_FAILED: "The Slack authorization flow is invalid or expired. Start it again from this Agent.",
  SLACK_SCOPE_REAUTH_REQUIRED: "The installed App is missing required bot scopes. Reauthorize OpenTag Slack and retry.",
  SLACK_TOKEN_REVOKED: "Slack revoked the Bot Token. Reauthorize to install fresh credentials.",
  SLACK_UPSTREAM_UNAVAILABLE: "Slack did not return installation details. Check Slack availability and retry.",
};

export interface SlackConfigurationControl {
  /** Starts the first-party OpenTag Slack OAuth install when the server has configured it. */
  startOAuth: (intent?: SlackOAuthIntent) => Promise<boolean>;
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
      setError(
        SLACK_CONFIGURATION_MESSAGES[oauthError] ??
          "The Slack authorization flow is invalid or expired. Start it again from this Agent.",
      );
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
      setError(normalizeSlackConfigurationError(cause, "Unable to start OpenTag Slack authorization"));
      return false;
    } finally {
      setLoading(false);
    }
  }

  return children({
    startOAuth,
    feedback: (
      <>
        {saved ? (
          <div className="notice success" role="status">
            Slack configuration is active. A future signed event will verify the App-to-Bot identity before runtime
            access becomes ready; Request URL verification remains observation-only, and no test message is required to
            save this generation.
          </div>
        ) : null}
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
      </>
    ),
  });
}

function normalizeSlackConfigurationError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code && SLACK_CONFIGURATION_MESSAGES[code]) return SLACK_CONFIGURATION_MESSAGES[code];
  return cause instanceof Error ? cause.message : fallback;
}
