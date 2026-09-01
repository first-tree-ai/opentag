import { randomUUID } from "node:crypto";
import type { RuntimeDurableWorkRecord, SessionMessageDeliveryRequest } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { accountComputers, computers, users, workspaces } from "../../db/schema/index.js";
import { PostgresRuntimeDurableWorkStore } from "../../runtime/runtime-durable-work-store.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

describe("Runtime durable work persistence on PostgreSQL", () => {
  let testDatabase: MigratedTestDatabase;
  let database: ReturnType<typeof createDatabaseClient>;
  let workspaceComputerId: string;

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
    const workspaceId = randomUUID();
    workspaceComputerId = randomUUID();
    await database.database
      .insert(users)
      .values({ id: accountId, email: `${accountId}@example.com`, displayName: "Test" });
    await database.database
      .insert(workspaces)
      .values({ id: workspaceId, name: `test-${accountId}`, displayName: "Test" });
    await database.database.insert(computers).values({ id: workspaceComputerId });
    await database.database.insert(accountComputers).values({
      id: workspaceComputerId,
      ownerAccountId: accountId,
      currentInstallationId: workspaceComputerId,
      displayName: "Test Computer",
      platform: "linux",
      arch: "x86_64",
      clientVersion: "1.0.0",
    });
  });

  it("survives a second database client and returns one idempotent receipt", async () => {
    const record = sessionRecord();
    const first = new PostgresRuntimeDurableWorkStore(database.database, { now: () => 1 });
    await first.write(workspaceComputerId, record);

    const secondClient = createDatabaseClient(testDatabase.databaseUrl);
    try {
      const second = new PostgresRuntimeDurableWorkStore(secondClient.database, { now: () => 1 });
      await expect(second.list(workspaceComputerId, "session-message")).resolves.toEqual([record]);
      await second.write(workspaceComputerId, record);
      await expect(second.list(workspaceComputerId, "session-message")).resolves.toHaveLength(1);
    } finally {
      await secondClient.sql.end();
    }
  });
});

function sessionRecord(): RuntimeDurableWorkRecord {
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
    key: `${targetSessionId}:${request.messageId}`,
    kind: "session-message",
    payload: request,
    status: "accepted",
    updatedAt: 1,
  };
}
