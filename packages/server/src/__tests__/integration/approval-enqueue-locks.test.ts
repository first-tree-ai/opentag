import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imBindings } from "../../db/schema/index.js";
import { type ApprovalStore, type PendingApproval, PostgresApprovalStore } from "../../runtime/approval-store.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { RuntimeApprovalOwner } from "../../runtime/runtime-approval-owner.js";
import { deferred } from "../support/deferred.js";
import { createSkillHarness } from "../support/skill-service-harness.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let observer: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
  client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
}, 120_000);
beforeEach(async () => pg.reset());
afterAll(async () => {
  await Promise.all([client?.sql.end(), observer?.sql.end()]);
  await pg?.stop();
});

async function fixture() {
  const harness = createSkillHarness(client);
  const accountId = await harness.createUser();
  const computerId = await harness.createComputer(accountId);
  const agentId = await harness.createAgent(accountId, computerId);
  const [binding] = await client.database.insert(imBindings).values({ agentId, provider: "feishu" }).returning();
  const instanceId = randomUUID();
  const registry = new ConnectionRegistry();
  const callbacks: ((error?: Error) => void)[] = [];
  const entered = deferred();
  const socket = {
    readyState: WebSocket.OPEN,
    send: vi.fn((_text: string, callback: (error?: Error) => void) => {
      callbacks.push(callback);
      entered.resolve();
    }),
    close: vi.fn(),
  } as unknown as WebSocket;
  await registry.register(
    {
      computerId,
      instanceId,
      connectionId: randomUUID(),
      installationId: randomUUID(),
      clientVersion: "0.1.2",
      active: true,
      lastHeartbeatAt: Date.now(),
      socket,
      negotiatedCapabilities: {},
    },
    async () => undefined,
  );
  registry.activate(computerId, instanceId, socket);
  const connectionId = registry.currentConnectionId(computerId, instanceId);
  assert(connectionId);
  assert(binding);
  await client.database
    .update(computers)
    .set({ currentInstanceId: instanceId, currentConnectionId: connectionId })
    .where(eq(computers.id, computerId));
  const row: PendingApproval = {
    id: randomUUID(),
    serverInstanceId: randomUUID(),
    computerId,
    instanceId,
    connectionId,
    imBindingId: binding.id,
    status: "accept",
    request: {
      type: "approval:request",
      title: "Controlled approval",
      description: "Controlled socket callback",
      requestId: randomUUID(),
      sessionId: randomUUID(),
      deliveryId: randomUUID(),
      turnId: randomUUID(),
      placementGeneration: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    authority: {
      senderExternalId: "U1",
      provider: "feishu",
      generation: 1,
      channelId: "C1",
      threadKey: null,
      externalMessageId: "M1",
      configRevision: 1,
    },
    expiresAt: new Date(Date.now() + 60_000),
    messageId: null,
    messageChannelId: null,
    cardUpdatedAt: null,
  };
  const store = new PostgresApprovalStore(client.database);
  expect(await store.insert(row)).toBe("inserted");
  return {
    row,
    store,
    registry,
    entered,
    callbacks,
    socket,
    send: () => registry.send(computerId, instanceId, { type: "approval:decision" }, connectionId),
  };
}

it.each(["success", "failure"] as const)(
  "releases Computer and approval locks before the delayed socket %s",
  async (outcome) => {
    const f = await fixture();
    let finished = false;
    const delivery = f.store
      .deliver(f.row, f.send)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        finished = true;
      });
    try {
      await f.entered.promise;
      await vi.waitFor(async () => {
        const rows = await observer.database.transaction((tx) =>
          tx
            .select({ id: computers.id })
            .from(computers)
            .where(eq(computers.id, f.row.computerId))
            .for("update", { skipLocked: true }),
        );
        expect(rows).toHaveLength(1);
      });
      expect(finished).toBe(false);
      // The original pool has one connection; both the pool and approval row must be free.
      expect(await f.store.update(f.row.id, "accept", { status: "approved" })).toBe(true);
      const callback = f.callbacks[0];
      assert(callback);
      if (outcome === "success") callback();
      else callback(new Error("delayed transport failure"));
      const result = await delivery;
      expect("error" in result).toBe(outcome === "failure");
      expect(await f.store.update(f.row.id, "accept", { status: "stale" })).toBe(false);
      expect((await f.store.find(f.row.id))?.status).toBe("approved");
      expect(f.socket.send).toHaveBeenCalledTimes(1);
    } finally {
      for (const callback of f.callbacks) callback();
      await delivery;
    }
  },
);

it.each(["connection", "status", "expiry"] as const)("rejects a stale %s without enqueue", async (change) => {
  const f = await fixture();
  if (change === "connection")
    await client.database
      .update(computers)
      .set({ currentConnectionId: randomUUID() })
      .where(eq(computers.id, f.row.computerId));
  if (change === "status") await f.store.update(f.row.id, "accept", { status: "stale" });
  if (change === "expiry")
    await client.sql`update runtime_approvals set expires_at = now() - interval '1 second' where id = ${f.row.id}`;
  expect(await f.store.deliver(f.row, f.send)).toBe(false);
  expect(f.socket.send).not.toHaveBeenCalled();
});

it.each(["poll", "request"] as const)("joins actual approval %s SQL before close completes", async (phase) => {
  const f = await fixture(),
    entered = deferred(),
    resume = deferred();
  const store: ApprovalStore = f.store;
  const owner = new RuntimeApprovalOwner({
    store,
    registry: f.registry,
    serverInstanceId: f.row.serverInstanceId,
    authority: async () => ({
      imBindingId: f.row.imBindingId,
      authority: f.row.authority,
      deadlineAt: f.row.expiresAt,
    }),
    messenger: { post: vi.fn(), finish: vi.fn() },
    onError: vi.fn(),
  });
  if (phase === "poll") {
    const original = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementation(async (...args) => {
      const result = await original(...args);
      entered.resolve();
      await resume.promise;
      return result;
    });
  } else {
    const original = store.insert.bind(store);
    vi.spyOn(store, "insert").mockImplementation(async (...args) => {
      const result = await original(...args);
      entered.resolve();
      await resume.promise;
      return result;
    });
  }
  let drained = false;
  const operation =
    phase === "poll"
      ? owner.poll()
      : owner.request(
          { ...f.row.request, requestId: randomUUID() },
          {
            computerId: f.row.computerId,
            instanceId: f.row.instanceId,
            connectionId: f.row.connectionId,
            installationId: "fixture",
            signal: new AbortController().signal,
          },
        );
  try {
    await entered.promise;
    const closing = owner.close().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    resume.resolve();
    await operation;
    await closing;
    expect(f.socket.send).not.toHaveBeenCalled();
    expect((await client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
  } finally {
    resume.resolve();
    await operation;
    await owner.close();
    vi.restoreAllMocks();
  }
});
