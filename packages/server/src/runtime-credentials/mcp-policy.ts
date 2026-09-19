import type { RuntimeMcpServiceScope } from "@opentag/shared";

/**
 * Platform `mcp` service policy.
 *
 * Unlike the `web` service, MCP is not deployment-gated: any Account may bind MCP Servers from the
 * web UI, and doing so is the opt-in. What gates the grant is whether this *Agent* actually has
 * something to reach — at least one enabled mount whose authorization is active.
 *
 * That check is the reason this is asynchronous where `authorizeWeb` is not: the answer lives in
 * the database, not in deployment configuration. It is worth the round trip at open, because the
 * alternative is handing every Agent an MCP server entry in its provider config that resolves to an
 * empty tool list — a connection the provider CLI still dials, and a failure the user would read as
 * "OpenTag's MCP is broken" rather than "nothing is bound".
 */
export interface RuntimeMcpServicePolicy {
  /**
   * Exact scopes granted at execution open; `undefined` when this Agent has no usable MCP mount.
   *
   * The Agent is named explicitly rather than derived from the Account: authorization in the MCP
   * feature is strictly per Agent, and an Account-level answer would grant one Agent access on the
   * strength of another's credential.
   */
  authorizeMcp(input: { accountId: string; agentId: string }): Promise<readonly RuntimeMcpServiceScope[] | undefined>;
}

export const RUNTIME_MCP_SERVICE_SCOPES: readonly RuntimeMcpServiceScope[] = ["mcp:tools"];
