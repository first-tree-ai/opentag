import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  GOOGLE_WORKSPACE_MCP_AUTHORIZATION_SERVER,
  isGoogleWorkspaceMcpEndpoint,
  isMcpStaticOAuthEndpoint,
  MCP_CATALOG_DEPLOYMENT_ENDPOINTS,
  MCP_OAUTH_HANDOFF_PATH,
  MCP_STATIC_OAUTH_PROVIDERS,
  type MCPCatalogEndpoint,
  type McpStaticOAuthBrand,
} from "@opentag/shared";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agentMcpServers,
  agents,
  mcpClientRegistrations,
  mcpServerAuthorizations,
  mcpServers,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { generateSecret, hashSecret } from "../auth/security.js";
import { MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import {
  invalidateMcpCredentialProbes,
  type McpAuthorizationContext,
  mcpConfigEqual,
  mcpEffectiveConfig,
  readMcpAuthorizationContexts,
  readMcpCredentialRoot,
} from "./mcp-authorization-graph.js";
import { lockMcpAccounts, lockMcpCredentialBinding } from "./mcp-binding-locks.js";
import type { McpCredentialCipher } from "./mcp-credential-cipher.js";
import {
  MCP_OAUTH_STATE_TTL_MS,
  type McpAuthorizationServerMetadata,
  type McpClientCredentials,
  McpOAuthClient,
  mcpCallbackRedirect,
  normalizeAuthorizationServerIssuer,
  normalizeResource,
  resourceRelatesToEndpoint,
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
  /**
   * The deployment's pre-registered Google Workspace OAuth client, present only when the
   * `OPENTAG_MCP_GOOGLE_CLIENT_*` pair is configured. It is offered only to the Google-hosted MCP
   * endpoints that resolve Google's authorization server, ahead of every other registration
   * mechanism, and the secret is presented only at that authorization server's token endpoint.
   */
  googleMcpClient?: { clientId: string; clientSecret: string };
  /**
   * The deployment's static clients for providers without DCR or CIMD,
   * keyed by brand and present only for a brand whose `OPENTAG_MCP_<BRAND>_CLIENT_*` pair is
   * configured. Each is offered only to that provider's own MCP origins and exact issuer. Canva's is
   * Developer Portal only: the waitlist endpoint at `mcp.canva.com` keeps its automatic resolution.
   */
  staticMcpClients?: Partial<Record<McpStaticOAuthBrand, { clientId: string; clientSecret: string }>>;
  now?: () => Date;
  logger?: ServiceLogger;
}

/**
 * One OAuth client this deployment registered with a provider out of band and configured through the
 * environment. Both halves of the binding are required before it is offered: the Server's effective
 * origin must be the provider's own, and the discovered issuer must be exactly the provider's.
 */
interface DeploymentOAuthClient {
  matchesEndpoint: (effectiveUrl: string) => boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationParams?: Record<string, string>;
  /** What the provider's authorization server accepts at its token endpoint. */
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
  /** The catalog entry whose endpoint this client requires, when it differs from the shipped one. */
  catalogId?: string;
}

function deploymentOAuthClients(options: McpOAuthFlowServiceOptions): readonly DeploymentOAuthClient[] {
  const clients: DeploymentOAuthClient[] = [];
  if (options.googleMcpClient) {
    clients.push({
      matchesEndpoint: isGoogleWorkspaceMcpEndpoint,
      issuer: GOOGLE_WORKSPACE_MCP_AUTHORIZATION_SERVER,
      tokenEndpointAuthMethod: "client_secret_basic",
      ...options.googleMcpClient,
      // Google issues a refresh token only for an offline request, and again only with fresh consent.
      authorizationParams: { access_type: "offline", prompt: "consent" },
    });
  }
  for (const provider of MCP_STATIC_OAUTH_PROVIDERS) {
    const client = options.staticMcpClients?.[provider.brand];
    if (!client) continue;
    clients.push({
      matchesEndpoint: (effectiveUrl) => isMcpStaticOAuthEndpoint(provider, effectiveUrl),
      issuer: provider.issuer,
      tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
      ...client,
      ...(provider.catalogId === undefined ? {} : { catalogId: provider.catalogId }),
    });
  }
  return clients;
}

export interface StartedMcpOAuth {
  authorizationUrl: string;
  expiresAt: Date;
  state: string;
}

export class McpOAuthFlowService {
  readonly #cipher: McpCredentialCipher;
  readonly #database: DatabaseClient;
  readonly #deploymentClients: readonly DeploymentOAuthClient[];
  readonly #now: () => Date;
  readonly #oauth: McpOAuthClient;
  readonly #servers: McpServerService;
  readonly #logger: ServiceLogger | undefined;

  constructor(options: McpOAuthFlowServiceOptions) {
    this.#cipher = options.cipher;
    this.#database = options.database;
    this.#deploymentClients = deploymentOAuthClients(options);
    this.#now = options.now ?? (() => new Date());
    this.#oauth = options.oauth;
    this.#servers = options.servers;
    this.#logger = options.logger;
  }

  /**
   * The catalog entries whose endpoint this deployment replaces, because a configured client requires
   * a different endpoint than the one the catalog ships. No client material is returned.
   */
  catalogEndpoints(): MCPCatalogEndpoint[] {
    return this.#deploymentClients.flatMap((client) => {
      const url = client.catalogId === undefined ? undefined : MCP_CATALOG_DEPLOYMENT_ENDPOINTS[client.catalogId];
      return client.catalogId === undefined || url === undefined ? [] : [{ catalogId: client.catalogId, url }];
    });
  }

  reusableClient(
    effectiveUrl: string,
    issuer: string,
    clientId: string | undefined,
    registrationId: string | null,
  ): boolean {
    const deployed = this.#deploymentClients.find(
      (client) => client.matchesEndpoint(effectiveUrl) && client.issuer === issuer,
    );
    return deployed
      ? clientId === deployed.clientId
      : registrationId !== null || clientId === this.#oauth.clientMetadataUrl;
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
    source: "account" | "agent-self" = "account",
  ): Promise<StartedMcpOAuth> {
    const context = await this.#prepareAuthorization(accountId, agentId, mcpServerId, source);
    const effective = McpServerService.resolveEffectiveConfig(context.server, context.binding);
    const existing = context.authorization;

    const { metadata, client, registrationId, challengeScope, resource, prmScopes } = await this.#discoverForStart(
      accountId,
      effective.url,
      existing?.authorizationServer ?? null,
    );

    const pkce = McpOAuthClient.createPkcePair();
    const state = McpOAuthClient.createState();
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + MCP_OAUTH_STATE_TTL_MS);
    /*
     * The protected resource's own scopes are the fallback the specification names, and for Google
     * they are load-bearing: an authorization request with no `scope` at all is rejected outright.
     */
    const scopes = this.#oauth.resolveScopes(challengeScope, prmScopes, metadata, requestedScopes);
    const authorizationUrl = this.#oauth.authorizationUrl({
      metadata,
      clientId: client.clientId,
      state,
      codeChallenge: pkce.challenge,
      resource,
      scopes,
      ...(client.authorizationParams ? { authorizationParams: client.authorizationParams } : {}),
    });

    await this.#database.transaction(async (transaction) => {
      await lockMcpCredentialBinding(transaction, accountId, agentId, mcpServerId, source);
      const [current] = await readMcpAuthorizationContexts(
        transaction,
        and(eq(mcpServers.accountId, accountId), eq(mcpServers.id, mcpServerId), eq(agentMcpServers.agentId, agentId)),
      );
      requireUnchangedMcpBinding(context, current, effective);
      const root = current.credentialAuthorization;
      const holder = root?.agentId ?? agentId;
      const family = root
        ? await transaction
            .select({ id: mcpServerAuthorizations.id })
            .from(mcpServerAuthorizations)
            .where(eq(mcpServerAuthorizations.credentialSourceId, root.id))
            .limit(1)
        : [];
      const sharedFormat =
        this.#servers.reuseOAuth || Boolean(current.localAuthorization?.credentialSourceId) || family.length > 0;
      const sealedPkce = sharedFormat
        ? this.#cipher.encryptPkceFlow(
            { mcpServerId, agentId: holder, authorizationServer: metadata.issuer },
            {
              version: 2,
              accountId,
              initiatingAgentId: agentId,
              codeVerifier: pkce.verifier,
              clientId: client.clientId,
              registrationId,
              scopes,
              config: effective,
            },
          )
        : this.#cipher.encryptPkceVerifier(
            { mcpServerId, agentId: holder, authorizationServer: metadata.issuer },
            pkce.verifier,
          );
      const flow = {
        state: hashSecret(state),
        stateExpiresAt: expiresAt,
        pkceCiphertext: sealedPkce.ciphertext,
        loginSessionHash: hashSecret(flowSecret),
        flowAuthorizationServer: metadata.issuer,
        flowOauthResource: resource,
        updatedAt: now,
      };
      if (root) {
        await transaction
          .update(mcpServerAuthorizations)
          .set({
            ...flow,
            kind: "oauth",
            // The old credential and refresh claim remain valid until consent succeeds.
            ...(!root.ciphertext
              ? {
                  kind: "oauth" as const,
                  status: "pending" as const,
                  authorizationServer: metadata.issuer,
                  clientRegistrationId: registrationId,
                  scopes,
                  failureCode: null,
                }
              : {}),
            revision: sql`${mcpServerAuthorizations.revision} + 1`,
          })
          .where(eq(mcpServerAuthorizations.id, root.id));
      } else {
        await transaction.insert(mcpServerAuthorizations).values({
          ...flow,
          agentId,
          mcpServerId,
          kind: "oauth",
          status: "pending",
          authorizationServer: metadata.issuer,
          clientRegistrationId: registrationId,
          scopes,
          probeState: "pending",
          createdAt: now,
        });
      }
    });
    return { authorizationUrl, expiresAt, state };
  }

  async #prepareAuthorization(
    accountId: string,
    agentId: string,
    mcpServerId: string,
    source: "account" | "agent-self",
  ) {
    return this.#database.transaction(async (transaction) => {
      await lockMcpCredentialBinding(transaction, accountId, agentId, mcpServerId, source);
      const [context] = await readMcpAuthorizationContexts(
        transaction,
        and(eq(mcpServers.accountId, accountId), eq(mcpServers.id, mcpServerId), eq(agentMcpServers.agentId, agentId)),
        { tools: false, limit: 1 },
      );
      if (!context) throw new McpServiceError(MCP_ERROR_CODES.BINDING_NOT_FOUND, "The MCP binding was not found");
      if (context.localAuthorization) return context;
      const [root] = await transaction
        .insert(mcpServerAuthorizations)
        .values({
          agentId,
          mcpServerId,
          kind: "oauth",
          status: "pending",
          createdAt: this.#now(),
          updatedAt: this.#now(),
        })
        .returning();
      if (!root) throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FAILED, "The authorization could not be prepared");
      return { ...context, authorization: root, localAuthorization: root, credentialAuthorization: root };
    });
  }

  /**
   * Start an OAuth flow with a same-origin handoff URL for Agent self-service.
   *
   * An Agent CLI or runtime cannot set cookies in the user's browser directly.
   * By routing through `MCP_OAUTH_HANDOFF_PATH`, the user's browser receives the
   * required single-use `mcpOAuthContext` cookie and is immediately redirected to
   * the upstream provider authorization URL, preserving full PKCE/state/cookie security.
   */
  async startWithHandoff(
    accountId: string,
    agentId: string,
    mcpServerId: string,
    requestedScopes: readonly string[] = [],
    publicOrigin: string,
    source: "account" | "agent-self" = "agent-self",
  ): Promise<StartedMcpOAuth> {
    const flowSecret = randomUUID();
    const started = await this.start(accountId, agentId, mcpServerId, requestedScopes, flowSecret, source);
    const handoffUrl = this.createHandoffUrl({
      flowSecret,
      authorizationUrl: started.authorizationUrl,
      state: started.state,
      expiresAt: started.expiresAt,
      publicOrigin,
    });
    return {
      authorizationUrl: handoffUrl,
      expiresAt: started.expiresAt,
      state: started.state,
    };
  }

  createHandoffUrl(params: {
    flowSecret: string;
    authorizationUrl: string;
    state: string;
    expiresAt: Date;
    publicOrigin: string;
  }): string {
    const token = this.#cipher.encryptHandoff({
      flowSecret: params.flowSecret,
      targetUrl: params.authorizationUrl,
      stateHash: hashSecret(params.state),
      expiresAt: params.expiresAt.getTime(),
    });
    const origin = params.publicOrigin.replace(/\/+$/, "");
    return `${origin}${MCP_OAUTH_HANDOFF_PATH}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Redeem a handoff token for the browser secret the callback will compare against.
   *
   * Three properties make this safe to expose as a link a human clicks:
   *
   * - The caller must be signed in, and the signed-in Account must own the Agent the flow belongs to
   *   (`expectedAccountId`). Otherwise a link an Agent posted into a shared channel would bind
   *   *whoever clicked it* into the Agent's authorization. A mismatch is reported as
   *   `MCP_SERVER_NOT_FOUND`, the same bounded answer a caller gets for a token that does not exist,
   *   so the response never tells a stranger whether the flow is real.
   * - Redemption is single use. The row's `loginSessionHash` is compared and then replaced with the
   *   hash of a fresh browser secret in one conditional update, so the token that was redeemed can
   *   never be redeemed again — a replay updates nothing and is refused.
   * - The returned secret is the *new* one, which the route sets as the `mcpOAuthContext` cookie. The
   *   token therefore stops being a bearer credential for the callback the moment it is used.
   */
  async redeemHandoffToken(
    token: string,
    expectedAccountId: string,
  ): Promise<{ flowSecret: string; targetUrl: string }> {
    const payload = this.#cipher.decryptHandoff(token);
    const now = this.#now();
    if (now.getTime() > payload.expiresAt) {
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization handoff token has expired");
    }

    return this.#database.transaction(async (transaction) => {
      await lockMcpAccounts(transaction, [expectedAccountId]);
      const issuedBinding = hashSecret(payload.flowSecret);
      const [row] = await transaction
        .select({
          id: mcpServerAuthorizations.id,
          stateExpiresAt: mcpServerAuthorizations.stateExpiresAt,
          loginSessionHash: mcpServerAuthorizations.loginSessionHash,
          ownerAccountId: agents.createdByUserId,
        })
        .from(mcpServerAuthorizations)
        .innerJoin(agents, eq(agents.id, mcpServerAuthorizations.agentId))
        .where(eq(mcpServerAuthorizations.state, payload.stateHash))
        .limit(1);

      if (!row?.stateExpiresAt || row.stateExpiresAt.getTime() <= now.getTime()) {
        throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization flow is no longer valid");
      }

      if (!row.loginSessionHash || !timingSafeEqual(Buffer.from(row.loginSessionHash), Buffer.from(issuedBinding))) {
        throw new McpServiceError(
          MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
          "The authorization flow was not started by this browser",
        );
      }

      if (row.ownerAccountId !== expectedAccountId) {
        throw new McpServiceError(MCP_ERROR_CODES.SERVER_NOT_FOUND, "The requested MCP Server was not found");
      }

      if (!(await readMcpCredentialRoot(transaction, expectedAccountId, row.id))) {
        throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization flow is no longer valid");
      }

      /*
       * The conditional update is the single-use gate: the secret that arrived in the token is the one
       * being replaced, so exactly one caller can win, and a second redemption of the same token matches
       * no row. The flow itself stays live — `state`, its deadline, and the PKCE verifier are untouched —
       * because the callback still needs them.
       */
      const browserSecret = generateSecret(32);
      const [consumed] = await transaction
        .update(mcpServerAuthorizations)
        .set({ loginSessionHash: hashSecret(browserSecret), updatedAt: now })
        .where(
          and(
            eq(mcpServerAuthorizations.id, row.id),
            eq(mcpServerAuthorizations.loginSessionHash, issuedBinding),
            eq(mcpServerAuthorizations.state, payload.stateHash),
          ),
        )
        .returning({ id: mcpServerAuthorizations.id });
      if (!consumed) {
        throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization handoff was already used");
      }

      return { flowSecret: browserSecret, targetUrl: payload.targetUrl };
    });
  }

  /**
   * The identifier to request for one authorization server this Server advertises.
   *
   * Google's Workspace MCP endpoints advertise `https://accounts.google.com/` while their metadata
   * declares the slash-free spelling, and the metadata reader compares the document's `issuer`
   * exactly. Only that one identifier, and only for a Google Workspace MCP origin, is requested in
   * its slash-free form: every other advertised identifier is used exactly as published, so a
   * provider whose legitimate issuer ends in a slash still compares equal to its own metadata
   * document (RFC 8414 §3.3) instead of being rewritten into a mismatch.
   */
  #advertisedIssuer(effectiveUrl: string, issuer: string): string {
    if (!isGoogleWorkspaceMcpEndpoint(effectiveUrl)) return issuer;
    const canonical = normalizeAuthorizationServerIssuer(issuer);
    if (canonical !== GOOGLE_WORKSPACE_MCP_AUTHORIZATION_SERVER) return issuer;
    return canonical;
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
    prmScopes: readonly string[];
  }> {
    const { metadata: prm, challengeScope } = await this.#oauth.protectedResourceMetadata(accountId, url);
    /*
     * Each advertised identifier is requested as published, except for Google's own identifier on a
     * Google Workspace origin (see `#advertisedIssuer`). The metadata reader compares exactly, so an
     * ordinary provider's slash-ending issuer is preserved and still matches its own document.
     */
    const candidates = orderIssuers(
      prm.authorizationServers.map((issuer) => this.#advertisedIssuer(url, issuer)),
      recordedIssuer === null ? null : this.#advertisedIssuer(url, recordedIssuer),
    );
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
        const { client, registrationId } = await this.#clientForStart(accountId, url, metadata);
        return {
          metadata,
          client,
          registrationId,
          challengeScope,
          /*
           * The reader's value is the accepted spelling — the advertised one, or the endpoint when
           * the document named none — and it travels verbatim: normalization is comparison-only, so
           * the authorization request and the token request cannot disagree.
           */
          resource: prm.resource,
          prmScopes: prm.scopesSupported,
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
   * The deployment's pre-registered client for this flow (Google or a static brand), resolved rather than
   * stored, or undefined when this flow must not use one.
   *
   * Two conditions are deliberate, and both are required. The Server's effective origin must be the
   * provider's own, so a hostile Server that merely advertises that provider as its authorization
   * server cannot obtain a credential for its own endpoint; and the discovered issuer must be exactly
   * the provider's, so a provider endpoint that unexpectedly resolves elsewhere does not receive a
   * client bound to that provider. The client is never written to `mcp_client_registrations`:
   * configuration stays authoritative, so unsetting the variables stops its use immediately instead
   * of leaving a stale row behind.
   */
  #deploymentClient(effectiveUrl: string, issuer: string): McpClientCredentials | undefined {
    const configured = this.#deploymentClients.find(
      (client) => client.issuer === issuer && client.matchesEndpoint(effectiveUrl),
    );
    if (!configured) return undefined;
    return {
      source: "preregistered",
      clientId: configured.clientId,
      clientSecret: configured.clientSecret,
      tokenEndpointAuthMethod: configured.tokenEndpointAuthMethod,
      ...(configured.authorizationParams ? { authorizationParams: configured.authorizationParams } : {}),
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
   * - the deployment's Google or static-provider client, when this Server is one it is bound to;
   * - a `preregistered` row, which is the deployment's own client and always wins;
   * - an existing DCR row, reused as-is;
   * - otherwise a fresh registration, which is the only case that writes the row.
   *
   * A CIMD client is not a row at all — it is this deployment's URL — so it is resolved rather than
   * looked up, and `registrationId` stays null for it. A deployment client likewise has no row: it is
   * derived from configuration, so its `registrationId` stays null too.
   */
  async #clientForStart(
    accountId: string,
    effectiveUrl: string,
    metadata: McpAuthorizationServerMetadata,
  ): Promise<{ client: McpClientCredentials; registrationId: string | null }> {
    const deployment = this.#deploymentClient(effectiveUrl, metadata.issuer);
    if (deployment) return { client: deployment, registrationId: null };
    const preregistered = await this.#readPreregistered(accountId, metadata.issuer);
    if (preregistered) {
      const row = await this.#readRegistrationRow(accountId, metadata.issuer, "preregistered");
      return { client: preregistered, registrationId: row?.id ?? null };
    }
    if (metadata.clientIdMetadataDocumentSupported) {
      /*
       * No row is stored for CIMD.
       *
       * The client is this deployment's own metadata URL — it is derivable from `publicUrl`, so there
       * is nothing to remember, and `#readClientCredentials` resolves it the same way. Recording one
       * was actively harmful: `mcp_client_registrations` is unique on `(Account, issuer)` and holds ONE
       * row per pair, while this lookup is scoped by `source`. So a CIMD record upserted over an
       * existing DCR row, repointing `client_id` and clearing the secret under every authorization
       * already using it — their next refresh presented a client the authorization server had never
       * issued them, and `invalid_client` is terminal, so the credential was destroyed with no way
       * back. The same hazard existed in the other direction, and both are gone with the row.
       */
      return {
        client: {
          source: "cimd",
          clientId: this.#oauth.clientMetadataUrl,
          tokenEndpointAuthMethod: "none",
        },
        registrationId: null,
      };
    }
    const existing = await this.#readRegistrationRow(accountId, metadata.issuer, "dcr");
    if (existing) {
      const client = await this.#clientFromRow(accountId, existing);
      return { client, registrationId: existing.id };
    }
    const client = await this.#oauth.registerDynamically(accountId, metadata);
    await this.#recordRegistration(accountId, metadata, client, this.#now(), { ifAbsent: true });
    /*
     * Re-read rather than using what was just registered.
     *
     * Two concurrent starts both miss the lookup above and both register; with an insert-if-absent the
     * second one stores nothing, so the row holds the first client. Naming the client this call
     * registered would make the loser's authorization request name a client its callback — which
     * resolves the row — will not present, and a strict authorization server answers `invalid_client`.
     * Reading back is what makes both flows agree on the client the row actually holds.
     */
    const recorded = await this.#readRegistrationRow(accountId, metadata.issuer, "dcr");
    if (!recorded) {
      throw new McpServiceError(
        MCP_ERROR_CODES.REGISTRATION_FAILED,
        "A different client registration already exists for this authorization server",
      );
    }
    return { client: await this.#clientFromRow(accountId, recorded), registrationId: recorded.id };
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
    options: { ifAbsent?: boolean } = {},
  ): Promise<string> {
    const sealed = client.clientSecret
      ? this.#cipher.encryptClientSecret({ accountId, authorizationServer: metadata.issuer }, client.clientSecret)
      : undefined;
    const values = {
      accountId,
      authorizationServer: metadata.issuer,
      source: client.source,
      clientId: client.clientId,
      ciphertext: sealed?.ciphertext ?? null,
      keyId: sealed?.keyId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const insert = this.#database.insert(mcpClientRegistrations).values(values);
    const [row] =
      options.ifAbsent === true
        ? // Never overwrite an existing registration: it is the client every authorization at this
          // issuer is already using, and replacing `client_id` under them is terminal.
          await insert
            .onConflictDoNothing({
              target: [mcpClientRegistrations.accountId, mcpClientRegistrations.authorizationServer],
            })
            .returning({ id: mcpClientRegistrations.id })
        : await insert
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
    if (row) return row.id;
    /*
     * No row came back from an insert-if-absent, which means someone else's registration won. That is
     * expected under concurrency and the caller re-reads; reaching here from the upsert path would be
     * a datastore fault.
     */
    const [existing] = await this.#database
      .select({ id: mcpClientRegistrations.id })
      .from(mcpClientRegistrations)
      .where(
        and(
          eq(mcpClientRegistrations.accountId, accountId),
          eq(mcpClientRegistrations.authorizationServer, metadata.issuer),
        ),
      )
      .limit(1);
    if (existing) return existing.id;
    throw new McpServiceError(MCP_ERROR_CODES.REGISTRATION_FAILED, "The client registration was not stored");
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
    onVerified?: (target: { agentId: string; mcpServerId: string }) => void,
  ): Promise<{ accountId: string; agentId: string; mcpServerId: string }> {
    const row = await this.#locateFlow(query.state, flowSecret);
    const { authorization, agentId, accountId, initiatingAgentId, returnAgentId } = row;
    const mcpServerId = authorization.mcpServerId;
    // Only a valid state and browser binding may identify the page for a failed callback.
    onVerified?.({ agentId: returnAgentId, mcpServerId });
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
        query.state,
        query.error === "access_denied" ? MCP_ERROR_CODES.OAUTH_DENIED : MCP_ERROR_CODES.OAUTH_FAILED,
      );
      throw new McpServiceError(
        query.error === "access_denied" ? MCP_ERROR_CODES.OAUTH_DENIED : MCP_ERROR_CODES.OAUTH_FAILED,
        "The authorization was not granted",
      );
    }
    if (!query.code) {
      await this.#failFlow(authorization.id, query.state, MCP_ERROR_CODES.OAUTH_FLOW_INVALID);
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization response carried no code");
    }
    const redeemState = `redeeming:${randomUUID()}`;
    const [claimed] = await this.#database
      .update(mcpServerAuthorizations)
      .set({ state: hashSecret(redeemState) })
      .where(
        and(
          eq(mcpServerAuthorizations.id, authorization.id),
          eq(mcpServerAuthorizations.state, hashSecret(query.state)),
        ),
      )
      .returning({ id: mcpServerAuthorizations.id });
    if (!claimed)
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization flow has already been claimed");
    let completedAgentId = agentId;
    try {
      completedAgentId = await this.#redeemCode({
        accountId,
        agentId,
        authorization,
        code: query.code,
        issuedState: redeemState,
        iss: query.iss,
      });
    } catch (error) {
      /*
       * A failed exchange is terminal, so the flow is cleared and a terminal status is recorded —
       * leaving the row awaiting a callback that will never come would only be a wait that ends in a
       * timeout. A transient failure is left alone, because a retry can still succeed.
       *
       * The superseded case is re-thrown untouched: the flow already belongs to a newer decision, and
       * clearing or failing it here would undo that decision.
       */
      if (error instanceof McpServiceError && error.code === MCP_ERROR_CODES.OAUTH_FLOW_INVALID) throw error;
      await this.#failFlow(
        authorization.id,
        redeemState,
        error instanceof McpServiceError && error.category === "transient" ? undefined : MCP_ERROR_CODES.OAUTH_FAILED,
      );
      throw error;
    }
    completedAgentId = await this.#flowReturnAgent(accountId, authorization.id, mcpServerId, initiatingAgentId);
    return { accountId, agentId: completedAgentId, mcpServerId };
  }

  /**
   * Exchange the code and store the credential, fenced on the flow that started it.
   *
   * Extracted from `callback` so that method reads as the decisions it makes — denied, no code,
   * redeem — rather than as one long body, and because this is the half that talks upstream.
   */
  async #redeemCode(input: {
    accountId: string;
    agentId: string;
    authorization: typeof mcpServerAuthorizations.$inferSelect;
    code: string;
    issuedState: string;
    iss: string | undefined;
  }): Promise<string> {
    const { accountId, agentId, authorization, code, issuedState, iss } = input;
    const mcpServerId = authorization.mcpServerId;
    const flow = this.#cipher.decryptPkceFlow(
      { mcpServerId, agentId, authorizationServer: requireFlowIssuer(authorization) },
      requirePkce(authorization),
    );
    const context = await readMcpCredentialRoot(this.#database, accountId, authorization.id);
    if (!context)
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization holder is no longer valid");
    const effective = mcpEffectiveConfig(context.server, context.binding);
    if ("version" in flow && flow.accountId !== accountId)
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The flow Account no longer matches");
    if ("version" in flow && !mcpConfigEqual(flow.config, effective))
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The MCP connection changed during authorization");
    const metadata = await this.#oauth.authorizationServerMetadata(accountId, requireFlowIssuer(authorization));
    this.#oauth.validateIssuer(metadata, iss, metadata.issuer);
    const registrationId = "version" in flow ? flow.registrationId : authorization.clientRegistrationId;
    const client = await this.#readClientCredentials(accountId, effective.url, metadata, registrationId);
    if ("version" in flow && client.clientId !== flow.clientId)
      throw new McpServiceError(MCP_ERROR_CODES.REGISTRATION_FAILED, "The OAuth client changed during authorization");
    const resource = authorization.flowOauthResource ?? normalizeResource(undefined, effective.url);
    if (!resourceRelatesToEndpoint(resource, effective.url))
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The OAuth resource no longer matches");
    const tokens = await this.#oauth.exchangeAuthorizationCode(accountId, metadata, {
      code,
      codeVerifier: flow.codeVerifier,
      client,
      resource,
    });
    const holder = await this.#database.transaction(async (transaction) => {
      await lockMcpAccounts(transaction, [accountId]);
      const current = await readMcpCredentialRoot(transaction, accountId, authorization.id);
      const root = requireMcpFlowRoot(current, issuedState, effective, this.#now());
      const sealed = this.#cipher.encryptAuthorizationCredential(
        { mcpServerId, agentId: root.agentId, authorizationServer: metadata.issuer },
        {
          ...("version" in flow ? { clientId: client.clientId } : {}),
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
        },
      );
      const now = this.#now();
      const [stored] = await transaction
        .update(mcpServerAuthorizations)
        .set({
          kind: "oauth",
          status: "active",
          authorizationServer: metadata.issuer,
          clientRegistrationId: registrationId,
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          oauthResource: resource,
          scopes:
            tokens.scope !== undefined
              ? grantedMcpScopes(tokens.scope, metadata.issuer)
              : "version" in flow
                ? flow.scopes
                : authorization.scopes,
          accessTokenExpiresAt: accessTokenExpiry(now, tokens.expiresIn),
          failureCode: null,
          state: null,
          stateExpiresAt: null,
          pkceCiphertext: null,
          loginSessionHash: null,
          flowAuthorizationServer: null,
          flowOauthResource: null,
          refreshClaimId: null,
          refreshClaimedAt: null,
          refreshGeneration: sql`${mcpServerAuthorizations.refreshGeneration} + 1`,
          updatedAt: now,
        })
        .where(and(eq(mcpServerAuthorizations.id, root.id), eq(mcpServerAuthorizations.state, hashSecret(issuedState))))
        .returning({ id: mcpServerAuthorizations.id });
      if (!stored)
        throw new McpServiceError(
          MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
          "The authorization was superseded before it completed",
        );
      await invalidateMcpCredentialProbes(transaction, root.id);
      return root.agentId;
    });
    this.#logger?.info(
      {
        accountId,
        authorizationId: authorization.id,
        agentId: "version" in flow ? flow.initiatingAgentId : agentId,
        holderAgentId: holder,
      },
      "MCP OAuth authentication updated",
    );
    return holder;
  }

  async #flowReturnAgent(accountId: string, rootId: string, mcpServerId: string, initiatingAgentId: string) {
    const contexts = await readMcpAuthorizationContexts(
      this.#database,
      and(
        eq(mcpServers.accountId, accountId),
        eq(mcpServers.id, mcpServerId),
        or(eq(agentMcpServers.agentId, initiatingAgentId), eq(mcpServerAuthorizations.id, rootId)),
      ),
      { tools: false },
    );
    const members = contexts.filter((context) => context.credentialAuthorization?.id === rootId);
    const target = members.find((context) => context.binding.agentId === initiatingAgentId) ?? members[0];
    if (!target)
      throw new McpServiceError(
        MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
        "The authorization has no return binding in its Account",
      );
    return target.binding.agentId;
  }

  async #locateFlow(
    state: string,
    flowSecret: string | undefined,
  ): Promise<{
    authorization: typeof mcpServerAuthorizations.$inferSelect;
    agentId: string;
    accountId: string;
    initiatingAgentId: string;
    returnAgentId: string;
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
      await this.#failFlow(authorization.id, state, MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED);
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED, "The authorization flow has expired");
    }
    /*
     * `status` is not consulted here.
     *
     * A row can be `active` and still have a flow in flight, because starting a re-authorization no
     * longer downgrades a working credential. What makes this row the callback's target is that the
     * state resolved to it and has not expired — both checked above — and `#clearFlow` nulls the state
     * the moment the code is redeemed, so a replay still finds nothing.
     */
    const context = await readMcpCredentialRoot(this.#database, row.accountId, authorization.id);
    if (!context)
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The authorization holder is no longer valid");
    const flow = this.#cipher.decryptPkceFlow(
      {
        mcpServerId: authorization.mcpServerId,
        agentId: authorization.agentId,
        authorizationServer: requireFlowIssuer(authorization),
      },
      requirePkce(authorization),
    );
    if ("version" in flow && flow.accountId !== row.accountId)
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The initiating Account no longer matches");
    const initiatingAgentId = "version" in flow ? flow.initiatingAgentId : authorization.agentId;
    const returnAgentId = await this.#flowReturnAgent(
      row.accountId,
      authorization.id,
      authorization.mcpServerId,
      initiatingAgentId,
    );
    return {
      authorization,
      agentId: authorization.agentId,
      accountId: row.accountId,
      initiatingAgentId,
      returnAgentId,
    };
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
  /**
   * End a flow that cannot succeed.
   *
   * `status` leaves `pending` only when there is no credential to protect: the poll in `mcp authorize`
   * and the page's probe indicator both end on a status other than `pending`, and a row that only had
   * its state cleared kept a user waiting for the flow's full ten minutes.
   *
   * But `status` is also what `resolveActiveCredential` gates on, so writing `error` unconditionally
   * destroyed a working credential: an Agent that was authorized and working, whose user denied a
   * *re*-authorization, came out unauthorized — the same outcome as the bug that stopped `start` from
   * clearing it, reached by a different door. With a credential present the row keeps its status and
   * only records the reason; the pending-probe pass re-probes it, because an active row with a pending
   * probe is exactly what that pass runs, so nothing is left waiting either way.
   *
   * Passing no code means the failure is transient — the flow's state is cleared and the row is left
   * `pending` for a retry, the one case where waiting is still the right answer.
   */
  async #failFlow(id: string, issuedState: string, failureCode: string | undefined): Promise<void> {
    await this.#database
      .update(mcpServerAuthorizations)
      .set({
        state: null,
        stateExpiresAt: null,
        pkceCiphertext: null,
        loginSessionHash: null,
        flowOauthResource: null,
        ...(failureCode === undefined
          ? {}
          : {
              failureCode,
              /*
               * Downgraded only when there is nothing to lose. `ciphertext` is read in the same
               * statement so the decision cannot go stale between a read and this write.
               */
              status: sql`case when ${mcpServerAuthorizations.ciphertext} is null then 'error' else ${mcpServerAuthorizations.status} end`,
            }),
        revision: sql`${mcpServerAuthorizations.revision} + 1`,
        updatedAt: this.#now(),
      })
      .where(and(eq(mcpServerAuthorizations.id, id), eq(mcpServerAuthorizations.state, hashSecret(issuedState))));
  }

  /**
   * The client to redeem the code with.
   *
   * The flow row already carries `clientRegistrationId`, so the callback and every later refresh use
   * exactly the client the authorization request named. Resolving a client *fresh* here would
   * register a second one and then present the first one's code under it — which a strict
   * authorization server refuses with `invalid_client`.
   *
   * CIMD and the deployment clients are the mechanisms with no row to record: they are derived
   * rather than looked up, and they are by construction the same client the authorization request
   * named.
   */
  async #readClientCredentials(
    accountId: string,
    effectiveUrl: string,
    metadata: McpAuthorizationServerMetadata,
    clientRegistrationId: string | null,
  ): Promise<McpClientCredentials> {
    /*
     * A deployment client is resolved the same way `start` resolved it — same origin, same issuer —
     * so the callback and every refresh present the client the authorization request named.
     */
    const deployment = this.#deploymentClient(effectiveUrl, metadata.issuer);
    if (deployment) return deployment;
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
   * leaves the outcome unknown: the AS may have rotated the refresh token. Potentially consumed
   * material is cleared and the shared authentication requires new consent, without replay. Only `invalid_grant` and `invalid_client` are terminal,
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
    let credential: { accessToken: string; refreshToken?: string; clientId?: string };
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
    let requestDispatched = false;
    try {
      /*
       * The effective URL is read before the authorization server is contacted, because the
       * credential's audience is checked against it first: a row whose endpoint no longer accepts
       * the recorded resource must fail as requiring reauthorization, not have a fresh token minted
       * for an audience the token will never be presented to.
       */
      const effective = row.effective;
      const resource = row.oauthResource ?? normalizeResource(undefined, effective.url);
      if (row.oauthResource !== null && !resourceRelatesToEndpoint(row.oauthResource, effective.url)) {
        throw new McpServiceError(
          MCP_ERROR_CODES.AUTHORIZATION_REQUIRED,
          "The authorization's resource no longer matches the MCP endpoint",
        );
      }
      const metadata = await this.#oauth.authorizationServerMetadata(row.accountId, requireIssuer(row));
      // A deployment client is bound to the origin, not just the issuer.
      const client = await this.#readClientCredentials(
        row.accountId,
        effective.url,
        metadata,
        row.clientRegistrationId,
      );
      if (credential.clientId && client.clientId !== credential.clientId)
        throw new McpServiceError(MCP_ERROR_CODES.REGISTRATION_FAILED, "The OAuth client changed; authorize again");
      requestDispatched = true;
      const tokens = await this.#oauth.refreshAccessToken(row.accountId, metadata, {
        refreshToken: credential.refreshToken,
        client,
        resource,
      });
      const scopes = tokens.scope === undefined ? undefined : grantedMcpScopes(tokens.scope, metadata.issuer);
      const scopeUpdate = scopes === undefined ? {} : { scopes };
      await this.#database.transaction(async (transaction) => {
        await lockMcpAccounts(transaction, [row.accountId]);
        const current = await readMcpCredentialRoot(transaction, row.accountId, authorizationId);
        const root = current?.credentialAuthorization;
        if (
          !current ||
          !root ||
          root.status !== "active" ||
          root.refreshClaimId !== claimId ||
          root.refreshGeneration !== row.refreshGeneration ||
          !mcpConfigEqual(effective, mcpEffectiveConfig(current.server, current.binding))
        )
          throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The refresh result was superseded");
        const sealed = this.#cipher.encryptAuthorizationCredential(
          { ...binding, agentId: root.agentId },
          {
            ...(credential.clientId || this.#servers.reuseOAuth ? { clientId: client.clientId } : {}),
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? credential.refreshToken,
            ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
          },
        );
        const now = this.#now();
        const [stored] = await transaction
          .update(mcpServerAuthorizations)
          .set({
            ciphertext: sealed.ciphertext,
            keyId: sealed.keyId,
            accessTokenExpiresAt: accessTokenExpiry(now, tokens.expiresIn),
            ...scopeUpdate,
            status: "active",
            failureCode: null,
            refreshClaimId: null,
            refreshClaimedAt: null,
            refreshGeneration: sql`${mcpServerAuthorizations.refreshGeneration} + 1`,
            lastRefreshedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(mcpServerAuthorizations.id, authorizationId),
              eq(mcpServerAuthorizations.refreshClaimId, claimId),
              eq(mcpServerAuthorizations.refreshGeneration, row.refreshGeneration),
            ),
          )
          .returning({ id: mcpServerAuthorizations.id });
        if (!stored) throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FLOW_INVALID, "The refresh result was superseded");
        if (scopes !== undefined && !sameScopeSet(root.scopes, scopes))
          await invalidateMcpCredentialProbes(transaction, root.id);
      });
      // Token rotation alone keeps each Agent's tool snapshot.
    } catch (error) {
      this.#logger?.warn(
        {
          authorizationId,
          claimId,
          code: refreshFailureCode(error, requestDispatched),
        },
        "MCP refresh did not commit a credential",
      );
      await this.#classifyRefreshFailure(authorizationId, claimId, error, this.#database, requestDispatched);
    }
  }

  /**
   * Capture a root and its effective configuration before network I/O. A stale claim has an unknown
   * outcome and fails closed after two minutes; another worker never spends that token again.
   */
  async #claimForRefresh(authorizationId: string, claimId: string) {
    const [owner] = await this.#database
      .select({ accountId: mcpServers.accountId })
      .from(mcpServerAuthorizations)
      .innerJoin(mcpServers, eq(mcpServers.id, mcpServerAuthorizations.mcpServerId))
      .where(eq(mcpServerAuthorizations.id, authorizationId));
    if (!owner) return undefined;
    return this.#database.transaction(async (transaction) => {
      await lockMcpAccounts(transaction, [owner.accountId]);
      const context = await readMcpCredentialRoot(transaction, owner.accountId, authorizationId);
      const row = context?.credentialAuthorization;
      if (!context || !row || row.kind !== "oauth" || row.status !== "active") return undefined;
      if (row.refreshClaimId) {
        if (row.refreshClaimedAt && row.refreshClaimedAt.getTime() <= this.#now().getTime() - 2 * 60 * 1000)
          await this.#classifyRefreshFailure(
            authorizationId,
            row.refreshClaimId,
            new Error("Refresh outcome unknown"),
            transaction,
          );
        return undefined;
      }
      const [claimed] = await transaction
        .update(mcpServerAuthorizations)
        .set({ refreshClaimId: claimId, refreshClaimedAt: this.#now() })
        .where(
          and(
            eq(mcpServerAuthorizations.id, authorizationId),
            isNull(mcpServerAuthorizations.refreshClaimId),
            isNull(mcpServerAuthorizations.credentialSourceId),
          ),
        )
        .returning();
      return claimed
        ? { ...claimed, accountId: owner.accountId, effective: mcpEffectiveConfig(context.server, context.binding) }
        : undefined;
    });
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
        revision: sql`${mcpServerAuthorizations.revision} + 1`,
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
  async #classifyRefreshFailure(
    authorizationId: string,
    claimId: string,
    error: unknown,
    executor: Pick<DatabaseClient, "update"> = this.#database,
    requestDispatched = true,
  ): Promise<void> {
    const now = this.#now();
    const detail = error instanceof McpServiceError ? error.detail : undefined;
    const upstreamError = typeof detail?.error === "string" ? detail.error : undefined;
    const terminal = upstreamError === "invalid_grant" || upstreamError === "invalid_client";
    const unknownOutcome =
      requestDispatched && (!(error instanceof McpServiceError) || error.code === MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE);
    await executor
      .update(mcpServerAuthorizations)
      .set({
        ...(terminal
          ? {
              status: "revoked",
              ciphertext: null,
              keyId: null,
              // The audience is dropped with the credential. The flow's own resource is left alone:
              // a reauthorization may be in flight and its callback still needs it.
              oauthResource: null,
              accessTokenExpiresAt: null,
            }
          : unknownOutcome
            ? // An unanswered refresh may already have consumed the old token.
              {
                status: "error",
                ciphertext: null,
                keyId: null,
                accessTokenExpiresAt: null,
                oauthResource: null,
                failureCode: MCP_ERROR_CODES.REFRESH_OUTCOME_UNKNOWN,
              }
            : {
                status: "error",
                failureCode: error instanceof McpServiceError ? error.code : MCP_ERROR_CODES.OAUTH_FAILED,
              }),
        refreshClaimId: null,
        refreshClaimedAt: null,
        revision: sql`${mcpServerAuthorizations.revision} + 1`,
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
 * When an issued access token should be refreshed.
 *
 * A response with no `expires_in` is treated as short-lived rather than never-expiring: storing null
 * made the token immortal as far as the refresh worker was concerned, because its `due` predicate
 * compares `access_token_expires_at` and null never compares due. The specification makes `expires_in`
 * optional and recommends against assuming a long lifetime, so the token whose real lifetime is
 * unknown is exactly the one worth refreshing early.
 */
const UNKNOWN_LIFETIME_SECONDS = 5 * 60;
function accessTokenExpiry(now: Date, expiresInSeconds: number | undefined): Date {
  return new Date(now.getTime() + (expiresInSeconds ?? UNKNOWN_LIFETIME_SECONDS) * 1000);
}

/**
 * The issuer a flow discovered, which is not the same as the credential's issuer.
 *
 * A re-authorization keeps the existing credential while its flow runs, and the credential's issuer is
 * part of the envelope's AAD, so the two must be able to differ.
 */
function requireFlowIssuer(row: { flowAuthorizationServer: string | null }): string {
  if (!row.flowAuthorizationServer) {
    throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FAILED, "The authorization row has no flow authorization server");
  }
  return row.flowAuthorizationServer;
}

/** The issuer that sealed this row's credential, which a refresh must talk to. */
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

export { normalizeResource };

function requireUnchangedMcpBinding(
  previous: McpAuthorizationContext,
  current: McpAuthorizationContext | undefined,
  effective: ReturnType<typeof mcpEffectiveConfig>,
): asserts current is McpAuthorizationContext {
  if (
    !current ||
    !mcpConfigEqual(effective, mcpEffectiveConfig(current.server, current.binding)) ||
    (previous.credentialAuthorization?.id ?? null) !== (current.credentialAuthorization?.id ?? null)
  )
    throw new McpServiceError(
      MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
      "The MCP binding changed before authorization started",
    );
  if (current.localAuthorization?.credentialSourceId && !current.credentialAuthorization)
    throw new McpServiceError(MCP_ERROR_CODES.AUTHORIZATION_REQUIRED, "The shared authorization is no longer valid");
}

function requireMcpFlowRoot(
  current: McpAuthorizationContext | undefined,
  issuedState: string,
  effective: ReturnType<typeof mcpEffectiveConfig>,
  now: Date,
) {
  const root = current?.credentialAuthorization;
  if (
    !current ||
    !root ||
    root.state !== hashSecret(issuedState) ||
    !root.stateExpiresAt ||
    root.stateExpiresAt <= now ||
    !mcpConfigEqual(effective, mcpEffectiveConfig(current.server, current.binding))
  )
    throw new McpServiceError(
      MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
      "The authorization was superseded before it completed",
    );
  return root;
}

function grantedMcpScopes(value: string, issuer: string) {
  const github = MCP_STATIC_OAUTH_PROVIDERS.find((provider) => provider.brand === "github");
  return value.split(issuer === github?.issuer ? /[,\s]+/ : /\s+/).filter(Boolean);
}

function sameScopeSet(previous: string[] | null, next: string[]) {
  if (!previous) return false;
  const scopes = new Set(previous.filter((scope) => scope !== "offline_access"));
  const granted = new Set(next.filter((scope) => scope !== "offline_access"));
  return scopes.size === granted.size && [...granted].every((scope) => scopes.has(scope));
}

function refreshFailureCode(error: unknown, requestDispatched: boolean) {
  if (error instanceof McpServiceError) return error.code;
  return requestDispatched ? MCP_ERROR_CODES.REFRESH_OUTCOME_UNKNOWN : MCP_ERROR_CODES.OAUTH_FAILED;
}
