import { createHash, randomBytes, randomUUID } from "node:crypto";
import { boundedMcpSummary, MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import { isLoopbackHost, type McpFetchResponse, type McpOutboundFetcher } from "./mcp-url-policy.js";

/**
 * The OAuth 2.1 / RFC 9728 / RFC 8414 side of MCP authorization.
 *
 * Every URL here except the configured MCP endpoint comes from the peer: a `WWW-Authenticate`
 * challenge names the Protected Resource Metadata document, that document names the authorization
 * servers, and their metadata names the endpoints we then dial. Each one therefore goes through the
 * same outbound gate as the endpoint itself, and so does a CIMD document URL. A redirect is never
 * followed, and its `Location` is never read.
 *
 * Discovery order is significant and is taken from the specification verbatim; reordering it would
 * let a Server steer the client at a document it does not own.
 */

const PRM_WELL_KNOWN = "/.well-known/oauth-protected-resource";
const AS_WELL_KNOWN = "/.well-known/oauth-authorization-server";
const OIDC_WELL_KNOWN = "/.well-known/openid-configuration";

export const MCP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface McpProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export interface McpAuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
  clientIdMetadataDocumentSupported: boolean;
  authorizationResponseIssParameterSupported: boolean;
  tokenEndpointAuthMethodsSupported: string[];
}

/**
 * Try each candidate URL in order and return the first document the reader accepts, or `undefined`
 * when none was published.
 *
 * An error thrown by the reader means the document was published but unacceptable. Which of those
 * are fatal is the caller's decision, so `fatal` names them: a `URL_BLOCKED` refusal always aborts,
 * because falling through to the next spelling would be exactly the bypass the gate exists to
 * prevent; an issuer mismatch also aborts, because a document that names the wrong issuer is a
 * mix-up attack rather than a spelling that merely did not resolve.
 */
async function firstPublishedDocument<T>(
  candidates: readonly string[],
  read: (candidate: string) => Promise<T | undefined>,
  fatal: readonly string[],
): Promise<{ value: T; failures: string[] } | { value?: undefined; failures: string[] }> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const value = await read(candidate);
      if (value !== undefined) return { value, failures };
    } catch (error) {
      if (error instanceof McpServiceError && fatal.includes(error.code)) throw error;
      failures.push(`${candidate}: ${error instanceof Error ? error.name : typeof error}`);
    }
  }
  return { failures };
}

export interface McpOAuthOptions {
  fetcher: McpOutboundFetcher;
  /** This deployment's public origin, used for the fixed callback and the CIMD document URL. */
  publicUrl: string;
  clientName?: string;
  softwareId?: string;
  softwareVersion?: string;
}

export interface McpClientCredentials {
  source: "preregistered" | "cimd" | "dcr";
  clientId: string;
  clientSecret?: string;
  /** The exact `token_endpoint_auth_method` the credential must present. */
  tokenEndpointAuthMethod: string;
}

export interface McpTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}

function upstream(message: string, detail?: Record<string, unknown>): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.UPSTREAM_ERROR, message, detail);
}

function json(body: McpFetchResponse): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body.text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw upstream("The MCP authorization server returned an unreadable document");
  }
}

/**
 * A URL from an authorization server document that this deployment will hand to a browser or dial.
 *
 * Requires an absolute `https:` URL, and admits `http:` only for a loopback host so the local fixture
 * Server still works. `new URL()` alone is not enough: it accepts `javascript:`, `data:`, and other
 * schemes, and the authorization endpoint in particular is passed straight to `window.location.assign`
 * — a peer answering with `javascript:` would be executing script in an authenticated page. The CSP
 * happens to block that today; validating the scheme here is what makes it true rather than lucky.
 *
 * Returns undefined for anything else, so the caller treats it as "no metadata" and tries the next
 * candidate rather than proceeding with a value it cannot use.
 */
function endpointUrl(document: Record<string, unknown>, key: string, allowLoopback: boolean): string | undefined {
  const raw = stringField(document, key);
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol === "https:") return raw;
  /*
   * Loopback plain HTTP is admitted only where the deployment opted into it, exactly as the outbound
   * gate does — not merely because the host resolves to the local machine. This endpoint is handed to
   * the browser with `location.assign`, so a hostile public authorization server could otherwise
   * answer `http://localhost:3000/…` and have a production browser navigated at the user's own
   * machine. The exception exists for the test fixture, which is its own authorization server on
   * loopback and runs in a deployment that set the flag.
   */
  if (allowLoopback && url.protocol === "http:" && isLoopbackHost(url.hostname)) return raw;
  return undefined;
}

/**
 * The `resource` parameter's exact spelling: lowercase scheme and host, no fragment, and no trailing
 * slash unless the path is only a slash. Case tolerance is for the peer's spelling, not ours.
 *
 * It lives here rather than in the flow service because the protected-resource reader needs it to
 * compare an advertised `resource` with the endpoint, and the flow service already imports this module
 * — the dependency would otherwise run both ways.
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

function stringField(document: Record<string, unknown>, key: string): string | undefined {
  const value = document[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(document: Record<string, unknown>, key: string): string[] {
  const value = document[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Build the well-known candidate URLs for an issuer, in the specification's order. The path-insertion
 * forms come before the path-appended OIDC form, and the bare forms only apply to a pathless issuer.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") {
    return [`${url.origin}${AS_WELL_KNOWN}`, `${url.origin}${OIDC_WELL_KNOWN}`];
  }
  return [
    `${url.origin}${AS_WELL_KNOWN}${path}`,
    `${url.origin}${OIDC_WELL_KNOWN}${path}`,
    `${url.origin}${path}${OIDC_WELL_KNOWN}`,
  ];
}

/** The Protected Resource Metadata candidates, used only when the challenge names no document. */
export function protectedResourceMetadataUrls(mcpEndpoint: string): string[] {
  const url = new URL(mcpEndpoint);
  const path = url.pathname.replace(/\/+$/, "");
  const withPath = `${url.origin}${PRM_WELL_KNOWN}${path}`;
  const bare = `${url.origin}${PRM_WELL_KNOWN}`;
  return path === "" || path === "/" ? [bare] : [withPath, bare];
}

/**
 * Parse a `WWW-Authenticate: Bearer ...` challenge for `resource_metadata` and `scope`.
 * A quoted parameter may contain commas, so the split is parameter-aware rather than a naive comma
 * split — a URL with a comma in it must not be truncated.
 */
export function parseBearerChallenge(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header) return {};
  const match = /^Bearer\s+(.*)$/is.exec(header.trim());
  if (!match?.[1]) return {};
  const params: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  for (const found of match[1].matchAll(pattern)) {
    const key = found[1]?.toLowerCase();
    const value = found[2] ?? found[3];
    if (key && value !== undefined) params[key] = value;
  }
  return {
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
  };
}

export class McpOAuthClient {
  /** This deployment's public origin, used for the fixed callback and the CIMD document URL. */
  readonly publicUrl: string;
  readonly #clientName: string;
  readonly #fetcher: McpOutboundFetcher;
  readonly #publicUrl: string;
  readonly #softwareId: string;
  readonly #softwareVersion: string;

  constructor(options: McpOAuthOptions) {
    this.#clientName = options.clientName ?? "OpenTag";
    this.#fetcher = options.fetcher;
    this.#publicUrl = options.publicUrl.replace(/\/+$/, "");
    this.#softwareId = options.softwareId ?? "opentag";
    this.#softwareVersion = options.softwareVersion ?? "1";
    this.publicUrl = this.#publicUrl;
  }

  get redirectUri(): string {
    return `${this.#publicUrl}/api/v1/mcp-servers/oauth/callback`;
  }

  /** The client-metadata document URL, which is also the CIMD `client_id`. */
  get clientMetadataUrl(): string {
    return `${this.#publicUrl}/oauth/client-metadata.json`;
  }

  /**
   * Read a Protected Resource Metadata document (RFC 9728). The challenge's URL wins when it names
   * one; the well-known fallbacks are tried only in the specified order, never reversed.
   */
  async protectedResourceMetadata(
    accountId: string,
    mcpEndpoint: string,
    resourceMetadataUrl?: string,
  ): Promise<{ metadata: McpProtectedResourceMetadata; challengeScope?: string }> {
    const candidates = resourceMetadataUrl ? [resourceMetadataUrl] : protectedResourceMetadataUrls(mcpEndpoint);
    const result = await firstPublishedDocument(
      candidates,
      async (candidate) => {
        const document = await this.#readJsonDocument(accountId, candidate);
        if (document === undefined) return undefined;
        const authorizationServers = stringArray(document, "authorization_servers");
        if (authorizationServers.length === 0) return undefined;
        /*
         * An advertised `resource` that names a different endpoint is refused (RFC 9728 §3.3).
         *
         * This is the one identity check the document has, and it is load-bearing for two reasons.
         * The value travels as the authorization request's `resource`, so a hostile Server could
         * otherwise name another resource server and have this deployment obtain a token for it from a
         * shared authorization server. And our two requests have to agree: the authorization request
         * sent the advertised value while the token request sends the endpoint, and a mismatch there is
         * what the specification's `resource` binding exists to prevent.
         *
         * Compared after normalization so a peer's spelling of the same endpoint — a trailing slash,
         * an uppercase host — is accepted rather than treated as an attack.
         */
        const advertised = stringField(document, "resource");
        const resource = advertised ?? mcpEndpoint;
        if (normalizeResource(advertised, mcpEndpoint) !== normalizeResource(undefined, mcpEndpoint)) {
          return undefined;
        }
        return {
          resource,
          authorizationServers,
          scopesSupported: stringArray(document, "scopes_supported"),
        } satisfies McpProtectedResourceMetadata;
      },
      [MCP_ERROR_CODES.URL_BLOCKED],
    );
    if (!result.value) {
      throw upstream("The MCP Server's protected resource metadata could not be read", {
        tried: result.failures.slice(0, 4),
      });
    }
    return { metadata: result.value };
  }

  /**
   * Fetch and parse one well-known document, or `undefined` when this spelling is simply not
   * published. Only a 2xx JSON object counts as published; a miss is not an error, and a non-2xx is
   * reported by the caller as a candidate that did not work.
   */
  async #readJsonDocument(accountId: string, url: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.#fetcher.fetchOutbound(accountId, url, { headers: { accept: "application/json" } });
    if (response.status < 200 || response.status >= 300) return undefined;
    return json(response);
  }

  /**
   * Read one authorization server's metadata. The document's `issuer` must equal the issuer string
   * the well-known URL was built from — a mismatch is a mix-up attack and is refused outright rather
   * than normalized (no case folding, no default-port or trailing-slash tolerance).
   */
  async authorizationServerMetadata(accountId: string, issuer: string): Promise<McpAuthorizationServerMetadata> {
    // The same opt-in the outbound gate enforces, so a loopback endpoint is only usable where the
    // deployment already permits dialing one.
    const allowLoopback = this.#fetcher.policy.allowLoopback;
    const result = await firstPublishedDocument(
      authorizationServerMetadataUrls(issuer),
      async (candidate) => {
        const document = await this.#readJsonDocument(accountId, candidate);
        if (document === undefined) return undefined;
        /*
         * The document's `issuer` must equal the issuer string its well-known URL was built from,
         * compared as a plain string: no case folding, no default-port elision, no trailing-slash
         * tolerance.
         */
        if (stringField(document, "issuer") !== issuer) {
          throw new McpServiceError(
            MCP_ERROR_CODES.OAUTH_FAILED,
            "The authorization server metadata issuer does not match the requested issuer",
          );
        }
        const authorizationEndpoint = endpointUrl(document, "authorization_endpoint", allowLoopback);
        const tokenEndpoint = endpointUrl(document, "token_endpoint", allowLoopback);
        if (!authorizationEndpoint || !tokenEndpoint) return undefined;
        const registrationEndpoint = endpointUrl(document, "registration_endpoint", allowLoopback);
        return {
          issuer,
          authorizationEndpoint,
          tokenEndpoint,
          ...(registrationEndpoint ? { registrationEndpoint } : {}),
          scopesSupported: stringArray(document, "scopes_supported"),
          clientIdMetadataDocumentSupported: document.client_id_metadata_document_supported === true,
          authorizationResponseIssParameterSupported: document.authorization_response_iss_parameter_supported === true,
          tokenEndpointAuthMethodsSupported: stringArray(document, "token_endpoint_auth_methods_supported"),
        } satisfies McpAuthorizationServerMetadata;
      },
      [MCP_ERROR_CODES.URL_BLOCKED, MCP_ERROR_CODES.OAUTH_FAILED],
    );
    if (!result.value) {
      throw upstream("The authorization server metadata could not be read", { tried: result.failures.slice(0, 4) });
    }
    return result.value;
  }

  /** RFC 7591 dynamic registration. This is a remote web application, not a native one. */
  async registerDynamically(
    accountId: string,
    metadata: McpAuthorizationServerMetadata,
  ): Promise<McpClientCredentials> {
    const endpoint = metadata.registrationEndpoint;
    if (!endpoint) {
      throw new McpServiceError(
        MCP_ERROR_CODES.REGISTRATION_UNSUPPORTED,
        "The authorization server has no registration endpoint",
      );
    }
    const response = await this.#fetcher.fetchOutbound(accountId, endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        application_type: "web",
        redirect_uris: [this.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
        client_name: this.#clientName,
        software_id: this.#softwareId,
        software_version: this.#softwareVersion,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new McpServiceError(
        MCP_ERROR_CODES.REGISTRATION_FAILED,
        "The authorization server refused to register this client",
        { status: response.status, callback: this.redirectUri },
      );
    }
    const document = json(response);
    const clientId = stringField(document, "client_id");
    if (!clientId) {
      throw new McpServiceError(MCP_ERROR_CODES.REGISTRATION_FAILED, "The registration response carried no client ID");
    }
    return {
      source: "dcr",
      clientId,
      ...(stringField(document, "client_secret") ? { clientSecret: stringField(document, "client_secret") } : {}),
      tokenEndpointAuthMethod: "client_secret_basic",
    };
  }

  /**
   * Validate a client-metadata document fetched from a CIMD `client_id`. The document's own
   * `client_id` must equal the URL exactly, and its redirect hosts must match that URL's host, so a
   * document cannot claim a callback it does not own.
   */
  validateClientMetadataDocument(url: string, document: Record<string, unknown>): void {
    if (stringField(document, "client_id") !== url) {
      throw new McpServiceError(
        MCP_ERROR_CODES.REGISTRATION_FAILED,
        "The client metadata document names a different client ID",
      );
    }
    if (!stringField(document, "client_name")) {
      throw new McpServiceError(MCP_ERROR_CODES.REGISTRATION_FAILED, "The client metadata document has no client name");
    }
    const redirectUris = stringArray(document, "redirect_uris");
    if (redirectUris.length === 0) {
      throw new McpServiceError(
        MCP_ERROR_CODES.REGISTRATION_FAILED,
        "The client metadata document has no redirect URIs",
      );
    }
    const documentHost = new URL(url).host;
    for (const redirect of redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(redirect);
      } catch {
        throw new McpServiceError(MCP_ERROR_CODES.REGISTRATION_FAILED, "A client metadata redirect URI is invalid");
      }
      if (parsed.host !== documentHost) {
        throw new McpServiceError(
          MCP_ERROR_CODES.REGISTRATION_FAILED,
          "A client metadata redirect URI is on a different host than the client ID",
        );
      }
    }
  }

  /** The PKCE S256 pair. The verifier is stored encrypted; only the challenge travels. */
  static createPkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }

  static createState(): string {
    return randomBytes(32).toString("base64url");
  }

  /**
   * Build the authorization URL. `resource` must be present here and again on the token request,
   * per the specification, and `offline_access` is requested only when the AS advertises it.
   */
  authorizationUrl(input: {
    metadata: McpAuthorizationServerMetadata;
    clientId: string;
    state: string;
    codeChallenge: string;
    resource: string;
    scopes: readonly string[];
  }): string {
    const url = new URL(input.metadata.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", input.resource);
    const scopes = [...input.scopes];
    if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
    return url.toString();
  }

  /**
   * The scopes to request, in the specification's priority order: the challenge's `scope` is
   * authoritative when present, otherwise the PRM's `scopes_supported`, otherwise none at all.
   * `offline_access` is appended only when the AS itself advertises it.
   */
  resolveScopes(
    challengeScope: string | undefined,
    prmScopes: readonly string[],
    metadata: McpAuthorizationServerMetadata,
    requested: readonly string[] = [],
  ): string[] {
    const base =
      requested.length > 0 ? requested : challengeScope ? challengeScope.split(/\s+/).filter(Boolean) : [...prmScopes];
    const scopes = new Set(base);
    if (metadata.scopesSupported.includes("offline_access")) scopes.add("offline_access");
    return [...scopes];
  }

  /**
   * RFC 9207 `iss` validation, exactly per the specification's table. Comparison is a plain string
   * comparison: no case folding, no default-port elision, no trailing-slash or percent-encoding
   * normalization. A missing `iss` is a failure only when the AS declared it always sends one.
   */
  validateIssuer(
    metadata: McpAuthorizationServerMetadata,
    returnedIss: string | undefined,
    expectedIssuer: string,
  ): void {
    if (returnedIss === undefined) {
      if (metadata.authorizationResponseIssParameterSupported) {
        throw new McpServiceError(
          MCP_ERROR_CODES.OAUTH_FAILED,
          "The authorization response omitted the required issuer",
        );
      }
      return;
    }
    if (returnedIss !== expectedIssuer) {
      throw new McpServiceError(MCP_ERROR_CODES.OAUTH_FAILED, "The authorization response issuer does not match");
    }
  }

  /** Exchange an authorization code. `resource` is repeated here, as the specification requires. */
  async exchangeAuthorizationCode(
    accountId: string,
    metadata: McpAuthorizationServerMetadata,
    input: { code: string; codeVerifier: string; client: McpClientCredentials; resource: string },
  ): Promise<McpTokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.redirectUri,
      code_verifier: input.codeVerifier,
      resource: input.resource,
    });
    return this.#tokenRequest(accountId, metadata.tokenEndpoint, body, input.client);
  }

  async refreshAccessToken(
    accountId: string,
    metadata: McpAuthorizationServerMetadata,
    input: { refreshToken: string; client: McpClientCredentials; resource: string },
  ): Promise<McpTokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      resource: input.resource,
    });
    return this.#tokenRequest(accountId, metadata.tokenEndpoint, body, input.client);
  }

  async #tokenRequest(
    accountId: string,
    tokenEndpoint: string,
    body: URLSearchParams,
    client: McpClientCredentials,
  ): Promise<McpTokenSet> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (client.clientSecret && client.tokenEndpointAuthMethod === "client_secret_basic") {
      headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
    } else {
      body.set("client_id", client.clientId);
    }
    const response = await this.#fetcher.fetchOutbound(accountId, tokenEndpoint, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    const document = response.text.trim().length > 0 ? json(response) : {};
    if (response.status < 200 || response.status >= 300) {
      throw tokenRequestFailure(response.status, document);
    }
    const accessToken = stringField(document, "access_token");
    if (!accessToken) throw upstream("The token response carried no access token");
    const expiresIn = typeof document.expires_in === "number" ? document.expires_in : undefined;
    return {
      accessToken,
      ...(stringField(document, "refresh_token") ? { refreshToken: stringField(document, "refresh_token") } : {}),
      ...(expiresIn === undefined ? {} : { expiresIn }),
      ...(stringField(document, "scope") ? { scope: stringField(document, "scope") } : {}),
      ...(stringField(document, "token_type") ? { tokenType: stringField(document, "token_type") } : {}),
    };
  }
}

/** The RFC 6749 error code an AS returns, bounded and never the free-form description. */
export function tokenRequestFailure(status: number, document: Record<string, unknown>): McpServiceError {
  const errorCode = typeof document.error === "string" ? document.error : undefined;
  return new McpServiceError(
    MCP_ERROR_CODES.OAUTH_FAILED,
    boundedMcpSummary(`The token endpoint refused the request${errorCode ? ` (${errorCode})` : ""}`),
    { status, error: errorCode },
  );
}

export interface McpOAuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  iss?: string;
}

/** Where the browser lands after a successful or failed authorization. */
export function mcpCallbackRedirect(
  publicUrl: string,
  agentId: string,
  mcpServerId: string,
  errorCode?: string,
): string {
  const url = new URL(`/agents/${encodeURIComponent(agentId)}/mcp`, publicUrl);
  url.searchParams.set("server", mcpServerId);
  if (errorCode) {
    url.searchParams.set("mcp_oauth", "error");
    url.searchParams.set("mcp_oauth_error", errorCode);
  } else {
    url.searchParams.set("mcp_oauth", "success");
  }
  return url.toString();
}

/** A fresh claim id for the refresh single-flight. */
export function newRefreshClaimId(): string {
  return randomUUID();
}
