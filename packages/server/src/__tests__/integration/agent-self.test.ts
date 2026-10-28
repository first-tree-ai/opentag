import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { agents, mcpServers, users } from "../../db/schema/index.js";
import { AgentSelfService, AgentService, DatabaseAgentOwnerResolver } from "../../services/agents/index.js";
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

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);

afterAll(async () => testDatabase.stop());

beforeEach(async () => testDatabase.reset());

async function fixture() {
  const client = createDatabaseClient(testDatabase.databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, { displayName: "Admin", email: "admin@example.com" });
  const agentService = new AgentService(client.database);
  const mcp = new McpServerService({ database: client.database });
  const fetcher = new McpOutboundFetcher({ allowLoopback: true });
  const cipher = new McpCredentialCipher(new ApplicationCipher(randomBytes(32)));
  const authorization = new McpAuthorizationService({
    database: client.database,
    cipher,
    probe: new McpProbe({ fetcher }),
    servers: mcp,
  });
  const flows = new McpOAuthFlowService({
    database: client.database,
    cipher,
    oauth: new McpOAuthClient({ fetcher, publicUrl: "https://opentag.example.com" }),
    servers: mcp,
  });
  const agent = await agentService.createForAccount(bootstrap.userId, {
    displayName: "Helper",
    name: "helper",
    runtimeProvider: "codex",
  });
  const self = new AgentSelfService({
    agents: agentService,
    authorization,
    flows,
    mcp,
    owners: new DatabaseAgentOwnerResolver(client.database),
    publicOrigin: "https://opentag.example.com",
    proofs: {
      authenticate: async (proof) => {
        if (proof !== "valid-proof") throw new Error("invalid proof");
        return {
          agentId: agent.id,
          computerId: randomUUID(),
          connectionInstanceId: randomUUID(),
          installationId: randomUUID(),
          placementGeneration: 1,
          sessionId: randomUUID(),
          sessionKind: "channel",
        };
      },
    },
  });
  return { ...client, accountId: bootstrap.userId, agent, agentService, authorization, flows, mcp, self };
}

async function createUser(database: DatabaseClient, email: string) {
  const [user] = await database.insert(users).values({ displayName: email, email }).returning();
  if (!user) throw new Error("User fixture was not created");
  return user;
}

async function setSelfConfiguration(value: Awaited<ReturnType<typeof fixture>>, enabled: boolean) {
  const updated = await value.agentService.updateById(value.accountId, value.agent.id, {
    expectedRevision: value.agent.revision,
    selfConfigurationEnabled: enabled,
  });
  value.agent = updated;
  return updated;
}

async function enableSelfConfiguration(value: Awaited<ReturnType<typeof fixture>>) {
  const updated = await value.agentService.updateById(value.accountId, value.agent.id, {
    expectedRevision: value.agent.revision,
    selfConfigurationEnabled: true,
  });
  value.agent = updated;
  return updated;
}

describe("Agent self-configuration against PostgreSQL", () => {
  it("rolls back the owner toggle if the runtime revision write fails", async () => {
    const value = await fixture();
    try {
      await setSelfConfiguration(value, false);
      await value.sql.unsafe(`
        CREATE FUNCTION reject_runtime_revision() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated runtime revision write failure'; END $$;
        CREATE TRIGGER reject_runtime_revision BEFORE UPDATE ON agent_runtime_configs
        FOR EACH ROW EXECUTE FUNCTION reject_runtime_revision();
      `);
      await expect(enableSelfConfiguration(value)).rejects.toThrow();
      expect(await value.agentService.getConfigById(value.accountId, value.agent.id)).toEqual(value.agent);
    } finally {
      await value.sql.unsafe("DROP TRIGGER IF EXISTS reject_runtime_revision ON agent_runtime_configs");
      await value.sql.unsafe("DROP FUNCTION IF EXISTS reject_runtime_revision()");
      await value.sql.end();
    }
  });

  it("resolves the owning Account from the Agent and updates its runtime config", async () => {
    const value = await fixture();
    try {
      expect(value.agent.selfConfigurationEnabled).toBe(true);
      await setSelfConfiguration(value, false);
      await expect(value.self.authenticate("valid-proof")).rejects.toMatchObject({
        code: "AGENT_SELF_CONFIGURATION_DISABLED",
        statusCode: 403,
      });
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");
      expect(scope).toMatchObject({ accountId: value.accountId, agentId: value.agent.id });

      const current = await value.self.getConfig(scope);
      const updated = await value.self.updateConfig(scope, {
        expectedRevision: current.revision,
        runtimeConfig: { instructions: "Answer in English.", reasoningEffort: "high" },
      });
      expect(updated.revision).toBe(current.revision + 1);
      expect(updated.runtimeConfig).toMatchObject({ instructions: "Answer in English.", reasoningEffort: "high" });
      expect(updated.runtimeConfig.revision).toBeGreaterThan(current.runtimeConfig.revision);
      expect(updated.displayName).toBe(current.displayName);
      expect(updated.runtimeConfig.maxDurationMs).toBe(current.runtimeConfig.maxDurationMs);

      await expect(
        value.self.updateConfig(scope, { expectedRevision: current.revision, runtimeConfig: { model: null } }),
      ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    } finally {
      await value.sql.end();
    }
  });

  it("mounts, toggles, and unmounts only the owning Account's MCP Servers", async () => {
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");
      const anonymous = await value.mcp.createServer(value.accountId, {
        name: "anonymous",
        url: "https://mcp.example.com/mcp",
        defaultAuthKind: "none",
      });
      const server = await value.mcp.createServer(value.accountId, {
        name: "docs",
        url: "https://mcp.example.com/credentials",
        defaultAuthKind: "bearer",
      });
      const stranger = await createUser(value.database, "stranger@example.com");
      const foreign = await value.mcp.createServer(stranger.id, {
        name: "foreign",
        url: "https://foreign.example.com/mcp",
        defaultAuthKind: "none",
      });

      expect((await value.self.listAvailableMcpServers(scope)).map((entry) => entry.id)).toEqual(
        expect.arrayContaining([anonymous.id, server.id]),
      );
      await expect(value.self.attachMcpServer(scope, foreign.id, true)).rejects.toThrow();
      await expect(value.self.attachMcpServer(scope, anonymous.id, true)).rejects.toMatchObject({
        code: "MCP_SELF_ATTACH_NONE_AUTH_FORBIDDEN",
        statusCode: 403,
      });

      const humanMounted = await value.mcp.attachServer(value.accountId, value.agent.id, anonymous.id, true);
      expect(humanMounted).toMatchObject({ mcpServerId: anonymous.id, enabled: true });

      const mounted = await value.self.attachMcpServer(scope, server.id, true);
      expect(mounted).toMatchObject({ mcpServerId: server.id, enabled: true });
      await expect(value.self.updateMcpBinding(scope, server.id, { enabled: false })).resolves.toMatchObject({
        enabled: false,
      });
      expect(await value.self.listMcpServers(scope)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ mcpServerId: anonymous.id, enabled: true }),
          expect.objectContaining({ mcpServerId: server.id, enabled: false }),
        ]),
      );

      await value.self.detachMcpServer(scope, server.id);
      expect(await value.self.listMcpServers(scope)).toEqual([
        expect.objectContaining({ mcpServerId: anonymous.id, enabled: true }),
      ]);
      await expect(value.self.updateMcpBinding(scope, anonymous.id, { enabled: false })).resolves.toMatchObject({
        enabled: false,
      });
      await value.self.detachMcpServer(scope, anonymous.id);
      expect(await value.self.listMcpServers(scope)).toEqual([]);
    } finally {
      await value.sql.end();
    }
  });

  it("registers and mounts a Server the Agent defines, then drops the definition with it", async () => {
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");

      const created = await value.self.createMcpServer(scope, {
        name: "hubspot",
        url: "https://mcp.hubspot.example/mcp",
        defaultAuthKind: "oauth",
      });
      expect(created).toMatchObject({ name: "hubspot", enabled: true, authorization: null });
      expect((await value.self.listMcpServers(scope)).map((entry) => entry.name)).toEqual(["hubspot"]);

      const { definitionRemoved } = await value.self.deleteMcpServer(scope, created.mcpServerId);
      expect(definitionRemoved).toBe(false);
      expect(await value.self.listMcpServers(scope)).toEqual([]);
      const [row] = await value.database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, created.mcpServerId));
      expect(row).toBeDefined();
    } finally {
      await value.sql.end();
    }
  });

  it("keeps a definition another Agent still mounts", async () => {
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");
      const created = await value.self.createMcpServer(scope, {
        name: "shared",
        url: "https://mcp.example.com/mcp",
        defaultAuthKind: "oauth",
      });
      const sibling = await value.agentService.createForAccount(value.accountId, {
        displayName: "Sibling",
        name: "sibling",
        runtimeProvider: "codex",
      });
      await value.mcp.attachServer(value.accountId, sibling.id, created.mcpServerId, true);

      await expect(value.self.deleteMcpServer(scope, created.mcpServerId)).resolves.toEqual({
        definitionRemoved: false,
      });
      expect(await value.self.listMcpServers(scope)).toEqual([]);
      const [row] = await value.database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, created.mcpServerId));
      expect(row?.id).toBe(created.mcpServerId);
      expect((await value.mcp.listAgentServers(value.accountId, sibling.id)).map((entry) => entry.name)).toEqual([
        "shared",
      ]);
    } finally {
      await value.sql.end();
    }
  });

  it("writes the Agent's own Bearer key and reports a failed probe rather than throwing", async () => {
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");
      /*
       * Port 1 is never bound, so the probe fails deterministically on this host without reaching
       * the public network: the point of the test is that a failed probe is recorded, not that a
       * Server is reachable.
       */
      const created = await value.self.createMcpServer(scope, {
        name: "internal",
        url: "http://127.0.0.1:1/mcp",
        defaultAuthKind: "bearer",
        apiKey: "secret-key-value",
      });
      expect(created.authorization).toMatchObject({ kind: "bearer", status: "active", hasCredential: true });
      expect(created.authorization?.probeState).toBe("failed");

      const status = await value.self.getMcpOAuthStatus(scope, created.mcpServerId);
      expect(status).toMatchObject({
        name: "internal",
        authKind: "bearer",
        authStatus: "active",
        probeState: "failed",
        tools: null,
      });
      expect(JSON.stringify(status)).not.toContain("secret-key-value");
    } finally {
      await value.sql.end();
    }
  });

  it("rolls back the definition atomically if mounting fails (P2 regression)", async () => {
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");

      // Inject a database failure on the mount table inside the transaction
      await value.sql.unsafe(`
        CREATE FUNCTION reject_agent_mcp_mount() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated mount failure'; END $$;
        CREATE TRIGGER reject_agent_mcp_mount BEFORE INSERT ON agent_mcp_servers
        FOR EACH ROW EXECUTE FUNCTION reject_agent_mcp_mount();
      `);

      await expect(
        value.self.createMcpServer(scope, {
          name: "fail-mount",
          url: "https://mcp.fail.example/mcp",
          defaultAuthKind: "oauth",
        }),
      ).rejects.toThrow();

      // Verify that no orphan definition exists in mcp_servers
      const rows = await value.database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.name, "fail-mount"));
      expect(rows).toEqual([]);
    } finally {
      await value.sql.unsafe(`DROP TRIGGER IF EXISTS reject_agent_mcp_mount ON agent_mcp_servers;`);
      await value.sql.unsafe(`DROP FUNCTION IF EXISTS reject_agent_mcp_mount();`);
      await value.sql.end();
    }
  });

  it("preserves Account-level definitions regardless of description when unmounted by an Agent (Option 1 pure detach)", async () => {
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");

      // Definition with edited description containing arbitrary text
      const definition = await value.mcp.createServer(value.accountId, {
        name: "human-global",
        url: "https://mcp.global.example/mcp",
        defaultAuthKind: "oauth",
      });
      await value.database
        .update(mcpServers)
        .set({ description: "Human-maintained Agent self-service documentation" })
        .where(eq(mcpServers.id, definition.id));

      // Mount to Agent
      await value.self.attachMcpServer(scope, definition.id, true);
      expect((await value.self.listMcpServers(scope)).map((s) => s.mcpServerId)).toContain(definition.id);

      // Agent deletes it: under Option 1 pure detach, definition is NEVER cascaded
      const { definitionRemoved } = await value.self.deleteMcpServer(scope, definition.id);
      expect(definitionRemoved).toBe(false);

      // Unmounted from Agent
      expect((await value.self.listMcpServers(scope)).map((s) => s.mcpServerId)).not.toContain(definition.id);

      // But definition still exists in Account pool intact!
      const [remaining] = await value.database
        .select({ id: mcpServers.id, description: mcpServers.description })
        .from(mcpServers)
        .where(eq(mcpServers.id, definition.id));
      expect(remaining).toBeDefined();
      expect(remaining?.description).toBe("Human-maintained Agent self-service documentation");
    } finally {
      await value.sql.end();
    }
  });

  it("aborts and rolls back definition insert if Agent ownership changes concurrently (P1, DB1)", async () => {
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const otherUser = await createUser(value.database, "other-owner@example.com");

      // Inject a trigger on mcp_servers INSERT that simulates concurrent Agent transfer
      await value.sql.unsafe(`
        CREATE FUNCTION simulate_concurrent_agent_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE agents SET created_by_user_id = '${otherUser.id}' WHERE id = '${value.agent.id}';
          RETURN NEW;
        END $$;
        CREATE TRIGGER simulate_concurrent_agent_transfer AFTER INSERT ON mcp_servers
        FOR EACH ROW EXECUTE FUNCTION simulate_concurrent_agent_transfer();
      `);

      await expect(
        value.mcp.createAndAttachServer(value.accountId, value.agent.id, {
          name: "race-transfer-mcp",
          url: "https://mcp.race.example/mcp",
          defaultAuthKind: "bearer",
        }),
      ).rejects.toMatchObject({ code: "MCP_SERVER_NOT_FOUND" });

      // Verify that the definition insert was completely rolled back
      const rows = await value.database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.name, "race-transfer-mcp"));
      expect(rows).toEqual([]);
    } finally {
      await value.sql.unsafe(`DROP TRIGGER IF EXISTS simulate_concurrent_agent_transfer ON mcp_servers;`);
      await value.sql.unsafe(`DROP FUNCTION IF EXISTS simulate_concurrent_agent_transfer();`);
      await value.sql.end();
    }
  });

  it("aborts self-configuration create if selfConfigurationEnabled is revoked concurrently (P2, DB1)", async () => {
    const value = await fixture();
    const secondClient = createDatabaseClient(testDatabase.databaseUrl);
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");

      // In a second PostgreSQL connection, revoke selfConfigurationEnabled
      const secondAgentService = new AgentService(secondClient.database);
      await secondAgentService.updateById(value.accountId, value.agent.id, {
        expectedRevision: value.agent.revision,
        selfConfigurationEnabled: false,
      });

      // Self-create under previously authenticated scope must reject and roll back
      await expect(
        value.self.createMcpServer(scope, {
          name: "race-revoked-mcp",
          url: "https://mcp.revoked.example/mcp",
          defaultAuthKind: "bearer",
          apiKey: "test-key",
        }),
      ).rejects.toMatchObject({ code: "AGENT_SELF_CONFIGURATION_DISABLED" });

      const rows = await value.database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.name, "race-revoked-mcp"));
      expect(rows).toEqual([]);

      // Normal Account operations succeed when flag is false
      const accountCreated = await value.mcp.createAndAttachServer(
        value.accountId,
        value.agent.id,
        {
          name: "account-created-mcp",
          url: "https://mcp.account.example/mcp",
          defaultAuthKind: "bearer",
        },
        true,
        "account",
      );
      expect(accountCreated.mcpServerId).toBeTruthy();

      // But agent-self attach fails when flag is false
      await expect(
        value.mcp.attachServer(value.accountId, value.agent.id, accountCreated.mcpServerId, true, "agent-self"),
      ).rejects.toMatchObject({ code: "AGENT_SELF_CONFIGURATION_DISABLED" });
    } finally {
      await secondClient.sql.end();
      await value.sql.end();
    }
  });

  it("generates a safe browser handoff URL that redeems the flow secret (P1)", async () => {
    const fixtureServer = await McpFixtureServer.start();
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");

      const created = await value.self.createMcpServer(scope, {
        name: "handoff-test",
        url: fixtureServer.endpoint,
        defaultAuthKind: "oauth",
      });

      const started = await value.self.startMcpOAuth(scope, created.mcpServerId, {});
      expect(started.authorizationUrl).toContain("https://opentag.example.com/api/v1/mcp-servers/oauth/handoff?token=");

      const parsedUrl = new URL(started.authorizationUrl);
      const token = parsedUrl.searchParams.get("token");
      expect(token).toBeTruthy();
      if (!token) throw new Error("Expected token parameter in handoff URL");

      // Redeem the handoff token as the Account that owns the Agent.
      const redeemed = await value.flows.redeemHandoffToken(token, value.accountId);
      expect(redeemed.flowSecret).toBeTruthy();
      expect(redeemed.targetUrl).toContain("/authorize");
      // Single use: the same link cannot bind a second browser.
      await expect(value.flows.redeemHandoffToken(token, value.accountId)).rejects.toMatchObject({
        code: "MCP_OAUTH_FLOW_INVALID",
      });
    } finally {
      await fixtureServer.stop();
      await value.sql.end();
    }
  });

  it("refuses a handoff redemption from another Account as a missing Server (P1)", async () => {
    const fixtureServer = await McpFixtureServer.start();
    const value = await fixture();
    const stranger = await createUser(value.database, "stranger-handoff@example.com");
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");
      const created = await value.self.createMcpServer(scope, {
        name: "handoff-owner-only",
        url: fixtureServer.endpoint,
        defaultAuthKind: "oauth",
      });
      const started = await value.self.startMcpOAuth(scope, created.mcpServerId, {});
      const token = new URL(started.authorizationUrl).searchParams.get("token") ?? "";

      // A stranger's session cannot bind this flow, and learns nothing about whether it exists.
      await expect(value.flows.redeemHandoffToken(token, stranger.id)).rejects.toMatchObject({
        code: "MCP_SERVER_NOT_FOUND",
        statusCode: 404,
      });
      // The refusal must not burn the link for the Account it belongs to.
      const redeemed = await value.flows.redeemHandoffToken(token, value.accountId);
      expect(redeemed.targetUrl).toContain("/authorize");
    } finally {
      await fixtureServer.stop();
      await value.sql.end();
    }
  });

  it("refuses every self-service write path once the opt-in is withdrawn (DB1)", async () => {
    // The flow's discovery has to reach a real endpoint, so the fixture serves both roles here.
    const fixtureServer = await McpFixtureServer.start();
    const value = await fixture();
    try {
      await enableSelfConfiguration(value);
      const scope = await value.self.authenticate("valid-proof");
      const server = await value.mcp.createServer(value.accountId, {
        name: "revoked-writes",
        url: fixtureServer.endpoint,
        defaultAuthKind: "oauth",
      });
      await value.mcp.attachServer(value.accountId, value.agent.id, server.id, true);

      // The owner revokes while the Agent's authenticated scope is still valid.
      await value.agentService.updateById(value.accountId, value.agent.id, {
        expectedRevision: value.agent.revision,
        selfConfigurationEnabled: false,
      });

      for (const write of [
        () => value.self.setMcpBearerKey(scope, server.id, "sk-late"),
        () => value.self.startMcpOAuth(scope, server.id, {}),
        () => value.self.deleteMcpServer(scope, server.id),
        () => value.self.detachMcpServer(scope, server.id),
        () => value.self.updateMcpBinding(scope, server.id, { enabled: false }),
      ]) {
        await expect(write()).rejects.toMatchObject({ code: "AGENT_SELF_CONFIGURATION_DISABLED" });
      }

      // Nothing was written: the mount is intact and carries no credential.
      expect(await value.mcp.listAgentServers(value.accountId, value.agent.id)).toMatchObject([
        { mcpServerId: server.id, enabled: true, authorization: null },
      ]);
    } finally {
      await fixtureServer.stop();
      await value.sql.end();
    }
  });

  it("refuses a deleted Agent", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, value.agent.id));
      await expect(value.self.authenticate("valid-proof")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await expect(value.self.authenticate("other")).rejects.toThrow("invalid proof");
    } finally {
      await value.sql.end();
    }
  });
});
