import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { agents, users } from "../../db/schema/index.js";
import { AgentSelfService, AgentService, DatabaseAgentOwnerResolver } from "../../services/agents/index.js";
import { McpServerService } from "../../services/mcp/index.js";
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
  const agent = await agentService.createForAccount(bootstrap.userId, {
    displayName: "Helper",
    name: "helper",
    runtimeProvider: "codex",
  });
  const self = new AgentSelfService({
    agents: agentService,
    mcp,
    owners: new DatabaseAgentOwnerResolver(client.database),
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
  return { ...client, accountId: bootstrap.userId, agent, agentService, mcp, self };
}

async function createUser(database: DatabaseClient, email: string) {
  const [user] = await database.insert(users).values({ displayName: email, email }).returning();
  if (!user) throw new Error("User fixture was not created");
  return user;
}

describe("Agent self-configuration against PostgreSQL", () => {
  it("resolves the owning Account from the Agent and updates its runtime config", async () => {
    const value = await fixture();
    try {
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
      const scope = await value.self.authenticate("valid-proof");
      const server = await value.mcp.createServer(value.accountId, {
        name: "docs",
        url: "https://mcp.example.com/mcp",
        defaultAuthKind: "none",
      });
      const stranger = await createUser(value.database, "stranger@example.com");
      const foreign = await value.mcp.createServer(stranger.id, {
        name: "foreign",
        url: "https://foreign.example.com/mcp",
        defaultAuthKind: "none",
      });

      expect((await value.self.listAvailableMcpServers(scope)).map((entry) => entry.id)).toEqual([server.id]);
      await expect(value.self.attachMcpServer(scope, foreign.id, true)).rejects.toThrow();

      const mounted = await value.self.attachMcpServer(scope, server.id, true);
      expect(mounted).toMatchObject({ mcpServerId: server.id, enabled: true });
      await expect(value.self.updateMcpBinding(scope, server.id, { enabled: false })).resolves.toMatchObject({
        enabled: false,
      });
      expect(await value.self.listMcpServers(scope)).toHaveLength(1);

      await value.self.detachMcpServer(scope, server.id);
      expect(await value.self.listMcpServers(scope)).toEqual([]);
    } finally {
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
