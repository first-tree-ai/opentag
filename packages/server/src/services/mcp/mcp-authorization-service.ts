import {
  type CreateMCPServerRequest,
  MCP_ACCOUNT_TOOL_SNAPSHOT_MAX_BYTES,
  normalizeExtraHeaders,
} from "@opentag/shared";
import { and, arrayContains, eq, gt, isNotNull, isNull, ne, notInArray, or, type SQL, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agentMcpServers,
  agents,
  mcpClientRegistrations,
  mcpServerAuthorizations,
  mcpServers,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { hashSecret } from "../auth/security.js";
import { boundedMcpSummary, MCP_ERROR_CODES, McpServiceError, mcpServerNotFound } from "./errors.js";
import { buildMcpAuthHeaders } from "./mcp-auth-headers.js";
import {
  invalidateMcpCredentialProbes,
  type McpAuthorizationContext,
  mcpEffectiveConfig,
  readMcpAuthorizationContexts,
  removeMcpLocalAuthorization,
  unlinkMcpSharedAuthorization,
} from "./mcp-authorization-graph.js";
import { lockMcpAccounts, lockMcpCredentialBinding } from "./mcp-binding-locks.js";
import type { McpAuthorizationCredential, McpCredentialCipher } from "./mcp-credential-cipher.js";
import type { McpProbe, McpProbeResult } from "./mcp-probe.js";
import { McpServerService, toServerDto } from "./mcp-server-service.js";

/** Agent-local mounts and probes resolve OAuth credentials through one validated authentication root. */

export interface McpAuthorizationServiceOptions {
  database: DatabaseClient;
  logger?: ServiceLogger;
  cipher: McpCredentialCipher;
  probe: McpProbe;
  servers: McpServerService;
  reusableClient?: (
    url: string,
    issuer: string,
    clientId: string | undefined,
    registrationId: string | null,
  ) => boolean;
  now?: () => Date;
  /**
   * The Account's stored-tool-snapshot bound, in bytes. Overridable so a test can reach it without
   * planting 64 MiB of fixtures; production always uses the published constant.
   */
  accountSnapshotMaxBytes?: number;
}

export interface McpProbeOutcome {
  probeState: "pending" | "succeeded" | "failed";
  probeError: string | null;
  toolsCount: number | null;
  toolsTruncated: boolean;
  protocolEra: "modern" | "legacy" | null;
  protocolVersion: string | null;
}

type ProbeAuthorizationVersion = Pick<typeof mcpServerAuthorizations.$inferSelect, "id" | "revision"> & {
  accountId: string;
  rootId: string;
};

export interface ResolvedMcpCredential {
  binding: typeof agentMcpServers.$inferSelect;
  server: Parameters<typeof McpServerService.resolveEffectiveConfig>[0];
  authorization: typeof mcpServerAuthorizations.$inferSelect;
  credential: McpAuthorizationCredential | undefined;
}

export class McpAuthorizationService {
  readonly #accountSnapshotMaxBytes: number;
  readonly #cipher: McpCredentialCipher;
  readonly #database: DatabaseClient;
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => Date;
  readonly #probe: McpProbe;
  readonly #servers: McpServerService;
  readonly #reusableClient: NonNullable<McpAuthorizationServiceOptions["reusableClient"]>;

  constructor(options: McpAuthorizationServiceOptions) {
    this.#accountSnapshotMaxBytes = options.accountSnapshotMaxBytes ?? MCP_ACCOUNT_TOOL_SNAPSHOT_MAX_BYTES;
    this.#cipher = options.cipher;
    this.#database = options.database;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#probe = options.probe;
    this.#servers = options.servers;
    this.#reusableClient = options.reusableClient ?? (() => false);
  }

  /**
   * Write (or replace) this Agent's Bearer key, or declare it anonymous. Both are an UPSERT into the
   * one row for the pair, so changing kind never leaves a stale credential behind and never needs a
   * delete first — which is also why `kind` is deliberately absent from the envelope's AAD.
   */
  async setBearerOrNone(
    accountId: string,
    agentId: string,
    mcpServerId: string,
    input: { kind: "none" | "bearer"; bearerKey?: string },
    source: "account" | "agent-self" = "account",
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await lockMcpCredentialBinding(transaction, accountId, agentId, mcpServerId, source);
      await removeMcpLocalAuthorization(transaction, agentId, mcpServerId, this.#cipher, true);
      const now = this.#now();
      if (input.kind === "bearer" && (!input.bearerKey || input.bearerKey.length === 0)) {
        throw new McpServiceError(MCP_ERROR_CODES.CREDENTIAL_INPUT_INVALID, "A bearer authorization requires its key");
      }
      /*
       * The sealed value is stored in `access_token` position of the envelope: a Bearer key is this
       * Agent's single credential for the Server, and the envelope shape is shared with OAuth so a
       * kind change is one write rather than a migration.
       *
       * Sealed under the authorization server the row will *end up* with, which is `null`: a bearer
       * credential is not issued by an authorization server, and the write below clears the column for
       * `bearer` and `none` alike. Sealing under the previous row's value instead — as this did — left
       * an envelope the current AAD could not open whenever a row arrived with one set, which is every
       * row after an abandoned OAuth start or an OAuth revoke. The PUT returned 200 and every probe
       * then failed to decrypt.
       */
      const sealed =
        input.kind === "bearer"
          ? this.#cipher.encryptAuthorizationCredential(
              { mcpServerId, agentId, authorizationServer: null },
              { accessToken: input.bearerKey as string },
            )
          : undefined;
      await transaction
        .insert(mcpServerAuthorizations)
        .values({
          agentId,
          mcpServerId,
          kind: input.kind,
          status: "active",
          ciphertext: sealed?.ciphertext ?? null,
          keyId: sealed?.keyId ?? null,
          probeState: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [mcpServerAuthorizations.mcpServerId, mcpServerAuthorizations.agentId],
          set: {
            credentialSourceId: null,
            kind: input.kind,
            status: "active",
            // The new envelope replaces the old in this same statement, so a kind change can never
            // leave behind a ciphertext the current AAD cannot open.
            ciphertext: sealed?.ciphertext ?? null,
            keyId: sealed?.keyId ?? null,
            scopes: null,
            accessTokenExpiresAt: null,
            authorizationServer: null,
            // Replacing or switching the credential replaces its audience; the flow's resource follows
            // `state`, cleared below.
            oauthResource: null,
            clientRegistrationId: null,
            state: null,
            stateExpiresAt: null,
            pkceCiphertext: null,
            /*
             * Cleared with the flow it belongs to. The datastore pairs the two
             * (`mcp_server_authorizations_flow_binding_shape`), and a write that nulled only `state`
             * was rejected outright — switching a row that was mid-flow to a Bearer key failed before
             * it could store anything.
             */
            loginSessionHash: null,
            flowOauthResource: null,
            refreshClaimId: null,
            refreshClaimedAt: null,
            probeState: "pending",
            failureCode: null,
            revision: sql`${mcpServerAuthorizations.revision} + 1`,
            updatedAt: now,
          },
        });
    });
  }

  /** A guarded cancellation ends only that flow; an explicit revoke also drops the credential. */
  async revoke(accountId: string, agentId: string, mcpServerId: string, expectedOAuthState?: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await lockMcpCredentialBinding(transaction, accountId, agentId, mcpServerId);
      const [context] = await readMcpAuthorizationContexts(
        transaction,
        and(eq(mcpServers.accountId, accountId), eq(agentMcpServers.agentId, agentId), eq(mcpServers.id, mcpServerId)),
      );
      if (
        expectedOAuthState === undefined &&
        (await unlinkMcpSharedAuthorization(transaction, context?.localAuthorization, this.#cipher, this.#now()))
      )
        return;
      const root = revocableMcpRoot(context, expectedOAuthState);
      if (!root) return;
      await transaction
        .update(mcpServerAuthorizations)
        .set({
          state: null,
          stateExpiresAt: null,
          pkceCiphertext: null,
          loginSessionHash: null,
          flowAuthorizationServer: null,
          flowOauthResource: null,
          ...(expectedOAuthState && root.ciphertext
            ? {}
            : {
                status: "revoked" as const,
                ciphertext: null,
                keyId: null,
                oauthResource: null,
                accessTokenExpiresAt: null,
                refreshClaimId: null,
                refreshClaimedAt: null,
                refreshGeneration: sql`${mcpServerAuthorizations.refreshGeneration} + 1`,
                failureCode: null,
              }),
          updatedAt: this.#now(),
        })
        .where(eq(mcpServerAuthorizations.id, root.id));
      if (expectedOAuthState && root.ciphertext) {
        await transaction
          .update(mcpServerAuthorizations)
          .set({ revision: sql`${mcpServerAuthorizations.revision} + 1` })
          .where(eq(mcpServerAuthorizations.id, root.id));
      } else await invalidateMcpCredentialProbes(transaction, root.id);
    });
  }

  /** Advisory definition selection; mounting and Connect still validate the current graph. */
  async findReusableInstallation(
    accountId: string,
    agentId: string,
    input: CreateMCPServerRequest,
    scopes: readonly string[] = [],
  ) {
    return this.#database.transaction(
      async (transaction) => {
        const [target] = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")))
          .limit(1);
        if (!target) throw mcpServerNotFound();
        if (!this.#servers.reuseOAuth || input.defaultAuthKind !== "oauth") return null;
        const effective = {
          url: input.url,
          authHeader: input.authHeader ?? "authorization",
          authScheme: input.authScheme ?? "Bearer",
          extraHeaders: normalizeExtraHeaders(input.extraHeaders ?? {}),
        };
        const root = await this.#oldestReusableRoot(
          transaction,
          accountId,
          effective,
          scopes.filter((scope) => scope !== "offline_access"),
          and(
            eq(mcpServers.defaultAuthKind, "oauth"),
            eq(mcpServers.url, effective.url),
            eq(mcpServers.authHeader, effective.authHeader),
            eq(mcpServers.authScheme, effective.authScheme),
            sql`${mcpServers.extraHeaders} = ${JSON.stringify(effective.extraHeaders)}::jsonb`,
          ),
        );
        if (!root) return null;
        const [server] = await transaction.select().from(mcpServers).where(eq(mcpServers.id, root.mcpServerId));
        if (!server) return null;
        const aggregates = await this.#servers.aggregatesFor([server.id], transaction);
        return toServerDto(server, aggregates.get(server.id));
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async connectOAuth(
    accountId: string,
    agentId: string,
    mcpServerId: string,
    scopes: readonly string[] = [],
  ): Promise<boolean> {
    let sourceAuthorizationId: string | undefined;
    const connected = await this.#database.transaction(async (transaction) => {
      await lockMcpCredentialBinding(transaction, accountId, agentId, mcpServerId);
      const [target] = await readMcpAuthorizationContexts(
        transaction,
        and(eq(mcpServers.accountId, accountId), eq(mcpServers.id, mcpServerId), eq(agentMcpServers.agentId, agentId)),
        { tools: false, limit: 1 },
      );
      if (!target) return false;
      if (target.localAuthorization) return hasRequestedOAuth(target.authorization, scopes);
      if (!this.#servers.reuseOAuth) return false;
      const effective = mcpEffectiveConfig(target.server, target.binding);
      const requiredScopes = scopes.filter((scope) => scope !== "offline_access");
      const root = await this.#oldestReusableRoot(
        transaction,
        accountId,
        effective,
        requiredScopes,
        eq(mcpServers.id, mcpServerId),
      );
      if (!root) return false;
      sourceAuthorizationId = root.id;
      await transaction.insert(mcpServerAuthorizations).values({
        agentId,
        mcpServerId,
        kind: "oauth",
        status: "active",
        credentialSourceId: root.id,
        probeState: "pending",
        createdAt: this.#now(),
        updatedAt: this.#now(),
      });
      return true;
    });
    if (connected && sourceAuthorizationId)
      this.#logger?.info(
        { accountId, agentId, mcpServerId, authorizationId: sourceAuthorizationId },
        "MCP OAuth authentication reused",
      );
    return connected;
  }

  async #oldestReusableRoot(
    transaction: DatabaseTransaction,
    accountId: string,
    effective: ReturnType<typeof mcpEffectiveConfig>,
    requiredScopes: string[],
    definitionScope?: SQL,
  ) {
    const rejected: string[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      const [candidate] = await readMcpAuthorizationContexts(
        transaction,
        and(
          eq(mcpServers.accountId, accountId),
          definitionScope,
          isNull(mcpServerAuthorizations.credentialSourceId),
          eq(mcpServerAuthorizations.kind, "oauth"),
          eq(mcpServerAuthorizations.status, "active"),
          isNotNull(mcpServerAuthorizations.ciphertext),
          isNotNull(mcpServerAuthorizations.keyId),
          isNotNull(mcpServerAuthorizations.authorizationServer),
          or(
            isNull(mcpServerAuthorizations.accessTokenExpiresAt),
            gt(mcpServerAuthorizations.accessTokenExpiresAt, this.#now()),
          ),
          sql`coalesce(${agentMcpServers.urlOverride},${mcpServers.url}) = ${effective.url}`,
          sql`coalesce(${agentMcpServers.authHeaderOverride},${mcpServers.authHeader}) = ${effective.authHeader}`,
          sql`coalesce(${agentMcpServers.authSchemeOverride},${mcpServers.authScheme}) = ${effective.authScheme}`,
          sql`coalesce(${agentMcpServers.extraHeadersOverride},${mcpServers.extraHeaders}) = ${JSON.stringify(effective.extraHeaders)}::jsonb`,
          requiredScopes.length ? arrayContains(mcpServerAuthorizations.scopes, requiredScopes) : undefined,
          rejected.length ? notInArray(mcpServerAuthorizations.id, rejected) : undefined,
        ),
        { oldestFirst: true, limit: 1, tools: false },
      );
      const row = candidate?.localAuthorization;
      if (!row?.ciphertext || !row.keyId || !row.authorizationServer) break;
      rejected.push(row.id);
      if (candidate?.authorization?.status !== "active") continue;
      const credential = this.#reusableCredential(row, { ciphertext: row.ciphertext, keyId: row.keyId });
      if (
        !credential ||
        !(await this.#matchesRegistration(transaction, accountId, row, credential.clientId)) ||
        !this.#reusableClient(effective.url, row.authorizationServer, credential.clientId, row.clientRegistrationId)
      )
        continue;
      return row;
    }
    return undefined;
  }

  #reusableCredential(
    row: typeof mcpServerAuthorizations.$inferSelect,
    material: { ciphertext: string; keyId: string },
  ) {
    try {
      return this.#cipher.decryptAuthorizationCredential(
        { mcpServerId: row.mcpServerId, agentId: row.agentId, authorizationServer: row.authorizationServer },
        material,
      );
    } catch {
      this.#logger?.warn({ authorizationId: row.id }, "Unreadable MCP reuse candidate skipped");
      return undefined;
    }
  }

  async #matchesRegistration(
    transaction: DatabaseTransaction,
    accountId: string,
    row: typeof mcpServerAuthorizations.$inferSelect,
    clientId: string | undefined,
  ) {
    if (!row.clientRegistrationId) return true;
    const [registration] = await transaction
      .select({ clientId: mcpClientRegistrations.clientId })
      .from(mcpClientRegistrations)
      .where(
        and(
          eq(mcpClientRegistrations.id, row.clientRegistrationId),
          eq(mcpClientRegistrations.accountId, accountId),
          eq(mcpClientRegistrations.authorizationServer, row.authorizationServer ?? ""),
        ),
      )
      .limit(1);
    return Boolean(registration && (!clientId || registration.clientId === clientId));
  }

  /**
   * Resolve the mounted authentication root in the same Account and decrypt under its current holder.
   */
  async resolveActiveCredential(
    accountId: string,
    agentId: string,
    mcpServerId: string,
  ): Promise<ResolvedMcpCredential | undefined> {
    const context = await this.#servers.readProbeContext(accountId, agentId, mcpServerId);
    return this.#resolveContextCredential(context);
  }

  resolveAccessCredential(context: McpAuthorizationContext): { accessToken: string; clientId?: string } | undefined {
    const credential = this.#resolveContextCredential(context)?.credential;
    return credential
      ? { accessToken: credential.accessToken, ...(credential.clientId ? { clientId: credential.clientId } : {}) }
      : undefined;
  }

  #resolveContextCredential(context: McpAuthorizationContext): ResolvedMcpCredential | undefined {
    const authorization = context.authorization;
    if (authorization?.status !== "active") return undefined;
    const base = { binding: context.binding, server: context.server, authorization };
    if (authorization.kind === "none") return { ...base, credential: undefined };
    if (!authorization.ciphertext || !authorization.keyId) return undefined;
    const credential = this.#cipher.decryptAuthorizationCredential(
      {
        mcpServerId: context.server.id,
        agentId: context.credentialAuthorization?.agentId ?? context.agent.id,
        authorizationServer: authorization.authorizationServer,
      },
      { ciphertext: authorization.ciphertext, keyId: authorization.keyId },
    );
    return { ...base, credential };
  }

  /**
   * The headers one Agent's probe — and any future runtime call — presents to this Server, built
   * from the effective configuration so an Agent override is honored exactly as the UI reports it.
   * Probing and the runtime share this one construction, so a header rule cannot be enforced in one
   * and forgotten in the other.
   */
  async buildHeaders(accountId: string, agentId: string, mcpServerId: string): Promise<Record<string, string>> {
    const resolved = await this.resolveActiveCredential(accountId, agentId, mcpServerId);
    if (!resolved) {
      throw new McpServiceError(
        MCP_ERROR_CODES.AUTHORIZATION_REQUIRED,
        "This Agent is not authorized for this MCP Server",
      );
    }
    return this.buildHeadersFor(resolved);
  }

  /** The same construction from an already-resolved row, for a caller that just read one. */
  buildHeadersFor(resolved: ResolvedMcpCredential): Record<string, string> {
    const { authorization, credential } = resolved;
    const effective = McpServerService.resolveEffectiveConfig(resolved.server, resolved.binding);
    const token = credential?.accessToken;
    return buildMcpAuthHeaders({
      kind: authorization.kind,
      authHeader: effective.authHeader,
      authScheme: effective.authScheme,
      extraHeaders: effective.extraHeaders,
      ...(token && authorization.kind === "oauth" ? { accessToken: token } : {}),
      ...(token && authorization.kind === "bearer" ? { bearerKey: token } : {}),
    });
  }

  /** Probe this Agent's credential and write the snapshot onto its own authorization row. */
  async probe(accountId: string, agentId: string, mcpServerId: string): Promise<McpProbeOutcome> {
    const context = await this.#servers.readProbeContext(accountId, agentId, mcpServerId);
    const authorization = context.authorization;
    if (authorization?.status !== "active") {
      throw new McpServiceError(
        MCP_ERROR_CODES.AUTHORIZATION_REQUIRED,
        "This Agent is not authorized for this MCP Server",
      );
    }
    const effective = McpServerService.resolveEffectiveConfig(context.server, context.binding);
    /*
     * The row and revision this probe was built from. Every write below is fenced on both: a detached
     * and recreated authorization can reuse a revision, but has a different row id. The probe
     * takes an upstream round trip and the row can be re-authorized or revoked while it is in flight:
     * without the fence a slow result landed on a row that had since been changed — revoking a
     * credential and immediately re-probing brought back `succeeded` and a tool snapshot on the
     * revoked row, and replacing key A with key B let A's slower answer overwrite B's.
     */
    const expected = {
      id: authorization.id,
      revision: authorization.revision,
      accountId,
      rootId: context.credentialAuthorization?.id ?? authorization.id,
    };
    let result: McpProbeResult;
    try {
      const headers = await this.buildHeaders(accountId, agentId, mcpServerId);
      result = await this.#probe.probe({
        accountId,
        url: effective.url,
        authHeaders: headers,
        cachedEra: authorization.protocolEra,
        cachedVersion: authorization.protocolVersion,
      });
    } catch (error) {
      return await this.#persistProbeFailure(mcpServerId, agentId, error, false, expected);
    }
    if (result.probeState === "failed") {
      return await this.#persistProbeFailure(mcpServerId, agentId, result, result.eraInvalidated, expected);
    }
    // The write can still be refused for exceeding the Account's snapshot budget, in which case the
    // reported outcome must match what was stored rather than what the Server answered.
    const refusal = await this.#persistProbeSuccess(mcpServerId, agentId, result, expected);
    if (refusal) return refusal;
    return {
      probeState: "succeeded",
      probeError: null,
      toolsCount: result.toolsCount,
      toolsTruncated: result.toolsTruncated,
      protocolEra: result.protocolEra,
      protocolVersion: result.protocolVersion,
    };
  }

  /** The outcome of the last probe of one row, for `mcp probe` to report. */
  async readProbeOutcome(accountId: string, agentId: string, mcpServerId: string): Promise<McpProbeOutcome> {
    const context = await this.#servers.readProbeContext(accountId, agentId, mcpServerId);
    const authorization = context.authorization;
    if (!authorization) return pendingOutcome();
    return {
      probeState: authorization.probeState,
      probeError: authorization.probeError,
      toolsCount: authorization.toolsCount,
      toolsTruncated: authorization.toolsTruncated,
      protocolEra: authorization.protocolEra,
      protocolVersion: authorization.protocolVersion,
    };
  }

  /**
   * A failed probe records the failure and leaves every snapshot column alone: the last good tool
   * list stays readable, and the UI shows "probe failed" beside it rather than going blank.
   */
  /**
   * Record a probe failure on the row.
   *
   * The input is either a thrown error or a `McpProbeResult` that already failed. The distinction
   * matters: the probe composes its own bounded `probeError` from the specific cause —
   * `MCP_URL_BLOCKED`, `MCP_PROTOCOL_UNSUPPORTED`, and so on — and re-deriving a code from the
   * result object would flatten every one of those into the generic `MCP_PROBE_FAILED`, hiding from
   * the user exactly the fact that tells them what to fix.
   */
  async #persistProbeFailure(
    mcpServerId: string,
    agentId: string,
    failure: unknown,
    eraInvalidated: boolean,
    expected: ProbeAuthorizationVersion,
  ): Promise<McpProbeOutcome> {
    const probeError = probeErrorOf(failure);
    const now = this.#now();
    await this.#writeProbe(mcpServerId, agentId, expected, {
      probeState: "failed",
      probeError,
      ...(eraInvalidated ? { protocolEra: null, protocolVersion: null } : {}),
      updatedAt: now,
    });
    return {
      probeState: "failed",
      probeError,
      toolsCount: null,
      toolsTruncated: false,
      protocolEra: null,
      protocolVersion: null,
    };
  }

  /**
   * A successful probe writes only this authorization row. The shared definition's `revision` is
   * untouched, so a probe running while a user edits the definition cannot make the user's
   * `expectedRevision` stale.
   *
   * The snapshot is refused when storing it would push the Account's total past its hard bound. That
   * is a deliberate failure rather than a silent eviction: the bound exists because a snapshot is per
   * credential, so a hundred Agents on one Server multiply the same tool list a hundred times. An
   * Account that reaches it needs to be told which Servers to drop.
   */
  async #persistProbeSuccess(
    mcpServerId: string,
    agentId: string,
    result: McpProbeResult,
    expected: ProbeAuthorizationVersion,
  ): Promise<McpProbeOutcome | undefined> {
    const now = this.#now();
    const stored = await this.#writeProbe(
      mcpServerId,
      agentId,
      expected,
      {
        probeState: "succeeded",
        probedAt: now,
        probeError: null,
        serverInfo: result.serverInfo ?? null,
        capabilities: result.capabilities ?? null,
        instructions: result.instructions,
        tools: result.tools,
        toolsCount: result.toolsCount,
        toolsTruncated: result.toolsTruncated,
        protocolEra: result.protocolEra,
        protocolVersion: result.protocolVersion,
        updatedAt: now,
      },
      result.tools,
    );
    if (stored === "budget")
      return this.#persistProbeFailure(
        mcpServerId,
        agentId,
        new McpServiceError(
          MCP_ERROR_CODES.PROBE_FAILED,
          "The Account's stored MCP tool snapshots would exceed 64 MiB; remove unused Servers",
        ),
        false,
        expected,
      );
    return undefined;
  }

  async #writeProbe(
    mcpServerId: string,
    agentId: string,
    expected: ProbeAuthorizationVersion,
    values: Partial<typeof mcpServerAuthorizations.$inferInsert>,
    tools?: McpProbeResult["tools"],
  ) {
    return this.#database.transaction(async (transaction) => {
      await lockMcpAccounts(transaction, [expected.accountId]);
      const [current] = await readMcpAuthorizationContexts(
        transaction,
        and(
          eq(mcpServers.accountId, expected.accountId),
          eq(mcpServers.id, mcpServerId),
          eq(agentMcpServers.agentId, agentId),
        ),
        { tools: false, limit: 1 },
      );
      if (
        current?.authorization?.status !== "active" ||
        current.localAuthorization?.id !== expected.id ||
        current.localAuthorization.revision !== expected.revision ||
        current.credentialAuthorization?.id !== expected.rootId
      )
        return "superseded";
      if (tools && (await this.#exceedsAccountSnapshotBudget(mcpServerId, agentId, tools, transaction)))
        return "budget";
      const [stored] = await transaction
        .update(mcpServerAuthorizations)
        .set(values)
        .where(
          and(
            eq(mcpServerAuthorizations.id, expected.id),
            eq(mcpServerAuthorizations.revision, expected.revision),
            eq(mcpServerAuthorizations.agentId, agentId),
          ),
        )
        .returning({ id: mcpServerAuthorizations.id });
      return stored ? "stored" : "superseded";
    });
  }

  /**
   * Whether this snapshot would take the Account past `MCP_ACCOUNT_TOOL_SNAPSHOT_MAX_BYTES`.
   *
   * The total excludes this row's current contribution, because the probe replaces that row rather
   * than adding to it. `pg_column_size` measures the stored bytes, which is what the bound is about.
   */
  async #exceedsAccountSnapshotBudget(
    mcpServerId: string,
    agentId: string,
    tools: McpProbeResult["tools"],
    executor: Pick<DatabaseClient, "select"> = this.#database,
  ): Promise<boolean> {
    const [row] = await executor
      .select({
        accountId: agents.createdByUserId,
        currentBytes: sql<number>`coalesce(pg_column_size(${mcpServerAuthorizations.tools}), 0)::bigint`,
      })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(and(eq(mcpServerAuthorizations.mcpServerId, mcpServerId), eq(mcpServerAuthorizations.agentId, agentId)))
      .limit(1);
    if (!row) return false;
    const [total] = await executor
      .select({ bytes: sql<number>`coalesce(sum(pg_column_size(${mcpServerAuthorizations.tools})), 0)::bigint` })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(eq(agents.createdByUserId, row.accountId));
    const otherBytes = Number(total?.bytes ?? 0) - Number(row.currentBytes ?? 0);
    const nextBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
    return otherBytes + nextBytes > this.#accountSnapshotMaxBytes;
  }
}

function pendingOutcome(): McpProbeOutcome {
  return {
    probeState: "pending",
    probeError: null,
    toolsCount: null,
    toolsTruncated: false,
    protocolEra: null,
    protocolVersion: null,
  };
}

/**
 * The bounded public failure string for a probe.
 *
 * A `McpProbeResult` already carries one composed from its specific cause, so it is used verbatim.
 * Anything else is a thrown error whose code is the specific one when it is an `McpServiceError`.
 */
function probeErrorOf(failure: unknown): string {
  // A failed probe result always carries a composed message; the fallback covers a result that
  // somehow reached here without one, so the column is never written as null after a failure.
  if (isProbeResult(failure) && failure.probeError) return failure.probeError;
  const code = failure instanceof McpServiceError ? failure.code : MCP_ERROR_CODES.PROBE_FAILED;
  const summary = boundedMcpSummary(
    failure instanceof Error && failure.message.length > 0 ? failure.message : "The MCP Server could not be probed",
  );
  return `${code}: ${summary}`;
}

/** Whether a value is a probe result rather than an error, without importing the class. */
function isProbeResult(value: unknown): value is { probeError: string | null } {
  return typeof value === "object" && value !== null && "probeState" in value;
}

function hasRequestedOAuth(
  authorization: typeof mcpServerAuthorizations.$inferSelect | null,
  scopes: readonly string[],
): boolean {
  if (authorization?.kind !== "oauth" || authorization.status !== "active" || !authorization.ciphertext) return false;
  return scopes.filter((scope) => scope !== "offline_access").every((scope) => authorization.scopes?.includes(scope));
}

function revocableMcpRoot(context: McpAuthorizationContext | undefined, expectedState: string | undefined) {
  const root = context?.credentialAuthorization;
  if (expectedState && (!root || root.state !== hashSecret(expectedState)))
    throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization attempt has already ended");
  return root;
}
