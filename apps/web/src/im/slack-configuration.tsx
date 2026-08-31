import { type ReactNode, useEffect, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { Banner } from "../ui/design-system.js";

type SlackOAuthIntent = "create" | "reauthorize";

const SLACK_CONFIGURATION_MESSAGES: Record<string, () => string> = {
  AUTH_INVALID_TOKEN: () => m.im_slack_auth_invalid_token(),
  IM_BINDING_FORBIDDEN: () => m.im_slack_binding_forbidden(),
  IM_BINDING_PROVIDER_IMMUTABLE: () => m.im_slack_binding_provider_immutable(),
  SLACK_APP_TEAM_ALREADY_BOUND: () => m.im_slack_app_team_already_bound(),
  SLACK_AUTH_IDENTITY_INCOMPLETE: () => m.im_slack_auth_identity_incomplete(),
  SLACK_AUTH_INVALID: () => m.im_slack_auth_invalid(),
  SLACK_BINDING_IDENTITY_MISMATCH: () => m.im_slack_binding_identity_mismatch(),
  SLACK_CONFIGURATION_CONFLICT: () => m.im_slack_configuration_conflict(),
  SLACK_OAUTH_FAILED: () => m.im_slack_oauth_failed(),
  SLACK_SCOPE_REAUTH_REQUIRED: () => m.im_slack_scope_reauth_required(),
  SLACK_TOKEN_REVOKED: () => m.im_slack_token_revoked(),
  SLACK_UPSTREAM_UNAVAILABLE: () => m.im_slack_upstream_unavailable(),
};

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
      setError(SLACK_CONFIGURATION_MESSAGES[oauthError]?.() ?? m.im_slack_oauth_failed());
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
      setError(normalizeSlackConfigurationError(cause, m.im_slack_unable_to_start_authorization()));
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
        {saved ? <Banner variant="secondary" role="status" description={m.im_slack_configuration_active()} /> : null}
        {error ? <Banner variant="error" role="alert" description={error} /> : null}
      </>
    ),
  });
}

function normalizeSlackConfigurationError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code && SLACK_CONFIGURATION_MESSAGES[code]) return SLACK_CONFIGURATION_MESSAGES[code]?.();
  return cause instanceof Error ? cause.message : fallback;
}
