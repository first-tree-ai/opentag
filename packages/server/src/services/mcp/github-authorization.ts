import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { agentMcpServers, mcpServerAuthorizations, mcpServers } from "../../db/schema/index.js";
import {
  type McpAuthorizationContext,
  type McpExecutor,
  mcpEffectiveConfig,
  readMcpAuthorizationContexts,
} from "./mcp-authorization-graph.js";

export const GITHUB_MCP_ISSUER = "https://github.com/login/oauth";
const ENDPOINTS = ["https://api.githubcopilot.com/mcp/", "https://api.githubcopilot.com/mcp"];

export interface GitHubMcpAuthorityFence {
  accountId: string;
  agentId: string;
  mcpServerId: string;
  localAuthorizationId: string;
  rootAuthorizationId: string;
  authorizationVersion: string;
}

export async function readAgentGitHubMcp(executor: McpExecutor, accountId: string, agentId: string) {
  const [context] = await readMcpAuthorizationContexts(
    executor,
    and(
      eq(mcpServers.accountId, accountId),
      eq(agentMcpServers.agentId, agentId),
      inArray(sql<string>`coalesce(${agentMcpServers.urlOverride}, ${mcpServers.url})`, ENDPOINTS),
    ),
    { tools: false, oldestMount: true, limit: 1 },
  );
  return context;
}

export function gitHubMcpFence(context: McpAuthorizationContext): GitHubMcpAuthorityFence | undefined {
  const { authorization, localAuthorization: local, credentialAuthorization: root, binding, server, agent } = context;
  if (
    !binding.enabled ||
    authorization?.kind !== "oauth" ||
    authorization.status !== "active" ||
    !local ||
    !root ||
    root.authorizationServer !== GITHUB_MCP_ISSUER
  )
    return undefined;
  const effective = mcpEffectiveConfig(server, binding);
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        server.accountId,
        agent.id,
        server.id,
        local.id,
        local.revision,
        root.id,
        root.revision,
        root.authorizationServer,
        root.oauthResource,
        root.clientRegistrationId,
        [...(root.scopes ?? [])].sort(),
        effective.url,
        effective.authHeader,
        effective.authScheme,
        Object.entries(effective.extraHeaders).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
  return {
    accountId: server.accountId,
    agentId: agent.id,
    mcpServerId: server.id,
    localAuthorizationId: local.id,
    rootAuthorizationId: root.id,
    authorizationVersion: `mcp:${version}`,
  };
}

export function gitHubMcpReadOnly(context: McpAuthorizationContext): boolean {
  const header = Object.entries(mcpEffectiveConfig(context.server, context.binding).extraHeaders).find(
    ([name]) => name.toLowerCase() === "x-mcp-readonly",
  );
  return header !== undefined && !["", "false", "f", "no", "n", "0", "off"].includes(header[1].trim().toLowerCase());
}

export async function matchesGitHubMcpFence(transaction: DatabaseTransaction, expected: GitHubMcpAuthorityFence) {
  await transaction
    .select({ id: mcpServerAuthorizations.id })
    .from(mcpServerAuthorizations)
    .where(inArray(mcpServerAuthorizations.id, [expected.localAuthorizationId, expected.rootAuthorizationId]))
    .orderBy(asc(mcpServerAuthorizations.id))
    .for("update");
  const context = await readAgentGitHubMcp(transaction, expected.accountId, expected.agentId);
  const observed = context && gitHubMcpFence(context);
  return (
    observed?.mcpServerId === expected.mcpServerId && observed.authorizationVersion === expected.authorizationVersion
  );
}
