import { randomBytes, randomUUID } from "node:crypto";
import {
  AGENT_MCP_AUTHORIZATION_TEMPLATE,
  AGENT_MCP_SERVERS_TEMPLATE,
  MCP_GATEWAY_PATH,
  MCP_SERVERS_PATH,
} from "@opentag/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import type { McpGatewayExecutionAuthorizer } from "../../runtime-credentials/mcp-gateway-execution.js";
import { RuntimeMcpGatewayTokenStore } from "../../runtime-credentials/mcp-gateway-token-store.js";
import type { RuntimeExecutionRecord } from "../../runtime-credentials/types.js";
import { AgentService } from "../../services/agents/index.js";
import type { UserAuthService } from "../../services/auth/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import {
  McpAuthorizationService,
  McpCredentialCipher,
  McpGatewayService,
  McpOAuthClient,
  McpOAuthFlowService,
  McpOutboundFetcher,
  McpProbe,
  McpServerService,
  McpUpstreamCaller,
} from "../../services/mcp/index.js";
import { McpFixtureServer, type RecordedRequest } from "../fixtures/mcp-fixture-server.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * The MCP gateway end to end, over real HTTP, against real PostgreSQL and loopback fixture Servers.
 *
 * This is the claim the whole feature rests on and the one no unit test can make: that a bound,
 * authorized MCP Server's tools reach an Agent through one endpoint, and that a call routed through
 * it arrives at the right upstream Server with that Agent's own credential. Everything in between —
 * the definition, the mount, the bearer, the probe, the snapshot, the aggregation, the transport —
 * is real here.
 *
 * Nothing reaches the public network: the fixtures bind `127.0.0.1` on ephemeral ports and the
 * outbound policy is given the loopback opt-in a development deployment uses.
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
  tokens: RuntimeMcpGatewayTokenStore;
  /** Points the stub fence at one Agent, as a live execution would. */
  fenceTo(agentId: string): void;
  /** Makes every request fail the fence, as a closed execution would. */
  closeExecution(): void;
}

/**
 * A stub execution fence.
 *
 * The real authorizer's job — re-checking the live execution, the control connection, the Cloud
 * credential and the Session snapshot — is covered by its own unit tests and has nothing to do with
 * MCP. What matters to the gateway is only the *output*: which Account and Agent this request acts
 * as. Stubbing it keeps this suite about the MCP path while still proving the route reads identity
 * from the fence rather than from the request.
 */
function stubAuthorizer(state: { accountId: string; agentId: string; open: boolean }): McpGatewayExecutionAuthorizer {
  return {
    authorize: async ({ executionId }: { executionId: string }) => {
      if (!state.open) {
        const { McpGatewayError } = await import("../../runtime-credentials/mcp-gateway-execution.js");
        throw new McpGatewayError("execution_closed", "The execution is closed");
      }
      return {
        executionId,
        accountId: state.accountId,
        agentId: state.agentId,
        purpose: "execution",
      } as RuntimeExecutionRecord;
    },
  } as McpGatewayExecutionAuthorizer;
}

async function boot(): Promise<Harness> {
  const client = createDatabaseClient(databaseUrl);
  openPools.push(client.sql);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Tester",
    email: `mcp-gateway-${randomUUID()}@company.example`,
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
    runtimeProvider: "claude-code",
  });
  const agentB = await agentService.createForAccount(accountId, {
    computerId: exchange.computerId,
    displayName: "Agent B",
    name: "agent-b",
    runtimeProvider: "claude-code",
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
    getAuthenticatedUser: async () => ({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: { user: { id: accountId, email: "admin@example.com", displayName: "Admin" }, setupCompletedAt: null },
    }),
    getActiveUserById: async () => undefined,
  } as unknown as UserAuthService;

  const tokens = new RuntimeMcpGatewayTokenStore();
  const fence = { accountId, agentId: agentA.id, open: true };
  const app = createApp({
    authService,
    agentService,
    mcp: { authorization, flows, servers, publicOrigin: PUBLIC_ORIGIN, secureCookies: false },
    mcpGateway: {
      tokens,
      authorizer: stubAuthorizer(fence),
      service: new McpGatewayService({
        servers,
        authorizations: authorization,
        upstream: new McpUpstreamCaller({ fetcher }),
      }),
    },
  });
  openApps.push(app);

  return {
    accountId,
    agentA: agentA.id,
    agentB: agentB.id,
    app,
    tokens,
    fenceTo: (agentId) => {
      fence.agentId = agentId;
    },
    closeExecution: () => {
      fence.open = false;
    },
  };
}

async function fixture(options: Parameters<typeof McpFixtureServer.start>[0] = {}) {
  const started = await McpFixtureServer.start(options);
  openFixtures.push(started);
  return started;
}

/** Register a definition, mount it on the Agent, and store that Agent's Bearer key (which probes). */
async function bind(
  harness: Harness,
  agentId: string,
  name: string,
  endpoint: string,
  bearerKey: string,
): Promise<string> {
  const created = await harness.app.inject({
    method: "POST",
    url: MCP_SERVERS_PATH,
    headers: ACCESS_HEADER,
    payload: { name, url: endpoint, defaultAuthKind: "bearer" },
  });
  expect(created.statusCode, created.body).toBe(201);
  const definition = created.json() as { id: string };

  const attached = await harness.app.inject({
    method: "POST",
    url: AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", agentId),
    headers: ACCESS_HEADER,
    payload: { mcpServerId: definition.id, enabled: true },
  });
  expect(attached.statusCode, attached.body).toBe(201);

  const authorized = await harness.app.inject({
    method: "PUT",
    url: AGENT_MCP_AUTHORIZATION_TEMPLATE.replace(":agentId", agentId).replace(":mcpServerId", definition.id),
    headers: ACCESS_HEADER,
    payload: { kind: "bearer", bearerKey },
  });
  expect(authorized.statusCode, authorized.body).toBe(200);
  await waitForProbe(harness, agentId, definition.id);
  return definition.id;
}

/** The probe runs backstage after the credential is stored, so the snapshot lands asynchronously. */
async function waitForProbe(harness: Harness, agentId: string, mcpServerId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const list = await harness.app.inject({
          method: "GET",
          url: AGENT_MCP_SERVERS_TEMPLATE.replace(":agentId", agentId),
          headers: ACCESS_HEADER,
        });
        const body = list.json() as {
          servers: { mcpServerId: string; authorization: { probeState: string } | null }[];
        };
        return body.servers.find((server) => server.mcpServerId === mcpServerId)?.authorization?.probeState;
      },
      { timeout: 10_000 },
    )
    .toBe("succeeded");
}

async function rpc(
  harness: Harness,
  token: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: "POST",
    url: MCP_GATEWAY_PATH,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: body,
  });
  return {
    statusCode: response.statusCode,
    json: (response.body ? response.json() : {}) as Record<string, unknown>,
  };
}

/** The `tools/call` requests one fixture actually received, with the name and the key it was sent. */
function toolCalls(server: McpFixtureServer): { name: unknown; arguments: unknown; authorization: unknown }[] {
  return server.requests
    .map((request: RecordedRequest) => request.body as { method?: string; params?: Record<string, unknown> })
    .map((body, index) => ({ body, request: server.requests[index] as RecordedRequest }))
    .filter(({ body }) => body?.method === "tools/call")
    .map(({ body, request }) => ({
      name: body.params?.name,
      arguments: body.params?.arguments,
      authorization: request.headers.authorization,
    }));
}

function issue(harness: Harness): string {
  return harness.tokens.issue({ executionId: randomUUID(), expiresAt: Date.now() + 600_000 }).token;
}

describe("the MCP gateway end to end", () => {
  it("aggregates two bound Servers and routes a call to the right one with its own credential", async () => {
    const linear = await fixture({ toolPages: [{ tools: [{ name: "create_issue" }, { name: "search" }] }] });
    const notion = await fixture({ toolPages: [{ tools: [{ name: "search" }] }] });
    const harness = await boot();
    await bind(harness, harness.agentA, "linear", linear.endpoint, "key_linear");
    await bind(harness, harness.agentA, "notion", notion.endpoint, "key_notion");
    const token = issue(harness);

    const handshake = await rpc(harness, token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(handshake.statusCode).toBe(200);
    expect((handshake.json.result as { capabilities: unknown }).capabilities).toEqual({ tools: {} });

    const listed = await rpc(harness, token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.statusCode).toBe(200);
    const tools = (listed.json.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    // Both Servers expose `search`; the namespace is what keeps both reachable.
    expect(tools.sort()).toEqual(["linear__create_issue", "linear__search", "notion__search"]);

    const called = await rpc(harness, token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "notion__search", arguments: { query: "roadmap" } },
    });
    expect(called.statusCode).toBe(200);
    expect(called.json.result).toBeDefined();
    // The call reached Notion, not Linear, and carried Notion's own key.
    expect(toolCalls(notion).at(-1)).toMatchObject({
      name: "search",
      arguments: { query: "roadmap" },
      authorization: "Bearer key_notion",
    });
    expect(toolCalls(linear)).toHaveLength(0);
  }, 30_000);

  it("refuses every request without a valid bearer", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }] }] });
    const harness = await boot();
    await bind(harness, harness.agentA, "fixture", server.endpoint, "key");

    for (const headers of [{}, { authorization: "Bearer otmg_wrong" }, { authorization: "Basic x" }]) {
      const response = await harness.app.inject({
        method: "POST",
        url: MCP_GATEWAY_PATH,
        headers: { ...headers, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(response.statusCode).toBe(401);
    }
  }, 30_000);

  /* The token dies with its execution, which is the whole reason it may be written to a config file. */
  it("stops accepting a token once its execution is revoked", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }] }] });
    const harness = await boot();
    await bind(harness, harness.agentA, "fixture", server.endpoint, "key");
    const executionId = randomUUID();
    const { token } = harness.tokens.issue({ executionId, expiresAt: Date.now() + 600_000 });

    expect((await rpc(harness, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(200);
    harness.tokens.revokeExecution(executionId);
    expect((await rpc(harness, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).statusCode).toBe(401);
  }, 30_000);

  it("refuses a request whose execution no longer passes the fence", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }] }] });
    const harness = await boot();
    await bind(harness, harness.agentA, "fixture", server.endpoint, "key");
    const token = issue(harness);

    harness.closeExecution();
    const response = await rpc(harness, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.statusCode).toBe(409);
  }, 30_000);

  /*
   * Authorization is strictly per Agent, and the gateway inherits that: a tool name lifted from one
   * Agent resolves to nothing for another, because the resolution set is built from the caller's own
   * mounts rather than from the Account's.
   */
  it("never lets one Agent reach another Agent's Server", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }] }] });
    const harness = await boot();
    await bind(harness, harness.agentA, "fixture", server.endpoint, "key_a");
    const token = issue(harness);

    harness.fenceTo(harness.agentB);
    const listed = await rpc(harness, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((listed.json.result as { tools: unknown[] }).tools).toEqual([]);

    const called = await rpc(harness, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "fixture__echo", arguments: {} },
    });
    // A tool error rather than a transport error, and no upstream call was made.
    expect((called.json.result as { isError: boolean }).isError).toBe(true);
    expect(toolCalls(server)).toHaveLength(0);
  }, 30_000);

  it("publishes nothing and reports why when the credential is revoked", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }] }] });
    const harness = await boot();
    const definitionId = await bind(harness, harness.agentA, "fixture", server.endpoint, "key");
    const token = issue(harness);

    const revoked = await harness.app.inject({
      method: "DELETE",
      url: AGENT_MCP_AUTHORIZATION_TEMPLATE.replace(":agentId", harness.agentA).replace(":mcpServerId", definitionId),
      headers: ACCESS_HEADER,
    });
    expect(revoked.statusCode).toBe(200);

    const listed = await rpc(harness, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((listed.json.result as { tools: unknown[] }).tools).toEqual([]);

    const handshake = await rpc(harness, token, { jsonrpc: "2.0", id: 2, method: "initialize" });
    expect((handshake.json.result as { instructions?: string }).instructions).toContain("fixture");
  }, 30_000);

  it("reports an upstream failure as a tool error, not a transport error", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }] }] });
    const harness = await boot();
    await bind(harness, harness.agentA, "fixture", server.endpoint, "key");
    const token = issue(harness);

    // The peer is gone, which is exactly what a model must be able to read and recover from.
    await server.stop();
    const called = await rpc(harness, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fixture__echo", arguments: {} },
    });
    expect(called.statusCode).toBe(200);
    expect((called.json.result as { isError: boolean }).isError).toBe(true);
    expect(called.json.error).toBeUndefined();
  }, 30_000);

  it("answers a notification with 202 and an unknown method with 404", async () => {
    const harness = await boot();
    const token = issue(harness);

    const notification = await harness.app.inject({
      method: "POST",
      url: MCP_GATEWAY_PATH,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(notification.statusCode).toBe(202);

    const unknown = await rpc(harness, token, { jsonrpc: "2.0", id: 1, method: "resources/read" });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json.error as { code: number }).code).toBe(-32601);
  }, 30_000);
});
