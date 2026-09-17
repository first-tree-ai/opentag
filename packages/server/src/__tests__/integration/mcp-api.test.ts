import { randomBytes, randomUUID } from "node:crypto";
import {
  AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE,
  AGENT_MCP_SERVER_TEMPLATE,
  AGENT_MCP_SERVERS_TEMPLATE,
  MCP_CLIENT_METADATA_PATH,
  MCP_OAUTH_CALLBACK_PATH,
  MCP_SERVER_BY_ID_TEMPLATE,
  MCP_SERVERS_PATH,
} from "@opentag/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { AgentService } from "../../services/agents/index.js";
import type { UserAuthService } from "../../services/auth/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import {
  McpAuthorizationService,
  McpCredentialCipher,
  McpOAuthClient,
  McpOAuthFlowService,
  McpOutboundFetcher,
  McpProbe,
  McpServerService,
} from "../../services/mcp/index.js";
import { McpFixtureServer } from "../fixtures/mcp-fixture-server.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * The management plane exercised over **real HTTP**, against a real PostgreSQL and a loopback fixture
 * MCP Server that is also its own authorization server.
 *
 * `mcp-management.test.ts` drives the services directly, which proves the domain rules but says
 * nothing about the routes: the parsing, the ownership preHandlers, the status codes, the response
 * shapes, the session-less callback, and the CIMD document. Those are exactly what a client depends
 * on, so this suite goes through `app.inject` and asserts the wire contract.
 *
 * No test reaches the public network: the fixture binds to `127.0.0.1` on an ephemeral port and the
 * Server's outbound policy is given the loopback opt-in that a development deployment uses.
 */

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const openPools: { end: () => Promise<unknown> }[] = [];
const openApps: { close: () => Promise<void> }[] = [];
const openFixtures: McpFixtureServer[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openFixtures.splice(0).map((fixture) => fixture.stop()));
  await Promise.all(openPools.splice(0).map((pool) => pool.end()));
});

const PUBLIC_ORIGIN = "https://opentag.test";
const ACCESS_HEADER = { authorization: "Bearer access" };

interface Harness {
  accountId: string;
  agentA: string;
  agentB: string;
  app: ReturnType<typeof createApp>;
  database: DatabaseClient;
  servers: McpServerService;
}

/**
 * Boot the real application with the MCP plane wired, authenticating as one Account.
 *
 * The auth service is stubbed at exactly one seam — the token exchange — so every route under test
 * runs its real preHandler and its real ownership checks; only "who is calling" is fixed.
 */
async function boot(): Promise<Harness> {
  const client = createDatabaseClient(databaseUrl);
  openPools.push(client.sql);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Tester",
    email: `mcp-api-${randomUUID()}@company.example`,
  });
  const accountId = bootstrap.userId;

  const agentService = new AgentService(client.database);
  const machineAuth = new MachineAuthService(client.database);
  const issued = await machineAuth.issueForAccount(accountId, {});
  const exchange = await machineAuth.exchangeConnectCode({
    code: issued.code,
    installationId: randomUUID(),
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const agentA = await agentService.createForAccount(accountId, {
    computerId: exchange.computerId,
    displayName: "Agent A",
    name: "agent-a",
    runtimeProvider: "codex",
  });
  const agentB = await agentService.createForAccount(accountId, {
    computerId: exchange.computerId,
    displayName: "Agent B",
    name: "agent-b",
    runtimeProvider: "codex",
  });

  const fetcher = new McpOutboundFetcher({ allowLoopback: true });
  const cipher = new McpCredentialCipher(new ApplicationCipher(randomBytes(32)));
  const servers = new McpServerService({ database: client.database });
  const oauth = new McpOAuthClient({ fetcher, publicUrl: PUBLIC_ORIGIN });
  const authorization = new McpAuthorizationService({
    database: client.database,
    cipher,
    probe: new McpProbe({ fetcher }),
    servers,
  });
  const flows = new McpOAuthFlowService({ database: client.database, cipher, oauth, servers });

  const authService = {
    exchangeConnectCode: async () => {
      throw new Error("not used");
    },
    refresh: async () => {
      throw new Error("not used");
    },
    getActiveUserById: async () => undefined,
    updateSelfProfile: async () => {
      throw new Error("not used");
    },
    getAuthenticatedUser: async () => ({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: accountId, email: "admin@example.com", displayName: "Admin" },
        setupCompletedAt: null,
      },
    }),
  } as unknown as UserAuthService;

  const app = createApp({
    authService,
    agentService,
    mcp: { authorization, flows, servers, publicOrigin: PUBLIC_ORIGIN },
  });
  openApps.push(app);

  return {
    accountId,
    agentA: agentA.id,
    agentB: agentB.id,
    app,
    database: client.database,
    servers,
  };
}

/** A fixture whose tools span two pages, so pagination is exercised through the HTTP path too. */
async function fixture(options: Parameters<typeof McpFixtureServer.start>[0] = {}) {
  const started = await McpFixtureServer.start(options);
  openFixtures.push(started);
  return started;
}

async function createServerOverHttp(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ id: string; revision: number }> {
  const response = await harness.app.inject({
    method: "POST",
    url: MCP_SERVERS_PATH,
    headers: ACCESS_HEADER,
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; revision: number };
}

async function attachOverHttp(harness: Harness, agentId: string, mcpServerId: string): Promise<unknown> {
  const response = await harness.app.inject({
    method: "POST",
    url: AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", agentId),
    headers: ACCESS_HEADER,
    payload: { mcpServerId, enabled: true },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

// ------------------------------------------------------------------ the route table

describe("MCP HTTP routes — definitions", () => {
  it("creates, reads, lists, edits, and deletes a definition through the real routes", async () => {
    const harness = await boot();
    const created = await createServerOverHttp(harness, {
      name: "linear",
      displayName: "Linear",
      url: "https://mcp.example.com/mcp",
      defaultAuthKind: "bearer",
      authHeader: "x-api-key",
      authScheme: "",
      extraHeaders: { "x-workspace-id": "ws_123" },
    });
    expect(created.revision).toBe(1);

    const listed = await harness.app.inject({ method: "GET", url: MCP_SERVERS_PATH, headers: ACCESS_HEADER });
    expect(listed.statusCode).toBe(200);
    const listBody = listed.json() as { servers: Record<string, unknown>[] };
    expect(listBody.servers).toHaveLength(1);
    // The aggregate fields the pool view depends on, present and zero before any mount.
    expect(listBody.servers[0]).toMatchObject({
      name: "linear",
      boundAgentCount: 0,
      authorizedAgentCount: 0,
      lastProbedAt: null,
      authScheme: "",
      extraHeaders: { "x-workspace-id": "ws_123" },
    });

    const detail = await harness.app.inject({
      method: "GET",
      url: MCP_SERVER_BY_ID_TEMPLATE.replace(":mcpServerId", created.id),
      headers: ACCESS_HEADER,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ server: { id: created.id }, agents: [] });

    const patched = await harness.app.inject({
      method: "PATCH",
      url: MCP_SERVER_BY_ID_TEMPLATE.replace(":mcpServerId", created.id),
      headers: ACCESS_HEADER,
      payload: { displayName: "Linear (renamed)", expectedRevision: 1 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ displayName: "Linear (renamed)", revision: 2 });

    const removed = await harness.app.inject({
      method: "DELETE",
      url: MCP_SERVER_BY_ID_TEMPLATE.replace(":mcpServerId", created.id),
      headers: ACCESS_HEADER,
    });
    expect(removed.statusCode).toBe(204);
    const after = await harness.app.inject({ method: "GET", url: MCP_SERVERS_PATH, headers: ACCESS_HEADER });
    expect((after.json() as { servers: unknown[] }).servers).toHaveLength(0);
  });

  it("answers 409 on a name conflict and on a stale expectedRevision", async () => {
    const harness = await boot();
    const base = { displayName: "Fixture", url: "https://mcp.example.com/mcp", defaultAuthKind: "oauth" };
    await createServerOverHttp(harness, { ...base, name: "linear" });

    /*
     * Over HTTP only the lowercase form is reachable — the name schema rejects anything else before
     * the write — so the reachable conflict is the identical name. The case-insensitive form of the
     * index is exercised by a direct insert in `mcp-management.test.ts`, which is where a database
     * rule can actually be observed.
     */
    const duplicate = await harness.app.inject({
      method: "POST",
      url: MCP_SERVERS_PATH,
      headers: ACCESS_HEADER,
      payload: { ...base, name: "linear" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "MCP_SERVER_NAME_CONFLICT", category: "deterministic" } });

    // An uppercase name is a schema rejection, not a conflict, and must not be reported as one.
    const uppercase = await harness.app.inject({
      method: "POST",
      url: MCP_SERVERS_PATH,
      headers: ACCESS_HEADER,
      payload: { ...base, name: "LINEAR" },
    });
    expect(uppercase.statusCode).toBe(400);

    const second = await createServerOverHttp(harness, { ...base, name: "second" });
    const stale = await harness.app.inject({
      method: "PATCH",
      url: MCP_SERVER_BY_ID_TEMPLATE.replace(":mcpServerId", second.id),
      headers: ACCESS_HEADER,
      payload: { displayName: "Nope", expectedRevision: 99 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "MCP_SERVER_REVISION_CONFLICT" } });
  });

  it("answers 400 for an invalid URL and for a reserved header name", async () => {
    const harness = await boot();
    const invalidUrl = await harness.app.inject({
      method: "POST",
      url: MCP_SERVERS_PATH,
      headers: ACCESS_HEADER,
      payload: { name: "bad", displayName: "Bad", url: "not-a-url" },
    });
    // A shape the schema rejects is the generic validation envelope, not an MCP code.
    expect(invalidUrl.statusCode).toBe(400);
    expect(invalidUrl.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const reservedHeader = await harness.app.inject({
      method: "POST",
      url: MCP_SERVERS_PATH,
      headers: ACCESS_HEADER,
      payload: {
        name: "reserved",
        displayName: "Reserved",
        url: "https://mcp.example.com/mcp",
        authHeader: "host",
      },
    });
    expect(reservedHeader.statusCode).toBe(400);
    expect(reservedHeader.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("answers 404 for an unknown definition and 401 without a session", async () => {
    const harness = await boot();
    const missing = await harness.app.inject({
      method: "GET",
      url: MCP_SERVER_BY_ID_TEMPLATE.replace(":mcpServerId", randomUUID()),
      headers: ACCESS_HEADER,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "MCP_SERVER_NOT_FOUND" } });

    const anonymous = await harness.app.inject({ method: "GET", url: MCP_SERVERS_PATH });
    expect(anonymous.statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ per-Agent routes

describe("MCP HTTP routes — per-Agent mounts and authorization", () => {
  it("drives the whole per-Agent surface and asserts the two-kinds-on-one-Server goal", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }] }] });
    const harness = await boot();

    const definition = await createServerOverHttp(harness, {
      name: "fixture",
      displayName: "Fixture",
      url: server.endpoint,
      defaultAuthKind: "bearer",
    });
    const agentAPath = AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", harness.agentA);
    const agentBPath = AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", harness.agentB);

    await attachOverHttp(harness, harness.agentA, definition.id);
    await attachOverHttp(harness, harness.agentB, definition.id);

    // Goal 1, over HTTP: Agent A takes a Bearer key, Agent B takes OAuth. Same Server, one Account.
    const bearer = await harness.app.inject({
      method: "PUT",
      url: AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE.replace(":agentId", harness.agentA)
        .replace(":mcpServerId", definition.id)
        .replace("/oauth", ""),
      headers: ACCESS_HEADER,
      payload: { kind: "bearer", bearerKey: "key_a" },
    });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json()).toMatchObject({
      mcpServerId: definition.id,
      enabled: true,
      // The credential is never returned, not even masked.
      authorization: { kind: "bearer", status: "active", hasCredential: true },
    });
    expect(JSON.stringify(bearer.json())).not.toContain("key_a");

    const oauthStart = await harness.app.inject({
      method: "POST",
      url: AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE.replace(":agentId", harness.agentB).replace(
        ":mcpServerId",
        definition.id,
      ),
      headers: ACCESS_HEADER,
      payload: {},
    });
    expect(oauthStart.statusCode).toBe(200);
    const started = oauthStart.json() as { authorizationUrl: string; expiresAt: string };
    expect(started.authorizationUrl).toContain("/authorize");

    // The pool view now reports one bound... two bound, one authorized.
    const pool = await harness.app.inject({ method: "GET", url: MCP_SERVERS_PATH, headers: ACCESS_HEADER });
    expect((pool.json() as { servers: Record<string, unknown>[] }).servers[0]).toMatchObject({
      boundAgentCount: 2,
      authorizedAgentCount: 1,
    });

    // Both Agents see the same Server, each with its own authorization kind.
    for (const [path, kind] of [
      [agentAPath, "bearer"],
      [agentBPath, "oauth"],
    ] as const) {
      const list = await harness.app.inject({ method: "GET", url: path, headers: ACCESS_HEADER });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { servers: { authorization: { kind: string; status: string } | null }[] };
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0]?.authorization?.kind).toBe(kind);
    }

    // Goal 4 over HTTP: disabling is per Agent and leaves the other's credential alone.
    const bindingPath = AGENT_MCP_SERVER_TEMPLATE.replace(":agentId", harness.agentB).replace(
      ":mcpServerId",
      definition.id,
    );
    const disabled = await harness.app.inject({
      method: "PATCH",
      url: bindingPath,
      headers: ACCESS_HEADER,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ enabled: false, authorization: { status: "pending" } });

    const stillEnabled = await harness.app.inject({ method: "GET", url: agentAPath, headers: ACCESS_HEADER });
    expect((stillEnabled.json() as { servers: { enabled: boolean }[] }).servers[0]?.enabled).toBe(true);

    // Re-enabling needs no reauthorization.
    const reenabled = await harness.app.inject({
      method: "PATCH",
      url: bindingPath,
      headers: ACCESS_HEADER,
      payload: { enabled: true },
    });
    expect(reenabled.json()).toMatchObject({ enabled: true });
  }, 30_000);

  it("validates the authorization payload and reports a required credential", async () => {
    const server = await fixture({ toolPages: [{ tools: [] }] });
    const harness = await boot();
    const definition = await createServerOverHttp(harness, {
      name: "fixture",
      displayName: "Fixture",
      url: server.endpoint,
      defaultAuthKind: "oauth",
    });
    await attachOverHttp(harness, harness.agentA, definition.id);
    const authorizationPath = AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE.replace(":agentId", harness.agentA)
      .replace(":mcpServerId", definition.id)
      .replace("/oauth", "");

    // A bearer write without a key is a client error, not a silent anonymous authorization.
    const missingKey = await harness.app.inject({
      method: "PUT",
      url: authorizationPath,
      headers: ACCESS_HEADER,
      payload: { kind: "bearer" },
    });
    expect(missingKey.statusCode).toBe(400);

    // Probing before authorizing is refused with the code the client branches on.
    const prematureProbe = await harness.app.inject({
      method: "POST",
      url: `${AGENT_MCP_SERVER_TEMPLATE.replace(":agentId", harness.agentA).replace(":mcpServerId", definition.id)}/probe`,
      headers: ACCESS_HEADER,
    });
    expect(prematureProbe.statusCode).toBe(401);
    expect(prematureProbe.json()).toMatchObject({ error: { code: "MCP_AUTHORIZATION_REQUIRED" } });

    // A cross-Account Agent id is not a permission denial with a hint; it is simply not found.
    const foreign = await harness.app.inject({
      method: "GET",
      url: AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", randomUUID()),
      headers: ACCESS_HEADER,
    });
    expect([403, 404]).toContain(foreign.statusCode);
  }, 30_000);

  it("exposes an unused definition through the available list and never the mounted one", async () => {
    const server = await fixture({ toolPages: [{ tools: [] }] });
    const harness = await boot();
    const mounted = await createServerOverHttp(harness, {
      name: "mounted",
      displayName: "Mounted",
      url: server.endpoint,
      defaultAuthKind: "none",
    });
    await createServerOverHttp(harness, {
      name: "unused",
      displayName: "Unused",
      url: `${server.endpoint}?alt=1`,
      defaultAuthKind: "none",
    });
    await attachOverHttp(harness, harness.agentA, mounted.id);

    const available = await harness.app.inject({
      method: "GET",
      url: `${AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", harness.agentA)}/available`,
      headers: ACCESS_HEADER,
    });
    expect(available.statusCode).toBe(200);
    const body = available.json() as { servers: { name: string }[] };
    expect(body.servers.map((entry) => entry.name)).toEqual(["unused"]);
  }, 30_000);

  it("mounts an anonymous Server and probes it immediately, with no further step", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }, { name: "search" }] }] });
    const harness = await boot();
    const definition = await createServerOverHttp(harness, {
      name: "anonymous",
      displayName: "Anonymous",
      url: server.endpoint,
      defaultAuthKind: "none",
    });
    const mounted = (await attachOverHttp(harness, harness.agentA, definition.id)) as {
      authorization: { kind: string; status: string; hasCredential: boolean } | null;
    };
    // `none` is a real authorization row, so the mount is usable straight away.
    expect(mounted.authorization).toMatchObject({ kind: "none", status: "active", hasCredential: false });

    const probe = await harness.app.inject({
      method: "POST",
      url: `${AGENT_MCP_SERVER_TEMPLATE.replace(":agentId", harness.agentA).replace(":mcpServerId", definition.id)}/probe`,
      headers: ACCESS_HEADER,
    });
    expect(probe.statusCode, probe.body).toBe(200);
    expect(probe.json()).toMatchObject({
      probeState: "succeeded",
      toolsCount: 2,
      toolsTruncated: false,
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
    });
    // The fixture really was dialled over the wire, and it saw the modern request shape.
    expect(server.requestsFor("server/discover")).toHaveLength(1);
    expect(server.requestsFor("tools/list")).toHaveLength(1);
  }, 30_000);

  it("refuses to delete a definition another Agent still mounts, over HTTP", async () => {
    const server = await fixture({ toolPages: [{ tools: [] }] });
    const harness = await boot();
    const definition = await createServerOverHttp(harness, {
      name: "fixture",
      displayName: "Fixture",
      url: server.endpoint,
      defaultAuthKind: "none",
    });
    await attachOverHttp(harness, harness.agentA, definition.id);

    const blocked = await harness.app.inject({
      method: "DELETE",
      url: MCP_SERVER_BY_ID_TEMPLATE.replace(":mcpServerId", definition.id),
      headers: ACCESS_HEADER,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: "MCP_SERVER_IN_USE" } });

    // Detaching releases it, and the same request then succeeds.
    const detached = await harness.app.inject({
      method: "DELETE",
      url: AGENT_MCP_SERVER_TEMPLATE.replace(":agentId", harness.agentA).replace(":mcpServerId", definition.id),
      headers: ACCESS_HEADER,
    });
    expect(detached.statusCode).toBe(204);
    const removed = await harness.app.inject({
      method: "DELETE",
      url: MCP_SERVER_BY_ID_TEMPLATE.replace(":mcpServerId", definition.id),
      headers: ACCESS_HEADER,
    });
    expect(removed.statusCode).toBe(204);
  }, 30_000);
});

// ------------------------------------------------------------------ the public paths

describe("MCP HTTP routes — the two unauthenticated paths", () => {
  it("serves the client metadata document with an absolute self-referential client_id", async () => {
    const harness = await boot();
    const response = await harness.app.inject({ method: "GET", url: MCP_CLIENT_METADATA_PATH });
    expect(response.statusCode).toBe(200);
    const document = response.json() as Record<string, unknown>;
    // The document must name itself as the exact URL it is served from, or a CIMD consumer rejects it.
    expect(document.client_id).toBe(`${PUBLIC_ORIGIN}${MCP_CLIENT_METADATA_PATH}`);
    expect(document.redirect_uris).toEqual([`${PUBLIC_ORIGIN}/api/v1/mcp-servers/oauth/callback`]);
    expect(document.token_endpoint_auth_method).toBe("none");
    expect(document.application_type).toBe("web");
  });

  it("completes an OAuth authorization through the callback and lands on the Agent page", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "only" }] }] });
    const harness = await boot();
    const definition = await createServerOverHttp(harness, {
      name: "fixture",
      displayName: "Fixture",
      url: server.endpoint,
      defaultAuthKind: "oauth",
    });
    await attachOverHttp(harness, harness.agentA, definition.id);

    const start = await harness.app.inject({
      method: "POST",
      url: AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE.replace(":agentId", harness.agentA).replace(
        ":mcpServerId",
        definition.id,
      ),
      headers: ACCESS_HEADER,
      payload: {},
    });
    const { authorizationUrl } = start.json() as { authorizationUrl: string };

    // Drive the fixture's authorize endpoint the way a browser would, then hand the redirect back to
    // the callback. This is the only path that exercises the session-less state authentication.
    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    const location = new URL(authorize.headers.get("location") as string);
    const callback = await harness.app.inject({
      method: "GET",
      url: `${MCP_OAUTH_CALLBACK_PATH}?code=${encodeURIComponent(location.searchParams.get("code") ?? "")}&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}&iss=${encodeURIComponent(location.searchParams.get("iss") ?? "")}`,
    });
    expect(callback.statusCode).toBe(302);
    const landed = callback.headers.location as string;
    expect(landed).toContain(`/agents/${harness.agentA}/mcp`);
    expect(landed).toContain("mcp_oauth=success");
    expect(landed).toContain(`server=${definition.id}`);

    // The credential is stored and active, and the state is single use.
    const list = await harness.app.inject({
      method: "GET",
      url: AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", harness.agentA),
      headers: ACCESS_HEADER,
    });
    expect((list.json() as { servers: { authorization: { status: string } }[] }).servers[0]?.authorization.status).toBe(
      "active",
    );

    const replay = await harness.app.inject({
      method: "GET",
      url: `${MCP_OAUTH_CALLBACK_PATH}?code=stolen&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`,
    });
    expect(replay.statusCode).toBe(302);
    expect(replay.headers.location as string).toContain("mcp_oauth=error");
    expect(replay.headers.location as string).toContain("MCP_OAUTH_FLOW_INVALID");
  }, 30_000);

  it("reports a denied authorization as a bounded error without echoing the upstream description", async () => {
    const server = await fixture({ denyAuthorization: true });
    const harness = await boot();
    const definition = await createServerOverHttp(harness, {
      name: "fixture",
      displayName: "Fixture",
      url: server.endpoint,
      defaultAuthKind: "oauth",
    });
    await attachOverHttp(harness, harness.agentA, definition.id);

    const start = await harness.app.inject({
      method: "POST",
      url: AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE.replace(":agentId", harness.agentA).replace(
        ":mcpServerId",
        definition.id,
      ),
      headers: ACCESS_HEADER,
      payload: {},
    });
    const { authorizationUrl } = start.json() as { authorizationUrl: string };
    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    const location = new URL(authorize.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("access_denied");

    const callback = await harness.app.inject({
      method: "GET",
      url: `${MCP_OAUTH_CALLBACK_PATH}?error=access_denied&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`,
    });
    expect(callback.statusCode).toBe(302);
    const landed = callback.headers.location as string;
    expect(landed).toContain("mcp_oauth=error");
    expect(landed).toContain("MCP_OAUTH_DENIED");
    // Only the bounded code travels; nothing the authorization server said is echoed.
    expect(landed).not.toContain("error_description");
  }, 30_000);

  it("answers the exact request shapes the browser client builds", async () => {
    /*
     * `apps/web` may only depend on `@opentag/shared`, so the browser client cannot be imported here.
     * What can be asserted is the wire contract it depends on: the CSRF header on every mutation, the
     * paths its helpers build, and the field names its Zod schemas parse. A drift in any of those
     * breaks the page with a schema error rather than a visible failure.
     */
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }] }] });
    const harness = await boot();

    // The browser sends `X-OpenTag-CSRF` on mutations; the route must accept it alongside the session.
    const created = await harness.app.inject({
      method: "POST",
      url: MCP_SERVERS_PATH,
      headers: { ...ACCESS_HEADER, "x-opentag-csrf": "probe-token" },
      payload: { name: "fixture", displayName: "Fixture", url: server.endpoint, defaultAuthKind: "none" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const definition = created.json() as { id: string };

    const attached = await harness.app.inject({
      method: "POST",
      url: `/api/v1/agents/${harness.agentA}/mcp-servers`,
      headers: { ...ACCESS_HEADER, "x-opentag-csrf": "probe-token" },
      payload: { mcpServerId: definition.id, enabled: true },
    });
    expect(attached.statusCode, attached.body).toBe(201);
    // `MCPAgentServerSchema` requires all of these; a rename here would surface as a parse failure.
    expect(attached.json()).toMatchObject({
      mcpServerId: definition.id,
      name: "fixture",
      enabled: true,
      effective: { url: server.endpoint, authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} },
      overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
      authorization: { kind: "none", status: "active", hasCredential: false, probeState: "pending" },
    });

    // The detail payload the edit and remove dialogs read, including the per-Agent era field.
    const detail = await harness.app.inject({
      method: "GET",
      url: `/api/v1/mcp-servers/${definition.id}`,
      headers: ACCESS_HEADER,
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as { server: Record<string, unknown>; agents: Record<string, unknown>[] };
    expect(detailBody.server).toMatchObject({
      revision: 1,
      boundAgentCount: 1,
      authorizedAgentCount: 1,
      defaultAuthKind: "none",
    });
    expect(detailBody.agents[0]).toHaveProperty("protocolEra");
    expect(detailBody.agents[0]).toHaveProperty("protocolVersion");

    // The available list the "add existing" drawer reads.
    const available = await harness.app.inject({
      method: "GET",
      url: `/api/v1/agents/${harness.agentA}/mcp-servers/available`,
      headers: ACCESS_HEADER,
    });
    expect(available.statusCode).toBe(200);
    expect(available.json()).toEqual({ servers: [] });
  }, 30_000);

  it("keeps the outbound gate in front of the routes by refusing a private endpoint", async () => {
    const harness = await boot();
    // A definition whose endpoint is link-local is accepted at write time (the URL is well-formed)
    // and refused when anything tries to dial it, which is the layer that matters.
    const definition = await createServerOverHttp(harness, {
      name: "metadata",
      displayName: "Metadata",
      url: "https://169.254.169.254/latest/meta-data/",
      defaultAuthKind: "none",
    });
    await attachOverHttp(harness, harness.agentA, definition.id);
    const probe = await harness.app.inject({
      method: "POST",
      url: `${AGENT_MCP_SERVER_TEMPLATE.replace(":agentId", harness.agentA).replace(":mcpServerId", definition.id)}/probe`,
      headers: ACCESS_HEADER,
    });
    // `probe` never returns 401 for an authenticated anonymous row, so this is the sealed outcome the
    // UI renders: discovery failed for a blocked destination.
    expect(probe.json()).toMatchObject({ probeState: "failed" });
    expect(JSON.stringify(probe.json())).toContain("MCP_URL_BLOCKED");
  }, 30_000);
});
