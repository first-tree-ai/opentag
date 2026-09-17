import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, mcpClientRegistrations, mcpServerAuthorizations } from "../../db/schema/index.js";
import { hashSecret } from "../auth/security.js";
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
 * Two bindings make the callback safe to expose publicly, and both are copied from the GitHub flow
 * rather than invented here:
 *
 * - **The row is found by the hash of the state, not the state.** A leaked database row (a backup, a
 *   log of a query) cannot be turned into a redeemable callback URL for a flow nobody started.
 * - **The flow records the hash of the initiating browser's session proof.** The callback must
 *   present the matching secret. Without it, developer A could start a flow, hand the resulting
 *   `authorizationUrl` to developer B, and B's approval — a genuine consent screen for a genuine
 *   deployment, because the `client_id` is deployment-wide — would land a credential on A's Agent.
 *   That is session fixation, and the state alone does not prevent it: A knows the state, so nothing
 *   in it distinguishes A's browser from B's.
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
    /*
     * The initiating browser's flow secret. Required, not optional: a caller that forgot it would
     * silently produce an unbound flow, which is the vulnerability this parameter exists to close.
     */
    flowSecret: string,
  ): Promise<StartedMcpOAuth> {
    const context = await this.#servers.readProbeContext(accountId, agentId, mcpServerId);
    const effective = McpServerService.resolveEffectiveConfig(context.server, context.binding);
    const existing = context.authorization;

    const { metadata, client, registrationId, challengeScope, resource } = await this.#discoverForStart(
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
        // Stored hashed: the raw state is only ever in the URL the browser carries.
        state: hashSecret(state),
        stateExpiresAt: expiresAt,
        pkceCiphertext: sealedPkce.ciphertext,
        scopes,
        loginSessionHash: hashSecret(flowSecret),
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
          state: hashSecret(state),
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
          loginSessionHash: hashSecret(flowSecret),
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
    registrationId: string | null;
    challengeScope: string | undefined;
    resource: string;
  }> {
    const { metadata: prm, challengeScope } = await this.#oauth.protectedResourceMetadata(accountId, url);
    const candidates = orderIssuers(prm.authorizationServers, recordedIssuer);
    const failures: string[] = [];
    for (const issuer of candidates) {
      try {
        const metadata = await this.#oauth.authorizationServerMetadata(accountId, issuer);
        /*
         * A client already registered with this issuer is reused rather than registered again.
         *
         * Registering unconditionally looks harmless because `#recordRegistration` upserts in place
         * and keeps the row id — but the row is keyed by `(account, issuer)`, so it holds ONE client
         * for the whole Account. A second `start` therefore rotated `client_id` and the secret out
         * from under every authorization already pointing at that row: their next refresh presented
         * the wrong client, `invalid_client` is terminal, and the row went to `status: error`.
         * Authorizing a second Agent silently killed the first.
         *
         * Reuse also keeps a flow's own client stable: the authorization request named the client
         * returned here, so nothing may replace it between this call and the callback.
         */
        const { client, registrationId } = await this.#clientForStart(accountId, metadata);
        return {
          metadata,
          client,
          registrationId,
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
   * The client a new flow should present at this issuer, plus the registration row to record on it.
   *
   * Reuse is the whole point: the row is keyed by `(Account, issuer)`, so registering on every start
   * replaced the one client every existing authorization at that issuer points at. Their next refresh
   * then presented a client the authorization server had never seen, `invalid_client` is terminal,
   * and the credential was destroyed — so authorizing a second Agent silently killed the first.
   *
   * Order of preference, matching the discovery rules:
   * - a `preregistered` row, which is the deployment's own client and always wins;
   * - an existing DCR row, reused as-is;
   * - otherwise a fresh registration, which is the only case that writes the row.
   *
   * A CIMD client is not a row at all — it is this deployment's URL — so it is resolved rather than
   * looked up, and `registrationId` stays null for it.
   */
  async #clientForStart(
    accountId: string,
    metadata: McpAuthorizationServerMetadata,
  ): Promise<{ client: McpClientCredentials; registrationId: string | null }> {
    const preregistered = await this.#readPreregistered(accountId, metadata.issuer);
    if (preregistered) {
      const row = await this.#readRegistrationRow(accountId, metadata.issuer, "preregistered");
      return { client: preregistered, registrationId: row?.id ?? null };
    }
    if (metadata.clientIdMetadataDocumentSupported) {
      /*
       * The CIMD client is this deployment's own metadata URL, so it is the same on every start and
       * recording it is idempotent — unlike a DCR registration, re-recording cannot invalidate a flow
       * that already named it. A row is kept because the schema models one per mechanism and the
       * callback and refresh find their client through `client_registration_id`.
       */
      const client: McpClientCredentials = {
        source: "cimd",
        clientId: this.#oauth.clientMetadataUrl,
        tokenEndpointAuthMethod: "none",
      };
      const registrationId = await this.#recordRegistration(accountId, metadata, client, this.#now());
      return { client, registrationId };
    }
    const existing = await this.#readRegistrationRow(accountId, metadata.issuer, "dcr");
    if (existing) {
      const client = await this.#clientFromRow(accountId, existing);
      return { client, registrationId: existing.id };
    }
    const client = await this.#oauth.registerDynamically(accountId, metadata);
    const registrationId = await this.#recordRegistration(accountId, metadata, client, this.#now());
    return { client, registrationId };
  }

  /** One registration row for `(Account, issuer)`, by the mechanism that created it. */
  async #readRegistrationRow(
    accountId: string,
    issuer: string,
    source: typeof mcpClientRegistrations.$inferSelect.source,
  ) {
    const [row] = await this.#database
      .select()
      .from(mcpClientRegistrations)
      .where(
        and(
          eq(mcpClientRegistrations.accountId, accountId),
          eq(mcpClientRegistrations.authorizationServer, issuer),
          eq(mcpClientRegistrations.source, source),
        ),
      )
      .limit(1);
    return row;
  }

  /** A stored row as the credential to present, decrypting the secret it carries. */
  async #clientFromRow(
    accountId: string,
    row: typeof mcpClientRegistrations.$inferSelect,
  ): Promise<McpClientCredentials> {
    const clientSecret =
      row.ciphertext && row.keyId
        ? this.#cipher.decryptClientSecret(
            { accountId, authorizationServer: row.authorizationServer },
            { ciphertext: row.ciphertext, keyId: row.keyId },
          )
        : undefined;
    return {
      source: row.source,
      clientId: row.clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
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
   * Complete the round trip. The row is located by the hash of its one-time `state`, then checked for
   * the initiating browser's flow secret, expiry, and pending status; any failure past that point
   * clears the flow so a stale callback cannot be replayed.
   *
   * `flowSecret` is the value the initiating browser holds in its cookie. It is what stops a
   * callback that was started by someone else from landing here: the state travels in the URL and is
   * therefore known to whoever was handed the URL, while the secret never leaves the first browser.
   */
  async callback(
    query: {
      code?: string;
      state: string;
      error?: string;
      iss?: string;
    },
    flowSecret: string | undefined,
  ): Promise<{ accountId: string; agentId: string; mcpServerId: string }> {
    const row = await this.#locateFlow(query.state, flowSecret);
    const { authorization, agentId, accountId } = row;
    if (query.error) {
      /*
       * A denial is terminal, so it is recorded as such rather than only cleared.
       *
       * Clearing the flow left `status` at `pending`, and the poll's terminal conditions require it to
       * leave `pending` — so a user who denied the request waited out the full ten minutes, and a
       * failed exchange did the same. `failureCode` carries the bounded reason for the row's reader.
       */
      await this.#failFlow(
        authorization.id,
        query.error === "access_denied" ? MCP_ERROR_CODES.OAUTH_DENIED : MCP_ERROR_CODES.OAUTH_FAILED,
      );
      throw new McpServiceError(
        query.error === "access_denied" ? MCP_ERROR_CODES.OAUTH_DENIED : MCP_ERROR_CODES.OAUTH_FAILED,
        "The authorization was not granted",
      );
    }
    const mcpServerId = authorization.mcpServerId;
    if (!query.code) {
      await this.#failFlow(authorization.id, MCP_ERROR_CODES.OAUTH_FLOW_INVALID);
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
      const client = await this.#readClientCredentials(accountId, metadata, authorization.clientRegistrationId);
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
          // Single use: the state, its verifier, and the flow binding are gone the moment the code is redeemed.
          state: null,
          stateExpiresAt: null,
          pkceCiphertext: null,
          loginSessionHash: null,
          probeState: "pending",
          revision: sql`${authorization.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(mcpServerAuthorizations.id, authorization.id));
    } catch (error) {
      /*
       * A failed exchange is terminal too: the code is spent, so retrying cannot help and leaving the
       * row `pending` would just be a wait that ends in a timeout. The flow is cleared and a terminal
       * status recorded, and a transient failure is left pending because a retry can still succeed.
       */
      await this.#failFlow(
        authorization.id,
        error instanceof McpServiceError && error.category === "transient" ? undefined : MCP_ERROR_CODES.OAUTH_FAILED,
      );
      throw error;
    }
    return { accountId, agentId, mcpServerId };
  }

  async #locateFlow(
    state: string,
    flowSecret: string | undefined,
  ): Promise<{
    authorization: typeof mcpServerAuthorizations.$inferSelect;
    agentId: string;
    accountId: string;
  }> {
    /*
     * A missing secret is rejected before the lookup rather than after, so an attacker without the
     * cookie learns nothing about whether the state exists.
     */
    if (!flowSecret) {
      throw new McpServiceError(
        MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
        "The authorization flow was not started by this browser",
      );
    }
    const [row] = await this.#database
      .select({ authorization: mcpServerAuthorizations, accountId: agents.createdByUserId })
      .from(mcpServerAuthorizations)
      .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
      // The state is stored hashed, so the callback's raw value is hashed the same way to find it.
      .where(eq(mcpServerAuthorizations.state, hashSecret(state)))
      .limit(1);
    if (!row) {
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization flow is no longer valid");
    }
    const authorization = row.authorization;
    /*
     * A mismatched secret does NOT clear the flow.
     *
     * Clearing here would hand anyone who learned a `state` an unauthenticated way to destroy a
     * pending authorization: present the state with a garbage cookie and the flow is gone. It also
     * made two concurrent flows hopeless — one cookie name at one path means starting flow B
     * replaces the cookie flow A is holding, and A's callback would then have killed A. An
     * unauthorized caller simply gets nothing.
     */
    if (authorization.loginSessionHash !== hashSecret(flowSecret)) {
      throw new McpServiceError(
        MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
        "The authorization flow was not started by this browser",
      );
    }
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
      .set({ state: null, stateExpiresAt: null, pkceCiphertext: null, loginSessionHash: null, updatedAt: this.#now() })
      .where(eq(mcpServerAuthorizations.id, id));
  }

  /**
   * End a flow that cannot succeed, so a waiter stops waiting.
   *
   * `status` must leave `pending`: the poll in `mcp authorize` and the page's probe indicator both end
   * on a status other than `pending`, so a row that only had its state cleared kept a user waiting for
   * the flow's full ten minutes after a denial. `failureCode` records the bounded reason.
   *
   * Passing no code means the failure is transient — the flow's state is cleared and the row is left
   * `pending` for a retry, which is the one case where waiting is still the right answer.
   */
  async #failFlow(id: string, failureCode: string | undefined): Promise<void> {
    await this.#database
      .update(mcpServerAuthorizations)
      .set({
        state: null,
        stateExpiresAt: null,
        pkceCiphertext: null,
        loginSessionHash: null,
        ...(failureCode === undefined ? {} : { status: "error", failureCode }),
        updatedAt: this.#now(),
      })
      .where(eq(mcpServerAuthorizations.id, id));
  }

  /**
   * The client to redeem the code with.
   *
   * The flow row already carries `clientRegistrationId`, so the callback and every later refresh use
   * exactly the client the authorization request named. Resolving a client *fresh* here would
   * register a second one and then present the first one's code under it — which a strict
   * authorization server refuses with `invalid_client`.
   *
   * CIMD is the one mechanism with no row to record: the client is this deployment's metadata URL, so
   * it is derived rather than looked up, and it is by construction the same client the authorization
   * request named.
   */
  async #readClientCredentials(
    accountId: string,
    metadata: McpAuthorizationServerMetadata,
    clientRegistrationId: string | null,
  ): Promise<McpClientCredentials> {
    /*
     * A pre-registered client is stable for the Account and issuer, so it is preferred: it is what
     * the authorization request named, and there is exactly one of them per pair.
     */
    const preregistered = await this.#readPreregistered(accountId, metadata.issuer);
    if (preregistered) return preregistered;
    if (clientRegistrationId) {
      const recorded = await this.#readRegistration(accountId, clientRegistrationId, metadata.issuer);
      if (recorded) return recorded;
    } else if (metadata.clientIdMetadataDocumentSupported) {
      return {
        source: "cimd",
        clientId: this.#oauth.clientMetadataUrl,
        tokenEndpointAuthMethod: "none",
      };
    }
    /*
     * Nothing usable: the flow predates this registration, or the row was pruned. Registering a new
     * client here would produce one the authorization request never named, so the exchange could not
     * succeed anyway — and on the DCR path it would also overwrite the Account's shared registration
     * with a client that no in-flight flow is using.
     */
    throw new McpServiceError(
      MCP_ERROR_CODES.REGISTRATION_FAILED,
      "The client registration for this authorization flow is no longer available",
    );
  }

  /**
   * Read one recorded registration back, with its secret.
   *
   * Scoped to the issuer as well as the Account: a client registered with one authorization server
   * is not presented to another. Returns undefined rather than throwing for a row that no longer
   * exists, so the caller decides what that means.
   */
  async #readRegistration(accountId: string, id: string, issuer: string): Promise<McpClientCredentials | undefined> {
    const [row] = await this.#database
      .select()
      .from(mcpClientRegistrations)
      .where(
        and(
          eq(mcpClientRegistrations.id, id),
          eq(mcpClientRegistrations.accountId, accountId),
          eq(mcpClientRegistrations.authorizationServer, issuer),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    const clientSecret = row.ciphertext
      ? this.#cipher.decryptClientSecret(
          { accountId, authorizationServer: row.authorizationServer },
          { ciphertext: row.ciphertext, keyId: row.keyId as string },
        )
      : undefined;
    return {
      clientId: row.clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      source: row.source,
      // The same derivation the pre-registered path uses: a stored secret means basic auth.
      tokenEndpointAuthMethod: row.ciphertext ? "client_secret_basic" : "none",
    };
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
      const client = await this.#readClientCredentials(row.accountId, metadata, row.clientRegistrationId);
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
