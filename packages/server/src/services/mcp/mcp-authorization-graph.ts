import { and, asc, eq, getTableColumns, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agentMcpServers, agents, mcpServerAuthorizations, mcpServers } from "../../db/schema/index.js";
import { MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import type { McpCredentialCipher } from "./mcp-credential-cipher.js";
import { resourceRelatesToEndpoint } from "./mcp-oauth.js";

export type McpAuthorizationRow = typeof mcpServerAuthorizations.$inferSelect;
export type McpExecutor = DatabaseClient | DatabaseTransaction;

const source = alias(mcpServerAuthorizations, "mcp_credential_source");
const sourceAgent = alias(agents, "mcp_credential_agent");
const sourceBinding = alias(agentMcpServers, "mcp_credential_binding");

export interface McpAuthorizationContext {
  agent: Pick<typeof agents.$inferSelect, "id" | "name" | "displayName">;
  binding: typeof agentMcpServers.$inferSelect;
  server: typeof mcpServers.$inferSelect;
  authorization: McpAuthorizationRow | null;
  localAuthorization: McpAuthorizationRow | null;
  credentialAuthorization: McpAuthorizationRow | null;
}

export function mcpEffectiveConfig(
  server: Pick<typeof mcpServers.$inferSelect, "url" | "authHeader" | "authScheme" | "extraHeaders">,
  binding: Pick<
    typeof agentMcpServers.$inferSelect,
    "urlOverride" | "authHeaderOverride" | "authSchemeOverride" | "extraHeadersOverride"
  >,
) {
  return {
    url: binding.urlOverride ?? server.url,
    authHeader: binding.authHeaderOverride ?? server.authHeader,
    authScheme: binding.authSchemeOverride ?? server.authScheme,
    extraHeaders: binding.extraHeadersOverride ?? server.extraHeaders,
  };
}

export function mcpConfigEqual(
  a: ReturnType<typeof mcpEffectiveConfig>,
  b: ReturnType<typeof mcpEffectiveConfig>,
): boolean {
  const headers = (value: Record<string, string>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return (
    a.url === b.url &&
    a.authHeader === b.authHeader &&
    a.authScheme === b.authScheme &&
    headers(a.extraHeaders) === headers(b.extraHeaders)
  );
}

function validSource() {
  return and(
    eq(source.kind, "oauth"),
    isNull(source.credentialSourceId),
    eq(source.mcpServerId, mcpServers.id),
    isNotNull(sourceAgent.id),
    isNotNull(sourceBinding.agentId),
    sql`coalesce(${sourceBinding.urlOverride}, ${mcpServers.url}) = coalesce(${agentMcpServers.urlOverride}, ${mcpServers.url})`,
    sql`coalesce(${sourceBinding.authHeaderOverride}, ${mcpServers.authHeader}) = coalesce(${agentMcpServers.authHeaderOverride}, ${mcpServers.authHeader})`,
    sql`coalesce(${sourceBinding.authSchemeOverride}, ${mcpServers.authScheme}) = coalesce(${agentMcpServers.authSchemeOverride}, ${mcpServers.authScheme})`,
    sql`coalesce(${sourceBinding.extraHeadersOverride}, ${mcpServers.extraHeaders}) = coalesce(${agentMcpServers.extraHeadersOverride}, ${mcpServers.extraHeaders})`,
  );
}

function credentialProjection(row: McpAuthorizationRow) {
  return {
    kind: row.kind,
    status: row.status,
    ciphertext: row.ciphertext,
    keyId: row.keyId,
    scopes: row.scopes,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    authorizationServer: row.authorizationServer,
    oauthResource: row.oauthResource,
    clientRegistrationId: row.clientRegistrationId,
    state: row.state,
    stateExpiresAt: row.stateExpiresAt,
    pkceCiphertext: row.pkceCiphertext,
    loginSessionHash: row.loginSessionHash,
    flowAuthorizationServer: row.flowAuthorizationServer,
    flowOauthResource: row.flowOauthResource,
    refreshGeneration: row.refreshGeneration,
    refreshClaimId: row.refreshClaimId,
    refreshClaimedAt: row.refreshClaimedAt,
    lastRefreshedAt: row.lastRefreshedAt,
    failureCode: row.failureCode,
  };
}

export async function readMcpAuthorizationContexts(
  executor: McpExecutor,
  scope: SQL | undefined,
  options: { limit?: number; oldestFirst?: boolean; oldestMount?: boolean; tools?: boolean } = {},
): Promise<McpAuthorizationContext[]> {
  const localColumns = {
    ...getTableColumns(mcpServerAuthorizations),
    ...(options.tools === false ? { tools: sql<unknown>`null` } : {}),
  };
  const sourceColumns = { ...getTableColumns(source), tools: sql<unknown>`null` };
  const query = executor
    .select({
      agent: { id: agents.id, name: agents.name, displayName: agents.displayName },
      binding: agentMcpServers,
      server: mcpServers,
      local: localColumns,
      source: sourceColumns,
      validSource: sql<boolean>`coalesce(${validSource()}, false)`,
    })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
    .innerJoin(
      agents,
      and(
        eq(agents.id, agentMcpServers.agentId),
        eq(agents.createdByUserId, mcpServers.accountId),
        ne(agents.status, "deleted"),
      ),
    )
    .leftJoin(
      mcpServerAuthorizations,
      and(
        eq(mcpServerAuthorizations.agentId, agentMcpServers.agentId),
        eq(mcpServerAuthorizations.mcpServerId, mcpServers.id),
      ),
    )
    .leftJoin(source, eq(source.id, mcpServerAuthorizations.credentialSourceId))
    .leftJoin(
      sourceAgent,
      and(
        eq(sourceAgent.id, source.agentId),
        eq(sourceAgent.createdByUserId, mcpServers.accountId),
        ne(sourceAgent.status, "deleted"),
      ),
    )
    .leftJoin(
      sourceBinding,
      and(eq(sourceBinding.agentId, source.agentId), eq(sourceBinding.mcpServerId, mcpServers.id)),
    )
    .where(scope)
    .orderBy(
      ...(options.oldestMount
        ? [asc(agentMcpServers.createdAt), asc(agentMcpServers.mcpServerId)]
        : options.oldestFirst
          ? [asc(mcpServerAuthorizations.createdAt), asc(mcpServerAuthorizations.id)]
          : [asc(mcpServers.name)]),
    );
  const rows = await (options.limit ? query.limit(options.limit) : query);

  const observedAt = new Date();
  return rows.map((row) => {
    const local = row.local;
    const credential = local?.credentialSourceId ? (row.validSource ? row.source : null) : local;
    const effective = mcpEffectiveConfig(row.server, row.binding);
    const resourceValid =
      !credential?.oauthResource || resourceRelatesToEndpoint(credential.oauthResource, effective.url);
    let authorization = local;
    if (local && credential && resourceValid) {
      const status =
        credential.status === "active" &&
        credential.accessTokenExpiresAt &&
        credential.accessTokenExpiresAt <= observedAt
          ? ("expired" as const)
          : credential.status;
      authorization = { ...local, ...credentialProjection(credential), status };
    } else if (local) {
      authorization = {
        ...local,
        status: "revoked",
        ciphertext: null,
        keyId: null,
        state: null,
        stateExpiresAt: null,
        failureCode: MCP_ERROR_CODES.AUTHORIZATION_REQUIRED,
      };
    }
    return {
      agent: row.agent,
      binding: row.binding,
      server: row.server,
      authorization,
      localAuthorization: local,
      credentialAuthorization: credential,
    };
  });
}

export async function readMcpCredentialRoot(executor: McpExecutor, accountId: string, id: string) {
  const rows = await readMcpAuthorizationContexts(
    executor,
    and(eq(mcpServers.accountId, accountId), eq(mcpServerAuthorizations.id, id)),
    { tools: false, limit: 1 },
  );
  const context = rows[0];
  return context?.localAuthorization?.credentialSourceId === null ? context : undefined;
}

export async function invalidateMcpCredentialProbes(transaction: DatabaseTransaction, rootId: string) {
  await transaction
    .update(mcpServerAuthorizations)
    .set({
      revision: sql`${mcpServerAuthorizations.revision} + 1`,
      probeState: "pending",
      tools: null,
      toolsCount: null,
      toolsTruncated: false,
      instructions: null,
      capabilities: null,
      serverInfo: null,
      probeError: null,
    })
    .where(sql`${mcpServerAuthorizations.id} = ${rootId} or ${mcpServerAuthorizations.credentialSourceId} = ${rootId}`);
}

export async function assertMcpAuthorizationUnshared(
  transaction: DatabaseTransaction,
  agentId: string,
  serverId: string,
) {
  const [local] = await transaction
    .select()
    .from(mcpServerAuthorizations)
    .where(and(eq(mcpServerAuthorizations.agentId, agentId), eq(mcpServerAuthorizations.mcpServerId, serverId)));
  if (!local) return;
  const [reference] = await transaction
    .select({ id: mcpServerAuthorizations.id })
    .from(mcpServerAuthorizations)
    .where(eq(mcpServerAuthorizations.credentialSourceId, local.id))
    .limit(1);
  if (local.credentialSourceId || reference)
    throw new McpServiceError(
      MCP_ERROR_CODES.BINDING_CONFLICT,
      "Disconnect shared authorization before changing its connection configuration",
    );
}

export async function unlinkMcpSharedAuthorization(
  transaction: DatabaseTransaction,
  local: McpAuthorizationRow | null | undefined,
  cipher: McpCredentialCipher | undefined,
  now: Date,
): Promise<boolean> {
  if (!local) return false;
  const [reference] = await transaction
    .select({ id: mcpServerAuthorizations.id })
    .from(mcpServerAuthorizations)
    .where(eq(mcpServerAuthorizations.credentialSourceId, local.id))
    .limit(1);
  if (!local.credentialSourceId && !reference) return false;
  await removeMcpLocalAuthorization(transaction, local.agentId, local.mcpServerId, cipher);
  await transaction.insert(mcpServerAuthorizations).values({
    agentId: local.agentId,
    mcpServerId: local.mcpServerId,
    kind: local.kind,
    status: "revoked",
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

function localSnapshot(row: McpAuthorizationRow) {
  return {
    probeState: row.probeState,
    probedAt: row.probedAt,
    probeError: row.probeError,
    serverInfo: row.serverInfo,
    capabilities: row.capabilities,
    instructions: row.instructions,
    tools: row.tools,
    toolsCount: row.toolsCount,
    toolsTruncated: row.toolsTruncated,
    protocolEra: row.protocolEra,
    protocolVersion: row.protocolVersion,
  };
}

// Caller holds the Account admission lock before any Agent, binding, or authorization lock.
export async function removeMcpLocalAuthorization(
  transaction: DatabaseTransaction,
  agentId: string,
  serverId: string,
  cipher?: McpCredentialCipher,
  keepIndependent = false,
) {
  const rows = await transaction
    .select()
    .from(mcpServerAuthorizations)
    .where(eq(mcpServerAuthorizations.mcpServerId, serverId))
    .orderBy(asc(mcpServerAuthorizations.id))
    .for("update");
  const root = rows.find((row) => row.agentId === agentId);
  if (!root) return;
  const candidates = rows
    .filter((row) => row.credentialSourceId === root.id)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const next = candidates[0];
  if (!next) {
    if (keepIndependent && !root.credentialSourceId) return;
    await transaction.delete(mcpServerAuthorizations).where(eq(mcpServerAuthorizations.id, root.id));
    return;
  }
  if (!cipher) throw new Error("MCP credential cipher is required for shared authorization handoff");
  const context = await readMcpCredentialRoot(
    transaction,
    (
      await transaction.select({ accountId: mcpServers.accountId }).from(mcpServers).where(eq(mcpServers.id, serverId))
    )[0]?.accountId ?? "",
    root.id,
  );
  const members = context
    ? await readMcpAuthorizationContexts(
        transaction,
        and(eq(mcpServers.id, serverId), eq(mcpServerAuthorizations.id, next.id)),
      )
    : [];
  if (!members[0]?.credentialAuthorization)
    throw new McpServiceError(MCP_ERROR_CODES.BINDING_CONFLICT, "Shared authorization holder is no longer valid");
  const binding = { mcpServerId: serverId, agentId, authorizationServer: root.authorizationServer };
  const sealed =
    root.ciphertext && root.keyId
      ? cipher.rebindAuthorization(
          binding,
          { ...binding, agentId: next.agentId },
          { ciphertext: root.ciphertext, keyId: root.keyId },
        )
      : null;
  const flowBinding = { ...binding, authorizationServer: root.flowAuthorizationServer };
  const pkceCiphertext = root.pkceCiphertext
    ? cipher.rebindPkce(flowBinding, { ...flowBinding, agentId: next.agentId }, root.pkceCiphertext)
    : null;
  await transaction.delete(mcpServerAuthorizations).where(eq(mcpServerAuthorizations.id, next.id));
  await transaction
    .update(mcpServerAuthorizations)
    .set({
      agentId: next.agentId,
      ...localSnapshot(next),
      ciphertext: sealed?.ciphertext ?? null,
      keyId: sealed?.keyId ?? null,
      pkceCiphertext,
      revision: sql`${mcpServerAuthorizations.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(mcpServerAuthorizations.id, root.id));
}
