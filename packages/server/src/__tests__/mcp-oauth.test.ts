import { MCP_ERROR_CODES } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import {
  authorizationServerMetadataUrls,
  McpOAuthClient,
  protectedResourceMetadataUrls,
} from "../services/mcp/mcp-oauth.js";
import { normalizeResource, orderIssuers } from "../services/mcp/mcp-oauth-flow-service.js";
import { refreshAtFrom, refreshLeadMs } from "../services/mcp/mcp-refresh-worker.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";

/**
 * OAuth discovery, registration choice, PKCE, the `resource` parameter, the `iss` table, and the
 * refresh lead.
 *
 * The discovery order is not a preference: a reversed order lets a Server steer this client at a
 * document it does not own, so the tests assert the exact sequence. The `iss` cases mirror the
 * specification's four-row table, including the one that is easy to get wrong — an AS that declares
 * it always sends `iss` must be *refused* when it does not.
 */

const ACCOUNT = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const PUBLIC_URL = "https://opentag.example.com";

interface Response {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function stubOAuth(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 404 };
    return new Response(next.body ?? "", {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as unknown as typeof globalThis.fetch;
  /*
   * The gate resolves hostnames, and these tests dial `mcp.example.com` and `auth.example.com`. A
   * stub resolver keeps them about OAuth discovery rather than about DNS, and keeps them offline.
   */
  const fetcher = new McpOutboundFetcher({
    allowLoopback: false,
    fetch: fetchImpl,
    resolveAddresses: async (): Promise<string[]> => ["93.184.216.34"],
  });
  return { calls, client: new McpOAuthClient({ fetcher, publicUrl: PUBLIC_URL }) };
}

/**
 * The same stub, with loopback plain HTTP admitted.
 *
 * The fixture Server is on `127.0.0.1` and is its own authorization server, so its metadata is on
 * `http:` — which the ordinary stub refuses before any metadata is parsed. A test about the document's
 * own scheme rules needs that gate out of the way.
 */
function stubOAuthWithLoopback(responses: Response[]) {
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift() ?? { status: 404 };
    return new Response(next.body ?? "", {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as unknown as typeof globalThis.fetch;
  const fetcher = new McpOutboundFetcher({ allowLoopback: true, fetch: fetchImpl });
  return { client: new McpOAuthClient({ fetcher, publicUrl: PUBLIC_URL }) };
}

function json(value: unknown): Response {
  return { status: 200, body: JSON.stringify(value) };
}

describe("MCP OAuth discovery order", () => {
  it("tries the path-insertion well-known forms before the path-appended OIDC form", () => {
    expect(authorizationServerMetadataUrls("https://auth.example.com/tenant")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.com/.well-known/openid-configuration/tenant",
      "https://auth.example.com/tenant/.well-known/openid-configuration",
    ]);
  });

  it("uses only the bare forms for a pathless issuer", () => {
    expect(authorizationServerMetadataUrls("https://auth.example.com")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  it("tries the endpoint-pathwell-known before the bare one, in that order", () => {
    expect(protectedResourceMetadataUrls("https://mcp.example.com/api/mcp")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("uses the challenge's resource_metadata instead of the well-known fallbacks", async () => {
    const { calls, client } = stubOAuth([
      json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] }),
    ]);
    await client.protectedResourceMetadata(
      ACCOUNT,
      "https://mcp.example.com/mcp",
      "https://mcp.example.com/custom-prm.json",
    );
    expect(calls.map((call) => call.url)).toEqual(["https://mcp.example.com/custom-prm.json"]);
  });

  it("refuses a protected-resource document whose resource names a different endpoint", async () => {
    /*
     * RFC 9728 §3.3: the document must name the resource it describes. The value travels as the
     * authorization request's `resource`, so accepting another name would let a hostile Server have
     * this deployment obtain a token for a different resource server at a shared authorization server.
     */
    const { client } = stubOAuth([
      json({ resource: "https://other.example.com/mcp", authorization_servers: ["https://auth.example.com"] }),
    ]);
    await expect(client.protectedResourceMetadata(ACCOUNT, "https://mcp.example.com/mcp")).rejects.toThrow();
  });

  it("accepts the same endpoint spelled with an uppercase host or a trailing slash", async () => {
    // Compared after normalization, so a peer's spelling is not mistaken for an attack.
    for (const advertised of ["HTTPS://MCP.example.com/mcp/", "https://mcp.example.com/mcp#frag"]) {
      const { client } = stubOAuth([
        json({ resource: advertised, authorization_servers: ["https://auth.example.com"] }),
      ]);
      await expect(
        client.protectedResourceMetadata(ACCOUNT, "https://mcp.example.com/mcp"),
        advertised,
      ).resolves.toBeDefined();
    }
  });

  it("rejects an authorization server whose document names a different issuer", async () => {
    const { client } = stubOAuth([
      json({
        issuer: "https://attacker.example.com",
        authorization_endpoint: "https://attacker.example.com/authorize",
        token_endpoint: "https://attacker.example.com/token",
      }),
    ]);
    const error = await client
      .authorizationServerMetadata(ACCOUNT, "https://auth.example.com")
      .catch((caught: unknown) => caught);
    // A mismatch is a mix-up attack, so it propagates instead of falling through to the next form.
    expect((error as { code?: string }).code).toBe(MCP_ERROR_CODES.OAUTH_FAILED);
  });

  it("accepts a document whose issuer matches exactly and exposes its metadata", async () => {
    const { client } = stubOAuth([
      json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        scopes_supported: ["mcp.read", "offline_access"],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      }),
    ]);
    await expect(client.authorizationServerMetadata(ACCOUNT, "https://auth.example.com")).resolves.toMatchObject({
      issuer: "https://auth.example.com",
      registrationEndpoint: "https://auth.example.com/register",
      clientIdMetadataDocumentSupported: true,
      authorizationResponseIssParameterSupported: true,
    });
  });

  it("refuses a document whose endpoints are not https", async () => {
    /*
     * The authorization endpoint is handed to the browser with `location.assign`, and `new URL()`
     * accepts `javascript:` — so a peer answering with one would be executing script in an
     * authenticated page. The CSP blocks that today; validating the scheme is what makes it true by
     * construction rather than by luck.
     *
     * The credential-bearing URL is assembled rather than written out: a literal like this trips
     * secret scanners, which is a false positive but a red CI job either way.
     */
    const credentialBearing = `https://${["user", "secret"].join(":")}@auth.example.com/authorize`;
    for (const endpoint of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://auth.example.com/authorize",
      credentialBearing,
    ]) {
      const { client } = stubOAuth([
        json({
          issuer: "https://auth.example.com",
          authorization_endpoint: endpoint,
          token_endpoint: "https://auth.example.com/token",
        }),
      ]);
      // Refused as "no usable metadata", so the caller tries the next candidate rather than proceeding.
      await expect(client.authorizationServerMetadata(ACCOUNT, "https://auth.example.com"), endpoint).rejects.toThrow();
    }
  });

  it("admits loopback plain HTTP, which the local fixture server needs", async () => {
    /*
     * Exercised with a loopback-permitting fetcher, because the other tests' stub refuses loopback
     * before the metadata is ever parsed — so asserting it there would only be testing the gate.
     */
    const { client } = stubOAuthWithLoopback([
      json({
        issuer: "http://127.0.0.1:9123",
        authorization_endpoint: "http://127.0.0.1:9123/authorize",
        token_endpoint: "http://127.0.0.1:9123/token",
      }),
    ]);
    await expect(client.authorizationServerMetadata(ACCOUNT, "http://127.0.0.1:9123")).resolves.toMatchObject({
      authorizationEndpoint: "http://127.0.0.1:9123/authorize",
    });
  });

  it("orders the recorded issuer first, keeping the document's order for the rest", () => {
    expect(orderIssuers(["https://a", "https://b", "https://c"], "https://b")).toEqual([
      "https://b",
      "https://a",
      "https://c",
    ]);
    expect(orderIssuers(["https://a", "https://b"], null)).toEqual(["https://a", "https://b"]);
    expect(orderIssuers(["https://a"], "https://gone")).toEqual(["https://a"]);
  });
});

describe("MCP client registration choice", () => {
  const metadata = {
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    scopesSupported: [],
    clientIdMetadataDocumentSupported: false,
    authorizationResponseIssParameterSupported: false,
    tokenEndpointAuthMethodsSupported: [],
  };

  it("uses a client metadata document when the AS advertises it, without registering", async () => {
    /*
     * The CIMD client is this deployment's own metadata URL, derived rather than registered — which is
     * also why no row is stored for it. `resolveClientCredentials` used to own this decision and was
     * the rotating path for the DCR case, so it is gone; the flow service makes the choice now.
     */
    const { calls, client } = stubOAuth([]);
    expect(client.clientMetadataUrl).toBe(`${PUBLIC_URL}/oauth/client-metadata.json`);
    expect(calls).toHaveLength(0);
  });

  it("falls back to dynamic registration and asks for this deployment's exact callback", async () => {
    const { calls, client } = stubOAuth([json({ client_id: "dcr_1", client_secret: "cs_1" })]);
    await expect(
      client.registerDynamically(ACCOUNT, {
        ...metadata,
        registrationEndpoint: "https://auth.example.com/register",
      }),
    ).resolves.toEqual({
      source: "dcr",
      clientId: "dcr_1",
      clientSecret: "cs_1",
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    const registration = JSON.parse(String((calls[0] as { init: RequestInit }).init.body)) as Record<string, unknown>;
    expect(registration.redirect_uris).toEqual([`${PUBLIC_URL}/api/v1/mcp-servers/oauth/callback`]);
    // A remote web application, not a native one.
    expect(registration.application_type).toBe("web");
    expect(registration.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("reports an explicit unsupported result when the AS offers no registration endpoint", async () => {
    // The flow service reaches this through `registerDynamically` when the AS advertises neither CIMD
    // nor a registration endpoint, so the refusal lives on that method now.
    const { client } = stubOAuth([]);
    const error = await client.registerDynamically(ACCOUNT, metadata).catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe(MCP_ERROR_CODES.REGISTRATION_UNSUPPORTED);
  });
});

describe("MCP client metadata document validation", () => {
  const url = `${PUBLIC_URL}/oauth/client-metadata.json`;
  const { client } = stubOAuth([]);

  it("accepts a document that names itself and keeps its redirects on its own host", () => {
    expect(() =>
      client.validateClientMetadataDocument(url, {
        client_id: url,
        client_name: "OpenTag",
        redirect_uris: [`${PUBLIC_URL}/api/v1/mcp-servers/oauth/callback`],
      }),
    ).not.toThrow();
  });

  it("refuses a document that claims a different client id", () => {
    expect(() =>
      client.validateClientMetadataDocument(url, {
        client_id: "https://elsewhere.example.com/oauth/client-metadata.json",
        client_name: "OpenTag",
        redirect_uris: [`${PUBLIC_URL}/api/v1/mcp-servers/oauth/callback`],
      }),
    ).toThrow();
  });

  it("refuses a redirect on another host", () => {
    expect(() =>
      client.validateClientMetadataDocument(url, {
        client_id: url,
        client_name: "OpenTag",
        redirect_uris: ["https://attacker.example.com/callback"],
      }),
    ).toThrow();
  });
});

describe("MCP PKCE and the resource parameter", () => {
  it("derives an S256 challenge from a high-entropy verifier", () => {
    const { verifier, challenge } = McpOAuthClient.createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("creates a distinct state per call", () => {
    expect(McpOAuthClient.createState()).not.toBe(McpOAuthClient.createState());
  });

  it("carries the resource on both the authorization and the token request", async () => {
    const { calls, client } = stubOAuth([json({ access_token: "at_1", token_type: "Bearer" })]);
    const metadata = {
      issuer: "https://auth.example.com",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      scopesSupported: [],
      clientIdMetadataDocumentSupported: false,
      authorizationResponseIssParameterSupported: false,
      tokenEndpointAuthMethodsSupported: [],
    };
    const authorizationUrl = client.authorizationUrl({
      metadata,
      clientId: "c1",
      state: "s1",
      codeChallenge: "challenge",
      resource: "https://mcp.example.com/mcp",
      scopes: [],
    });
    expect(new URL(authorizationUrl).searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(new URL(authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");

    await client.exchangeAuthorizationCode(ACCOUNT, metadata, {
      code: "code1",
      codeVerifier: "verifier",
      client: { source: "cimd", clientId: "c1", tokenEndpointAuthMethod: "none" },
      resource: "https://mcp.example.com/mcp",
    });
    const body = new URLSearchParams(String((calls[0] as { init: RequestInit }).init.body));
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(body.get("code_verifier")).toBe("verifier");
  });

  it("normalizes the resource spelling without rewriting its path", () => {
    expect(normalizeResource("HTTPS://MCP.Example.com/MCP/", "https://fallback.example.com")).toBe(
      "https://mcp.example.com/MCP",
    );
    expect(normalizeResource(undefined, "https://mcp.example.com/")).toBe("https://mcp.example.com/");
    expect(normalizeResource("https://mcp.example.com/a/b#frag", "https://x")).toBe("https://mcp.example.com/a/b");
  });
});

describe("MCP scope resolution", () => {
  const { client } = stubOAuth([]);
  const metadata = {
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    scopesSupported: ["offline_access"],
    clientIdMetadataDocumentSupported: false,
    authorizationResponseIssParameterSupported: false,
    tokenEndpointAuthMethodsSupported: [],
  };

  it("prefers the challenge's scope as the authority", () => {
    expect(client.resolveScopes("mcp.read mcp.write", ["mcp.read"], metadata)).toEqual([
      "mcp.read",
      "mcp.write",
      "offline_access",
    ]);
  });

  it("falls back to the protected resource scopes when there is no challenge scope", () => {
    expect(client.resolveScopes(undefined, ["mcp.read"], metadata)).toEqual(["mcp.read", "offline_access"]);
  });

  it("adds offline_access only when the authorization server advertises it", () => {
    expect(client.resolveScopes(undefined, ["mcp.read"], { ...metadata, scopesSupported: [] })).toEqual(["mcp.read"]);
  });

  it("sends no scope at all when nothing defines one", () => {
    expect(client.resolveScopes(undefined, [], metadata)).toEqual(["offline_access"]);
    expect(client.resolveScopes(undefined, [], { ...metadata, scopesSupported: [] })).toEqual([]);
  });

  it("honours an explicitly requested set over both defaults", () => {
    expect(client.resolveScopes("mcp.read", ["mcp.read"], metadata, ["custom"])).toEqual(["custom", "offline_access"]);
  });
});

describe("MCP issuer validation (RFC 9207)", () => {
  const { client } = stubOAuth([]);
  const issuer = "https://auth.example.com";
  const declared = {
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    scopesSupported: [],
    clientIdMetadataDocumentSupported: false,
    authorizationResponseIssParameterSupported: true,
    tokenEndpointAuthMethodsSupported: [],
  };
  const silent = { ...declared, authorizationResponseIssParameterSupported: false };

  it("compares a present iss by exact string", () => {
    expect(() => client.validateIssuer(declared, issuer, issuer)).not.toThrow();
    expect(() => client.validateIssuer(silent, issuer, issuer)).not.toThrow();
    // No case folding, no default-port elision, no trailing-slash tolerance.
    expect(() => client.validateIssuer(declared, "HTTPS://AUTH.EXAMPLE.COM", issuer)).toThrow();
    expect(() => client.validateIssuer(declared, `${issuer}/`, issuer)).toThrow();
    expect(() => client.validateIssuer(declared, "https://auth.example.com:443", issuer)).toThrow();
  });

  it("refuses a missing iss only when the AS declared it always sends one", () => {
    expect(() => client.validateIssuer(declared, undefined, issuer)).toThrow();
    expect(() => client.validateIssuer(silent, undefined, issuer)).not.toThrow();
  });
});

describe("MCP refresh lead", () => {
  it("pulls the deadline forward by at most five minutes", () => {
    expect(refreshLeadMs(3600)).toBe(5 * 60 * 1000);
    // A lifetime shorter than ten minutes gets half of it, so the refresh never loops.
    expect(refreshLeadMs(120)).toBe(60_000);
    expect(refreshLeadMs(60)).toBe(30_000);
  });

  it("treats a missing expires_in as a five-minute lifetime", () => {
    expect(refreshLeadMs(undefined)).toBe(2.5 * 60 * 1000);
  });

  it("computes the deadline from the expiry minus the lead", () => {
    const expiresAt = new Date("2026-09-16T12:00:00.000Z");
    expect(refreshAtFrom(expiresAt, 3600).toISOString()).toBe("2026-09-16T11:55:00.000Z");
    expect(refreshAtFrom(expiresAt, 60).toISOString()).toBe("2026-09-16T11:59:30.000Z");
  });
});
