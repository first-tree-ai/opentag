import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, mcpClientRegistrations, mcpServerAuthorizations } from "../../db/schema/index.js";
import { MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import type { McpCredentialCipher } from "./mcp-credential-cipher.js";
import {
  MCP_OAUTH_STATE_TTL_MS,
  type McpAuthorizationServerMetadata,
  type McpClientCredentials,
  McpOAuthClient,
  mcpCallbackRedirect,
} from "./mcp-oauth.js";
import { McpServerService } from "./mcp-server-service.js";

/**
 * The OAuth round trip for one `(Server, Agent)` pair, plus token maintenance.
 *
 * The flow is stateful on the row the authorization already owns, following the existing GitHub
 * precedent: `state`, its deadline, and the encrypted PKCE verifier live there, and a repeated start
 * simply overwrites them, which invalidates the previous `state` immediately.
 *
 * Discovery runs on every start but never on a refresh: a refresh only needs the endpoint the row
 * already recorded, and re-discovering there would let a peer move our token endpoint mid-flight.
 */

export interface McpOAuthFlowServiceOptions {
  database: DatabaseClient;
  cipher: McpCredentialCipher;
  oauth: McpOAuthClient;
  servers: McpServerService;
  now?: () => Date;
}

export interface StartedMcpOAuth {
  authorizationUrl: string;
  expiresAt: Date;
}

export class McpOAuthFlowService {
  readonly #cipher: McpCredentialCipher;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #oauth: McpOAuthClient;
  readonly #servers: McpServerService;

  constructor(options: McpOAuthFlowServiceOptions) {
    this.#cipher = options.cipher;
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#oauth = options.oauth;
    this.#servers = options.servers;
  }

  /**
   * Begin (or restart) the flow. Every start re-runs discovery so a changed authorization server is
   * detected here rather than at refresh time; when it changed, a DCR or pre-registered credential
   * is not reused, per the specification, and the previous authorization is revoked with a clear
   * "authorize again" signal. CIMD credentials are portable across issuers and are reused.
   */
  async start(
    accountId: string,
    agentId: string,
    mcpServerId: string,
    requestedScopes: readonly string[] = [],
  ): Promise<StartedMcpOAuth> {
    const context = await this.#servers.readProbeContext(accountId, agentId, mcpServerId);
    const effective = McpServerService.resolveEffectiveConfig(context.server, context.binding);
    const existing = context.authorization;

    const { metadata, client, challengeScope, resource } = await this.#discoverForStart(
      accountId,
      effective.url,
      existing?.authorizationServer ?? null,
    );

    const pkce = McpOAuthClient.createPkcePair();
    const state = McpOAuthClient.createState();
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + MCP_OAUTH_STATE_TTL_MS);
    const sealedPkce = this.#cipher.encryptPkceVerifier(
      { mcpServerId, agentId, authorizationServer: metadata.issuer },
      pkce.verifier,
    );
    const registrationId = await this.#recordRegistration(accountId, metadata, client, now);
    const scopes = this.#oauth.resolveScopes(challengeScope, [], metadata, requestedScopes);
    const authorizationUrl = this.#oauth.authorizationUrl({
      metadata,
      clientId: client.clientId,
      state,
      codeChallenge: pkce.challenge,
      resource,
      scopes,
    });

    await this.#database
      .insert(mcpServerAuthorizations)
      .values({
        agentId,
        mcpServerId,
        kind: "oauth",
        status: "pending",
        authorizationServer: metadata.issuer,
        clientRegistrationId: registrationId,
        state,
        stateExpiresAt: expiresAt,
        pkceCiphertext: sealedPkce.ciphertext,
        scopes,
        probeState: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpServerAuthorizations.mcpServerId, mcpServerAuthorizations.agentId],
        set: {
          kind: "oauth",
          // A restarted flow invalidates the previous state in the same write, so an old callback
          // URL can no longer be redeemed.
          state,
          stateExpiresAt: expiresAt,
          pkceCiphertext: sealedPkce.ciphertext,
          authorizationServer: metadata.issuer,
          clientRegistrationId: registrationId,
          scopes,
          status: "pending",
          ciphertext: null,
          keyId: null,
          accessTokenExpiresAt: null,
          failureCode: null,
          probeState: "pending",
          refreshClaimId: null,
          refreshClaimedAt: null,
          revision: sql`${mcpServerAuthorizations.revision} + 1`,
          updatedAt: now,
        },
      });
    return { authorizationUrl, expiresAt };
  }

  /**
   * Resolve the authorization server for a start. The row's recorded issuer is preferred, but a
   * credential that cannot cross issuers is only reused when the issuer is unchanged.
   */
  async #discoverForStart(
    accountId: string,
    url: string,
    recordedIssuer: string | null,
  ): Promise<{
    metadata: McpAuthorizationServerMetadata;
    client: McpClientCredentials;
    challengeScope: string | undefined;
    resource: string;
  }> {
    const { metadata: prm, challengeScope } = await this.#oauth.protectedResourceMetadata(accountId, url);
    const candidates = orderIssuers(prm.authorizationServers, recordedIssuer);
    const failures: string[] = [];
    for (const issuer of candidates) {
      try {
        const metadata = await this.#oauth.authorizationServerMetadata(accountId, issuer);
        const preregistered = await this.#readPreregistered(accountId, issuer);
        const client = await this.#oauth.resolveClientCredentials(accountId, metadata, preregistered);
        return {
          metadata,
          client,
          challengeScope,
          resource: normalizeResource(prm.resource, url),
        };
      } catch (error) {
        /*
         * Every candidate is tried in order and the first one that can complete discovery, client
         * resolution, and authorization-URL construction wins. A failure on one issuer is not fatal
         * to the others — an AS that is down must not block one that works.
         */
        if (error instanceof McpServiceError && error.code === MCP_ERROR_CODES.URL_BLOCKED) throw error;
        if (error instanceof McpServiceError && error.code === MCP_ERROR_CODES.REGISTRATION_UNSUPPORTED) {
          failures.push(`${issuer}: no registration mechanism`);
          continue;
        }
        failures.push(`${issuer}: ${error instanceof McpServiceError ? error.code : "discovery failed"}`);
      }
    }
    throw new McpServiceError(
      MCP_ERROR_CODES.OAUTH_FAILED,
      `No authorization server of this MCP Server could be used (tried ${failures.length})`,
      { tried: failures.slice(0, 4) },
    );
  }

  async #readPreregistered(accountId: string, issuer: string): Promise<McpClientCredentials | undefined> {
    const [row] = await this.#database
      .select()
      .from(mcpClientRegistrations)
      .where(
        and(
          eq(mcpClientRegistrations.accountId, accountId),
          eq(mcpClientRegistrations.authorizationServer, issuer),
          eq(mcpClientRegistrations.source, "preregistered"),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return {
      source: "preregistered",
      clientId: row.clientId,
      ...(row.ciphertext && row.keyId
        ? {
            clientSecret: this.#cipher.decryptClientSecret(
              { accountId, authorizationServer: issuer },
              { ciphertext: row.ciphertext, keyId: row.keyId },
            ),
          }
        : {}),
      tokenEndpointAuthMethod: row.ciphertext ? "client_secret_basic" : "none",
    };
  }

  /**
   * Persist the client credential against `(Account, issuer)`. `mcp_client_registrations` is
   * append-only: deleting a row when its last referencing Server disappeared would need a
   * cross-table reference count that is both expensive and easy to get wrong, to save a few dozen
   * bytes. The row is the Account's registration at that AS, reusable by every Server that resolves
   * there — which is its whole purpose.
   */
  async #recordRegistration(
    accountId: string,
    metadata: McpAuthorizationServerMetadata,
    client: McpClientCredentials,
    now: Date,
  ): Promise<string> {
    const sealed = client.clientSecret
      ? this.#cipher.encryptClientSecret({ accountId, authorizationServer: metadata.issuer }, client.clientSecret)
      : undefined;
    const [row] = await this.#database
      .insert(mcpClientRegistrations)
      .values({
        accountId,
        authorizationServer: metadata.issuer,
        source: client.source,
        clientId: client.clientId,
        ciphertext: sealed?.ciphertext ?? null,
        keyId: sealed?.keyId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpClientRegistrations.accountId, mcpClientRegistrations.authorizationServer],
        set: {
          source: client.source,
          clientId: client.clientId,
          ciphertext: sealed?.ciphertext ?? null,
          keyId: sealed?.keyId ?? null,
          updatedAt: now,
        },
      })
      .returning({ id: mcpClientRegistrations.id });
    if (!row) throw new McpServiceError(MCP_ERROR_CODES.REGISTRATION_FAILED, "The client registration was not stored");
    return row.id;
  }

  /**
   * Complete the round trip. The row is located by its one-time `state`, then checked for expiry and
   * pending status; any failure past that point clears the flow so a stale callback cannot be replayed.
   */
  async callback(query: {
    code?: string;
    state: string;
    error?: string;
    iss?: string;
  }): Promise<{ agentId: string; mcpServerId: string }> {
    const row = await this.#locateFlow(query.state);
    const { authorization, agentId, accountId } = row;
    if (query.error) {
      await this.#clearFlow(authorization.id);
      throw new McpServiceError(
        query.error === "access_denied" ? MCP_ERROR_CODES.OAUTH_DENIED : MCP_ERROR_CODES.OAUTH_FAILED,
        "The authorization was not granted",
      );
    }
    const mcpServerId = authorization.mcpServerId;
    if (!query.code) {
      await this.#clearFlow(authorization.id);
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization response carried no code");
    }
    try {
      const metadata = await this.#oauth.authorizationServerMetadata(accountId, requireIssuer(authorization));
      /*
       * `iss` is validated before anything from the response is used. On a mismatch the response's
       * own `error` values are never shown or adopted, because a mismatched response is evidence of
       * an attack rather than a hint about what went wrong.
       */
      this.#oauth.validateIssuer(metadata, query.iss, metadata.issuer);
      const binding = { mcpServerId, agentId, authorizationServer: metadata.issuer };
      const codeVerifier = this.#cipher.decryptPkceVerifier(binding, requirePkce(authorization));
      const client = await this.#readClientCredentials(accountId, metadata);
      const context = await this.#servers.readProbeContext(accountId, agentId, mcpServerId);
      const effective = McpServerService.resolveEffectiveConfig(context.server, context.binding);
      const tokens = await this.#oauth.exchangeAuthorizationCode(accountId, metadata, {
        code: query.code,
        codeVerifier,
        client,
        resource: normalizeResource(undefined, effective.url),
      });
      const sealed = this.#cipher.encryptAuthorizationCredential(binding, {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
      });
      const now = this.#now();
      await this.#database
        .update(mcpServerAuthorizations)
        .set({
          status: "active",
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : authorization.scopes,
          accessTokenExpiresAt: tokens.expiresIn ? new Date(now.getTime() + tokens.expiresIn * 1000) : null,
          failureCode: null,
          // Single use: the state and its verifier are gone the moment the code is redeemed.
          state: null,
          stateExpiresAt: null,
          pkceCiphertext: null,
          probeState: "pending",
          revision: sql`${authorization.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(mcpServerAuthorizations.id, authorization.id));
    } catch (error) {
      await this.#clearFlow(authorization.id);
      throw error;
    }
    return { agentId, mcpServerId };
  }

  async #locateFlow(state: string): Promise<{
    authorization: typeof mcpServerAuthorizations.$inferSelect;
    agentId: string;
    accountId: string;
  }> {
    const [row] = await this.#database
      .select({ authorization: mcpServerAuthorizations, accountId: agents.createdByUserId })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      .where(eq(mcpServerAuthorizations.state, state))
      .limit(1);
    if (!row) {
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization flow is no longer valid");
    }
    const authorization = row.authorization;
    if (!authorization.stateExpiresAt || authorization.stateExpiresAt.getTime() <= this.#now().getTime()) {
      await this.#clearFlow(authorization.id);
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED, "The authorization flow has expired");
    }
    if (authorization.status !== "pending") {
      await this.#clearFlow(authorization.id);
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization flow is no longer pending");
    }
    return { authorization, agentId: authorization.agentId, accountId: row.accountId };
  }

  async #clearFlow(id: string): Promise<void> {
    await this.#database
      .update(mcpServerAuthorizations)
      .set({ state: null, stateExpiresAt: null, pkceCiphertext: null, updatedAt: this.#now() })
      .where(eq(mcpServerAuthorizations.id, id));
  }

  async #readClientCredentials(
    accountId: string,
    metadata: McpAuthorizationServerMetadata,
  ): Promise<McpClientCredentials> {
    const preregistered = await this.#readPreregistered(accountId, metadata.issuer);
    if (preregistered) return preregistered;
    const client = await this.#oauth.resolveClientCredentials(accountId, metadata);
    await this.#recordRegistration(accountId, metadata, client, this.#now());
    return client;
  }

  /** The fixed local surface a callback lands on, carrying only a bounded outcome. */
  redirectFor(agentId: string, mcpServerId: string, errorCode?: string): string {
    return mcpCallbackRedirect(this.#oauth.publicUrl, agentId, mcpServerId, errorCode);
  }

  // ---------------------------------------------------------------- refresh

  /**
   * Refresh one row, single-flighted by a claim and fenced by a generation.
   *
   * The failure taxonomy is deliberately conservative. A transport failure, a timeout, or a 5xx
   * leaves the outcome genuinely unknown — the AS may or may not have rotated the refresh token — so
   * the token is kept (discarding it would strand the user) and the row is marked as needing
   * reauthorization, never silently retried. Only `invalid_grant` and `invalid_client` are terminal,
   * because only they mean the credential is definitively gone.
   */
  async refreshAuthorization(authorizationId: string): Promise<void> {
    const claimId = randomUUID();
    const claimed = await this.#claimForRefresh(authorizationId, claimId);
    if (!claimed) return;
    const row = claimed;
    const binding = {
      mcpServerId: row.mcpServerId,
      agentId: row.agentId,
      authorizationServer: row.authorizationServer,
    };
    let credential: { accessToken: string; refreshToken?: string };
    try {
      if (!row.ciphertext || !row.keyId) throw new Error("no envelope");
      credential = this.#cipher.decryptAuthorizationCredential(binding, {
        ciphertext: row.ciphertext,
        keyId: row.keyId,
      });
    } catch {
      // Nothing was sent anywhere, so the claim is simply released and the next pass retries.
      await this.#releaseClaim(authorizationId, claimId);
      return;
    }
    if (!credential.refreshToken) {
      // No refresh token to spend: the credential lapses rather than being retried forever.
      await this.#markExpired(authorizationId, claimId);
      return;
    }
    try {
      const metadata = await this.#oauth.authorizationServerMetadata(row.accountId, requireIssuer(row));
      const client = await this.#readClientCredentials(row.accountId, metadata);
      const context = await this.#servers.readProbeContext(row.accountId, row.agentId, row.mcpServerId);
      const effective = McpServerService.resolveEffectiveConfig(context.server, context.binding);
      const tokens = await this.#oauth.refreshAccessToken(row.accountId, metadata, {
        refreshToken: credential.refreshToken,
        client,
        resource: normalizeResource(undefined, effective.url),
      });
      const sealed = this.#cipher.encryptAuthorizationCredential(binding, {
        accessToken: tokens.accessToken,
        // Rotation: keep the previous refresh token when the AS did not issue a new one (RFC 6749 §6).
        refreshToken: tokens.refreshToken ?? credential.refreshToken,
      });
      const now = this.#now();
      await this.#database
        .update(mcpServerAuthorizations)
        .set({
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          accessTokenExpiresAt: tokens.expiresIn ? new Date(now.getTime() + tokens.expiresIn * 1000) : null,
          ...(tokens.scope ? { scopes: tokens.scope.split(/\s+/).filter(Boolean) } : {}),
          status: "active",
          failureCode: null,
          refreshClaimId: null,
          refreshClaimedAt: null,
          refreshGeneration: sql`${mcpServerAuthorizations.refreshGeneration} + 1`,
          lastRefreshedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(mcpServerAuthorizations.id, authorizationId), eq(mcpServerAuthorizations.refreshClaimId, claimId)),
        );
      // A successful refresh does not re-probe: the tool list is a snapshot of the Server, not of
      // this token, and the credential change alone is not evidence the capabilities moved.
    } catch (error) {
      await this.#classifyRefreshFailure(authorizationId, claimId, error);
    }
  }

  /**
   * Claim the row for one refresh pass. The claim is taken with a single CAS so two workers cannot
   * both spend the same refresh token, and a stale claim from a crashed worker expires after two
   * minutes rather than wedging the row forever.
   */
  async #claimForRefresh(
    authorizationId: string,
    claimId: string,
  ): Promise<(typeof mcpServerAuthorizations.$inferSelect & { accountId: string }) | undefined> {
    const staleBefore = new Date(this.#now().getTime() - 2 * 60 * 1000);
    const now = this.#now();
    const [row] = await this.#database
      .update(mcpServerAuthorizations)
      .set({ refreshClaimId: claimId, refreshClaimedAt: now })
      .where(
        and(
          eq(mcpServerAuthorizations.id, authorizationId),
          eq(mcpServerAuthorizations.kind, "oauth"),
          eq(mcpServerAuthorizations.status, "active"),
          or(
            isNull(mcpServerAuthorizations.refreshClaimId),
            lte(mcpServerAuthorizations.refreshClaimedAt, staleBefore),
          ),
        ),
      )
      .returning();
    if (!row) return undefined;
    const [owner] = await this.#database
      .select({ accountId: agents.createdByUserId })
      .from(agents)
      .where(eq(agents.id, row.agentId))
      .limit(1);
    if (!owner) {
      await this.#releaseClaim(authorizationId, claimId);
      return undefined;
    }
    return { ...row, accountId: owner.accountId };
  }

  async #releaseClaim(authorizationId: string, claimId: string): Promise<void> {
    await this.#database
      .update(mcpServerAuthorizations)
      .set({ refreshClaimId: null, refreshClaimedAt: null })
      .where(and(eq(mcpServerAuthorizations.id, authorizationId), eq(mcpServerAuthorizations.refreshClaimId, claimId)));
  }

  async #markExpired(authorizationId: string, claimId: string): Promise<void> {
    await this.#database
      .update(mcpServerAuthorizations)
      .set({
        status: "expired",
        refreshClaimId: null,
        refreshClaimedAt: null,
        updatedAt: this.#now(),
      })
      .where(and(eq(mcpServerAuthorizations.id, authorizationId), eq(mcpServerAuthorizations.refreshClaimId, claimId)));
  }

  /**
   * The failure classification table, in one place. Each branch exists because it demands a
   * different operator action: renew the credential, re-register the client, or re-authorize.
   */
  async #classifyRefreshFailure(authorizationId: string, claimId: string, error: unknown): Promise<void> {
    const now = this.#now();
    const detail = error instanceof McpServiceError ? error.detail : undefined;
    const upstreamError = typeof detail?.error === "string" ? detail.error : undefined;
    const terminal = upstreamError === "invalid_grant" || upstreamError === "invalid_client";
    const unknownOutcome = !(error instanceof McpServiceError) || error.code === MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE;
    await this.#database
      .update(mcpServerAuthorizations)
      .set({
        ...(terminal
          ? { status: "revoked", ciphertext: null, keyId: null, accessTokenExpiresAt: null }
          : unknownOutcome
            ? // Result unknown: keep the refresh token, refuse to auto-retry, and ask a human. The
              // specification's point is that a blind retry could spend a token the AS already
              // rotated away, which loses the credential outright.
              { status: "error", failureCode: MCP_ERROR_CODES.REFRESH_OUTCOME_UNKNOWN }
            : {
                status: "error",
                failureCode: error instanceof McpServiceError ? error.code : MCP_ERROR_CODES.OAUTH_FAILED,
              }),
        refreshClaimId: null,
        refreshClaimedAt: null,
        updatedAt: now,
      })
      .where(and(eq(mcpServerAuthorizations.id, authorizationId), eq(mcpServerAuthorizations.refreshClaimId, claimId)));
  }
}

/** Prefer the issuer the row already recorded; the remaining candidates keep their PRM order. */
export function orderIssuers(issuers: readonly string[], recorded: string | null): string[] {
  if (!recorded || !issuers.includes(recorded)) return [...issuers];
  return [recorded, ...issuers.filter((issuer) => issuer !== recorded)];
}

/**
 * The `resource` parameter's exact spelling: lowercase scheme and host, no fragment, and no trailing
 * slash unless the path is only a slash. Case tolerance is for the peer's spelling, not ours.
 */
export function normalizeResource(advertised: string | undefined, fallback: string): string {
  const source = advertised && advertised.length > 0 ? advertised : fallback;
  const url = new URL(source);
  url.protocol = url.protocol.toLowerCase();
  url.host = url.host.toLowerCase();
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function requireIssuer(row: { authorizationServer: string | null }): string {
  if (!row.authorizationServer) {
    throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FAILED, "The authorization row has no authorization server");
  }
  return row.authorizationServer;
}

function requirePkce(row: { pkceCiphertext: string | null }): { ciphertext: string; keyId: string } {
  if (!row.pkceCiphertext) {
    throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization flow has no PKCE verifier");
  }
  // The verifier is sealed as one envelope; the ciphertext embeds the key ID it was written with.
  const keyId = /^v2\.([a-z0-9][a-z0-9-]{0,62})\./.exec(row.pkceCiphertext)?.[1];
  if (!keyId) throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The PKCE verifier is unreadable");
  return { ciphertext: row.pkceCiphertext, keyId };
}
