import {
  MCP_OAUTH_ERROR_PARAM,
  MCP_OAUTH_OUTCOME_ERROR,
  MCP_OAUTH_OUTCOME_PARAM,
  MCP_OAUTH_OUTCOME_SUCCESS,
  MCP_OAUTH_SERVER_PARAM,
} from "@opentag/shared/browser";

/**
 * The MCP OAuth outcome the callback redirect carries.
 *
 * The callback returns to this fixed local surface with a bounded code and nothing else — no
 * `error_description`, and no token. Reading it here, once, and stripping the parameters keeps the
 * banner from reappearing on the next render or on a page reload.
 */
export type McpOAuthOutcome = { kind: "success" } | { kind: "error"; code: string };

export interface McpOAuthOutcomeRead {
  outcome: McpOAuthOutcome;
  mcpServerId?: string;
}

export function readMcpOAuthOutcome(): McpOAuthOutcomeRead | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get(MCP_OAUTH_OUTCOME_PARAM);
  if (outcome !== MCP_OAUTH_OUTCOME_SUCCESS && outcome !== MCP_OAUTH_OUTCOME_ERROR) return undefined;
  const code = params.get(MCP_OAUTH_ERROR_PARAM) ?? "MCP_OAUTH_FAILED";
  const mcpServerId = params.get(MCP_OAUTH_SERVER_PARAM) ?? undefined;
  params.delete(MCP_OAUTH_OUTCOME_PARAM);
  params.delete(MCP_OAUTH_ERROR_PARAM);
  params.delete(MCP_OAUTH_SERVER_PARAM);
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  return {
    outcome: outcome === MCP_OAUTH_OUTCOME_SUCCESS ? { kind: "success" } : { kind: "error", code },
    ...(mcpServerId ? { mcpServerId } : {}),
  };
}

/**
 * The banner text for one outcome. An unexpected code still renders a bounded message rather than
 * the raw upstream value, so nothing a Server sent can reach the page.
 */
export function mcpOAuthOutcomeMessage(outcome: McpOAuthOutcome, describeError: (code: string) => string): string {
  return outcome.kind === "success" ? "" : describeError(outcome.code);
}
