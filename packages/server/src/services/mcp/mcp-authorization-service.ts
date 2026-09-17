import { MCP_ACCOUNT_TOOL_SNAPSHOT_MAX_BYTES } from "@opentag/shared";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { type agentMcpServers, agents, mcpServerAuthorizations } from "../../db/schema/index.js";
import { boundedMcpSummary, MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import { buildMcpAuthHeaders } from "./mcp-auth-headers.js";
import type { McpAuthorizationCredential, McpCredentialCipher } from "./mcp-credential-cipher.js";
import type { McpProbe, McpProbeResult } from "./mcp-probe.js";
import { McpServerService } from "./mcp-server-service.js";

/**
 * Per-Agent authorization: resolving the one row that decides this Agent's access to this Server,
 * and writing it for each kind.
 *
 * Resolution has exactly one step and no Account-level fallback: an `active` row for this
 * `(Server, Agent)` pair is used, and anything else means unauthorized. That is what lets two Agents
 * of one Account hold different kinds — a Bearer key for one, OAuth for the other — on one Server.
 *
 * `none` is written as a real row rather than treated as an absence, so the pair always has exactly
 * one row and a probe always has somewhere to put its snapshot.
 */

export interface McpAuthorizationServiceOptions {
  database: DatabaseClient;
  cipher: McpCredentialCipher;
  probe: McpProbe;
  servers: McpServerService;
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
  readonly #now: () => Date;
  readonly #probe: McpProbe;
  readonly #servers: McpServerService;

  constructor(options: McpAuthorizationServiceOptions) {
    this.#accountSnapshotMaxBytes = options.accountSnapshotMaxBytes ?? MCP_ACCOUNT_TOOL_SNAPSHOT_MAX_BYTES;
    this.#cipher = options.cipher;
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#probe = options.probe;
    this.#servers = options.servers;
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
  ): Promise<void> {
    const context = await this.#servers.readProbeContext(accountId, agentId, mcpServerId);
    const now = this.#now();
    if (input.kind === "bearer" && (!input.bearerKey || input.bearerKey.length === 0)) {
      throw new McpServiceError(MCP_ERROR_CODES.CREDENTIAL_INPUT_INVALID, "A bearer authorization requires its key");
    }
    /*
     * The sealed value is stored in `access_token` position of the envelope: a Bearer key is this
     * Agent's single credential for the Server, and the envelope shape is shared with OAuth so a
     * kind change is one write rather than a migration.
     */
    const sealed =
      input.kind === "bearer"
        ? this.#cipher.encryptAuthorizationCredential(
            { mcpServerId, agentId, authorizationServer: context.authorization?.authorizationServer ?? null },
            { accessToken: input.bearerKey as string },
          )
        : undefined;
    await this.#database
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
          kind: input.kind,
          status: "active",
          // The new envelope replaces the old in this same statement, so a kind change can never
          // leave behind a ciphertext the current AAD cannot open.
          ciphertext: sealed?.ciphertext ?? null,
          keyId: sealed?.keyId ?? null,
          scopes: null,
          accessTokenExpiresAt: null,
          authorizationServer: null,
          clientRegistrationId: null,
          state: null,
          stateExpiresAt: null,
          pkceCiphertext: null,
          refreshClaimId: null,
          refreshClaimedAt: null,
          probeState: "pending",
          failureCode: null,
          revision: sql`${mcpServerAuthorizations.revision} + 1`,
          updatedAt: now,
        },
      });
  }

  /** Drop the credential and the snapshot. The mount stays; the Agent is simply unauthorized again. */
  async revoke(accountId: string, agentId: string, mcpServerId: string): Promise<void> {
    await this.#servers.requireAgentBinding(accountId, agentId, mcpServerId);
    const now = this.#now();
    await this.#database
      .update(mcpServerAuthorizations)
      .set({
        status: "revoked",
        ciphertext: null,
        keyId: null,
        accessTokenExpiresAt: null,
        state: null,
        stateExpiresAt: null,
        pkceCiphertext: null,
        refreshClaimId: null,
        refreshClaimedAt: null,
        probeState: "pending",
        probeError: null,
        tools: null,
        toolsCount: null,
        toolsTruncated: false,
        failureCode: null,
        revision: sql`${mcpServerAuthorizations.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(mcpServerAuthorizations.agentId, agentId), eq(mcpServerAuthorizations.mcpServerId, mcpServerId)));
  }

  /**
   * The entire resolution chain for one Agent and one Server: an active row, or nothing. There is no
   * Account-level row to fall back to, which is the whole point of the per-Agent design.
   */
  async resolveActiveCredential(
    accountId: string,
    agentId: string,
    mcpServerId: string,
  ): Promise<ResolvedMcpCredential | undefined> {
    const context = await this.#servers.readProbeContext(accountId, agentId, mcpServerId);
    const authorization = context.authorization;
    if (authorization?.status !== "active") return undefined;
    const base = { binding: context.binding, server: context.server, authorization };
    if (authorization.kind === "none") return { ...base, credential: undefined };
    if (!authorization.ciphertext || !authorization.keyId) return undefined;
    const credential = this.#cipher.decryptAuthorizationCredential(
      { mcpServerId, agentId, authorizationServer: authorization.authorizationServer },
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
      return await this.#persistProbeFailure(mcpServerId, agentId, error, false);
    }
    if (result.probeState === "failed") {
      return await this.#persistProbeFailure(mcpServerId, agentId, result, result.eraInvalidated);
    }
    // The write can still be refused for exceeding the Account's snapshot budget, in which case the
    // reported outcome must match what was stored rather than what the Server answered.
    const refusal = await this.#persistProbeSuccess(mcpServerId, agentId, result);
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
  ): Promise<McpProbeOutcome> {
    const probeError = probeErrorOf(failure);
    const now = this.#now();
    await this.#database
      .update(mcpServerAuthorizations)
      .set({
        probeState: "failed",
        probeError,
        /*
         * Only a protocol-class failure invalidates the cached era. A timeout, a 5xx, or a 401 are
         * not evidence that the origin changed its protocol, and re-detecting on them would throw
         * away a correct cache on every transient error.
         */
        ...(eraInvalidated ? { protocolEra: null, protocolVersion: null } : {}),
        updatedAt: now,
      })
      .where(and(eq(mcpServerAuthorizations.agentId, agentId), eq(mcpServerAuthorizations.mcpServerId, mcpServerId)));
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
  ): Promise<McpProbeOutcome | undefined> {
    const now = this.#now();
    if (await this.#exceedsAccountSnapshotBudget(mcpServerId, agentId, result.tools)) {
      return await this.#persistProbeFailure(
        mcpServerId,
        agentId,
        new McpServiceError(
          MCP_ERROR_CODES.PROBE_FAILED,
          "The Account's stored MCP tool snapshots would exceed 64 MiB; remove unused Servers",
        ),
        false,
      );
    }
    await this.#database
      .update(mcpServerAuthorizations)
      .set({
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
      })
      .where(and(eq(mcpServerAuthorizations.agentId, agentId), eq(mcpServerAuthorizations.mcpServerId, mcpServerId)));
    return undefined;
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
  ): Promise<boolean> {
    const [row] = await this.#database
      .select({
        accountId: agents.createdByUserId,
        currentBytes: sql<number>`coalesce(pg_column_size(${mcpServerAuthorizations.tools}), 0)::bigint`,
      })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(and(eq(mcpServerAuthorizations.mcpServerId, mcpServerId), eq(mcpServerAuthorizations.agentId, agentId)))
      .limit(1);
    if (!row) return false;
    const [total] = await this.#database
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
