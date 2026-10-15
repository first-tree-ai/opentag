import {
  MCP_AUTH_REJECTION_SUMMARY,
  MCP_ERROR_CODES,
  type MCPAgentServer,
  type MCPAuthKind,
} from "@opentag/shared/browser";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { connectionPreset } from "./mcp-connection-model.js";
import { probeFeedback } from "./mcp-feedback.js";
import { type McpOAuthSession, useMcpOAuthSession } from "./mcp-oauth-session.js";
import type { McpOAuthWindow } from "./mcp-oauth-window.js";
import { useProbeMcpServer, useSetMcpAuthorization } from "./mcp-queries.js";
import type { McpReturnContext } from "./mcp-return-context.js";

export class McpConnectionError extends Error {
  constructor(
    readonly reason: "key" | "tools",
    label?: string,
  ) {
    super(label ?? (reason === "key" ? m.mcp_add_key_error() : m.mcp_add_tools_failed()));
  }
}
export type ConnectionAttempt = {
  binding: MCPAgentServer;
  kind: MCPAuthKind;
};

/** The same Agent-scoped connection operation serves URL Add, Discover, and row Connect. */
export function useMcpConnectionOperation(agentId: string) {
  const authorize = useSetMcpAuthorization(agentId);
  const oauth = useMcpOAuthSession(agentId);
  const probe = useProbeMcpServer(agentId);
  const run = async (
    attempt: ConnectionAttempt,
    options: {
      oauthSession?: McpOAuthSession;
      reauthorize?: boolean;
      token?: string;
      source: McpReturnContext["source"];
      onTools?: () => void;
      isAlive: () => boolean;
      oauthWindow?: McpOAuthWindow;
      returnContext?: Partial<McpReturnContext>;
    },
  ): Promise<"connected" | "key" | "redirect" | "cancelled"> => {
    const session = options.oauthSession ?? oauth;
    const alive = options.isAlive;
    if (!alive()) return "connected";
    const startOAuth = async () => {
      const result = await session.start(
        { ...options.returnContext, agentId, serverId: attempt.binding.mcpServerId, source: options.source },
        connectionPreset(attempt.binding.effective.url)?.oauthScopes,
        options.oauthWindow,
      );
      if (result !== "authorized") return result;
      if (!alive()) return "cancelled" as const;
      options.onTools?.();
      const checked = await probe.mutateAsync(attempt.binding.mcpServerId);
      requireTools(attempt, checked);
      return "connected" as const;
    };
    if (requiresOAuth(attempt, options.reauthorize)) return startOAuth();
    if (requiresConnectionKey(attempt.kind, attempt.binding, options.token)) return "key";
    if (shouldAuthorize(attempt, options.token)) {
      attempt.binding = await authorize.mutateAsync(authorizationInput(attempt, options.token));
    }
    if (!alive()) return "connected";
    options.onTools?.();
    const result = await probe.mutateAsync(attempt.binding.mcpServerId);
    if (!alive()) return "connected";
    requireTools(attempt, result);
    return "connected";
  };
  return { run, oauth };
}

export function requiresConnectionKey(
  kind: MCPAuthKind | undefined,
  binding?: MCPAgentServer,
  token?: string,
): boolean {
  if (kind !== "bearer" || token?.trim()) return false;
  const authorization = binding?.authorization;
  return (
    !authorization?.hasCredential ||
    authorization.status !== "active" ||
    authorization.probeError === `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`
  );
}
function shouldAuthorize(attempt: ConnectionAttempt, token?: string): boolean {
  return attempt.kind !== "oauth" && (Boolean(token?.trim()) || attempt.binding.authorization?.status !== "active");
}
function requireTools(
  attempt: ConnectionAttempt,
  result: { probeState: string; probeError: string | null; toolsCount: number | null },
): void {
  if (result.probeState === "succeeded") return;
  const rejected = result.probeError === `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`;
  if (rejected && attempt.kind === "bearer") throw new McpConnectionError("key");
  throw new McpConnectionError(
    "tools",
    probeFeedback(result.probeError, attempt.kind, Boolean(connectionPreset(attempt.binding.effective.url))).label,
  );
}

export function connectionFailure(cause: unknown, kind?: MCPAuthKind): string {
  if (cause instanceof McpConnectionError) return cause.message;
  if (cause instanceof TypeError && /fetch|network|load failed/i.test(cause.message))
    return m.mcp_feedback_unreachable();
  if (cause instanceof ApiError) {
    if (cause.code === MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED) return m.mcp_authorization_expired();
    if (cause.status === 0) return m.mcp_feedback_unreachable();
    if (cause.code === MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE)
      return probeFeedback(`${cause.code}: ${cause.message}`, kind).label ?? m.mcp_add_tools_failed();
  }
  return kind === "oauth" ? m.mcp_authorization_issue() : m.mcp_add_tools_failed();
}
export function isKeyFailure(cause: unknown): boolean {
  return cause instanceof McpConnectionError && cause.reason === "key";
}

export function requiresOAuth(attempt: ConnectionAttempt, reauthorize = false): boolean {
  return (
    attempt.kind === "oauth" &&
    (reauthorize ||
      attempt.binding.authorization?.kind !== "oauth" ||
      attempt.binding.authorization.status !== "active")
  );
}

function authorizationInput(attempt: ConnectionAttempt, token?: string) {
  return {
    mcpServerId: attempt.binding.mcpServerId,
    kind: attempt.kind === "bearer" ? ("bearer" as const) : ("none" as const),
    ...(attempt.kind === "bearer" ? { bearerKey: token } : {}),
  };
}
