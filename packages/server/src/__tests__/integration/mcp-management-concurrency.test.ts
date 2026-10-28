import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { agentMcpServers, agents, mcpServerAuthorizations, mcpServers, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { McpAuthorizationService, McpCredentialCipher, McpServerService } from "../../services/mcp/index.js";
import type { McpProbeResult } from "../../services/mcp/mcp-probe.js";
import { OnboardingResetService } from "../../services/onboarding-reset/index.js";
import { deferred } from "../support/deferred.js";
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

function pauseAfterBindingRead(database: DatabaseClient, pause: () => Promise<void>): DatabaseClient {
  let armed = true;
  const wrapQuery = (query: object): object =>
    new Proxy(query, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then" && typeof value === "function") {
          return (fulfilled: (rows: unknown) => unknown, rejected: (error: unknown) => unknown) => {
            const toSQL = Reflect.get(target, "toSQL");
            const statement =
              typeof toSQL === "function" ? (Reflect.apply(toSQL, target, []) as { sql: string }) : undefined;
            return Promise.resolve(Reflect.apply(value, target, []))
              .then(async (rows) => {
                if (armed && statement?.sql.includes('from "agent_mcp_servers"')) {
                  armed = false;
                  await pause();
                }
                return rows;
              })
              .then(fulfilled, rejected);
          };
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          return result && typeof result === "object" ? wrapQuery(result) : result;
        };
      },
    });
  const wrapExecutor = (executor: object): object =>
    new Proxy(executor, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "select") return (...args: unknown[]) => wrapQuery(Reflect.apply(value, target, args));
        if (key === "transaction")
          return (run: (transaction: unknown) => Promise<unknown>) =>
            Reflect.apply(value, target, [(transaction: object) => run(wrapExecutor(transaction))]);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrapExecutor(database) as DatabaseClient;
}

function authorizations(database: DatabaseClient, servers = new McpServerService({ database })) {
  const probe = { probe: vi.fn().mockRejectedValue(new Error("No upstream request is allowed")) };
  return new McpAuthorizationService({
    database,
    servers,
    probe: probe as never,
    cipher: new McpCredentialCipher(new ApplicationCipher(Buffer.alloc(32, 7))),
  });
}

describe("MCP credential save serialization", () => {
  it.each([
    "detach",
    "detach none",
    "reattach",
    "delete Agent",
    "edit definition",
    "delete definition",
    "reset",
  ] as const)(
    "serializes a credential save with %s after reading its binding",
    async (operation) => {
      const observer = createDatabaseClient(testDatabase.databaseUrl);
      const writer = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const remover = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const resume = deferred();
      const pending: Promise<unknown>[] = [];
      const pause = vi.fn(() => resume.promise);
      const database = pauseAfterBindingRead(writer.database, pause);
      const auth = authorizations(database);
      const now = new Date("2026-10-20T00:00:00.000Z");
      const servers = new McpServerService({ database: remover.database, now: () => now });
      const agentsService = new AgentService(remover.database);
      try {
        const f = await seed(observer);
        await observer.database
          .update(agentMcpServers)
          .set({ createdAt: now })
          .where(eq(agentMcpServers.agentId, f.agentId));
        const [backend] = await remover.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        if (!backend) throw new Error("Missing removal backend");
        const save = Promise.allSettled([
          auth.setBearerOrNone(
            f.accountId,
            f.agentId,
            f.server.id,
            operation === "detach none" ? { kind: "none" } : { kind: "bearer", bearerKey: "synthetic-old-key" },
          ),
        ]);
        pending.push(save);
        await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce(), { timeout: 5_000 });
        const remove = async () => {
          switch (operation) {
            case "detach":
            case "detach none":
              return servers.detachServer(f.accountId, f.agentId, f.server.id);
            case "reattach":
              await servers.detachServer(f.accountId, f.agentId, f.server.id);
              return servers.attachServer(f.accountId, f.agentId, f.server.id, true);
            case "delete Agent":
              return agentsService.deleteById(f.accountId, f.agentId);
            case "edit definition":
              return servers.updateServer(f.accountId, f.server.id, {
                expectedRevision: f.server.revision,
                url: "https://updated.example.test/mcp",
              });
            case "delete definition":
              return servers.deleteServer(f.accountId, f.server.id);
            case "reset":
              return new OnboardingResetService({
                database: remover.database,
                agents: agentsService,
                environment: "staging",
              }).resetOnboarding(f.accountId);
          }
        };
        const removed = Promise.allSettled([remove()]);
        pending.push(removed);
        await waitForLock(observer.sql, backend.pid);
        resume.resolve();
        expectCommitted(await save);
        const outcomes = await removed;
        if (operation === "delete definition") {
          expect(outcomes).toMatchObject([{ status: "rejected", reason: { code: "MCP_SERVER_IN_USE" } }]);
        } else expectCommitted(outcomes);
        const rows = await observer.database.select().from(mcpServerAuthorizations);
        if (operation === "edit definition" || operation === "delete definition") {
          expect(rows).toMatchObject([{ kind: "bearer", status: "active" }]);
          expect(
            await authorizations(observer.database).buildHeaders(f.accountId, f.agentId, f.server.id),
          ).toMatchObject({ authorization: "Bearer synthetic-old-key" });
        } else if (operation === "reattach") {
          expect(rows).toMatchObject([{ kind: "none", ciphertext: null }]);
          expect(
            await authorizations(observer.database).buildHeaders(f.accountId, f.agentId, f.server.id),
          ).not.toHaveProperty("authorization");
          const [binding] = await observer.database.select().from(agentMcpServers);
          expect(binding?.createdAt).toEqual(now);
        } else {
          expect(rows).toEqual([]);
          if (operation === "detach" || operation === "detach none") {
            await servers.attachServer(f.accountId, f.agentId, f.server.id, true);
            expect(
              await authorizations(observer.database).buildHeaders(f.accountId, f.agentId, f.server.id),
            ).not.toHaveProperty("authorization");
          }
        }
      } finally {
        resume.resolve();
        await Promise.allSettled(pending);
        await Promise.all([observer.sql.end(), writer.sql.end(), remover.sql.end()]);
      }
    },
    20_000,
  );

  it("rejects a save queued behind detach without recreating credentials", async () => {
    const observer = createDatabaseClient(testDatabase.databaseUrl);
    const writer = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const remover = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const resume = deferred();
    const pause = vi.fn(() => resume.promise);
    const servers = new McpServerService({ database: pauseAfterBindingRead(remover.database, pause) });
    const pending: Promise<unknown>[] = [];
    try {
      const f = await seed(observer);
      const [backend] = await writer.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("Missing save backend");
      const removed = Promise.allSettled([servers.detachServer(f.accountId, f.agentId, f.server.id)]);
      pending.push(removed);
      await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
      const save = Promise.allSettled([
        authorizations(writer.database).setBearerOrNone(f.accountId, f.agentId, f.server.id, {
          kind: "bearer",
          bearerKey: "synthetic-old-key",
        }),
      ]);
      pending.push(save);
      await waitForLock(observer.sql, backend.pid);
      resume.resolve();
      expectCommitted(await removed);
      expect(await save).toMatchObject([{ status: "rejected", reason: { code: "MCP_BINDING_NOT_FOUND" } }]);
      expect(await observer.database.select().from(mcpServerAuthorizations)).toEqual([]);
      await new McpServerService({ database: observer.database }).attachServer(
        f.accountId,
        f.agentId,
        f.server.id,
        true,
      );
      expect(
        await authorizations(observer.database).buildHeaders(f.accountId, f.agentId, f.server.id),
      ).not.toHaveProperty("authorization");
    } finally {
      resume.resolve();
      await Promise.allSettled(pending);
      await Promise.all([observer.sql.end(), writer.sql.end(), remover.sql.end()]);
    }
  }, 15_000);
});

it.each(["same Agent", "same definition"] as const)(
  "admits an attach on the %s after the Account credential transaction commits",
  async (scope) => {
    const observer = createDatabaseClient(testDatabase.databaseUrl);
    const writer = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const attacher = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const resume = deferred();
    const pause = vi.fn(() => resume.promise);
    const pending: Promise<unknown>[] = [];
    try {
      const f = await seed(observer);
      const servers = new McpServerService({ database: attacher.database });
      const agentId =
        scope === "same Agent"
          ? f.agentId
          : (
              await new AgentService(observer.database).createForAccount(f.accountId, {
                name: "second-agent",
                displayName: "Second Agent",
                runtimeProvider: "codex",
              })
            ).id;
      const serverId =
        scope === "same definition"
          ? f.server.id
          : (
              await servers.createServer(f.accountId, {
                name: "second-server",
                url: "https://second.example.test/mcp",
                defaultAuthKind: "none",
              })
            ).id;
      const save = Promise.allSettled([
        authorizations(pauseAfterBindingRead(writer.database, pause)).setBearerOrNone(
          f.accountId,
          f.agentId,
          f.server.id,
          { kind: "bearer", bearerKey: "synthetic-key" },
        ),
      ]);
      pending.push(save);
      await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
      const [backend] = await attacher.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("Missing attach backend");
      const attached = Promise.allSettled([servers.attachServer(f.accountId, agentId, serverId, true)]);
      pending.push(attached);
      await waitForLock(observer.sql, backend.pid);
      resume.resolve();
      expectCommitted(await save);
      expect(await attached).toMatchObject([{ status: "fulfilled", value: { mcpServerId: serverId, enabled: true } }]);
      expect(await observer.database.select().from(agentMcpServers)).toHaveLength(2);
    } finally {
      resume.resolve();
      await Promise.allSettled(pending);
      await Promise.all([observer.sql.end(), writer.sql.end(), attacher.sql.end()]);
    }
  },
  15_000,
);

it("preserves credentials while disabled and clears them when switching to anonymous", async () => {
  const client = createDatabaseClient(testDatabase.databaseUrl);
  try {
    const f = await seed(client);
    const servers = new McpServerService({ database: client.database });
    const auth = authorizations(client.database);
    await auth.setBearerOrNone(f.accountId, f.agentId, f.server.id, { kind: "bearer", bearerKey: "synthetic-key" });
    const [before] = await client.database.select().from(mcpServerAuthorizations);
    await servers.updateBinding(f.accountId, f.agentId, f.server.id, { enabled: false });
    expect(await client.database.select().from(mcpServerAuthorizations)).toMatchObject([
      { ciphertext: before?.ciphertext },
    ]);
    await servers.updateBinding(f.accountId, f.agentId, f.server.id, { enabled: true });
    expect(await auth.buildHeaders(f.accountId, f.agentId, f.server.id)).toMatchObject({
      authorization: "Bearer synthetic-key",
    });
    await auth.setBearerOrNone(f.accountId, f.agentId, f.server.id, { kind: "none" });
    expect(await client.database.select().from(mcpServerAuthorizations)).toMatchObject([
      { kind: "none", status: "active", ciphertext: null, state: null },
    ]);
    expect(await auth.buildHeaders(f.accountId, f.agentId, f.server.id)).not.toHaveProperty("authorization");
  } finally {
    await client.sql.end();
  }
});

it.each(["success", "failure", "throw"] as const)(
  "drops an old probe %s after detach and reattach with the same revision",
  async (outcome) => {
    const observer = createDatabaseClient(testDatabase.databaseUrl);
    const writer = createDatabaseClient(testDatabase.databaseUrl);
    const answer = deferred<McpProbeResult>();
    const probe = { probe: vi.fn(() => answer.promise) };
    const running: Promise<unknown>[] = [];
    try {
      const f = await seed(observer);
      const servers = new McpServerService({ database: observer.database });
      const auth = new McpAuthorizationService({
        database: writer.database,
        servers: new McpServerService({ database: writer.database }),
        probe: probe as never,
        cipher: new McpCredentialCipher(new ApplicationCipher(Buffer.alloc(32, 7))),
      });
      const [old] = await observer.database.select().from(mcpServerAuthorizations);
      const pending = auth.probe(f.accountId, f.agentId, f.server.id);
      running.push(pending);
      await vi.waitFor(() => expect(probe.probe).toHaveBeenCalledOnce());
      await servers.detachServer(f.accountId, f.agentId, f.server.id);
      await servers.attachServer(f.accountId, f.agentId, f.server.id, true);
      const [replacement] = await observer.database.select().from(mcpServerAuthorizations);
      expect(replacement?.revision).toBe(old?.revision);
      expect(replacement?.id).not.toBe(old?.id);
      if (outcome === "throw") answer.reject(new Error("Synthetic upstream failure"));
      else
        answer.resolve({
          probeState: outcome === "success" ? "succeeded" : "failed",
          protocolEra: "modern",
          protocolVersion: "2026-07-28",
          serverInfo: { name: "Old server" },
          capabilities: {},
          instructions: "Old instructions",
          tools: [],
          toolsCount: 0,
          toolsTruncated: false,
          toolsSkipped: 0,
          probeError: outcome === "success" ? null : "MCP_PROBE_FAILED",
          eraInvalidated: false,
        });
      await pending;
      expect(await observer.database.select().from(mcpServerAuthorizations)).toEqual([replacement]);
    } finally {
      answer.reject(new Error("Fixture cleanup"));
      await Promise.allSettled(running);
      await Promise.all([observer.sql.end(), writer.sql.end()]);
    }
  },
);

it.each(["same Agent", "same definition"] as const)(
  "admits another mount on the %s after the Account credential transaction commits",
  async (scope) => {
    const observer = createDatabaseClient(testDatabase.databaseUrl);
    const writer = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const other = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const resume = deferred();
    const pause = vi.fn(() => resume.promise);
    const running: Promise<unknown>[] = [];
    try {
      const f = await seed(observer);
      const servers = new McpServerService({ database: observer.database });
      const agentId =
        scope === "same Agent"
          ? f.agentId
          : (
              await new AgentService(observer.database).createForAccount(f.accountId, {
                name: "parallel-agent",
                displayName: "Parallel Agent",
                runtimeProvider: "codex",
              })
            ).id;
      const serverId =
        scope === "same definition"
          ? f.server.id
          : (
              await servers.createServer(f.accountId, {
                name: "parallel-server",
                url: "https://parallel.example.test/mcp",
                defaultAuthKind: "none",
              })
            ).id;
      await servers.attachServer(f.accountId, agentId, serverId, true);
      const first = Promise.allSettled([
        authorizations(pauseAfterBindingRead(writer.database, pause)).setBearerOrNone(
          f.accountId,
          f.agentId,
          f.server.id,
          { kind: "bearer", bearerKey: "first-synthetic-key" },
        ),
      ]);
      running.push(first);
      await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
      const [backend] = await other.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error("Missing second credential backend");
      const second = Promise.allSettled([
        authorizations(other.database).setBearerOrNone(f.accountId, agentId, serverId, {
          kind: "bearer",
          bearerKey: "second-synthetic-key",
        }),
      ]);
      running.push(second);
      await waitForLock(observer.sql, backend.pid);
      resume.resolve();
      expectCommitted(await first);
      expectCommitted(await second);
      expect(await authorizations(observer.database).buildHeaders(f.accountId, agentId, serverId)).toMatchObject({
        authorization: "Bearer second-synthetic-key",
      });
    } finally {
      resume.resolve();
      await Promise.allSettled(running);
      await Promise.all([observer.sql.end(), writer.sql.end(), other.sql.end()]);
    }
  },
  15_000,
);
