import { randomUUID } from "node:crypto";
import type { RuntimeDurableWorkRecord, SessionMessageDeliveryRequest } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { computers, runtimeDurableWork, users } from "../../db/schema/index.js";
import {
  PostgresRuntimeDurableWorkStore,
  RuntimeDurableWorkQuotaExceededError,
  RuntimeDurableWorkStaleWriteError,
} from "../../runtime/runtime-durable-work-store.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

describe("Runtime durable work persistence on PostgreSQL", () => {
  let testDatabase: MigratedTestDatabase;
  let database: ReturnType<typeof createDatabaseClient>;
  let computerId: string;

  beforeAll(async () => {
    testDatabase = await startMigratedTestDatabase();
    database = createDatabaseClient(testDatabase.databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await testDatabase?.stop();
  });

  beforeEach(async () => {
    await testDatabase.reset();
    const accountId = randomUUID();
    computerId = randomUUID();
    await database.database
      .insert(users)
      .values({ id: accountId, email: `${accountId}@example.com`, displayName: "Test" });
    await database.database.insert(computers).values({
      id: computerId,
      ownerAccountId: accountId,
      currentInstallationId: randomUUID(),
      displayName: "Test Computer",
      platform: "linux",
      arch: "x86_64",
      clientVersion: "1.0.0",
    });
  });

  it("survives a second database client and returns one idempotent receipt", async () => {
    const record = sessionRecord();
    const first = new PostgresRuntimeDurableWorkStore(database.database, { now: () => 1 });
    await first.write(computerId, record);

    const secondClient = createDatabaseClient(testDatabase.databaseUrl);
    try {
      const second = new PostgresRuntimeDurableWorkStore(secondClient.database, { now: () => 1 });
      await expect(second.list(computerId, "session-message")).resolves.toEqual({ items: [record] });
      await second.write(computerId, record);
      await expect(second.list(computerId, "session-message")).resolves.toEqual({ items: [record] });
    } finally {
      await secondClient.sql.end();
    }
  });

  it("holds the row quota when concurrent writers race at the boundary", async () => {
    const first = new PostgresRuntimeDurableWorkStore(database.database, { now: () => 1, maxRecordsPerComputer: 1 });
    const second = new PostgresRuntimeDurableWorkStore(database.database, { now: () => 1, maxRecordsPerComputer: 1 });
    const results = await Promise.allSettled([
      first.write(computerId, sessionRecord("quota-first")),
      second.write(computerId, sessionRecord("quota-second")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => result.reason)).toEqual([
      expect.any(RuntimeDurableWorkQuotaExceededError),
    ]);
    expect(await database.database.select().from(runtimeDurableWork)).toHaveLength(1);
  });

  it("accepts the client retry re-arm sequence", async () => {
    const store = new PostgresRuntimeDurableWorkStore(database.database, { now: () => 1 });
    const accepted = sessionRecord("retry-sequence");
    const running = { ...accepted, status: "running" as const, updatedAt: 2 };
    const retryable = { ...running, status: "retryable" as const, nextAttemptAt: 4, updatedAt: 3 };
    const rearmed = { ...retryable, status: "accepted" as const, updatedAt: 4 };

    await expect(store.write(computerId, accepted)).resolves.toBeUndefined();
    await expect(store.write(computerId, running)).resolves.toBeUndefined();
    await expect(store.write(computerId, retryable)).resolves.toBeUndefined();
    await expect(store.write(computerId, rearmed)).resolves.toBeUndefined();
    await expect(store.list(computerId, "session-message")).resolves.toMatchObject({
      items: [{ status: "accepted", updatedAt: 4 }],
    });
  });

  it("allows a terminal transition at the active row quota and admits a freed slot", async () => {
    const store = new PostgresRuntimeDurableWorkStore(database.database, {
      now: () => 1,
      maxRecordsPerComputer: 1,
    });
    const accepted = sessionRecord("terminal-slot");
    await store.write(computerId, accepted);
    await store.write(computerId, { ...accepted, status: "running", updatedAt: 2 });
    await expect(store.write(computerId, { ...accepted, status: "succeeded", updatedAt: 3 })).resolves.toBeUndefined();
    await expect(store.write(computerId, sessionRecord("freed-slot"))).resolves.toBeUndefined();
    await expect(store.list(computerId, "session-message")).resolves.toMatchObject({
      items: [
        { key: expect.stringContaining("freed-slot"), status: "accepted" },
        { key: expect.stringContaining("terminal-slot"), status: "succeeded" },
      ],
    });
  });

  it("rejects an out-of-order writer from moving succeeded work back to accepted", async () => {
    const store = new PostgresRuntimeDurableWorkStore(database.database, { now: () => 1 });
    const record = sessionRecord("monotonic");
    await store.write(computerId, record);
    await store.write(computerId, { ...record, status: "running", updatedAt: 2 });
    await store.write(computerId, { ...record, status: "succeeded", updatedAt: 3 });
    await expect(store.write(computerId, { ...record, status: "accepted", updatedAt: 2 })).rejects.toBeInstanceOf(
      RuntimeDurableWorkStaleWriteError,
    );
    await expect(store.list(computerId, "session-message")).resolves.toMatchObject({
      items: [{ status: "succeeded", updatedAt: 3 }],
    });
  });

  it("pages a dataset larger than 1024 records to completion", async () => {
    const records = Array.from({ length: 1_025 }, (_, index) => sessionRecord(`page-${index}`));
    await database.database.insert(runtimeDurableWork).values(
      records.map((record) => ({
        computerId,
        kind: record.kind,
        recordKey: record.key,
        payload: record.payload,
        status: record.status,
        attempts: record.attempts,
        acceptedAt: record.acceptedAt,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: record.updatedAt,
      })),
    );
    const store = new PostgresRuntimeDurableWorkStore(database.database, { now: () => 1 });
    const first = await store.list(computerId, "session-message", { limit: 1_024 });
    expect(first.items).toHaveLength(1_024);
    expect(first.nextCursor).toBeDefined();
    const second = await store.list(computerId, "session-message", { cursor: first.nextCursor, limit: 1_024 });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });
});

function sessionRecord(keySuffix: string = randomUUID()): RuntimeDurableWorkRecord {
  const agentId = randomUUID();
  const targetSessionId = randomUUID();
  const request: SessionMessageDeliveryRequest = {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId,
    agentId,
    placementGeneration: 1,
    content: { kind: "text", text: "hello" },
    runtime: {
      revision: { agent: { sequence: 1, id: "agent" }, session: { sequence: 1, id: "session" } },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: false },
      workspace: { workspaceId: "workspace", mode: "empty_on_create", sharing: "agent" },
    },
  };
  return {
    acceptedAt: 1,
    attempts: 0,
    key: `${keySuffix}-${request.messageId}`,
    kind: "session-message",
    payload: request,
    status: "accepted",
    updatedAt: 1,
  };
}
