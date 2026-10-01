import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeRuntimeImMessageSemanticHash,
  computeRuntimeImSteerInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type RuntimeImSteerRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

describe("steered IM delivery recovery", () => {
  let testDatabase: MigratedTestDatabase;
  let client: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    testDatabase = await startMigratedTestDatabase();
    client = createDatabaseClient(testDatabase.databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await client?.sql.end();
    await testDatabase?.stop();
  });

  beforeEach(async () => {
    await testDatabase.reset();
  });

  it("reproduces the loss: cancelled root leaves steered deliveries terminal", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    const rootInputHash = computeDirectInputHash(fixture.rootRequest);

    await expect(
      custody.beginDeliveryDispatch(fixture.rootRequest, rootInputHash, fixture.dispatchContext),
    ).resolves.toBe("dispatched");
    await expect(
      custody.acceptDelivery(fixture.rootRequest, rootInputHash, fixture.rootTurnId, fixture.context),
    ).resolves.toBe("accepted");

    for (const request of fixture.steerRequests) {
      const inputHash = computeRuntimeImSteerInputHash(request);
      const semanticHash = computeRuntimeImMessageSemanticHash(request);
      await expect(custody.beginSteerDispatch(request, inputHash, fixture.dispatchContext)).resolves.toBe("dispatched");
      await expect(custody.recordSteered(request, inputHash, semanticHash, fixture.context)).resolves.toBe("steered");
    }

    const report = cancelledReport(fixture);
    await expect(custody.recordTurn(report, fixture.context)).resolves.toBe("recorded");

    const deliveries = await client.database
      .select({
        id: imMessageDeliveries.id,
        state: imMessageDeliveries.state,
        steerTargetDeliveryId: imMessageDeliveries.steerTargetDeliveryId,
        reportedAt: imMessageDeliveries.reportedAt,
      })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.sessionId, fixture.sessionId));

    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.rootDeliveryId, state: "accepted", reportedAt: expect.any(Date) }),
        expect.objectContaining({
          id: fixture.steerRequests[0]?.deliveryId,
          state: "steered",
          steerTargetDeliveryId: fixture.rootDeliveryId,
        }),
        expect.objectContaining({
          id: fixture.steerRequests[1]?.deliveryId,
          state: "steered",
          steerTargetDeliveryId: fixture.rootDeliveryId,
        }),
      ]),
    );
  });
});

type Fixture = {
  now: Date;
  rootDeliveryId: string;
  rootTurnId: string;
  sessionId: string;
  agentId: string;
  placementGeneration: number;
  rootRequest: DirectImMessageDeliveryRequest;
  steerRequests: [RuntimeImSteerRequest, RuntimeImSteerRequest];
  context: RuntimeBusinessContext;
  dispatchContext: { computerId: string; instanceId: string };
};

async function createFixture(database: ReturnType<typeof createDatabaseClient>["database"]): Promise<Fixture> {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const userId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const rootMessageId = randomUUID();
  const rootDeliveryId = randomUUID();
  const instanceId = randomUUID();
  const rootTurnId = randomUUID();

  await database.insert(users).values({ id: userId, email: `${userId}@example.test`, displayName: "Test User" });
  await database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    currentInstallationId: randomUUID(),
    displayName: "Test Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
    currentInstanceId: instanceId,
  });
  await database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `agent-${agentId}`,
    displayName: "Test Agent",
    runtimeProvider: "codex",
  });
  await database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "slack",
    status: "provisioning",
  });
  await database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "channel",
    conversationKind: "channel",
    kind: "channel",
  });
  await database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });

  const followUps = [
    { messageId: randomUUID(), deliveryId: randomUUID(), externalId: "follow-up-1" },
    { messageId: randomUUID(), deliveryId: randomUUID(), externalId: "follow-up-2" },
  ] as const;
  await database.insert(imMessages).values(
    [
      { messageId: rootMessageId, externalId: "root" },
      ...followUps.map(({ messageId, externalId }) => ({ messageId, externalId })),
    ].map(({ messageId, externalId }, index) => ({
      id: messageId,
      imBindingId: bindingId,
      channelId: "channel",
      externalMessageId: externalId,
      providerRevisionKey: "1",
      operation: "created" as const,
      direction: "inbound" as const,
      authorKind: "human" as const,
      authorExternalId: "human",
      content: { fallbackText: externalId },
      providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: externalId },
      occurredAt: new Date(now.getTime() + index * 1_000),
    })) as never,
  );
  await database.insert(imMessageDeliveries).values([
    {
      id: rootDeliveryId,
      messageId: rootMessageId,
      sessionId,
      attention: "direct",
      placementGeneration: 1,
      expiresAt: new Date(now.getTime() + 60_000),
    },
    ...followUps.map(({ messageId, deliveryId }) => ({
      id: deliveryId,
      messageId,
      sessionId,
      attention: "direct" as const,
      placementGeneration: 1,
      expiresAt: new Date(now.getTime() + 60_000),
    })),
  ]);

  const runtime = {
    contextTrees: [],
    revision: { agent: { sequence: 1, id: agentId }, session: { sequence: 1, id: sessionId } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "", agent: "", session: "" },
    execution: { approvalPolicy: "never" as const, networkAccess: false },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
  const content = {
    kind: "text" as const,
    text: "hello",
    providerRef: {
      provider: "slack" as const,
      appId: "app",
      teamId: "team",
      botUserId: "bot",
      channelId: "channel",
      messageTs: "1",
    },
  };
  const rootRequest: DirectImMessageDeliveryRequest = {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: rootDeliveryId,
    imMessageId: rootMessageId,
    sessionId,
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content,
    runtime,
  };
  const steerRequests = followUps.map(({ messageId, deliveryId }, index) => ({
    type: "im:steer" as const,
    requestId: randomUUID(),
    deliveryId,
    imMessageId: messageId,
    sessionId,
    agentId,
    placementGeneration: 1,
    rootDeliveryId,
    expectedTurnId: rootTurnId,
    attention: "direct" as const,
    content: { ...content, text: `follow-up-${index + 1}` },
  })) as [RuntimeImSteerRequest, RuntimeImSteerRequest];

  return {
    now,
    rootDeliveryId,
    rootTurnId,
    sessionId,
    agentId,
    placementGeneration: 1,
    rootRequest,
    steerRequests,
    context: {
      computerId,
      installationId: randomUUID(),
      instanceId,
      signal: new AbortController().signal,
    },
    dispatchContext: { computerId, instanceId },
  };
}

function cancelledReport(fixture: Fixture): TurnReportRequest {
  const body = {
    deliveryId: fixture.rootDeliveryId,
    turnId: fixture.rootTurnId,
    sessionId: fixture.sessionId,
    agentId: fixture.agentId,
    placementGeneration: fixture.placementGeneration,
    outcome: "cancelled" as const,
    executionEffects: "may_have_occurred" as const,
    errorReason: "client_shutdown" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
