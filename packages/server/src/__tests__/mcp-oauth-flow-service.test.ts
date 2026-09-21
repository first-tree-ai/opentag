import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentMcpServers,
  agents,
  mcpClientRegistrations,
  mcpServerAuthorizations,
  mcpServers,
  users,
} from "../db/schema/index.js";
import { hashSecret } from "../services/auth/security.js";
import { ApplicationCipher } from "../services/crypto.js";
import { MCP_ERROR_CODES } from "../services/mcp/errors.js";
import { McpCredentialCipher } from "../services/mcp/mcp-credential-cipher.js";
import { MCP_OAUTH_STATE_TTL_MS, McpOAuthClient } from "../services/mcp/mcp-oauth.js";
import { McpOAuthFlowService, orderIssuers } from "../services/mcp/mcp-oauth-flow-service.js";
import { McpServerService } from "../services/mcp/mcp-server-service.js";
import { McpOutboundFetcher } from "../services/mcp/mcp-url-policy.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * The OAuth round trip and token maintenance for one `(Server, Agent)` pair.
 *
 * These run against the same PGlite instance the rest of this package's service suites use, because
 * the flow's correctness lives in what it writes: a hashed state, the flow's own issuer column
 * beside the credential's, and the CAS fences on the callback and the refresh claim. A stubbed query
 * builder would assert the stub.
 *
 * The authorization server is a routed `fetch` fake keyed by URL rather than a queue, because a
 * callback re-fetches the metadata the start already fetched and a queue would make the assertions
 * depend on call order.
 */

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => {
  await unit.reset();
});

const PUBLIC_ORIGIN = "https://opentag.test";
const MCP_URL = "https://mcp.example.com/mcp";
const PRM_URL = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const ISSUER = "https://auth.example.com";
const AS_URL = `${ISSUER}/.well-known/oauth-authorization-server`;
const TOKEN_URL = `${ISSUER}/token`;
const REGISTER_URL = `${ISSUER}/register`;
const FLOW_SECRET = "flow-secret";

interface StubResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

type RouteMap = Record<string, StubResponse | ((init: RequestInit) => StubResponse | Promise<StubResponse>)>;

function doc(body: unknown, status = 200): StubResponse {
  return { status, body: JSON.stringify(body) };
}

/**
 * A stub authorization server keyed by exact URL.
 *
 * Every host used here resolves to one public address, so the suite stays about OAuth rather than
 * about DNS and never touches the network.
 */
function oauthNode(routes: RouteMap) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const route = routes[call.url];
    const next = route === undefined ? { status: 404 } : typeof route === "function" ? await route(call.init) : route;
    return new Response(next.body ?? "", {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function build(routes: RouteMap, options: { now?: () => Date } = {}) {
  const { calls, fetchImpl } = oauthNode(routes);
  const fetcher = new McpOutboundFetcher({
    allowLoopback: false,
    fetch: fetchImpl,
    resolveAddresses: async (): Promise<string[]> => ["93.184.216.34"],
  });
  const oauth = new McpOAuthClient({ fetcher, publicUrl: PUBLIC_ORIGIN });
  const cipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(7)));
  const servers = new McpServerService({ database: unit.database });
  const flows = new McpOAuthFlowService({
    database: unit.database,
    cipher,
    oauth,
    servers,
    ...options,
  });
  return { calls, cipher, flows, oauth, servers };
}

/** The metadata document a usable issuer serves, without any registration mechanism. */
function asMetadata(overrides: Record<string, unknown> = {}) {
  return doc({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: TOKEN_URL,
    ...overrides,
  });
}

/**
 * A Server whose Protected Resource Metadata names one issuer, whose metadata document is usable, and
 * which offers dynamic registration so a start can reach the client-resolution step.
 *
 * The registration endpoint and its route travel together because a metadata document that names an
 * endpoint the stub does not answer is a discovery failure, not a registration one.
 */
function discoverableAs(overrides: Record<string, unknown> = {}): RouteMap {
  const document = { registration_endpoint: REGISTER_URL, ...overrides };
  return {
    [PRM_URL]: doc({ resource: MCP_URL, authorization_servers: [ISSUER] }),
    [AS_URL]: asMetadata(document),
    [REGISTER_URL]: doc({ client_id: "dcr_default", client_secret: "cs_default" }),
  };
}

interface Seeded {
  accountId: string;
  agentId: string;
  mcpServerId: string;
}

async function seed(url = MCP_URL): Promise<Seeded> {
  const accountId = randomUUID();
  await unit.database
    .insert(users)
    .values({ id: accountId, email: `${accountId}@example.test`, displayName: "MCP owner" });
  const agentId = randomUUID();
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    name: `agent-${agentId.slice(0, 8)}`,
    displayName: "MCP Agent",
    runtimeProvider: "codex",
  });
  const [server] = await unit.database
    .insert(mcpServers)
    .values({
      accountId,
      name: `docs-${randomUUID().slice(0, 8)}-${randomUUID().slice(0, 8)}`,
      url,
      defaultAuthKind: "oauth",
    })
    .returning();
  await unit.database.insert(agentMcpServers).values({ agentId, mcpServerId: server?.id as string });
  return { accountId, agentId, mcpServerId: server?.id as string };
}

async function readAuthorization(ids: Seeded) {
  const [row] = await unit.database
    .select()
    .from(mcpServerAuthorizations)
    .where(eq(mcpServerAuthorizations.agentId, ids.agentId));
  return row;
}

function stateOf(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get("state") as string;
}

describe("orderIssuers", () => {
  it("moves the recorded issuer to the front and leaves the rest in PRM order", () => {
    expect(orderIssuers(["https://a", "https://b", "https://c"], "https://c")).toEqual([
      "https://c",
      "https://a",
      "https://b",
    ]);
  });

  it("keeps the document's order when the recorded issuer is gone or absent", () => {
    expect(orderIssuers(["https://a", "https://b"], null)).toEqual(["https://a", "https://b"]);
    expect(orderIssuers(["https://a", "https://b"], "https://gone")).toEqual(["https://a", "https://b"]);
  });
});

describe("McpOAuthFlowService.start", () => {
  it("records a pending flow with a hashed state, a sealed verifier, and the browser binding", async () => {
    const ids = await seed();
    const { calls, flows } = build(discoverableAs());
    const before = Date.now();
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);

    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${ISSUER}/authorize`);
    expect(authorizationUrl.searchParams.get("resource")).toBe(MCP_URL);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC_ORIGIN}/api/v1/mcp-servers/oauth/callback`,
    );
    expect(started.expiresAt.getTime() - before).toBeGreaterThanOrEqual(MCP_OAUTH_STATE_TTL_MS - 5_000);

    const row = await readAuthorization(ids);
    expect(row).toMatchObject({
      kind: "oauth",
      status: "pending",
      authorizationServer: ISSUER,
      flowAuthorizationServer: ISSUER,
      probeState: "pending",
    });
    // The raw state never lands in the column: only its hash does.
    expect(row?.state).toBe(hashSecret(stateOf(started.authorizationUrl)));
    expect(row?.state).not.toBe(stateOf(started.authorizationUrl));
    expect(row?.loginSessionHash).toBe(hashSecret(FLOW_SECRET));
    expect(row?.pkceCiphertext).toMatch(/^v2\.default\./);
    expect(row?.ciphertext).toBeNull();
    // Discovery ran against the endpoint's own well-known URLs, not against something the peer chose,
    // and the client was registered once against the endpoint the metadata named.
    expect(calls.map((call) => call.url)).toEqual([PRM_URL, AS_URL, REGISTER_URL]);
  });

  it("restarts a flow in place and invalidates the previous state in the same write", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    const first = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    const firstRow = await readAuthorization(ids);
    const second = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, ["mcp.read"], FAKE_SECOND_SECRET);

    expect(stateOf(second.authorizationUrl)).not.toBe(stateOf(first.authorizationUrl));
    const row = await readAuthorization(ids);
    expect(row?.state).toBe(hashSecret(stateOf(second.authorizationUrl)));
    expect(row?.loginSessionHash).toBe(hashSecret(FAKE_SECOND_SECRET));
    expect(row?.scopes).toEqual(["mcp.read"]);
    expect(row?.revision).toBe((firstRow?.revision ?? 0) + 1);
    // A restart is one row, never a second one.
    expect(await unit.database.select().from(mcpServerAuthorizations)).toHaveLength(1);
  });

  it("prefers the deployment's pre-registered client and stores no new registration", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "preregistered",
      clientId: "deployment-client",
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("deployment-client");
    const row = await readAuthorization(ids);
    expect(row?.clientRegistrationId).not.toBeNull();
    expect(await unit.database.select().from(mcpClientRegistrations)).toHaveLength(1);
  });

  it("uses this deployment's own metadata URL when the AS advertises a client metadata document", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs({ client_id_metadata_document_supported: true }));
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(
      `${PUBLIC_ORIGIN}/oauth/client-metadata.json`,
    );
    // CIMD is derived from the deployment, so there is no row to remember.
    expect(await unit.database.select().from(mcpClientRegistrations)).toEqual([]);
    expect((await readAuthorization(ids))?.clientRegistrationId).toBeNull();
  });

  it("reads a pre-registered client's sealed secret and hands it back", async () => {
    /*
     * A deployment's own client is the one a `preregistered` row carries, and its secret is sealed
     * under the registration AAD rather than stored in the clear.
     */
    const ids = await seed();
    const { cipher, flows } = build(discoverableAs());
    const sealed = cipher.encryptClientSecret({ accountId: ids.accountId, authorizationServer: ISSUER }, "cs-prereg");
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "preregistered",
      clientId: "deployment-client",
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("deployment-client");
    const row = await readAuthorization(ids);
    // It is the pre-registered row the flow names, not a new DCR one.
    const [registration] = await unit.database
      .select()
      .from(mcpClientRegistrations)
      .where(eq(mcpClientRegistrations.accountId, ids.accountId));
    expect(row?.clientRegistrationId).toBe(registration?.id as string);
    expect(registration?.source).toBe("preregistered");
    expect(await unit.database.select().from(mcpClientRegistrations)).toHaveLength(1);
  });

  it("reuses a recorded registration that carries no secret", async () => {
    /*
     * A public DCR client has a client id and nothing else; the token request then names it in the
     * body rather than authenticating with it.
     */
    const ids = await seed();
    const { flows } = build({ ...discoverableAs(), [TOKEN_URL]: doc({ access_token: "at_1" }) });
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "dcr",
      clientId: "dcr_public",
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("dcr_public");
    // The recorded row is reused rather than a second one being registered.
    expect(await unit.database.select().from(mcpClientRegistrations)).toHaveLength(1);
    await flows.callback({ code: "code-1", state: stateOf(started.authorizationUrl) }, FLOW_SECRET);
    expect((await readAuthorization(ids))?.status).toBe("active");
  });

  it("stores no secret when the authorization server issues a public client", async () => {
    const ids = await seed();
    const { flows } = build({
      ...discoverableAs(),
      [REGISTER_URL]: doc({ client_id: "dcr_public" }),
    });
    await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    const [registration] = await unit.database
      .select()
      .from(mcpClientRegistrations)
      .where(eq(mcpClientRegistrations.accountId, ids.accountId));
    expect(registration).toMatchObject({ clientId: "dcr_public", ciphertext: null, keyId: null });
  });

  it("registers dynamically once and reuses the recorded client on the next start", async () => {
    const ids = await seed();
    const { calls, flows } = build({
      ...discoverableAs(),
      [REGISTER_URL]: doc({ client_id: "dcr_1", client_secret: "cs_1" }),
    });
    const first = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    expect(new URL(first.authorizationUrl).searchParams.get("client_id")).toBe("dcr_1");
    const row = await readAuthorization(ids);
    expect(row?.clientRegistrationId).not.toBeNull();

    const second = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    expect(new URL(second.authorizationUrl).searchParams.get("client_id")).toBe("dcr_1");
    // One registration for the Account and issuer, whatever the number of starts.
    expect(calls.filter((call) => call.url === REGISTER_URL)).toHaveLength(1);
    expect(await unit.database.select().from(mcpClientRegistrations)).toHaveLength(1);
    // Reuse keeps the row the first flow named, which the callback then presents.
    expect((await readAuthorization(ids))?.clientRegistrationId).toBe(row?.clientRegistrationId);
  });

  it("stores the secret it was issued and hands it back on the next start", async () => {
    const ids = await seed();
    const { cipher, flows } = build({
      ...discoverableAs(),
      [REGISTER_URL]: doc({ client_id: "dcr_1", client_secret: "cs_1" }),
    });
    await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    const [registration] = await unit.database
      .select()
      .from(mcpClientRegistrations)
      .where(eq(mcpClientRegistrations.accountId, ids.accountId));
    expect(registration?.ciphertext).not.toBeNull();
    expect(
      cipher.decryptClientSecret(
        { accountId: ids.accountId, authorizationServer: ISSUER },
        { ciphertext: registration?.ciphertext as string, keyId: registration?.keyId as string },
      ),
    ).toBe("cs_1");
  });

  it("keeps the flow's issuer apart from the credential's when the row already holds a credential", async () => {
    const ids = await seed();
    const { cipher, flows } = build(discoverableAs());
    const sealed = cipher.encryptAuthorizationCredential(
      { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: "https://old.example.com" },
      { accessToken: "old-token", refreshToken: "old-refresh" },
    );
    await unit.database.insert(mcpServerAuthorizations).values({
      agentId: ids.agentId,
      mcpServerId: ids.mcpServerId,
      kind: "oauth",
      status: "active",
      authorizationServer: "https://old.example.com",
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
      probeState: "pending",
    });

    // A discovery failure from here is fine: the row's credential must survive a start either way.
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET).catch(() => null);
    expect(started === null || started.authorizationUrl.length > 0).toBe(true);

    const row = await readAuthorization(ids);
    // The credential's own issuer is the envelope's AAD, so it is the one column `start` may not move.
    expect(row?.authorizationServer).toBe("https://old.example.com");
    expect(row?.flowAuthorizationServer).toBe(ISSUER);
    expect(row?.status).toBe("active");
    expect(row?.ciphertext).toBe(sealed.ciphertext);
    expect(
      cipher.decryptAuthorizationCredential(
        { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: "https://old.example.com" },
        { ciphertext: row?.ciphertext as string, keyId: row?.keyId as string },
      ),
    ).toEqual({ accessToken: "old-token", refreshToken: "old-refresh" });
  });

  it("moves to the next issuer when one has no registration mechanism", async () => {
    const ids = await seed();
    const cimd = "https://cimd.example.com";
    const { flows } = build({
      [PRM_URL]: doc({ resource: MCP_URL, authorization_servers: [ISSUER, cimd] }),
      [AS_URL]: asMetadata(),
      [`${cimd}/.well-known/oauth-authorization-server`]: doc({
        issuer: cimd,
        authorization_endpoint: `${cimd}/authorize`,
        token_endpoint: `${cimd}/token`,
        client_id_metadata_document_supported: true,
      }),
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    expect(new URL(started.authorizationUrl).origin).toBe(cimd);
    expect((await readAuthorization(ids))?.authorizationServer).toBe(cimd);
  });

  it("aborts the whole start when a candidate is refused by the outbound gate", async () => {
    /*
     * Falling through to the next issuer on a `URL_BLOCKED` refusal would be the bypass the gate
     * exists to prevent: the refusal is about the destination, not about this spelling of it.
     */
    const ids = await seed();
    const { flows } = build({
      [PRM_URL]: doc({ resource: MCP_URL, authorization_servers: ["http://169.254.169.254", ISSUER] }),
      [AS_URL]: asMetadata(),
    });
    await expect(flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.URL_BLOCKED,
    });
    expect(await unit.database.select().from(mcpServerAuthorizations)).toEqual([]);
  });

  it("reports every issuer it tried when none of them can be used", async () => {
    const ids = await seed();
    const second = "https://second.example.com";
    const { flows } = build({
      [PRM_URL]: doc({ resource: MCP_URL, authorization_servers: [ISSUER, second] }),
      // Readable, but with no issuer of its own name: a mix-up, refused outright per candidate.
      [AS_URL]: doc({ issuer: "https://attacker.example.com" }),
      [`${second}/.well-known/oauth-authorization-server`]: { status: 500 },
    });
    const error = await flows
      .start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FAILED });
    expect(JSON.stringify((error as { detail?: unknown }).detail)).toContain("tried");
    expect(await unit.database.select().from(mcpServerAuthorizations)).toEqual([]);
  });

  it("refuses a start for an Agent that does not mount the Server", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    await unit.database.delete(agentMcpServers).where(eq(agentMcpServers.agentId, ids.agentId));
    await expect(flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.BINDING_NOT_FOUND,
    });
  });
});

const FAKE_SECOND_SECRET = "flow-secret-for-the-second-browser";

describe("McpOAuthFlowService.callback", () => {
  it("refuses a callback with no browser binding before it even looks for the state", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await expect(
      flows.callback({ code: "c", state: stateOf(started.authorizationUrl) }, undefined),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID });
    // The flow is untouched: an unauthenticated caller must not be able to destroy it.
    expect((await readAuthorization(ids))?.state).not.toBeNull();
  });

  it("refuses an unknown state and a mismatched browser binding without clearing the flow", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await expect(flows.callback({ code: "c", state: "not-a-state" }, FLOW_SECRET)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
    });
    await expect(
      flows.callback({ code: "c", state: stateOf(started.authorizationUrl) }, "another-browser"),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID });
    expect((await readAuthorization(ids))?.state).not.toBeNull();
  });

  it("clears an expired flow and says so", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ stateExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(mcpServerAuthorizations.agentId, ids.agentId));
    await expect(
      flows.callback({ code: "c", state: stateOf(started.authorizationUrl) }, FLOW_SECRET),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED });
    const row = await readAuthorization(ids);
    expect(row?.state).toBeNull();
    expect(row?.pkceCiphertext).toBeNull();
    expect(row?.loginSessionHash).toBeNull();
  });

  it("falls through to the next issuer when a stored client secret cannot be opened", async () => {
    /*
     * The catch treats every failure the same way, including one that is not an `McpServiceError`:
     * a pre-registered secret sealed under a key ring this deployment does not hold is a discovery
     * failure for this candidate, not an abort.
     */
    const ids = await seed();
    const foreign = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(9)));
    const sealed = foreign.encryptClientSecret({ accountId: ids.accountId, authorizationServer: ISSUER }, "cs_1");
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "preregistered",
      clientId: "deployment-client",
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
    });
    const second = "https://second.example.com";
    const { flows } = build({
      [PRM_URL]: doc({ resource: MCP_URL, authorization_servers: [ISSUER, second] }),
      [AS_URL]: asMetadata(),
      [`${second}/.well-known/oauth-authorization-server`]: doc({
        issuer: second,
        authorization_endpoint: `${second}/authorize`,
        token_endpoint: `${second}/token`,
        client_id_metadata_document_supported: true,
      }),
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    // The candidate with the unreadable secret failed; the next one completed.
    expect(new URL(started.authorizationUrl).origin).toBe(second);
    expect((await readAuthorization(ids))?.authorizationServer).toBe(second);
  });

  it("records a denial as terminal rather than leaving the row pending", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await expect(
      flows.callback({ state: stateOf(started.authorizationUrl), error: "access_denied" }, FLOW_SECRET),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_DENIED });
    const row = await readAuthorization(ids);
    // The poll ends on a status other than `pending`, and the reason is bounded.
    expect(row).toMatchObject({ status: "error", failureCode: MCP_ERROR_CODES.OAUTH_DENIED, state: null });
  });

  it("maps any other authorization error to a generic failure code", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await expect(
      flows.callback({ state: stateOf(started.authorizationUrl), error: "server_error" }, FLOW_SECRET),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FAILED });
    expect((await readAuthorization(ids))?.failureCode).toBe(MCP_ERROR_CODES.OAUTH_FAILED);
  });

  it("refuses a response that carries no code and ends the flow", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await expect(flows.callback({ state: stateOf(started.authorizationUrl) }, FLOW_SECRET)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID,
    });
    const row = await readAuthorization(ids);
    expect(row?.state).toBeNull();
    expect(row?.status).toBe("error");
  });

  it("redeems the code and stores the sealed credential on the row", async () => {
    const ids = await seed();
    const { cipher, flows } = build({
      ...discoverableAs(),
      [TOKEN_URL]: doc({
        access_token: "at_1",
        refresh_token: "rt_1",
        token_type: "Bearer",
        scope: "mcp.read mcp.write",
        expires_in: 3600,
      }),
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    const now = Date.now();
    await expect(
      flows.callback({ code: "code-1", state: stateOf(started.authorizationUrl), iss: ISSUER }, FLOW_SECRET),
    ).resolves.toEqual({ accountId: ids.accountId, agentId: ids.agentId, mcpServerId: ids.mcpServerId });

    const row = await readAuthorization(ids);
    expect(row).toMatchObject({
      status: "active",
      scopes: ["mcp.read", "mcp.write"],
      failureCode: null,
      // Single use: the flow material is gone the moment the code is redeemed.
      state: null,
      stateExpiresAt: null,
      pkceCiphertext: null,
      loginSessionHash: null,
      probeState: "pending",
    });
    expect(
      cipher.decryptAuthorizationCredential(
        { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: ISSUER },
        { ciphertext: row?.ciphertext as string, keyId: row?.keyId as string },
      ),
    ).toEqual({ accessToken: "at_1", refreshToken: "rt_1", tokenType: "Bearer" });
    expect((row?.accessTokenExpiresAt?.getTime() ?? 0) - now).toBeGreaterThan(3_000_000);
  });

  it("treats a token response without expires_in as a short-lived token", async () => {
    /*
     * Storing null made the token immortal as far as the refresh worker was concerned, because its
     * `due` predicate compares the deadline and null never compares due.
     */
    const ids = await seed();
    const { flows } = build({ ...discoverableAs(), [TOKEN_URL]: doc({ access_token: "at_1" }) });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    const now = Date.now();
    await flows.callback({ code: "code-1", state: stateOf(started.authorizationUrl) }, FLOW_SECRET);
    const row = await readAuthorization(ids);
    const lifetime = (row?.accessTokenExpiresAt?.getTime() ?? 0) - now;
    expect(lifetime).toBeGreaterThan(290_000);
    expect(lifetime).toBeLessThan(320_000);
  });

  it("refuses an authorization response whose issuer does not match", async () => {
    const ids = await seed();
    const { flows } = build({ ...discoverableAs(), [TOKEN_URL]: doc({ access_token: "at_1" }) });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await expect(
      flows.callback(
        { code: "code-1", state: stateOf(started.authorizationUrl), iss: "https://attacker.test" },
        FLOW_SECRET,
      ),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FAILED });
    // The response's own error values were never adopted, because a mismatch is an attack rather
    // than a hint about what went wrong.
    const row = await readAuthorization(ids);
    expect(row?.ciphertext).toBeNull();
    expect(row?.status).toBe("error");
  });

  it("fails the flow when the authorization row never recorded a flow issuer", async () => {
    const ids = await seed();
    const { cipher, flows } = build({ ...discoverableAs(), [TOKEN_URL]: doc({ access_token: "at_1" }) });
    const state = "hand-planted-state";
    await unit.database.insert(mcpServerAuthorizations).values({
      agentId: ids.agentId,
      mcpServerId: ids.mcpServerId,
      kind: "oauth",
      status: "pending",
      state: hashSecret(state),
      stateExpiresAt: new Date(Date.now() + 60_000),
      pkceCiphertext: cipher.encryptPkceVerifier(
        { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: ISSUER },
        "v".repeat(43),
      ).ciphertext,
      loginSessionHash: hashSecret(FLOW_SECRET),
      probeState: "pending",
    });
    await expect(flows.callback({ code: "code-1", state }, FLOW_SECRET)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.OAUTH_FAILED,
    });
  });

  it("fails the flow when the stored PKCE verifier is unreadable", async () => {
    const ids = await seed();
    const { flows } = build({ ...discoverableAs(), [TOKEN_URL]: doc({ access_token: "at_1" }) });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ pkceCiphertext: "not-an-envelope" })
      .where(eq(mcpServerAuthorizations.agentId, ids.agentId));
    await expect(
      flows.callback({ code: "code-1", state: stateOf(started.authorizationUrl) }, FLOW_SECRET),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID });
  });

  it("presents this deployment's own metadata URL for a CIMD flow, resolved rather than looked up", async () => {
    /*
     * A CIMD flow records no registration row, so the callback must derive the client the
     * authorization request named instead of looking one up.
     */
    const ids = await seed();
    const { calls, flows } = build({
      ...discoverableAs({ client_id_metadata_document_supported: true }),
      [TOKEN_URL]: (init) => {
        const body = new URLSearchParams(String(init.body));
        expect(body.get("client_id")).toBe(`${PUBLIC_ORIGIN}/oauth/client-metadata.json`);
        // No client secret, so the client id travels in the body rather than as Basic auth.
        expect(new Headers(init.headers).get("authorization")).toBeNull();
        return doc({ access_token: "at_1", expires_in: 60 });
      },
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await flows.callback({ code: "code-1", state: stateOf(started.authorizationUrl) }, FLOW_SECRET);
    expect(await readAuthorization(ids)).toMatchObject({ status: "active", clientRegistrationId: null });
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
  });

  it("will not present a registration recorded for another authorization server", async () => {
    /*
     * A client registered with one authorization server is not presented to another, so a
     * registration row that no longer names this flow's issuer is treated as missing.
     */
    const ids = await seed();
    const { flows } = build({ ...discoverableAs(), [TOKEN_URL]: doc({ access_token: "at_1" }) });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await unit.database
      .update(mcpClientRegistrations)
      .set({ authorizationServer: "https://elsewhere.example.com" })
      .where(eq(mcpClientRegistrations.accountId, ids.accountId));
    await expect(
      flows.callback({ code: "code-1", state: stateOf(started.authorizationUrl) }, FLOW_SECRET),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.REGISTRATION_FAILED });
    expect((await readAuthorization(ids))?.ciphertext).toBeNull();
  });

  it("names the client the row actually holds when another writer won the registration race", async () => {
    /*
     * Two concurrent starts both miss the lookup and both register; the insert-if-absent lets the
     * first win. The loser must read back the row the Account actually holds rather than naming the
     * client it just registered, which its own callback — which resolves the row — would then fail to
     * present, and a strict authorization server answers `invalid_client`.
     */
    const ids = await seed();
    const { flows } = build({
      ...discoverableAs(),
      [REGISTER_URL]: async () => {
        // The other writer lands between this call's lookup and its insert.
        await unit.database.insert(mcpClientRegistrations).values({
          accountId: ids.accountId,
          authorizationServer: ISSUER,
          source: "dcr",
          clientId: "the-winner",
        });
        return doc({ client_id: "the-loser", client_secret: "cs" });
      },
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe("the-winner");
    const [registration] = await unit.database.select().from(mcpClientRegistrations);
    // The winner's row is untouched: nothing overwrote the client every other flow points at.
    expect(registration?.clientId).toBe("the-winner");
    expect((await readAuthorization(ids))?.clientRegistrationId).toBe(registration?.id as string);
  });

  it("refuses a start whose registration cannot be confirmed after the write", async () => {
    /*
     * A registration that exists under the source the lookup uses but not the one the read-back looks
     * for leaves nothing to name. Registering another client here would rotate the Account's shared
     * row out from under every authorization already pointing at it.
     */
    const ids = await seed();
    const { flows } = build({
      ...discoverableAs(),
      [REGISTER_URL]: async () => {
        await unit.database.insert(mcpClientRegistrations).values({
          accountId: ids.accountId,
          authorizationServer: ISSUER,
          source: "preregistered",
          clientId: "someone-elses-client",
        });
        return doc({ client_id: "dcr_lost_the_race", client_secret: "cs" });
      },
    });
    await expect(flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.OAUTH_FAILED,
    });
    const [registration] = await unit.database.select().from(mcpClientRegistrations);
    expect(registration?.clientId).toBe("someone-elses-client");
    expect(await unit.database.select().from(mcpServerAuthorizations)).toEqual([]);
  });

  it("refuses to redeem a code when no client registration survives for the issuer", async () => {
    const ids = await seed();
    const { cipher, flows } = build({ ...discoverableAs(), [TOKEN_URL]: doc({ access_token: "at_1" }) });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    // The row was pruned between the authorization request and the callback.
    await unit.database.delete(mcpClientRegistrations);
    await unit.database
      .update(mcpServerAuthorizations)
      .set({ clientRegistrationId: null })
      .where(eq(mcpServerAuthorizations.agentId, ids.agentId));
    expect(cipher).toBeDefined();
    await expect(
      flows.callback({ code: "code-1", state: stateOf(started.authorizationUrl) }, FLOW_SECRET),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.REGISTRATION_FAILED });
  });

  it("reports a superseded callback rather than resurrecting a discarded credential", async () => {
    /*
     * The exchange takes an upstream round trip; a revoke or a Bearer switch during it clears the
     * state. The write is fenced on the state it resolved, so the newer decision stands.
     */
    const ids = await seed();
    const { flows } = build({
      ...discoverableAs(),
      [TOKEN_URL]: async () => {
        await unit.database
          .update(mcpServerAuthorizations)
          .set({ state: null, stateExpiresAt: null, loginSessionHash: null, status: "revoked" })
          .where(eq(mcpServerAuthorizations.agentId, ids.agentId));
        return doc({ access_token: "at_1", expires_in: 3600 });
      },
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await expect(
      flows.callback({ code: "code-1", state: stateOf(started.authorizationUrl) }, FLOW_SECRET),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.OAUTH_FLOW_INVALID });
    const row = await readAuthorization(ids);
    // The revoke survived: no credential was written back over it.
    expect(row).toMatchObject({ status: "revoked", ciphertext: null });
  });

  it("keeps a transient exchange failure retryable and a terminal one recorded", async () => {
    const ids = await seed();
    let transient = false;
    const { flows } = build({
      ...discoverableAs(),
      [TOKEN_URL]: () => {
        if (transient) throw new TypeError("socket hang up");
        return doc({ error: "invalid_request" }, 400);
      },
    });
    const started = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    const state = stateOf(started.authorizationUrl);

    await expect(flows.callback({ code: "c1", state }, FLOW_SECRET)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.OAUTH_FAILED,
    });
    expect(await readAuthorization(ids)).toMatchObject({
      status: "error",
      failureCode: MCP_ERROR_CODES.OAUTH_FAILED,
      state: null,
    });

    transient = true;
    const restarted = await flows.start(ids.accountId, ids.agentId, ids.mcpServerId, [], FLOW_SECRET);
    await expect(
      flows.callback({ code: "c2", state: stateOf(restarted.authorizationUrl) }, FLOW_SECRET),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE });
    const row = await readAuthorization(ids);
    // Nothing was sent that could have rotated the token, so the flow is simply cleared for a retry.
    expect(row?.state).toBeNull();
    expect(row?.failureCode).toBeNull();
  });

  it("builds the fixed local return surface, with and without a bounded outcome", async () => {
    const ids = await seed();
    const { flows } = build(discoverableAs());
    const success = new URL(flows.redirectFor(ids.agentId, ids.mcpServerId));
    expect(success.pathname).toBe(`/agents/${ids.agentId}/mcp`);
    expect(success.searchParams.get("mcp_oauth")).toBe("success");
    expect(success.searchParams.get("server")).toBe(ids.mcpServerId);
    const failure = new URL(flows.redirectFor(ids.agentId, ids.mcpServerId, MCP_ERROR_CODES.OAUTH_DENIED));
    expect(failure.searchParams.get("mcp_oauth")).toBe("error");
    expect(failure.searchParams.get("mcp_oauth_error")).toBe(MCP_ERROR_CODES.OAUTH_DENIED);
  });
});

/** A row that is already authorized, for the refresh half of the service. */
async function authorizedRow(
  ids: Seeded,
  credential: { accessToken: string; refreshToken?: string },
  overrides: Partial<typeof mcpServerAuthorizations.$inferInsert> = {},
) {
  const cipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(7)));
  const sealed = cipher.encryptAuthorizationCredential(
    { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: ISSUER },
    credential,
  );
  const [row] = await unit.database
    .insert(mcpServerAuthorizations)
    .values({
      agentId: ids.agentId,
      mcpServerId: ids.mcpServerId,
      kind: "oauth",
      status: "active",
      authorizationServer: ISSUER,
      flowAuthorizationServer: ISSUER,
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
      probeState: "pending",
      ...overrides,
    })
    .returning();
  return { cipher, row };
}

describe("McpOAuthFlowService.refreshAuthorization", () => {
  it("does nothing when the row is not claimable", async () => {
    const ids = await seed();
    const { row } = await authorizedRow(ids, { accessToken: "at", refreshToken: "rt" }, { status: "revoked" });
    const { calls, flows } = build(discoverableAs());
    await expect(flows.refreshAuthorization(row?.id as string)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("releases the claim without sending anything when the stored envelope cannot be opened", async () => {
    /*
     * An `active` OAuth row always carries an envelope — the datastore's `oauth_shape` check says so —
     * so the reachable failure here is a ciphertext this deployment cannot authenticate: a rotated
     * key ring, or a row written by a build that sealed it differently.
     */
    const ids = await seed();
    const foreign = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(9)));
    const sealed = foreign.encryptAuthorizationCredential(
      { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: ISSUER },
      { accessToken: "at_1", refreshToken: "rt_1" },
    );
    const [row] = await unit.database
      .insert(mcpServerAuthorizations)
      .values({
        agentId: ids.agentId,
        mcpServerId: ids.mcpServerId,
        kind: "oauth",
        status: "active",
        authorizationServer: ISSUER,
        ciphertext: sealed.ciphertext,
        keyId: sealed.keyId,
        probeState: "pending",
      })
      .returning();
    const { calls, flows } = build(discoverableAs());
    await expect(flows.refreshAuthorization(row?.id as string)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    const after = await readAuthorization(ids);
    // Released, not left claimed: the next pass retries instead of waiting out the stale window.
    expect(after).toMatchObject({ refreshClaimId: null, refreshClaimedAt: null, status: "active" });
  });

  it("releases the claim when the stored envelope is empty rather than unreadable", async () => {
    /*
     * The pair check is a null check, so an empty string in either column passes it — and the
     * truthiness test here is what refuses it before an attempt to decrypt. Both spellings are
     * exercised because the column that is empty decides which half of the guard fires, and each
     * spelling gets its own seeded pair so neither has to reset the shared database mid-test.
     */
    const spellings = [
      { ciphertext: "", keyId: "default" },
      { ciphertext: "v2.default.x.y.z", keyId: "" },
    ] as const;
    for (const spelling of spellings) {
      const ids = await seed();
      const [row] = await unit.database
        .insert(mcpServerAuthorizations)
        .values({
          agentId: ids.agentId,
          mcpServerId: ids.mcpServerId,
          kind: "oauth",
          status: "active",
          authorizationServer: ISSUER,
          probeState: "pending",
          ...spelling,
        })
        .returning();
      const { calls, flows } = build(discoverableAs());
      await expect(flows.refreshAuthorization(row?.id as string)).resolves.toBeUndefined();
      expect(calls, JSON.stringify(spelling)).toEqual([]);
      expect(await readAuthorization(ids)).toMatchObject({
        refreshClaimId: null,
        refreshClaimedAt: null,
        status: "active",
      });
    }
  });

  it("marks the row expired when the credential carries no refresh token", async () => {
    const ids = await seed();
    const { row } = await authorizedRow(ids, { accessToken: "at" });
    const { calls, flows } = build(discoverableAs());
    await flows.refreshAuthorization(row?.id as string);
    expect(calls).toEqual([]);
    expect(await readAuthorization(ids)).toMatchObject({ status: "expired", refreshClaimId: null });
  });

  it("rotates the credential, the deadline, and the generation on success", async () => {
    const ids = await seed();
    const { cipher, row } = await authorizedRow(ids, { accessToken: "at_1", refreshToken: "rt_1" });
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "preregistered",
      clientId: "deployment-client",
    });
    const { calls, flows } = build({
      ...discoverableAs(),
      [TOKEN_URL]: (init) => {
        const body = new URLSearchParams(String(init.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("rt_1");
        expect(body.get("resource")).toBe(MCP_URL);
        // No client secret on the row, so the client id travels in the body.
        expect(body.get("client_id")).toBe("deployment-client");
        return doc({ access_token: "at_2", refresh_token: "rt_2", expires_in: 600, scope: "mcp.read" });
      },
    });
    const now = Date.now();
    await flows.refreshAuthorization(row?.id as string);
    const after = await readAuthorization(ids);
    expect(after).toMatchObject({
      status: "active",
      failureCode: null,
      scopes: ["mcp.read"],
      refreshClaimId: null,
      refreshGeneration: 1,
    });
    expect((after?.accessTokenExpiresAt?.getTime() ?? 0) - now).toBeGreaterThan(590_000);
    expect(
      cipher.decryptAuthorizationCredential(
        { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: ISSUER },
        { ciphertext: after?.ciphertext as string, keyId: after?.keyId as string },
      ),
    ).toEqual({ accessToken: "at_2", refreshToken: "rt_2" });
    expect(calls.filter((call) => call.url === AS_URL)).toHaveLength(1);
  });

  it("keeps the previous refresh token when the AS does not rotate one", async () => {
    const ids = await seed();
    const { cipher, row } = await authorizedRow(ids, { accessToken: "at_1", refreshToken: "rt_1" });
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "preregistered",
      clientId: "deployment-client",
    });
    const { flows } = build({
      ...discoverableAs(),
      [TOKEN_URL]: doc({ access_token: "at_2", expires_in: 60 }),
    });
    await flows.refreshAuthorization(row?.id as string);
    const after = await readAuthorization(ids);
    expect(
      cipher.decryptAuthorizationCredential(
        { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: ISSUER },
        { ciphertext: after?.ciphertext as string, keyId: after?.keyId as string },
      ),
    ).toEqual({ accessToken: "at_2", refreshToken: "rt_1" });
  });

  it("revokes the credential on the two terminal upstream errors", async () => {
    for (const upstreamError of ["invalid_grant", "invalid_client"]) {
      const ids = await seed();
      const { row } = await authorizedRow(ids, { accessToken: "at_1", refreshToken: "rt_1" });
      await unit.database.insert(mcpClientRegistrations).values({
        accountId: ids.accountId,
        authorizationServer: ISSUER,
        source: "preregistered",
        clientId: "deployment-client",
      });
      const { flows } = build({
        ...discoverableAs(),
        [TOKEN_URL]: doc({ error: upstreamError }, 400),
      });
      await flows.refreshAuthorization(row?.id as string);
      // Only these two mean the credential is definitively gone.
      expect(await readAuthorization(ids), upstreamError).toMatchObject({
        status: "revoked",
        ciphertext: null,
        keyId: null,
        accessTokenExpiresAt: null,
        refreshClaimId: null,
      });
    }
  });

  it("keeps the token and asks for a human when the outcome is unknown", async () => {
    const ids = await seed();
    const { row } = await authorizedRow(ids, { accessToken: "at_1", refreshToken: "rt_1" });
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "preregistered",
      clientId: "deployment-client",
    });
    const { flows } = build({
      ...discoverableAs(),
      [TOKEN_URL]: () => {
        throw new TypeError("socket hang up");
      },
    });
    await flows.refreshAuthorization(row?.id as string);
    const after = await readAuthorization(ids);
    // A blind retry could spend a token the AS already rotated away, so the token is kept untouched.
    expect(after).toMatchObject({
      status: "error",
      failureCode: MCP_ERROR_CODES.REFRESH_OUTCOME_UNKNOWN,
      ciphertext: row?.ciphertext,
    });
  });

  it("records the specific failure code for a known, non-terminal refusal", async () => {
    const ids = await seed();
    const { row } = await authorizedRow(ids, { accessToken: "at_1", refreshToken: "rt_1" });
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "preregistered",
      clientId: "deployment-client",
    });
    // A metadata document that cannot be read is a transient upstream error, not an unknown outcome.
    const { flows } = build({
      [PRM_URL]: doc({ resource: MCP_URL, authorization_servers: [ISSUER] }),
      [AS_URL]: { status: 500 },
    });
    await flows.refreshAuthorization(row?.id as string);
    expect(await readAuthorization(ids)).toMatchObject({
      status: "error",
      failureCode: MCP_ERROR_CODES.UPSTREAM_ERROR,
      ciphertext: row?.ciphertext,
    });
  });

  it("classifies a failure that is not a service error as an unknown outcome", async () => {
    /*
     * The client resolution throws a plain `Error` when the recorded secret cannot be authenticated.
     * That is not a `McpServiceError`, so the row keeps its token and asks a human rather than
     * retrying: the refresh token was never sent, and discarding it would strand the user.
     */
    const ids = await seed();
    const { row } = await authorizedRow(ids, { accessToken: "at_1", refreshToken: "rt_1" });
    const foreign = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(9)));
    const sealed = foreign.encryptClientSecret({ accountId: ids.accountId, authorizationServer: ISSUER }, "cs_1");
    await unit.database.insert(mcpClientRegistrations).values({
      accountId: ids.accountId,
      authorizationServer: ISSUER,
      source: "preregistered",
      clientId: "deployment-client",
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
    });
    const { calls, flows } = build(discoverableAs());
    await flows.refreshAuthorization(row?.id as string);
    expect(calls.filter((call) => call.url === TOKEN_URL)).toEqual([]);
    expect(await readAuthorization(ids)).toMatchObject({
      status: "error",
      failureCode: MCP_ERROR_CODES.REFRESH_OUTCOME_UNKNOWN,
      ciphertext: row?.ciphertext,
    });
  });

  it("fails the refresh when the row's credential issuer is missing", async () => {
    const ids = await seed();
    const cipher = new McpCredentialCipher(new ApplicationCipher(new Uint8Array(32).fill(7)));
    // Sealed under the null issuer a Bearer-shaped envelope uses, then given an OAuth row: there is
    // no authorization server for the refresh to talk to.
    const sealed = cipher.encryptAuthorizationCredential(
      { mcpServerId: ids.mcpServerId, agentId: ids.agentId, authorizationServer: null },
      { accessToken: "at_1", refreshToken: "rt_1" },
    );
    const [row] = await unit.database
      .insert(mcpServerAuthorizations)
      .values({
        agentId: ids.agentId,
        mcpServerId: ids.mcpServerId,
        kind: "oauth",
        status: "active",
        authorizationServer: null,
        ciphertext: sealed.ciphertext,
        keyId: sealed.keyId,
        probeState: "pending",
      })
      .returning();
    const { calls, flows } = build(discoverableAs());
    await flows.refreshAuthorization(row?.id as string);
    expect(calls).toEqual([]);
    expect(await readAuthorization(ids)).toMatchObject({
      status: "error",
      failureCode: MCP_ERROR_CODES.OAUTH_FAILED,
    });
  });
});
