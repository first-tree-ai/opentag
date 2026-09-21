import type { OpenTagApi } from "@opentag/client";
import type { MCPAgentServer, MCPExtraHeaders, MCPProbeResponse, MCPServer, MCPServerDetail } from "@opentag/shared";
import { resolveCommandContext } from "../command/context.js";

/**
 * Shared plumbing for the MCP commands.
 *
 * The CLI is a thin presentation layer over the management API: it resolves the Server definition
 * once, then hands the concrete id to the Agent-scoped work, because every per-Agent route is keyed
 * by the Server's id rather than its name.
 */

export interface McpApiClient
  extends Pick<
    OpenTagApi,
    | "listMcpServers"
    | "createMcpServer"
    | "getMcpServer"
    | "updateMcpServer"
    | "removeMcpServer"
    | "listAgentMcpServers"
    | "listAvailableMcpServers"
    | "attachMcpServer"
    | "updateAgentMcpServer"
    | "detachMcpServer"
    | "setMcpAuthorization"
    | "revokeMcpAuthorization"
    | "startMcpOAuth"
    | "probeMcpServer"
  > {}

export interface McpCommandDependencies {
  accessToken?: string;
  api?: McpApiClient;
  home?: string;
}

export async function resolveMcpCommandContext(
  options: McpCommandDependencies,
): Promise<{ accessToken: string; api: McpApiClient }> {
  if ((options.api && !options.accessToken) || (options.accessToken && !options.api)) {
    throw new Error("MCP command test dependencies must provide both api and accessToken");
  }
  const context = await resolveCommandContext({
    accessToken: options.accessToken,
    api: options.api as OpenTagApi | undefined,
    home: options.home,
    requireAuth: true,
  });
  if (!context.api || !context.accessToken) throw new Error("Command context did not resolve an authenticated API");
  return { api: context.api, accessToken: context.accessToken };
}

/**
 * Resolve a Server by name or id. A name is the human-facing handle and an id is what the API uses,
 * so both are accepted and the response keeps its id.
 */
export async function resolveMcpServer(reference: string, options: McpCommandDependencies = {}): Promise<MCPServer> {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  const { servers } = await api.listMcpServers(accessToken);
  const match = servers.find((server) => server.id === reference || server.name === reference);
  if (!match) throw new Error(`No MCP Server named or identified by "${reference}"`);
  return match;
}

/** Collect repeated `--extra-header name=value` flags into one map, rejecting a duplicate name. */
export function extraHeadersFrom(entries: readonly string[] | undefined): MCPExtraHeaders | undefined {
  if (!entries || entries.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`--extra-header expects name=value, received "${entry}"`);
    const name = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1);
    if (name.length === 0) throw new Error("--extra-header requires a header name");
    if (name in headers) throw new Error(`--extra-header repeats "${name}"`);
    headers[name] = value;
  }
  return headers;
}

export function formatMcpServer(server: MCPServer): string {
  return [
    `id\t${server.id}`,
    `name\t${server.name}`,
    `description\t${server.description ?? "-"}`,
    `url\t${server.url}`,
    // Never a statement of what the Server requires: it is only the prefill for a new authorization.
    `defaultAuthKind\t${server.defaultAuthKind} (prefill for a new authorization only)`,
    `authHeader\t${server.authHeader}`,
    `authScheme\t${server.authScheme === "" ? "(sent verbatim)" : server.authScheme}`,
    `extraHeaders\t${formatHeaders(server.extraHeaders)}`,
    `revision\t${server.revision}`,
    `boundAgentCount\t${server.boundAgentCount}`,
    `authorizedAgentCount\t${server.authorizedAgentCount}`,
    `lastProbedAt\t${server.lastProbedAt ?? "-"}`,
  ].join("\n");
}

export function formatMcpServerList(servers: readonly MCPServer[]): string {
  if (servers.length === 0) return "No MCP Servers configured";
  return [
    ["NAME", "URL", "AGENTS", "AUTHORIZED", "LAST PROBED"].join("\t"),
    ...servers.map((server) =>
      [
        server.name,
        server.url,
        String(server.boundAgentCount),
        String(server.authorizedAgentCount),
        server.lastProbedAt ?? "-",
      ].join("\t"),
    ),
  ].join("\n");
}

/**
 * One row per mounted Server. The four states are printed as independent fields rather than folded
 * into one status, because "disabled" and "unauthorized" are different problems with different
 * fixes: a disabled Server needs no reauthorization, an unauthorized one does.
 */
export function formatAgentMcpServers(servers: readonly MCPAgentServer[]): string {
  if (servers.length === 0) return "No MCP Servers mounted";
  return [
    ["NAME", "MOUNT", "AUTH KIND", "AUTH STATUS", "PROBE", "TOOLS", "EXPIRES"].join("\t"),
    ...servers.map((entry) => {
      const authorization = entry.authorization;
      return [
        entry.name,
        entry.enabled ? "enabled" : "disabled",
        authorization?.kind ?? "none",
        authorization?.status ?? "none",
        describeProbe(authorization),
        authorization?.toolsCount === null || authorization?.toolsCount === undefined
          ? "-"
          : `${authorization.toolsCount}${authorization.toolsTruncated ? " (truncated)" : ""}`,
        authorization?.accessTokenExpiresAt ?? "-",
      ].join("\t");
    }),
  ].join("\n");
}

export function describeProbe(authorization: MCPAgentServer["authorization"]): string {
  if (!authorization) return "not authorized";
  if (authorization.probeState === "succeeded") return `probed ${authorization.probedAt ?? "-"}`;
  if (authorization.probeState === "failed") return `failed: ${authorization.probeError ?? "-"}`;
  return "pending";
}

export function formatHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  return entries.length === 0 ? "-" : entries.map(([name, value]) => `${name}=${value}`).join(", ");
}

/** One Agent's effective configuration, with each field's provenance so a user can see what applies. */
export function formatAgentServerRow(entry: MCPAgentServer): string {
  const authorization = entry.authorization;
  return [
    `name\t${entry.name}`,
    `mount\t${entry.enabled ? "enabled" : "disabled"}`,
    `authKind\t${authorization?.kind ?? "none"}`,
    `authStatus\t${authorization?.status ?? "none"}`,
    `probeState\t${authorization?.probeState ?? "not authorized"}`,
    `probeError\t${authorization?.probeError ?? "-"}`,
    `toolsCount\t${authorization?.toolsCount ?? "-"}${authorization?.toolsTruncated ? " (truncated)" : ""}`,
    `effectiveUrl\t${entry.effective.url}\t${entry.overridden.url ? "overridden" : "inherited"}`,
    `effectiveAuthHeader\t${entry.effective.authHeader}\t${entry.overridden.authHeader ? "overridden" : "inherited"}`,
    `effectiveAuthScheme\t${entry.effective.authScheme === "" ? "(verbatim)" : entry.effective.authScheme}\t${entry.overridden.authScheme ? "overridden" : "inherited"}`,
    `effectiveExtraHeaders\t${formatHeaders(entry.effective.extraHeaders)}\t${entry.overridden.extraHeaders ? "overridden" : "inherited"}`,
  ].join("\n");
}

/** The started OAuth flow plus, when the caller waited, the probe result the authorization produced. */
export function formatAuthorization(value: {
  server: MCPServer;
  started: { authorizationUrl: string; expiresAt: string };
  probe?: MCPProbeResponse;
}): string {
  return [
    `server\t${value.server.name}`,
    `authorizationUrl\t${value.started.authorizationUrl}`,
    `expiresAt\t${value.started.expiresAt}`,
    `probeState\t${value.probe?.probeState ?? "pending"}`,
    `toolsCount\t${value.probe?.toolsCount ?? "-"}${value.probe?.toolsTruncated ? " (truncated)" : ""}`,
    `protocolEra\t${value.probe?.protocolEra ?? "-"}`,
  ].join("\n");
}

export function formatProbe(value: MCPProbeResponse): string {
  return [
    `probeState\t${value.probeState}`,
    `probeError\t${value.probeError ?? "-"}`,
    `toolsCount\t${value.toolsCount ?? "-"}`,
    // A separate field as well as the inline marker: a script needs to branch on truncation, and a
    // suffix glued to another field cannot be parsed without string surgery.
    `toolsTruncated\t${value.toolsTruncated}`,
    `protocolEra\t${value.protocolEra ?? "-"}`,
    `protocolVersion\t${value.protocolVersion ?? "-"}`,
  ].join("\n");
}

/**
 * A Server definition together with its Agent matrix, and one Agent's effective view when asked.
 *
 * The definition's own fields come first: `mcp show <server>` without `--agent` is a request about
 * the definition, so reporting only the matrix would answer a different question than the one asked.
 */
export function formatMcpShow(value: { server: MCPServerDetail; agentView?: MCPAgentServer }): string {
  const lines = [
    formatMcpServer(value.server.server),
    `agentCount\t${value.server.agents.length}`,
    ...value.server.agents.map((agent) =>
      [
        "agent",
        agent.agentName,
        agent.enabled ? "enabled" : "disabled",
        agent.authorization?.kind ?? "none",
        agent.authorization?.status ?? "unauthorized",
        agent.protocolEra ?? "-",
      ].join("\t"),
    ),
  ];
  if (value.agentView) lines.push(formatAgentServerRow(value.agentView));
  return lines.join("\n");
}
