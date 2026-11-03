import {
  MCP_AUTH_REJECTION_SUMMARY,
  MCP_ERROR_CODES,
  type MCPAgentServer,
  type MCPAuthKind,
} from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { connectionPreset } from "./mcp-connection-model.js";
import { hasMcpToolSnapshot } from "./mcp-tool-snapshot.js";

/**
 * `recovery` refines the row's action when the fix is a specific edit rather than a retry: an address
 * the reader typed is changed in the connector's settings, and a rejected key is replaced.
 */
export type McpFeedback = {
  label?: string;
  action?: "authorize" | "retry";
  recovery?: "edit-address";
  neutral?: boolean;
};

/** Presentation only; an attempt's failure must not become a new persisted authorization state. */
export function probeFeedback(error: string | null, kind?: MCPAuthKind, preset = false): McpFeedback {
  if (error?.includes(MCP_AUTH_REJECTION_SUMMARY) || error?.startsWith(MCP_ERROR_CODES.AUTHORIZATION_REQUIRED))
    return rejectionFeedback(kind, preset);
  if (error?.startsWith(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE)) {
    return {
      label: /timeout|timed out/i.test(error) ? m.mcp_feedback_timeout() : m.mcp_feedback_unreachable(),
      action: "retry",
    };
  }
  return addressFeedback(error, preset) ?? { label: m.mcp_add_tools_failed(), action: "retry" };
}

/** The service refused the credential: a key is replaced, an account authorizes again. */
function rejectionFeedback(kind: MCPAuthKind | undefined, preset: boolean): McpFeedback {
  if (kind === "none" && preset) return { label: m.mcp_feedback_unavailable(), action: "retry" };
  if (kind === "bearer") return { label: m.mcp_add_key_error(), action: "authorize" };
  return { label: kind === "none" ? undefined : m.mcp_authorization_issue(), action: "authorize" };
}

/** A catalog address is unavailable; an address the reader typed is theirs to edit. */
function addressFeedback(error: string | null, preset: boolean): McpFeedback | undefined {
  const blocked = error?.startsWith(MCP_ERROR_CODES.URL_BLOCKED);
  if (preset && (blocked || error?.startsWith(MCP_ERROR_CODES.PROTOCOL_UNSUPPORTED)))
    return { label: m.mcp_feedback_unavailable(), action: "retry" };
  if (blocked) return { label: m.mcp_feedback_address_blocked(), action: "retry", recovery: "edit-address" };
  return undefined;
}

/**
 * The one short line, with its next step, for a failure the Server reported by code. Each line names
 * what the reader can do about it; an unrecognized code falls back to the caller's generic line.
 */
export function failureCodeFeedback(code: string | null | undefined): string | undefined {
  switch (code) {
    case MCP_ERROR_CODES.URL_BLOCKED:
    case MCP_ERROR_CODES.SERVER_URL_INVALID:
      return m.mcp_feedback_address_blocked();
    // Only an explicit "unsupported" says the service lacks account sign-in. A failed registration
    // (a temporary error, a malformed result, or a client that changed) is retried by authorizing again.
    case MCP_ERROR_CODES.REGISTRATION_UNSUPPORTED:
      return m.mcp_feedback_sign_in_unsupported();
    case MCP_ERROR_CODES.REGISTRATION_FAILED:
      return m.mcp_authorization_issue();
    case MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE:
      return m.mcp_feedback_unreachable();
    default:
      return undefined;
  }
}

export function connectorFeedback(entry: MCPAgentServer, error?: string): McpFeedback {
  if (error) return attemptFeedback(error);
  const auth = entry.authorization;
  if (!auth) return { action: "authorize" };
  if (auth.status === "expired") return { label: m.mcp_authorization_expired(), action: "authorize" };
  if (auth.status !== "active") {
    if (!auth.failureCode || auth.failureCode === MCP_ERROR_CODES.OAUTH_DENIED) return { action: "authorize" };
    return { label: failureCodeFeedback(auth.failureCode) ?? m.mcp_authorization_issue(), action: "authorize" };
  }
  if (auth.probeState === "failed")
    return probeFeedback(auth.probeError, auth.kind, Boolean(connectionPreset(entry.effective.url)));
  if (auth.probeState === "pending" && !hasMcpToolSnapshot(entry))
    return { label: m.mcp_add_loading_tools(), neutral: true };
  if (auth.toolsCount === 0 && !auth.toolsTruncated) return { label: m.mcp_tools_zero(), neutral: true };
  return {};
}

/** A failure the current attempt reported, before it reached the saved authorization. */
function attemptFeedback(error: string): McpFeedback {
  if (error === m.mcp_feedback_address_blocked()) return { label: error, action: "retry", recovery: "edit-address" };
  return { label: error, action: isAuthorizationFeedback(error) ? "authorize" : "retry" };
}

export function authorizationAction(entry: MCPAgentServer): string {
  const auth = entry.authorization;
  return auth?.hasCredential ||
    auth?.status === "expired" ||
    (auth?.failureCode && auth.failureCode !== MCP_ERROR_CODES.OAUTH_DENIED)
    ? m.mcp_auth_again()
    : m.mcp_authorize_action();
}

export function isAuthorizationFeedback(label: string): boolean {
  const reasons: string[] = [
    m.mcp_authorization_issue(),
    m.mcp_feedback_rejected(),
    m.mcp_authorization_expired(),
    m.mcp_authorization_revoked(),
    m.mcp_feedback_sign_in_unsupported(),
    m.mcp_add_key_error(),
  ];
  return reasons.includes(label);
}
