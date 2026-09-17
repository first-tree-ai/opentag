/**
 * A single end-to-end story told through the real HTTP API, in the order a user would do it.
 *
 * The other suites assert rules one at a time; this one walks the whole journey so that a regression
 * anywhere in the chain — create, mount, authorize, probe, read, edit, remove — shows up as one
 * recognizable failure rather than as an unexplained unit-test diff.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { MCP_SERVERS_PATH } from "@opentag/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { AgentService } from "../../services/agents/index.js";
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

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const openPools: { end: () => Promise<unknown> }[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
  await Promise.all(openPools.splice(0).map((pool) => pool.end()));
});

const HEADERS = { authorization: "Bearer access" };

describe("MCP management plane, end to end as a user would", () => {
  it("takes a Server from registration to a discovered tool list and back out again", async () => {
    const fixture = await McpFixtureServer.start({
      toolPages: [
        { tools: [{ name: "create_issue", description: "Create an issue" }], nextCursor: "page-1" },
        { tools: [{ name: "list_issues", description: "List issues" }] },
      ],
    });
    cleanup.push(() => fixture.stop());

    const client = createDatabaseClient(databaseUrl);
    openPools.push(client.sql);
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Tester",
      email: `live-${randomUUID()}@company.example`,
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
    const agent = await agentService.createForAccount(accountId, {
      computerId: exchange.computerId,
      displayName: "Reviewer",
      name: "reviewer",
      runtimeProvider: "codex",
    });

    const fetcher = new McpOutboundFetcher({ allowLoopback: true });
    const cipher = new McpCredentialCipher(new ApplicationCipher(randomBytes(32)));
    const servers = new McpServerService({ database: client.database });
    const app = createApp({
      authService: {
        exchangeConnectCode: async () => {
          throw new Error("unused");
        },
        refresh: async () => {
          throw new Error("unused");
        },
        getActiveUserById: async () => undefined,
        updateSelfProfile: async () => {
          throw new Error("unused");
        },
        getAuthenticatedUser: async () => ({
          tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
          me: { user: { id: accountId, email: "a@example.com", displayName: "Admin" }, setupCompletedAt: null },
        }),
      } as never,
      agentService,
      mcp: {
        authorization: new McpAuthorizationService({
          database: client.database,
          cipher,
          probe: new McpProbe({ fetcher }),
          servers,
        }),
        flows: new McpOAuthFlowService({
          database: client.database,
          cipher,
          oauth: new McpOAuthClient({ fetcher, publicUrl: "https://opentag.test" }),
          servers,
        }),
        servers,
        publicOrigin: "https://opentag.test",
      },
    });
    cleanup.push(() => app.close());

    // 1. Register the shared definition.
    const created = await app.inject({
      method: "POST",
      url: MCP_SERVERS_PATH,
      headers: HEADERS,
      payload: {
        name: "linear",
        displayName: "Linear",
        url: fixture.endpoint,
        defaultAuthKind: "bearer",
        description: "Issue tracking",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const definition = created.json() as { id: string; revision: number };

    // 2. Mount it for the Agent. Mounting needs no credential yet.
    const mounted = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/mcp-servers`,
      headers: HEADERS,
      payload: { mcpServerId: definition.id, enabled: true },
    });
    expect(mounted.statusCode, mounted.body).toBe(201);
    expect(mounted.json()).toMatchObject({ enabled: true, authorization: null });

    // 3. Authorize with a Bearer key, exactly as the CLI sends it.
    const authorized = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.id}/mcp-servers/${definition.id}/authorization`,
      headers: HEADERS,
      payload: { kind: "bearer", bearerKey: "lin_api_secret" },
    });
    expect(authorized.statusCode, authorized.body).toBe(200);
    expect(authorized.json()).toMatchObject({
      authorization: { kind: "bearer", status: "active", hasCredential: true },
    });
    // The response never carries the key.
    expect(authorized.body).not.toContain("lin_api_secret");

    // 4. Discover the tools. Both pages must land in one snapshot.
    const probed = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/mcp-servers/${definition.id}/probe`,
      headers: HEADERS,
    });
    expect(probed.statusCode, probed.body).toBe(200);
    expect(probed.json()).toMatchObject({
      probeState: "succeeded",
      toolsCount: 2,
      toolsTruncated: false,
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
    });

    /*
     * 5. The fixture saw real modern requests, carrying the credential.
     *
     * Two discoveries is the correct count, not a duplicate: storing a Bearer key triggers a probe
     * of its own (the key is a new credential, so its capability snapshot is unknown), and step 4
     * asked for one explicitly. Both are asserted so the trigger cannot silently stop firing.
     */
    const discovers = fixture.requestsFor("server/discover");
    expect(discovers).toHaveLength(2);
    for (const request of discovers) {
      expect(request.headers.authorization).toBe("Bearer lin_api_secret");
      expect(request.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(request.headers["mcp-method"]).toBe("server/discover");
      expect(request.headers.accept).toBe("application/json, text/event-stream");
    }
    // Two pages per probe, so the snapshot really was paginated rather than taken from page one.
    expect(fixture.requestsFor("tools/list")).toHaveLength(4);

    // 6. Read the row back: the snapshot is on the authorization, and the definition is untouched.
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}/mcp-servers`,
      headers: HEADERS,
    });
    expect(listed.statusCode).toBe(200);
    const row = (listed.json() as { servers: Record<string, unknown>[] }).servers[0] as {
      snapshot: { tools: { name: string }[] };
      authorization: { toolsCount: number };
      overridden: Record<string, boolean>;
    };
    expect(row.snapshot.tools.map((tool) => tool.name)).toEqual(["create_issue", "list_issues"]);
    expect(row.authorization.toolsCount).toBe(2);
    // Nothing is overridden: this Agent uses the shared definition as written.
    expect(Object.values(row.overridden).every((value) => value === false)).toBe(true);

    // The aggregate reflects one bound, one authorized, and a probe time.
    const pool = await app.inject({ method: "GET", url: MCP_SERVERS_PATH, headers: HEADERS });
    expect((pool.json() as { servers: Record<string, unknown>[] }).servers[0]).toMatchObject({
      boundAgentCount: 1,
      authorizedAgentCount: 1,
      revision: 1,
    });
    expect((pool.json() as { servers: { lastProbedAt: string | null }[] }).servers[0]?.lastProbedAt).not.toBeNull();

    // 7. Disable it: the credential survives, so re-enabling needs no reauthorization.
    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}/mcp-servers/${definition.id}`,
      headers: HEADERS,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      enabled: false,
      authorization: { kind: "bearer", hasCredential: true },
    });

    // 8. Take it back out, then delete the definition.
    const detached = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agent.id}/mcp-servers/${definition.id}`,
      headers: HEADERS,
    });
    expect(detached.statusCode).toBe(204);
    const removed = await app.inject({
      method: "DELETE",
      url: `${MCP_SERVERS_PATH}/${definition.id}`,
      headers: HEADERS,
    });
    expect(removed.statusCode).toBe(204);
    const final = await app.inject({ method: "GET", url: MCP_SERVERS_PATH, headers: HEADERS });
    expect((final.json() as { servers: unknown[] }).servers).toHaveLength(0);
  }, 60_000);
});
