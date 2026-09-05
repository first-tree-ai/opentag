import { randomUUID } from "node:crypto";
import type {
  EffectiveRuntimeSnapshot,
  RuntimeDurableWorkRecord,
  SessionMessageDeliveryRequest,
} from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computers, runtimeDurableWork, users } from "../db/schema/index.js";
import {
  PostgresRuntimeDurableWorkStore,
  RuntimeDurableWorkConflictError,
  RuntimeDurableWorkPayloadTooLargeError,
  RuntimeDurableWorkQuotaExceededError,
  RuntimeDurableWorkStaleWriteError,
  RuntimeDurableWorkTransitionError,
} from "../runtime/runtime-durable-work-store.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

describe("PostgresRuntimeDurableWorkStore", () => {
  let unit: UnitDatabase;
  let computerId: string;

  beforeAll(async () => {
    unit = await createUnitDatabase();
  }, 60_000);

  afterAll(async () => {
    await unit?.close();
  });

  beforeEach(async () => {
    await unit.reset();
    const accountId = randomUUID();
    computerId = randomUUID();
    await unit.database.insert(users).values({ id: accountId, email: `${accountId}@example.com`, displayName: "Test" });
    await unit.database.insert(computers).values({
      id: computerId,
      ownerAccountId: accountId,
      currentInstallationId: randomUUID(),
      displayName: "Test Computer",
      platform: "linux",
      arch: "x86_64",
      clientVersion: "1.0.0",
    });
  });

  it("recovers accepted work after a store restart and suppresses duplicate identity", async () => {
    const record = sessionRecord();
    const first = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 1 });
    await first.write(computerId, record);

    const restarted = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 1 });
    await expect(restarted.list(computerId, "session-message")).resolves.toEqual({ items: [record] });
    await expect(restarted.write(computerId, record)).resolves.toBeUndefined();
    await expect(
      restarted.write(computerId, {
        ...record,
        payload: {
          ...(record.payload as SessionMessageDeliveryRequest),
          content: { kind: "text", text: "other" },
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeDurableWorkConflictError);
    expect(await unit.database.select().from(runtimeDurableWork)).toHaveLength(1);
  });

  it("suppresses concurrent duplicate writes through the persisted unique receipt", async () => {
    const record = sessionRecord();
    const first = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 1 });
    const second = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 1 });
    await expect(Promise.all([first.write(computerId, record), second.write(computerId, record)])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(await unit.database.select().from(runtimeDurableWork)).toHaveLength(1);
  });

  it("retains active work while pruning old terminal receipts and enforcing the terminal cap", async () => {
    let now = 10_000;
    const store = new PostgresRuntimeDurableWorkStore(unit.database, {
      now: () => now,
      retentionMs: 100,
      maxTerminalRecords: 1,
    });
    const active = { ...sessionRecord(), key: "active", updatedAt: 9_950 };
    const oldTerminal = { ...sessionRecord(), key: "old-terminal", status: "succeeded" as const, updatedAt: 0 };
    const recentTerminal = {
      ...sessionRecord(),
      key: "recent-terminal",
      status: "succeeded" as const,
      updatedAt: 9_950,
    };
    await store.write(computerId, active);
    await store.write(computerId, oldTerminal);
    await store.write(computerId, recentTerminal);

    now = 10_000;
    await expect(store.list(computerId, "session-message")).resolves.toEqual({ items: [active, recentTerminal] });
  });

  it("rejects backward state transitions and stale updates", async () => {
    const store = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 1 });
    const record = sessionRecord();
    await store.write(computerId, record);
    await store.write(computerId, { ...record, status: "running", updatedAt: 2 });
    await store.write(computerId, { ...record, status: "succeeded", updatedAt: 3 });

    await expect(store.write(computerId, { ...record, status: "accepted", updatedAt: 2 })).rejects.toBeInstanceOf(
      RuntimeDurableWorkStaleWriteError,
    );
    await expect(store.write(computerId, { ...record, status: "running", updatedAt: 4 })).rejects.toBeInstanceOf(
      RuntimeDurableWorkTransitionError,
    );
  });

  it("enforces record and serialized payload quotas", async () => {
    const record = sessionRecord();
    const store = new PostgresRuntimeDurableWorkStore(unit.database, {
      now: () => 1,
      maxRecordsPerComputer: 1,
      maxPayloadBytesPerComputer: 1_000_000,
    });
    await store.write(computerId, record);
    await expect(store.write(computerId, { ...record, key: "second" })).rejects.toBeInstanceOf(
      RuntimeDurableWorkQuotaExceededError,
    );

    const oversized = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 1, maxPayloadBytesPerRecord: 1 });
    await expect(oversized.write(computerId, sessionRecord())).rejects.toBeInstanceOf(
      RuntimeDurableWorkPayloadTooLargeError,
    );
  });
});

function snapshot(agentId: string, workspaceId: string): EffectiveRuntimeSnapshot {
  return {
    revision: { agent: { sequence: 1, id: "agent" }, session: { sequence: 1, id: "session" } },
    agentId,
    provider: "codex",
    instructions: { platform: "platform", agent: "agent" },
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId, mode: "empty_on_create", sharing: "agent" },
  };
}

function sessionRecord(): RuntimeDurableWorkRecord {
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const request: SessionMessageDeliveryRequest = {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId: sessionId,
    agentId,
    placementGeneration: 1,
    content: { kind: "text", text: "hello" },
    runtime: snapshot(agentId, randomUUID()),
  };
  return {
    acceptedAt: 1,
    attempts: 0,
    key: `${sessionId}:${request.messageId}`,
    kind: "session-message",
    payload: request,
    status: "accepted",
    updatedAt: 1,
  };
}
