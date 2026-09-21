import {
  GITHUB_OAUTH_ERROR_PARAM,
  GITHUB_OAUTH_OUTCOME_ERROR,
  GITHUB_OAUTH_OUTCOME_PARAM,
  GITHUB_OAUTH_OUTCOME_SUCCESS,
} from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";

/**
 * The GitHub OAuth round trip returns to a fixed local surface with a bounded outcome parameter.
 * Reading it is shared by every return surface (Account and Agent) so the same code renders the
 * same product message, and the parameters are cleared immediately so a reload cannot replay a
 * stale notice.
 */
export type GitHubOAuthOutcome = { kind: "success" } | { kind: "error"; code: string };

export function readGitHubOAuthOutcome(): GitHubOAuthOutcome | undefined {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get(GITHUB_OAUTH_OUTCOME_PARAM);
  if (outcome !== GITHUB_OAUTH_OUTCOME_SUCCESS && outcome !== GITHUB_OAUTH_OUTCOME_ERROR) return undefined;
  const code = params.get(GITHUB_OAUTH_ERROR_PARAM);
  params.delete(GITHUB_OAUTH_OUTCOME_PARAM);
  params.delete(GITHUB_OAUTH_ERROR_PARAM);
  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  return outcome === GITHUB_OAUTH_OUTCOME_SUCCESS ? { kind: "success" } : { kind: "error", code: code ?? "" };
}

export function githubOAuthOutcomeMessage(outcome: GitHubOAuthOutcome): string {
  if (outcome.kind === "success") return m.integrations_github_connected_success();
  switch (outcome.code) {
    case "GITHUB_OAUTH_DENIED":
      return m.integrations_github_error_denied();
    case "GITHUB_OAUTH_AUTHENTICATION_REQUIRED":
      return m.integrations_github_error_authentication_required();
    case "GITHUB_OAUTH_FLOW_EXPIRED":
      return m.integrations_github_error_flow_expired();
    case "GITHUB_OAUTH_FLOW_INVALID":
    case "GITHUB_OAUTH_SESSION_MISMATCH":
      return m.integrations_github_error_flow_invalid();
    case "GITHUB_TOKEN_LIFETIME_UNSUPPORTED":
      return m.integrations_github_error_token_lifetime();
    case "GITHUB_IDENTITY_MISMATCH":
      return m.integrations_github_error_identity_mismatch();
    case "GITHUB_UPSTREAM_UNAVAILABLE":
    case "GITHUB_UPSTREAM_ERROR":
      return m.integrations_github_error_upstream();
    case "GITHUB_RATE_LIMITED":
      return m.integrations_github_error_rate_limited();
    default:
      return m.integrations_github_error_generic();
  }
}
