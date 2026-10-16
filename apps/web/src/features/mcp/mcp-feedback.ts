import {
  MCP_AUTH_REJECTION_SUMMARY,
  MCP_ERROR_CODES,
  type MCPAgentServer,
  type MCPAuthKind,
} from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { connectionPreset } from "./mcp-connection-model.js";

export type McpFeedback = { label?: string; action?: "authorize" | "retry"; neutral?: boolean };

/** Presentation only; an attempt's failure must not become a new persisted authorization state. */
export function probeFeedback(error: string | null, kind?: MCPAuthKind, preset = false): McpFeedback {
  if (error?.includes(MCP_AUTH_REJECTION_SUMMARY) || error?.startsWith(MCP_ERROR_CODES.AUTHORIZATION_REQUIRED)) {
    if (kind === "none" && preset) return { label: m.mcp_feedback_unavailable(), action: "retry" };
    return { label: kind === "none" ? undefined : m.mcp_authorization_issue(), action: "authorize" };
  }
  if (error?.startsWith(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE)) {
    return {
      label: /timeout|timed out/i.test(error) ? m.mcp_feedback_timeout() : m.mcp_feedback_unreachable(),
      action: "retry",
    };
  }
  if (
    preset &&
    (error?.startsWith(MCP_ERROR_CODES.URL_BLOCKED) || error?.startsWith(MCP_ERROR_CODES.PROTOCOL_UNSUPPORTED))
  ) {
    return { label: m.mcp_feedback_unavailable(), action: "retry" };
  }
  return { label: m.mcp_add_tools_failed(), action: "retry" };
}

export function connectorFeedback(entry: MCPAgentServer, error?: string): McpFeedback {
  if (error)
    return {
      label: error,
      action: isAuthorizationFeedback(error) ? "authorize" : "retry",
    };
  const auth = entry.authorization;
  if (!auth) return { action: "authorize" };
  if (auth.status === "expired") return { label: m.mcp_authorization_expired(), action: "authorize" };
  if (auth.status !== "active") {
    if (!auth.failureCode || auth.failureCode === MCP_ERROR_CODES.OAUTH_DENIED) return { action: "authorize" };
    return { label: m.mcp_authorization_issue(), action: "authorize" };
  }
  if (auth.probeState === "failed")
    return probeFeedback(auth.probeError, auth.kind, Boolean(connectionPreset(entry.effective.url)));
  if (auth.probeState === "pending") return { label: m.mcp_add_loading_tools(), neutral: true };
  if (auth.toolsCount === 0 && !auth.toolsTruncated) return { label: m.mcp_tools_zero(), neutral: true };
  return {};
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
  ];
  return reasons.includes(label);
}
