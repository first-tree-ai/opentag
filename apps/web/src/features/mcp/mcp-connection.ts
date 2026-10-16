import {
  MCP_AUTH_REJECTION_SUMMARY,
  MCP_ERROR_CODES,
  type MCPAgentServer,
  type MCPAuthKind,
} from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { connectionPreset } from "./mcp-connection-model.js";
import { type McpOAuthSession, useMcpOAuthSession } from "./mcp-oauth-session.js";
import type { McpOAuthWindow } from "./mcp-oauth-window.js";
import { useProbeMcpServer, useSetMcpAuthorization } from "./mcp-queries.js";
import type { McpReturnContext } from "./mcp-return-context.js";

export class McpConnectionError extends Error {
  constructor(readonly reason: "key" | "tools" | "empty") {
    super(
      reason === "key" ? m.mcp_add_key_error() : reason === "empty" ? m.mcp_add_no_tools() : m.mcp_add_tools_failed(),
    );
  }
}
export type ConnectionAttempt = {
  binding: MCPAgentServer;
  kind: MCPAuthKind;
  allowOAuthDiscovery?: boolean;
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
      if (probeRequiresOAuth(attempt, checked)) throw new McpConnectionError("tools");
      return "connected" as const;
    };
    if (requiresOAuth(attempt)) return startOAuth();
    if (requiresConnectionKey(attempt.kind, attempt.binding, options.token)) return "key";
    if (shouldAuthorize(attempt, options.token)) {
      attempt.binding = await authorize.mutateAsync(authorizationInput(attempt, options.token));
    }
    if (!alive()) return "connected";
    options.onTools?.();
    const result = await probe.mutateAsync(attempt.binding.mcpServerId);
    if (!alive()) return "connected";
    if (probeRequiresOAuth(attempt, result)) return startOAuth();
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
    authorization?.status !== "active" ||
    authorization.probeError === `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`
  );
}
function shouldAuthorize(attempt: ConnectionAttempt, token?: string): boolean {
  return attempt.kind !== "oauth" && (Boolean(token?.trim()) || attempt.binding.authorization?.status !== "active");
}
function probeRequiresOAuth(
  attempt: ConnectionAttempt,
  result: { probeState: string; probeError: string | null; toolsCount: number | null },
): boolean {
  if (result.probeState === "succeeded") {
    if (!result.toolsCount) throw new McpConnectionError("empty");
    return false;
  }
  const rejected = result.probeError === `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`;
  if (rejected && attempt.kind === "bearer") throw new McpConnectionError("key");
  if (rejected && (attempt.allowOAuthDiscovery || attempt.kind === "oauth")) {
    // Keep the discovered method if OAuth startup fails before its authorization write.
    attempt.kind = "oauth";
    return true;
  }
  throw new McpConnectionError("tools");
}

export function connectionFailure(cause: unknown, kind?: MCPAuthKind): string {
  if (cause instanceof McpConnectionError) return cause.message;
  return kind === "oauth" ? m.mcp_connect_sign_in_failed() : m.mcp_connect_failed();
}
export function isKeyFailure(cause: unknown): boolean {
  return cause instanceof McpConnectionError && cause.reason === "key";
}

function requiresOAuth(attempt: ConnectionAttempt): boolean {
  return (
    attempt.kind === "oauth" &&
    (attempt.binding.authorization?.kind !== "oauth" || attempt.binding.authorization.status !== "active")
  );
}

function authorizationInput(attempt: ConnectionAttempt, token?: string) {
  return {
    mcpServerId: attempt.binding.mcpServerId,
    kind: attempt.kind === "bearer" ? ("bearer" as const) : ("none" as const),
    ...(attempt.kind === "bearer" ? { bearerKey: token } : {}),
  };
}
