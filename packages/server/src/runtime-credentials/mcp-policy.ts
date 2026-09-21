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

export interface McpUsableMountReader {
  /** True when this Agent has at least one enabled mount with an active authorization. */
  hasUsableMount(accountId: string, agentId: string): Promise<boolean>;
}

/**
 * The live policy: an Agent may open an MCP execution exactly when it has something to reach.
 *
 * A probe that has not yet succeeded is deliberately *not* disqualifying. A mount is often
 * authorized moments before the first turn, and the snapshot arrives from a background pass; failing
 * the grant on that race would leave the gateway absent for the one turn the user is watching, and
 * the catalogue already reports an unprobed Server as a note rather than pretending it has tools.
 */
export class LiveMcpServicePolicy implements RuntimeMcpServicePolicy {
  readonly #mounts: McpUsableMountReader;

  constructor(mounts: McpUsableMountReader) {
    this.#mounts = mounts;
  }

  async authorizeMcp(input: {
    accountId: string;
    agentId: string;
  }): Promise<readonly RuntimeMcpServiceScope[] | undefined> {
    return (await this.#mounts.hasUsableMount(input.accountId, input.agentId)) ? RUNTIME_MCP_SERVICE_SCOPES : undefined;
  }
}
