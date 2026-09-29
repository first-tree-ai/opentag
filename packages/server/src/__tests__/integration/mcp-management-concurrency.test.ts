import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agentMcpServers, agents, mcpServerAuthorizations, mcpServers, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { McpServerService } from "../../services/mcp/index.js";
import { OnboardingResetService } from "../../services/onboarding-reset/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function seed(client: ReturnType<typeof createDatabaseClient>) {
  const accountId = randomUUID();
  const agentId = randomUUID();
  await client.database.insert(users).values({ id: accountId, email: "mcp@example.test", displayName: "MCP owner" });
  await client.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    name: "reviewer",
    displayName: "Reviewer",
    runtimeProvider: "codex",
    status: "suspended",
  });
  const servers = new McpServerService({ database: client.database });
  const server = await servers.createServer(accountId, {
    name: "docs",
    url: "https://mcp.example.test/api",
    defaultAuthKind: "none",
  });
  await servers.attachServer(accountId, agentId, server.id, true);
  return { accountId, agentId, server };
}

async function waitForLock(sql: ReturnType<typeof createDatabaseClient>["sql"], pid: number) {
  await vi.waitFor(
    async () => {
      const [row] = await sql<{ blocked: boolean }[]>`
        select exists (
          select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'
        ) as blocked
      `;
      expect(row?.blocked).toBe(true);
    },
    { timeout: 5_000 },
  );
}

function expectCommitted(results: PromiseSettledResult<unknown>[]) {
  expect(
    results.flatMap((result) => (result.status === "rejected" ? [result.reason.cause ?? result.reason] : [])),
  ).toEqual([]);
}

describe("MCP edit and removal concurrency", () => {
  it.each(["detach", "delete Agent", "reset historical mounts"] as const)(
    "commits a shared edit racing with %s without deadlocking",
    async (operation) => {
      const observer = createDatabaseClient(testDatabase.databaseUrl);
      const editor = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const remover = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const editingServers = new McpServerService({ database: editor.database });
      const removingServers = new McpServerService({ database: remover.database });
      const removingAgents = new AgentService(remover.database);
      const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
      let releaseEdit = () => {};
      const resumeEdit = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      const markPending = editingServers.markProbesPending.bind(editingServers);
      const paused = vi.spyOn(editingServers, "markProbesPending").mockImplementation(async (...args) => {
        // The real edit holds its definition and binding locks; pause before it writes authorization.
        await resumeEdit;
        return markPending(...args);
      });
      try {
        const { accountId, agentId, server } = await seed(observer);
        if (operation === "reset historical mounts") {
          // Legacy soft-deleted Agents can still have mounts, which reset must remove.
          await observer.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, agentId));
        }
        const [backend] = await remover.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        if (!backend) throw new Error("Removal backend was not allocated");
        const editResult = Promise.allSettled([
          editingServers.updateServer(accountId, server.id, {
            expectedRevision: server.revision,
            extraHeaders: { "x-workspace": "updated" },
          }),
        ]);
        pending.push(editResult);
        await vi.waitFor(() => expect(paused).toHaveBeenCalled(), { timeout: 5_000 });

        const remove = () => {
          switch (operation) {
            case "detach":
              return removingServers.detachServer(accountId, agentId, server.id);
            case "delete Agent":
              return removingAgents.deleteById(accountId, agentId);
            case "reset historical mounts":
              return new OnboardingResetService({
                database: remover.database,
                agents: removingAgents,
                environment: "staging",
              }).resetOnboarding(accountId);
          }
        };
        const removeResult = Promise.allSettled([remove()]);
        pending.push(removeResult);
        // Observe an actual PostgreSQL lock wait, rather than relying on scheduling or a sleep.
        await waitForLock(observer.sql, backend.pid);
        releaseEdit();
        expectCommitted(await editResult);
        expectCommitted(await removeResult);
        expect(await observer.database.select().from(agentMcpServers)).toEqual([]);
        expect(await observer.database.select().from(mcpServerAuthorizations)).toEqual([]);
        const definitions = await observer.database.select().from(mcpServers);
        expect(definitions).toMatchObject([
          { revision: server.revision + 1, extraHeaders: { "x-workspace": "updated" } },
        ]);
      } finally {
        releaseEdit();
        await Promise.all(pending);
        paused.mockRestore();
        await Promise.all([observer.sql.end(), editor.sql.end(), remover.sql.end()]);
      }
    },
    15_000,
  );

  it("locks a definition before its historical bindings when deletion queues behind an edit", async () => {
    const observer = createDatabaseClient(testDatabase.databaseUrl);
    const editor = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const remover = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const holder = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const pending: Promise<unknown>[] = [];
    let release = () => {};
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    try {
      const { accountId, agentId, server } = await seed(observer);
      await observer.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, agentId));
      const [editBackend] = await editor.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const [removeBackend] = await remover.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!editBackend || !removeBackend) throw new Error("Race backends were not allocated");
      const holding = holder.sql.begin(async (sql) => {
        await sql`select id from mcp_servers where id = ${server.id} for update`;
        locked();
        await resume;
      });
      pending.push(holding);
      await ready;
      const edited = Promise.allSettled([
        new McpServerService({ database: editor.database }).updateServer(accountId, server.id, {
          expectedRevision: server.revision,
          extraHeaders: { "x-workspace": "updated" },
        }),
      ]);
      pending.push(edited);
      await waitForLock(observer.sql, editBackend.pid);
      const removed = Promise.allSettled([
        new McpServerService({ database: remover.database }).deleteServer(accountId, server.id),
      ]);
      pending.push(removed);
      await waitForLock(observer.sql, removeBackend.pid);
      // The edit is first in the definition lock queue. Deletion must not already hold its bindings.
      release();
      await holding;
      expectCommitted(await edited);
      expectCommitted(await removed);
      expect(await observer.database.select().from(agentMcpServers)).toEqual([]);
      expect(await observer.database.select().from(mcpServerAuthorizations)).toEqual([]);
      expect(await observer.database.select().from(mcpServers)).toEqual([]);
    } finally {
      release();
      await Promise.all(pending);
      await Promise.all([observer.sql.end(), editor.sql.end(), remover.sql.end(), holder.sql.end()]);
    }
  }, 15_000);
});
