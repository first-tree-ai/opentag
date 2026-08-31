import { randomUUID } from "node:crypto";
import type {
  EffectiveRuntimeSnapshot,
  RuntimeDurableWorkRecord,
  SessionMessageDeliveryRequest,
} from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountComputers, computers, runtimeDurableWork, users, workspaces } from "../db/schema/index.js";
import {
  PostgresRuntimeDurableWorkStore,
  RuntimeDurableWorkConflictError,
} from "../runtime/runtime-durable-work-store.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

describe("PostgresRuntimeDurableWorkStore", () => {
  let unit: UnitDatabase;
  let workspaceComputerId: string;

  beforeAll(async () => {
    unit = await createUnitDatabase();
  }, 60_000);

  afterAll(async () => {
    await unit?.close();
  });

  beforeEach(async () => {
    await unit.reset();
    const accountId = randomUUID();
    workspaceComputerId = randomUUID();
    await unit.database.insert(users).values({ id: accountId, email: `${accountId}@example.com`, displayName: "Test" });
    const workspaceId = randomUUID();
    await unit.database.insert(workspaces).values({ id: workspaceId, name: `test-${accountId}`, displayName: "Test" });
    await unit.database.insert(computers).values({ id: workspaceComputerId });
    await unit.database.insert(accountComputers).values({
      id: workspaceComputerId,
      ownerAccountId: accountId,
      currentInstallationId: workspaceComputerId,
      displayName: "Test Computer",
      platform: "linux",
      arch: "x86_64",
      clientVersion: "1.0.0",
    });
  });

  it("recovers accepted work after a store restart and suppresses duplicate identity", async () => {
    const record = sessionRecord();
    const first = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 1 });
    await first.write(workspaceComputerId, record);

    const restarted = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 1 });
    await expect(restarted.list(workspaceComputerId, "session-message")).resolves.toEqual([record]);
    await expect(restarted.write(workspaceComputerId, record)).resolves.toBeUndefined();
    await expect(
      restarted.write(workspaceComputerId, {
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
    await expect(
      Promise.all([first.write(workspaceComputerId, record), second.write(workspaceComputerId, record)]),
    ).resolves.toEqual([undefined, undefined]);
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
    await store.write(workspaceComputerId, active);
    await store.write(workspaceComputerId, oldTerminal);
    await store.write(workspaceComputerId, recentTerminal);

    now = 10_000;
    await expect(store.list(workspaceComputerId, "session-message")).resolves.toEqual([active, recentTerminal]);
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
