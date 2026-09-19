import {
  type CreateMCPServerRequest,
  type MCPAgentServer,
  type MCPAuthorizationSummary,
  type MCPEffectiveConfig,
  type MCPOverrideSources,
  type MCPProbeSnapshot,
  MCPProbeSnapshotSchema,
  type MCPServer,
  type MCPServerAgent,
  type MCPServerDetail,
  normalizeExtraHeaders,
  probedServerDescription,
  type UpdateMCPBindingRequest,
  type UpdateMCPServerRequest,
} from "@opentag/shared";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentMcpServers, agents, mcpServerAuthorizations, mcpServers } from "../../db/schema/index.js";
import {
  isMcpUniqueViolation,
  MCP_ERROR_CODES,
  McpServiceError,
  mcpBindingNotFound,
  mcpServerNotFound,
} from "./errors.js";

/**
 * Server definitions, Agent mounts, effective configuration, and the aggregate views.
 *
 * Two invariants shape this module:
 *
 * 1. **Deleting an Agent is a soft delete** (`status='deleted'`), so the `on delete cascade` on the
 *    binding and authorization tables never fires on a real path. Every "how many Agents use this"
 *    decision therefore joins `agents` and excludes deleted ones. That judgement exists once, in
 *    `countLiveBindings`, so the delete guard, the aggregate counts, and the UI's "still in use by"
 *    list can never disagree and strand a definition nobody can delete.
 * 2. **Effective configuration is computed in one place.** Probes, (future) runtime calls, and the
 *    UI all read through `resolveEffectiveConfig`; nothing reads `mcp_servers` columns directly, so
 *    an Agent override cannot be honored in one path and ignored in another.
 */

export interface McpServerServiceOptions {
  database: DatabaseClient;
  now?: () => Date;
}

/** A binding row plus its definition and that pair's authorization, joined for the view builders. */
export interface McpJoinedBinding {
  binding: typeof agentMcpServers.$inferSelect;
  server: typeof mcpServers.$inferSelect;
  authorization: typeof mcpServerAuthorizations.$inferSelect | null;
}

type Aggregate = { boundAgentCount: number; authorizedAgentCount: number; lastProbedAt: Date | null };

export class McpServerService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(options: McpServerServiceOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- definitions

  async listServers(accountId: string): Promise<MCPServer[]> {
    const rows = await this.#database
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.accountId, accountId))
      .orderBy(asc(mcpServers.name));
    if (rows.length === 0) return [];
    const aggregates = await this.aggregatesFor(rows.map((row) => row.id));
    return rows.map((row) => toServerDto(row, aggregates.get(row.id)));
  }

  async createServer(accountId: string, input: CreateMCPServerRequest): Promise<MCPServer> {
    const now = this.#now();
    try {
      const [row] = await this.#database
        .insert(mcpServers)
        .values({
          accountId,
          name: input.name,
          url: input.url,
          defaultAuthKind: input.defaultAuthKind,
          authHeader: input.authHeader ?? "authorization",
          authScheme: input.authScheme ?? "Bearer",
          extraHeaders: normalizeExtraHeaders(input.extraHeaders ?? {}),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw mcpServerNotFound();
      return toServerDto(row, undefined);
    } catch (error) {
      if (isMcpUniqueViolation(error, "mcp_servers_account_name_unique")) {
        throw new McpServiceError(MCP_ERROR_CODES.SERVER_NAME_CONFLICT, "An MCP Server with this name already exists");
      }
      throw error;
    }
  }

  /**
   * Edit a shared definition. The `expectedRevision` CAS admits exactly one writer among humans —
   * and, because probes never touch this row, a concurrent probe cannot make a user's edit conflict.
   */
  async updateServer(accountId: string, mcpServerId: string, input: UpdateMCPServerRequest): Promise<MCPServer> {
    const row = await this.#requireServer(accountId, mcpServerId);
    if (row.revision !== input.expectedRevision) {
      throw new McpServiceError(
        MCP_ERROR_CODES.SERVER_REVISION_CONFLICT,
        "The MCP Server was changed by someone else; reload and retry",
        { actual: row.revision },
      );
    }
    const now = this.#now();
    const definitionChanged =
      input.url !== undefined ||
      input.authHeader !== undefined ||
      input.authScheme !== undefined ||
      input.extraHeaders !== undefined ||
      input.clearExtraHeaders === true;
    // Only a changed endpoint moves the origin; renaming a header does not.
    const originChanged = input.url !== undefined;
    const [updated] = await this.#database
      .update(mcpServers)
      .set({
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.defaultAuthKind === undefined ? {} : { defaultAuthKind: input.defaultAuthKind }),
        ...(input.authHeader === undefined ? {} : { authHeader: input.authHeader }),
        ...(input.authScheme === undefined ? {} : { authScheme: input.authScheme }),
        ...(input.extraHeaders === undefined ? {} : { extraHeaders: normalizeExtraHeaders(input.extraHeaders) }),
        ...(input.clearExtraHeaders === true ? { extraHeaders: {} } : {}),
        revision: sql`${mcpServers.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.revision, input.expectedRevision)))
      .returning();
    if (!updated) {
      throw new McpServiceError(MCP_ERROR_CODES.SERVER_REVISION_CONFLICT, "The MCP Server was changed by someone else");
    }
    /*
     * The snapshot was taken with the old configuration, so every mount is marked pending for a
     * re-probe, and a changed endpoint additionally drops the cached era and revokes OAuth credentials
     * that were issued for the old origin. Existing tools stay readable until a new result lands, so
     * the UI never goes blank.
     */
    if (definitionChanged) {
      await this.markProbesPending(mcpServerId, [], { dropCredential: originChanged, invalidateEra: originChanged });
    }
    const aggregates = await this.aggregatesFor([mcpServerId]);
    return toServerDto(updated, aggregates.get(mcpServerId));
  }

  /**
   * Delete a definition. Any surviving mount refuses the delete with the count the caller must
   * resolve first — where "surviving" excludes mounts held by a soft-deleted Agent, since otherwise
   * a definition whose only mounters were deleted could never be removed.
   */
  async deleteServer(accountId: string, mcpServerId: string): Promise<void> {
    await this.#requireServer(accountId, mcpServerId);
    await this.#database.transaction(async (transaction) => {
      const live = await countLiveBindings(transaction, mcpServerId);
      if (live > 0) {
        throw new McpServiceError(
          MCP_ERROR_CODES.SERVER_IN_USE,
          `The MCP Server is still mounted by ${live} Agent(s); detach it first`,
          { boundAgentCount: live },
        );
      }
      /*
       * No live mounts remain. Whatever is left belongs to deleted Agents: history with no reader
       * once the definition is gone, so it goes with it rather than lingering as an orphan.
       */
      await transaction.delete(agentMcpServers).where(eq(agentMcpServers.mcpServerId, mcpServerId));
      await transaction.delete(mcpServers).where(eq(mcpServers.id, mcpServerId));
    });
  }

  async getServerDetail(accountId: string, mcpServerId: string): Promise<MCPServerDetail> {
    const row = await this.#requireServer(accountId, mcpServerId);
    const aggregates = await this.aggregatesFor([mcpServerId]);
    const rows = await this.#database
      .select({
        binding: agentMcpServers,
        server: mcpServers,
        authorization: mcpServerAuthorizations,
        agent: { id: agents.id, name: agents.name, displayName: agents.displayName },
      })
      .from(agentMcpServers)
      .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
      .innerJoin(agents, eq(agents.id, agentMcpServers.agentId))
      .leftJoin(
        mcpServerAuthorizations,
        and(
          eq(mcpServerAuthorizations.mcpServerId, agentMcpServers.mcpServerId),
          eq(mcpServerAuthorizations.agentId, agentMcpServers.agentId),
        ),
      )
      .where(and(eq(agentMcpServers.mcpServerId, mcpServerId), ne(agents.status, "deleted")))
      .orderBy(asc(agents.name));
    return {
      server: toServerDto(row, aggregates.get(mcpServerId)),
      agents: rows.map((joined) => toServerAgentDto(joined.binding, joined.server, joined.authorization, joined.agent)),
    };
  }

  /** Servers of this Account that the Agent has not mounted, for the "add existing" chooser. */
  async listAvailableServers(accountId: string, agentId: string) {
    const rows = await this.#database
      .select({ server: mcpServers })
      .from(mcpServers)
      .leftJoin(
        agentMcpServers,
        and(eq(agentMcpServers.mcpServerId, mcpServers.id), eq(agentMcpServers.agentId, agentId)),
      )
      .where(and(eq(mcpServers.accountId, accountId), isNull(agentMcpServers.agentId)))
      .orderBy(asc(mcpServers.name));
    const aggregates = await this.aggregatesFor(rows.map((row) => row.server.id));
    return rows.map((row) => ({
      id: row.server.id,
      name: row.server.name,
      description: row.server.description,
      boundAgentCount: aggregates.get(row.server.id)?.boundAgentCount ?? 0,
    }));
  }

  // ---------------------------------------------------------------- bindings

  /**
   * One Agent's mounts as raw joined rows, for the runtime gateway.
   *
   * `listAgentServers` answers the same query but maps to the management DTO, which deliberately
   * omits the tool snapshot's contents and every credential-shaped column — correct for an API
   * response, useless for building a tool catalogue. This returns the rows themselves so the gateway
   * can read `tools`, `protocol_era`, and the override columns without a second round trip.
   *
   * Ownership is proven the same way every other read in this service proves it: the Agent must
   * belong to the Account and not be deleted, and the definition must be the Account's.
   */
  async listAgentBindings(accountId: string, agentId: string): Promise<McpJoinedBinding[]> {
    await this.#requireAgent(accountId, agentId);
    const rows = await this.#database
      .select({ binding: agentMcpServers, server: mcpServers, authorization: mcpServerAuthorizations })
      .from(agentMcpServers)
      .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
      .leftJoin(
        mcpServerAuthorizations,
        and(
          eq(mcpServerAuthorizations.mcpServerId, agentMcpServers.mcpServerId),
          eq(mcpServerAuthorizations.agentId, agentMcpServers.agentId),
        ),
      )
      .where(and(eq(agentMcpServers.agentId, agentId), eq(mcpServers.accountId, accountId)))
      .orderBy(asc(mcpServers.name));
    return rows.map((row) => ({ binding: row.binding, server: row.server, authorization: row.authorization }));
  }

  async listAgentServers(accountId: string, agentId: string): Promise<MCPAgentServer[]> {
    await this.#requireAgent(accountId, agentId);
    const rows = await this.#database
      .select({ binding: agentMcpServers, server: mcpServers, authorization: mcpServerAuthorizations })
      .from(agentMcpServers)
      .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
      .leftJoin(
        mcpServerAuthorizations,
        and(
          eq(mcpServerAuthorizations.mcpServerId, agentMcpServers.mcpServerId),
          eq(mcpServerAuthorizations.agentId, agentMcpServers.agentId),
        ),
      )
      .where(and(eq(agentMcpServers.agentId, agentId), eq(mcpServers.accountId, accountId)))
      .orderBy(asc(mcpServers.name));
    return rows.map((row) => toAgentServerDto(row.binding, row.server, row.authorization));
  }

  /**
   * Mount a Server for one Agent. Mounting does not require an authorization: a Server that needs one
   * can be mounted first and authorized afterwards. The exception is a `none` default, whose
   * authorization row is created immediately so the Agent is usable without a further step.
   */
  async attachServer(
    accountId: string,
    agentId: string,
    mcpServerId: string,
    enabled: boolean,
  ): Promise<MCPAgentServer> {
    await this.#requireAgent(accountId, agentId);
    const server = await this.#requireServer(accountId, mcpServerId);
    const now = this.#now();
    try {
      await this.#database.transaction(async (transaction) => {
        await transaction
          .insert(agentMcpServers)
          .values({ agentId, mcpServerId, enabled, createdAt: now, updatedAt: now });
        if (server.defaultAuthKind === "none") {
          await transaction
            .insert(mcpServerAuthorizations)
            .values({
              agentId,
              mcpServerId,
              kind: "none",
              status: "active",
              probeState: "pending",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing();
        }
      });
    } catch (error) {
      if (isMcpUniqueViolation(error, "agent_mcp_servers_agent_id_mcp_server_id_pk")) {
        throw new McpServiceError(MCP_ERROR_CODES.BINDING_CONFLICT, "The Agent already mounts this MCP Server");
      }
      throw error;
    }
    return await this.readAgentServer(accountId, agentId, mcpServerId);
  }

  async detachServer(accountId: string, agentId: string, mcpServerId: string): Promise<void> {
    await this.#requireAgent(accountId, agentId);
    await this.#requireBinding(agentId, mcpServerId);
    await this.#database.transaction(async (transaction) => {
      // The credential goes with the mount: a detached Server keeps no usable secret for this Agent.
      await transaction
        .delete(mcpServerAuthorizations)
        .where(and(eq(mcpServerAuthorizations.agentId, agentId), eq(mcpServerAuthorizations.mcpServerId, mcpServerId)));
      await transaction
        .delete(agentMcpServers)
        .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)));
    });
  }

  /**
   * The single enable/disable layer and this Agent's overrides. Disabling keeps the mount and the
   * credential, so re-enabling needs no reauthorization — the two states are deliberately
   * independent, and the UI must be able to tell them apart.
   */
  async updateBinding(
    accountId: string,
    agentId: string,
    mcpServerId: string,
    input: UpdateMCPBindingRequest,
  ): Promise<MCPAgentServer> {
    await this.#requireAgent(accountId, agentId);
    const binding = await this.#requireBinding(agentId, mcpServerId);
    await this.#requireServer(accountId, mcpServerId);
    const patch = applyOverridePatch(binding, input);
    const now = this.#now();
    const [row] = await this.#database
      .update(agentMcpServers)
      .set({ ...(input.enabled === undefined ? {} : { enabled: input.enabled }), ...patch, updatedAt: now })
      .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)))
      .returning();
    if (!row) throw mcpBindingNotFound();
    /*
     * Only this Agent's probe was taken with the old values, so only this Agent is re-probed. A
     * change of the shared definition re-probes every mount instead (see `updateServer`). An
     * overridden endpoint moves this Agent's origin, so its cached era goes with it.
     */
    if (overrideChanged(patch)) {
      await this.markProbesPending(mcpServerId, [agentId], {
        dropCredential: "urlOverride" in patch,
        invalidateEra: "urlOverride" in patch,
      });
    }
    return await this.readAgentServer(accountId, agentId, mcpServerId);
  }

  /**
   * Mark authorization rows pending so a background pass re-probes them. An empty `agentIds` means
   * every row of the Server. `probed_at` and the snapshot columns are left alone: the last good
   * result stays readable until a new one replaces it.
   *
   * `invalidateEra` drops the cached protocol era as well, which is required whenever the effective
   * `url` changed: the era is a property of the origin, so a new endpoint may be a different Server
   * speaking a different protocol, and reusing the old answer would send the modern request shape to
   * a legacy Server (or the reverse) until the cache happened to fail.
   *
   * `dropCredential` additionally revokes OAuth credentials, which is required for the same event for a
   * stronger reason: an access token is issued for one resource, and the authorization server's
   * `resource` binding is what stops it being presented elsewhere. A changed origin therefore makes the
   * stored token invalid — presenting it to the new host is exactly what the specification forbids — so
   * the row goes back to unauthorized and the user authorizes the new origin deliberately. A Bearer key
   * is left alone: nothing binds it to an origin, and discarding a working key because a URL was
   * corrected would be its own surprise.
   */
  async markProbesPending(
    mcpServerId: string,
    agentIds: readonly string[],
    options: { dropCredential?: boolean; invalidateEra?: boolean } = {},
  ): Promise<void> {
    const scope =
      agentIds.length === 0
        ? eq(mcpServerAuthorizations.mcpServerId, mcpServerId)
        : and(
            eq(mcpServerAuthorizations.mcpServerId, mcpServerId),
            inArray(mcpServerAuthorizations.agentId, [...agentIds]),
          );
    const reset = {
      probeState: "pending" as const,
      ...(options.invalidateEra === true ? { protocolEra: null, protocolVersion: null } : {}),
      /*
       * `revision` is bumped so every write already in flight against these rows is fenced out.
       *
       * `revoke` and `setBearerOrNone` bump it, which is exactly why a probe that started before them
       * cannot land afterwards. This path changes the row just as decisively — the endpoint moved, so
       * the snapshot and the credential describe an origin that no longer applies — yet it left the
       * revision alone, so a probe already in flight passed the new fence and wrote `succeeded` plus a
       * tool list from the old origin onto a row that had just been revoked.
       */
      revision: sql`${mcpServerAuthorizations.revision} + 1`,
    };
    if (options.dropCredential !== true) {
      await this.#database.update(mcpServerAuthorizations).set(reset).where(scope);
      return;
    }
    /*
     * Scoped to OAuth rows that actually hold a credential: `none` rows have nothing to drop, and a
     * Bearer row's key is not origin-bound. The envelope is cleared together with its key id, because
     * `credential_pair` requires the two to be present or absent as a pair.
     *
     * The flow columns go too, and they are not optional. A flow that was in progress when the origin
     * changed would otherwise survive this: its callback is located by `state`, and `#redeemCode`
     * writes `status: active` with a token minted by the *old* authorization server — authorizing the
     * new origin with a credential issued for the old one, which is the reuse the specification
     * forbids and the reason this branch exists at all. `state` and `loginSessionHash` are paired by
     * `flow_binding_shape`, so they clear together.
     */
    await this.#database
      .update(mcpServerAuthorizations)
      .set({
        ...reset,
        status: "revoked",
        ciphertext: null,
        keyId: null,
        accessTokenExpiresAt: null,
        state: null,
        stateExpiresAt: null,
        pkceCiphertext: null,
        loginSessionHash: null,
      })
      .where(and(scope, eq(mcpServerAuthorizations.kind, "oauth")));
    await this.#database
      .update(mcpServerAuthorizations)
      .set(reset)
      .where(and(scope, ne(mcpServerAuthorizations.kind, "oauth")));
  }

  // ---------------------------------------------------------------- effective values

  /**
   * The one implementation of effective-configuration resolution. A `null` override inherits; a
   * present value — including an empty header map or an empty scheme string — replaces. "Not set"
   * and "set to empty" are different states, which is why the override columns are nullable.
   */
  static resolveEffectiveConfig(
    server: Pick<typeof mcpServers.$inferSelect, "url" | "authHeader" | "authScheme" | "extraHeaders">,
    binding: Pick<
      typeof agentMcpServers.$inferSelect,
      "urlOverride" | "authHeaderOverride" | "authSchemeOverride" | "extraHeadersOverride"
    >,
  ): MCPEffectiveConfig {
    return {
      url: binding.urlOverride ?? server.url,
      authHeader: binding.authHeaderOverride ?? server.authHeader,
      authScheme: binding.authSchemeOverride ?? server.authScheme,
      extraHeaders: binding.extraHeadersOverride ?? server.extraHeaders,
    };
  }

  static resolveOverrideSources(
    binding: Pick<
      typeof agentMcpServers.$inferSelect,
      "urlOverride" | "authHeaderOverride" | "authSchemeOverride" | "extraHeadersOverride"
    >,
  ): MCPOverrideSources {
    return {
      url: binding.urlOverride !== null,
      authHeader: binding.authHeaderOverride !== null,
      authScheme: binding.authSchemeOverride !== null,
      extraHeaders: binding.extraHeadersOverride !== null,
    };
  }

  // ---------------------------------------------------------------- internals

  /**
   * The joined binding a probe needs: the definition, the Agent's overrides, and the credential row.
   *
   * A soft-deleted Agent has no binding, by construction: the join requires `status <> 'deleted'`, so
   * every caller below — the probe, OAuth `start`, authorization writes, and the reads — refuses a
   * deleted Agent at one choke point instead of each remembering to check. That matters beyond tidiness:
   * these paths perform outbound requests with the Agent's stored credential, so a deleted Agent that
   * still resolved here would keep reaching its MCP Server on behalf of an Account that had retired it.
   */
  async readProbeContext(accountId: string, agentId: string, mcpServerId: string): Promise<McpJoinedBinding> {
    const joined = await this.readJoinedBinding(accountId, agentId, mcpServerId);
    if (!joined) throw mcpBindingNotFound();
    return joined;
  }

  async readJoinedBinding(
    accountId: string,
    agentId: string,
    mcpServerId: string,
  ): Promise<McpJoinedBinding | undefined> {
    const [row] = await this.#database
      .select({ binding: agentMcpServers, server: mcpServers, authorization: mcpServerAuthorizations })
      .from(agentMcpServers)
      .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
      /*
       * A deleted Agent is excluded here rather than checked by each caller, because every path that
       * reads a binding goes on to use the Agent's credential against an external Server.
       */
      .innerJoin(agents, eq(agents.id, agentMcpServers.agentId))
      .leftJoin(
        mcpServerAuthorizations,
        and(
          eq(mcpServerAuthorizations.mcpServerId, agentMcpServers.mcpServerId),
          eq(mcpServerAuthorizations.agentId, agentMcpServers.agentId),
        ),
      )
      .where(
        and(
          eq(agentMcpServers.agentId, agentId),
          eq(agentMcpServers.mcpServerId, mcpServerId),
          eq(mcpServers.accountId, accountId),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return { binding: row.binding, server: row.server, authorization: row.authorization };
  }

  async readAgentServer(accountId: string, agentId: string, mcpServerId: string): Promise<MCPAgentServer> {
    const joined = await this.readJoinedBinding(accountId, agentId, mcpServerId);
    if (!joined) throw mcpBindingNotFound();
    return toAgentServerDto(joined.binding, joined.server, joined.authorization);
  }

  async requireAgentBinding(accountId: string, agentId: string, mcpServerId: string) {
    await this.#requireAgent(accountId, agentId);
    return await this.#requireBinding(agentId, mcpServerId);
  }

  async requireServerRow(accountId: string, mcpServerId: string) {
    return await this.#requireServer(accountId, mcpServerId);
  }

  async requireOwnedAgent(accountId: string, agentId: string) {
    return await this.#requireAgent(accountId, agentId);
  }

  async #requireServer(accountId: string, mcpServerId: string) {
    const [row] = await this.#database
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.accountId, accountId)))
      .limit(1);
    if (!row) throw mcpServerNotFound();
    return row;
  }

  /** Ownership of an Agent is the Account that created it, and a deleted Agent is not addressable. */
  async #requireAgent(accountId: string, agentId: string) {
    const [row] = await this.#database
      .select({ id: agents.id, createdByUserId: agents.createdByUserId, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw new McpServiceError(MCP_ERROR_CODES.SERVER_NOT_FOUND, "The Agent was not found");
    return row;
  }

  async #requireBinding(agentId: string, mcpServerId: string) {
    const [row] = await this.#database
      .select()
      .from(agentMcpServers)
      .where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)))
      .limit(1);
    if (!row) throw mcpBindingNotFound();
    return row;
  }

  /**
   * `boundAgentCount`, `authorizedAgentCount`, and `lastProbedAt` for a set of definitions.
   *
   * `lastProbedAt` is a `max(probed_at)` over the authorization rows rather than a stored column on
   * the definition: the definition has no probe of its own, because each credential probes
   * separately, and keeping the value derived is what lets automatic writes stay off a row whose
   * `revision` belongs to human editors.
   */
  async aggregatesFor(mcpServerIds: readonly string[]): Promise<Map<string, Aggregate>> {
    const aggregates = new Map<string, Aggregate>();
    for (const id of mcpServerIds) {
      aggregates.set(id, { boundAgentCount: 0, authorizedAgentCount: 0, lastProbedAt: null });
    }
    if (mcpServerIds.length === 0) return aggregates;
    const bindings = await this.#database
      .select({ mcpServerId: agentMcpServers.mcpServerId, count: sql<number>`count(*)::int` })
      .from(agentMcpServers)
      .innerJoin(agents, eq(agents.id, agentMcpServers.agentId))
      .where(and(inArray(agentMcpServers.mcpServerId, [...mcpServerIds]), ne(agents.status, "deleted")))
      .groupBy(agentMcpServers.mcpServerId);
    for (const row of bindings) {
      const entry = aggregates.get(row.mcpServerId);
      if (entry) entry.boundAgentCount = row.count;
    }
    const authorizations = await this.#database
      .select({
        mcpServerId: mcpServerAuthorizations.mcpServerId,
        /*
         * Only `active` counts as authorized. A `none` row is active by design and does count, while
         * a revoked, expired, or errored credential does not: the aggregate answers "how many Agents
         * can use this right now", and reporting a revoked row as authorized would hide exactly the
         * state a user needs to act on.
         *
         * `lastProbedAt` stays a max over every row, because it records when a probe happened rather
         * than whether the credential currently works.
         */
        count: sql<number>`count(*) filter (where ${mcpServerAuthorizations.status} = 'active')::int`,
        lastProbedAt: sql<string | null>`max(${mcpServerAuthorizations.probedAt})`,
      })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(and(inArray(mcpServerAuthorizations.mcpServerId, [...mcpServerIds]), ne(agents.status, "deleted")))
      .groupBy(mcpServerAuthorizations.mcpServerId);
    for (const row of authorizations) {
      const entry = aggregates.get(row.mcpServerId);
      if (!entry) continue;
      entry.authorizedAgentCount = row.count;
      entry.lastProbedAt = row.lastProbedAt ? new Date(row.lastProbedAt) : null;
    }
    return aggregates;
  }
}

/**
 * How many Agents actually use this definition: mounted, and not soft-deleted. This is the single
 * judgement the delete guard, both aggregate counts, and the UI's "still in use by" list share, so
 * they can never disagree.
 */
export async function countLiveBindings(
  executor: Pick<DatabaseClient, "select">,
  mcpServerId: string,
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMcpServers)
    .innerJoin(agents, eq(agents.id, agentMcpServers.agentId))
    .where(and(eq(agentMcpServers.mcpServerId, mcpServerId), ne(agents.status, "deleted")));
  return row?.count ?? 0;
}

/** The Agents still using a definition, for the UI's "will affect N Agents" warning. */
export async function liveBindingAgents(
  executor: Pick<DatabaseClient, "select">,
  mcpServerId: string,
): Promise<{ id: string; name: string; displayName: string }[]> {
  return await executor
    .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
    .from(agentMcpServers)
    .innerJoin(agents, eq(agents.id, agentMcpServers.agentId))
    .where(and(eq(agentMcpServers.mcpServerId, mcpServerId), ne(agents.status, "deleted")))
    .orderBy(asc(agents.name));
}

/**
 * Turn an override patch into the columns to write.
 *
 * `extraHeadersOverride` has three states and needs two distinct actions: `clearExtraHeaders` writes
 * `null` (inherit the definition) while `emptyExtraHeaders` writes `{}` (this Agent sends no extra
 * headers at all). Collapsing them would leave a user unable to drop the definition's
 * `x-workspace-id` for one Agent without deleting it for everyone.
 */
function applyOverridePatch(
  binding: typeof agentMcpServers.$inferSelect,
  input: UpdateMCPBindingRequest,
): Partial<typeof agentMcpServers.$inferInsert> {
  const patch: Partial<typeof agentMcpServers.$inferInsert> = {};
  if (input.url !== undefined) patch.urlOverride = input.url;
  if (input.clearUrl === true) patch.urlOverride = null;
  if (input.authHeader !== undefined) patch.authHeaderOverride = input.authHeader;
  if (input.clearAuthHeader === true) patch.authHeaderOverride = null;
  if (input.authScheme !== undefined) patch.authSchemeOverride = input.authScheme;
  if (input.clearAuthScheme === true) patch.authSchemeOverride = null;
  if (input.extraHeaders !== undefined) patch.extraHeadersOverride = normalizeExtraHeaders(input.extraHeaders);
  if (input.clearExtraHeaders === true) patch.extraHeadersOverride = null;
  if (input.emptyExtraHeaders === true) patch.extraHeadersOverride = {};
  rejectAuthHeaderCollision(patch, binding);
  return patch;
}

/**
 * Reject an override whose extra headers would repeat its own authorization header name. The check
 * runs case-insensitively, because HTTP field names are, and it runs against the *resolved* pair so
 * an override of one field cannot collide with an inherited value of the other.
 */
function rejectAuthHeaderCollision(
  patch: Partial<typeof agentMcpServers.$inferInsert>,
  binding: typeof agentMcpServers.$inferSelect,
): void {
  const extra = patch.extraHeadersOverride;
  if (extra === undefined || extra === null) return;
  const authHeader = patch.authHeaderOverride ?? binding.authHeaderOverride;
  if (authHeader === null || authHeader === undefined) return;
  if (Object.keys(extra).some((name) => name.toLowerCase() === authHeader.toLowerCase())) {
    throw new McpServiceError(
      MCP_ERROR_CODES.AUTH_HEADER_INVALID,
      "An extra header may not repeat the authorization header name",
    );
  }
}

function overrideChanged(patch: Partial<typeof agentMcpServers.$inferInsert>): boolean {
  return (
    "urlOverride" in patch ||
    "authHeaderOverride" in patch ||
    "authSchemeOverride" in patch ||
    "extraHeadersOverride" in patch
  );
}

// ------------------------------------------------------------------ view builders

function toServerDto(row: typeof mcpServers.$inferSelect, aggregate: Aggregate | undefined): MCPServer {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: row.url,
    defaultAuthKind: row.defaultAuthKind,
    authHeader: row.authHeader,
    authScheme: row.authScheme,
    extraHeaders: row.extraHeaders,
    revision: row.revision,
    boundAgentCount: aggregate?.boundAgentCount ?? 0,
    authorizedAgentCount: aggregate?.authorizedAgentCount ?? 0,
    lastProbedAt: aggregate?.lastProbedAt ? aggregate.lastProbedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAuthorizationSummary(
  row: typeof mcpServerAuthorizations.$inferSelect | null,
): MCPAuthorizationSummary | null {
  if (!row) return null;
  return {
    kind: row.kind,
    status: row.status,
    // Never the credential itself, not even masked: a caller learns only whether one exists.
    hasCredential: row.ciphertext !== null,
    scopes: row.scopes,
    accessTokenExpiresAt: row.accessTokenExpiresAt ? row.accessTokenExpiresAt.toISOString() : null,
    authorizationServer: row.authorizationServer,
    probeState: row.probeState,
    probedAt: row.probedAt ? row.probedAt.toISOString() : null,
    probeError: row.probeError,
    toolsCount: row.toolsCount,
    toolsTruncated: row.toolsTruncated,
    failureCode: row.failureCode,
    revision: row.revision,
  };
}

export function toProbeSnapshot(row: typeof mcpServerAuthorizations.$inferSelect | null): MCPProbeSnapshot | null {
  if (!row) return null;
  /*
   * `tools` is jsonb, so it is untrusted at read time: a row written by an earlier build, or a
   * snapshot whose shape drifted, must degrade to "no snapshot" rather than crash a reader.
   */
  const tools = Array.isArray(row.tools) ? MCPProbeSnapshotSchema.shape.tools.safeParse(row.tools) : undefined;
  return {
    protocolEra: row.protocolEra,
    protocolVersion: row.protocolVersion,
    serverInfo: row.serverInfo,
    capabilities: row.capabilities,
    instructions: row.instructions,
    tools: tools?.success ? tools.data : null,
  };
}

function toAgentServerDto(
  binding: typeof agentMcpServers.$inferSelect,
  server: typeof mcpServers.$inferSelect,
  authorization: typeof mcpServerAuthorizations.$inferSelect | null,
): MCPAgentServer {
  return {
    mcpServerId: server.id,
    name: server.name,
    description: server.description,
    discoveredDescription: probedServerDescription(authorization?.serverInfo),
    enabled: binding.enabled,
    effective: McpServerService.resolveEffectiveConfig(server, binding),
    overridden: McpServerService.resolveOverrideSources(binding),
    authorization: toAuthorizationSummary(authorization),
    snapshot: toProbeSnapshot(authorization),
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}

function toServerAgentDto(
  binding: typeof agentMcpServers.$inferSelect,
  server: typeof mcpServers.$inferSelect,
  authorization: typeof mcpServerAuthorizations.$inferSelect | null,
  agent: { id: string; name: string; displayName: string },
): MCPServerAgent {
  return {
    agentId: agent.id,
    agentName: agent.name,
    agentDisplayName: agent.displayName,
    enabled: binding.enabled,
    effective: McpServerService.resolveEffectiveConfig(server, binding),
    overridden: McpServerService.resolveOverrideSources(binding),
    // The era belongs to the origin this Agent's effective URL resolved to, so a Server whose mounts
    // point at different origins reports a different era per row.
    protocolEra: authorization?.protocolEra ?? null,
    protocolVersion: authorization?.protocolVersion ?? null,
    authorization: toAuthorizationSummary(authorization),
  };
}
