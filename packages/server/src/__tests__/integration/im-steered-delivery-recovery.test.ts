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
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { runImDeliveryExpiry } from "../../runtime/im-delivery-janitor.js";
import { STEER_TARGET_ENDED_ERROR_CODE } from "../../runtime/im-delivery-recovery.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
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

  it("requeues cancelled target children once and preserves ingress order", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await expect(
      custody.recordTurn(turnReport(fixture, "cancelled", "client_shutdown"), fixture.context),
    ).resolves.toBe("recorded");

    const recovered = await deliveryRows(client.database, fixture);
    expect(recovered.children.map((row) => row.id)).toEqual(fixture.steerRequests.map((request) => request.deliveryId));
    expect(recovered.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "pending",
          steerTargetDeliveryId: null,
          attemptCount: 1,
          lastErrorCode: STEER_TARGET_ENDED_ERROR_CODE,
        }),
      ]),
    );
    expect(recovered.children[0]?.nextAttemptAt.getTime()).toBeLessThan(
      recovered.children[1]?.nextAttemptAt.getTime() ?? Number.POSITIVE_INFINITY,
    );

    await runImDeliveryExpiry(client.database, janitorOptions(fixture.now));
    const afterJanitor = await deliveryRows(client.database, fixture);
    expect(afterJanitor.children).toEqual(recovered.children);
  });

  it("requeues a failed target through the janitor after a crashed Turn", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await client.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: "IM_DELIVERY_RECOVERY_FAILED", nextAttemptAt: fixture.now })
      .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));

    await runImDeliveryExpiry(client.database, janitorOptions(fixture.now));
    const recovered = await deliveryRows(client.database, fixture);
    expect(recovered.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "pending", steerTargetDeliveryId: null, attemptCount: 1 }),
      ]),
    );
  });

  it("requeues a timed-out target", async () => {
    const timedOut = await createFixture(client.database);
    const timedOutCustody = new PostgresRuntimeCustodyStore(client.database, { now: () => timedOut.now });
    await acceptAndSteer(timedOut, timedOutCustody);
    await expect(
      timedOutCustody.recordTurn(turnReport(timedOut, "failed", "turn_timeout"), timedOut.context),
    ).resolves.toBe("recorded");
    expect((await deliveryRows(client.database, timedOut)).children).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "pending", steerTargetDeliveryId: null })]),
    );
  });

  it("re-places children from an ended target Session before the worker claims them", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await client.database
      .update(sessions)
      .set({ endedAt: new Date(fixture.now.getTime() + 1_000) })
      .where(eq(sessions.id, fixture.sessionId));

    await expect(
      custody.recordTurn(turnReport(fixture, "cancelled", "client_shutdown"), fixture.context),
    ).resolves.toBe("recorded");

    const recovered = await deliveryRows(client.database, fixture);
    expect(recovered.children.every((row) => row.sessionId !== fixture.sessionId)).toBe(true);
    expect(recovered.children[0]?.placementGeneration).toBe(1);

    const requestDelivery = await runRecoveryWorker(client.database, fixture, custody);

    expect(requestDelivery).toHaveBeenCalledTimes(1);
    expect(requestDelivery.mock.calls[0]?.[2]).toMatchObject({
      deliveryId: fixture.steerRequests[0].deliveryId,
      sessionId: recovered.children[0]?.sessionId,
    });
    expect((await deliveryRows(client.database, fixture)).children[0]?.state).toBe("accepted");
  });

  it("keeps live-Session recoveries claimable by the worker", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await expect(
      custody.recordTurn(turnReport(fixture, "cancelled", "client_shutdown"), fixture.context),
    ).resolves.toBe("recorded");

    const recovered = await deliveryRows(client.database, fixture);
    expect(recovered.children.every((row) => row.sessionId === fixture.sessionId)).toBe(true);
    const requestDelivery = await runRecoveryWorker(client.database, fixture, custody);

    expect(requestDelivery).toHaveBeenCalledTimes(1);
    expect((await deliveryRows(client.database, fixture)).children[0]?.state).toBe("accepted");
  });

  it("leaves completed target children steered after the janitor runs", async () => {
    const completed = await createFixture(client.database);
    const completedCustody = new PostgresRuntimeCustodyStore(client.database, { now: () => completed.now });
    await acceptAndSteer(completed, completedCustody);
    await expect(completedCustody.recordTurn(turnReport(completed, "completed"), completed.context)).resolves.toBe(
      "recorded",
    );
    await runImDeliveryExpiry(client.database, janitorOptions(completed.now));
    expect((await deliveryRows(client.database, completed)).children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "steered", steerTargetDeliveryId: completed.rootDeliveryId, attemptCount: 0 }),
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
  runtime: DirectImMessageDeliveryRequest["runtime"];
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
    provider: "feishu",
    status: "active",
    externalAppId: "app",
    externalBotId: "bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: now,
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
      providerContext: { provider: "feishu", chatType: "group" },
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
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
    ...followUps.map(({ messageId, deliveryId }) => ({
      id: deliveryId,
      messageId,
      sessionId,
      attention: "direct" as const,
      placementGeneration: 1,
      expiresAt: new Date(Date.now() + 60 * 60_000),
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
      provider: "feishu" as const,
      teamBrand: "feishu" as const,
      appId: "app",
      botOpenId: "bot",
      chatId: "channel",
      messageId: "1",
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
    runtime,
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

async function acceptAndSteer(fixture: Fixture, custody: PostgresRuntimeCustodyStore): Promise<void> {
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
}

async function runRecoveryWorker(
  database: ReturnType<typeof createDatabaseClient>["database"],
  fixture: Fixture,
  custody: PostgresRuntimeCustodyStore,
) {
  const requestDelivery = vi.fn(
    async (
      _computerId: string,
      _instanceId: string,
      request: DirectImMessageDeliveryRequest,
      onDispatched?: () => void,
    ) => {
      const inputHash = computeDirectInputHash(request);
      await custody.beginDeliveryDispatch(request, inputHash, fixture.dispatchContext);
      onDispatched?.();
      await custody.acceptDelivery(request, inputHash, randomUUID(), fixture.context);
      return { status: "accepted" as const };
    },
  );
  const worker = new ImDeliveryWorker({
    database,
    domain: {
      requestReconcile: vi.fn((_computerId, _instanceId, _request, onDispatched) => {
        onDispatched?.();
        return Promise.resolve({ status: "ready" as const });
      }),
      requestDelivery,
    } as never,
    assembler: { assembleForSession: vi.fn(async () => fixture.runtime) },
    registry: {
      currentInstanceId: vi.fn(() => fixture.dispatchContext.instanceId),
      capabilityVersion: vi.fn(() => 2),
    } as never,
    now: () => new Date(),
    intervalMs: 60_000,
  });
  try {
    await worker.runOnce();
  } finally {
    worker.stop();
  }
  return requestDelivery;
}

async function deliveryRows(database: ReturnType<typeof createDatabaseClient>["database"], fixture: Fixture) {
  const rows = await database
    .select({
      id: imMessageDeliveries.id,
      sessionId: imMessageDeliveries.sessionId,
      placementGeneration: imMessageDeliveries.placementGeneration,
      state: imMessageDeliveries.state,
      steerTargetDeliveryId: imMessageDeliveries.steerTargetDeliveryId,
      reportedAt: imMessageDeliveries.reportedAt,
      attemptCount: imMessageDeliveries.attemptCount,
      nextAttemptAt: imMessageDeliveries.nextAttemptAt,
      lastErrorCode: imMessageDeliveries.lastErrorCode,
    })
    .from(imMessageDeliveries)
    .where(
      inArray(imMessageDeliveries.messageId, [
        fixture.rootRequest.imMessageId,
        ...fixture.steerRequests.map((request) => request.imMessageId),
      ]),
    );
  const root = rows.find((row) => row.id === fixture.rootDeliveryId);
  if (!root) throw new Error("Root delivery row is missing");
  const children = fixture.steerRequests.map((request) => {
    const child = rows.find((row) => row.id === request.deliveryId);
    if (!child) throw new Error(`Steered delivery row is missing: ${request.deliveryId}`);
    return child;
  });
  return { root, children };
}

function janitorOptions(now: Date) {
  return {
    clock: () => now,
    expiryBatchSize: 100,
    retentionBatchSize: 100,
    imMessagesRetentionMs: 90 * 24 * 60 * 60 * 1_000,
    imMessageDeliveriesRetentionMs: 90 * 24 * 60 * 60 * 1_000,
    slackWebhookReceiptsRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    feishuInboundReceiptsRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  };
}

function turnReport(
  fixture: Fixture,
  outcome: TurnReportRequest["outcome"],
  errorReason?: TurnReportRequest["errorReason"],
): TurnReportRequest {
  const body = {
    deliveryId: fixture.rootDeliveryId,
    turnId: fixture.rootTurnId,
    sessionId: fixture.sessionId,
    agentId: fixture.agentId,
    placementGeneration: fixture.placementGeneration,
    outcome,
    executionEffects: outcome === "completed" ? ("completed" as const) : ("may_have_occurred" as const),
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
    ...(errorReason ? { errorReason } : {}),
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
