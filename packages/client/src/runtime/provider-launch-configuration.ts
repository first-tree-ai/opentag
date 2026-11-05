import type { AgentRunConfiguration, JsonValue } from "../agent-runtime/types.js";
import type { PreparedMcpGatewayLaunch, PreparedWebToolsLaunch } from "./runtime-credential-environment-manager.js";

/**
 * Per-Turn provider launch facts, assembled from the freshly prepared execution.
 *
 * Every fact here is trusted and execution-scoped: it comes from what this Client just prepared,
 * never from Server content, and it is re-derived each Turn so a descriptor can never outlive the
 * execution that owns it. Each provider sees only what it can act on — Pi's extension socket never
 * reaches Claude Code, and the MCP gateway never reaches a provider with no MCP configuration.
 */
export function providerLaunchConfiguration(
  launch: { webTools?: PreparedWebToolsLaunch; mcpGateway?: PreparedMcpGatewayLaunch },
  providerId: string | undefined,
): { configuration?: AgentRunConfiguration } {
  const provider: Record<string, JsonValue> = {};
  if (launch.webTools && providerId === "pi") {
    provider.webTools = { extensionPath: launch.webTools.extensionPath, socketPath: launch.webTools.socketPath };
  }
  /*
   * Claude Code spawns its process per run, so the bearer goes straight into that run's MCP config.
   * Codex keeps one App Server per Session, so its runtime reloads the thread with the run's MCP
   * servers before the turn instead.
   */
  if (launch.mcpGateway && providerSupportsMcpGateway(providerId)) {
    provider.mcpGateway = { url: launch.mcpGateway.url, token: launch.mcpGateway.token };
  }
  if (Object.keys(provider).length === 0) return {};
  return { configuration: { provider } };
}

export function providerSupportsMcpGateway(providerId: string | undefined): boolean {
  return providerId === "claude-code" || providerId === "codex" || providerId === "pi";
}
