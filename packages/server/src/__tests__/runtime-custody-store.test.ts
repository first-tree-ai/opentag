import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type RuntimeImSteerRequest,
  type SessionReconcileRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountComputers,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  users,
  workspaceComputers,
  workspaces,
} from "../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

describe("PostgresRuntimeCustodyStore", () => {
  let unit: UnitDatabase;

  beforeAll(async () => {
    unit = await createUnitDatabase();
  }, 60_000);

  afterAll(async () => {
    await unit?.close();
  });

  beforeEach(async () => {
    await unit.reset();
  });

  it("covers direct dispatch state transitions and identity fences", async () => {
    const fixture = await createFixture(unit);
    const store = new PostgresRuntimeCustodyStore(unit.database);
    const request = fixture.direct;
    const hash = computeDirectInputHash(request);

    await expect(store.beginDeliveryDispatch(request, hash, fixture.dispatchContext)).resolves.toBe("dispatched");
    await expect(store.beginDeliveryDispatch(request, hash, fixture.dispatchContext)).resolves.toBe(
      "already_dispatched",
    );
    await expect(
      store.beginDeliveryDispatch({ ...request, requestId: randomUUID() }, hash, fixture.dispatchContext),
    ).resolves.toBe("conflict");
    await expect(
      store.beginDeliveryDispatch({ ...request, deliveryId: randomUUID() }, hash, fixture.dispatchContext),
    ).resolves.toBe("conflict");
    await expect(
      store.beginDeliveryDispatch(request, hash, { ...fixture.dispatchContext, workspaceComputerId: randomUUID() }),
    ).resolves.toBe("stale_generation");

    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        dispatchRequestId: null,
        dispatchInputHash: null,
        dispatchPayload: null,
        inputHash: hash,
        turnId: "turn-1",
        reportOwnerInstanceId: fixture.instanceId,
        acceptedAt: fixture.now,
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    await expect(store.beginDeliveryDispatch(request, hash, fixture.dispatchContext)).resolves.toBe("conflict");
    await expect(
      store.beginDeliveryDispatch({ ...request, deliveryId: randomUUID() }, hash, fixture.dispatchContext),
    ).resolves.toBe("conflict");
  });

  it("accepts deliveries and handles retries, expired rows, and conflicts", async () => {
    const fixture = await createFixture(unit);
    const store = new PostgresRuntimeCustodyStore(unit.database, { now: () => fixture.now });
    const request = fixture.direct;
    const hash = computeDirectInputHash(request);
    await expect(store.acceptDelivery(request, hash, "turn-1", fixture.context)).resolves.toBe("conflict");
    await store.beginDeliveryDispatch(request, hash, fixture.dispatchContext);
    await expect(store.acceptDelivery(request, hash, "turn-1", fixture.context)).resolves.toBe("accepted");
    await expect(store.acceptDelivery(request, hash, "turn-1", fixture.context)).resolves.toBe("already_accepted");
    await expect(store.acceptDelivery(request, "different", "turn-1", fixture.context)).resolves.toBe("conflict");
    await expect(store.acceptDelivery(request, hash, "different", fixture.context)).resolves.toBe("conflict");
    await expect(
      store.acceptDelivery(request, hash, "turn-1", { ...fixture.context, workspaceComputerId: randomUUID() }),
    ).resolves.toBe("stale_generation");

    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "expired",
        inputHash: null,
        turnId: null,
        reportOwnerInstanceId: null,
        acceptedAt: null,
        dispatchRequestId: request.requestId,
        dispatchInputHash: hash,
        dispatchPayload: request,
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    await expect(store.acceptDelivery(request, hash, "turn-2", fixture.context)).resolves.toBe("accepted");
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "terminal_rejected",
        inputHash: null,
        turnId: null,
        reportOwnerInstanceId: null,
        acceptedAt: null,
        dispatchRequestId: request.requestId,
        dispatchInputHash: hash,
        dispatchPayload: request,
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    await expect(store.acceptDelivery(request, hash, "turn-3", fixture.context)).resolves.toBe("conflict");
  });

  it("covers steer dispatch, steering, absorption, and release", async () => {
    const fixture = await createFixture(unit, { withRoot: true });
    const store = new PostgresRuntimeCustodyStore(unit.database, { now: () => fixture.now });
    const request = fixture.steer;
    const hash = "steer-input";
    await expect(store.beginSteerDispatch(request, hash, fixture.dispatchContext)).resolves.toBe("dispatched");
    await expect(store.beginSteerDispatch(request, hash, fixture.dispatchContext)).resolves.toBe("already_dispatched");
    await expect(
      store.beginSteerDispatch({ ...request, requestId: randomUUID() }, hash, fixture.dispatchContext),
    ).resolves.toBe("conflict");
    await expect(
      store.beginSteerDispatch(
        { ...request, requestId: randomUUID(), rootDeliveryId: randomUUID() },
        hash,
        fixture.dispatchContext,
      ),
    ).resolves.toBe("conflict");
    await expect(
      store.beginSteerDispatch(request, hash, { ...fixture.dispatchContext, workspaceComputerId: randomUUID() }),
    ).resolves.toBe("stale_generation");

    await expect(store.recordSteered(request, hash, "semantic-1", fixture.context)).resolves.toBe("steered");
    await expect(store.recordSteered(request, hash, "semantic-1", fixture.context)).resolves.toBe("already_steered");
    await expect(store.recordSteered(request, hash, "semantic-2", fixture.context)).resolves.toBe("conflict");

    const releaseRequest = {
      ...request,
      deliveryId: fixture.releaseDeliveryId,
      imMessageId: fixture.absorbedMessageId,
      attention: "direct" as const,
      requestId: randomUUID(),
    };
    const releaseHash = "release-input";
    await unit.database
      .update(imMessageDeliveries)
      .set({ dispatchRequestId: null, dispatchInputHash: null, dispatchPayload: null, steerTargetDeliveryId: null })
      .where(eq(imMessageDeliveries.id, fixture.releaseDeliveryId));
    await expect(store.releaseSteerDispatch(releaseRequest, releaseHash, "retry")).resolves.toBe("already_released");
    await expect(
      store.releaseSteerDispatch(
        { ...releaseRequest, rootDeliveryId: fixture.rootDeliveryId },
        releaseHash,
        "deferred",
      ),
    ).resolves.toBe("conflict");
    await unit.database
      .update(imMessageDeliveries)
      .set({
        dispatchRequestId: releaseRequest.requestId,
        dispatchInputHash: releaseHash,
        dispatchPayload: releaseRequest,
        steerTargetDeliveryId: fixture.rootDeliveryId,
      })
      .where(eq(imMessageDeliveries.id, fixture.releaseDeliveryId));
    await expect(store.releaseSteerDispatch(releaseRequest, releaseHash, "retry")).resolves.toBe("released");

    const absorbedRequest = {
      ...fixture.direct,
      deliveryId: fixture.absorbedDeliveryId,
      imMessageId: fixture.absorbedMessageId,
      requestId: randomUUID(),
    };
    const absorbedHash = computeDirectInputHash(absorbedRequest);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        dispatchRequestId: absorbedRequest.requestId,
        dispatchInputHash: absorbedHash,
        dispatchPayload: absorbedRequest,
      })
      .where(eq(imMessageDeliveries.id, fixture.absorbedDeliveryId));
    await expect(
      store.recordAbsorbed(
        absorbedRequest,
        absorbedHash,
        "semantic-absorbed",
        fixture.rootDeliveryId,
        "turn-root",
        fixture.context,
      ),
    ).resolves.toBe("steered");
    await expect(
      store.recordAbsorbed(
        absorbedRequest,
        absorbedHash,
        "semantic-other",
        fixture.rootDeliveryId,
        "turn-root",
        fixture.context,
      ),
    ).resolves.toBe("conflict");
  });

  it("claims retained reports only for the matching live placement", async () => {
    const fixture = await createFixture(unit);
    const store = new PostgresRuntimeCustodyStore(unit.database, { now: () => fixture.now });
    const request = fixture.reconcile;
    const directHash = computeDirectInputHash(fixture.direct);
    const claim = {
      dispatchRequestId: fixture.direct.requestId,
      deliveryId: fixture.deliveryId,
      inputHash: directHash,
      turnId: "turn-retained",
      placementGeneration: 1,
      resultHash: "result-retained",
    };
    await store.beginDeliveryDispatch(fixture.direct, directHash, fixture.dispatchContext);
    await store.claimRetainedReports(request, [claim, { ...claim, deliveryId: randomUUID() }], fixture.context);
    expect(await store.getDelivery(fixture.deliveryId)).toMatchObject({
      turnId: "turn-retained",
      instanceId: fixture.instanceId,
    });

    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        turnId: "turn-retained",
        inputHash: directHash,
        reportOwnerInstanceId: fixture.instanceId,
        acceptedAt: fixture.now,
        resultHash: null,
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    await store.claimRetainedReports(
      request,
      [{ ...claim, turnId: "turn-retained", resultHash: "result-updated" }],
      fixture.context,
    );
    const row = await unit.database
      .select({ owner: imMessageDeliveries.reportOwnerInstanceId, resultHash: imMessageDeliveries.resultHash })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row[0]).toMatchObject({ owner: fixture.instanceId, resultHash: "result-updated" });

    await unit.database
      .update(sessionPlacements)
      .set({ generation: 2 })
      .where(eq(sessionPlacements.sessionId, fixture.sessionId));
    await expect(store.claimRetainedReports(request, [claim], fixture.context)).resolves.toBeUndefined();
  });

  it("reads accepted deliveries and records turn reports idempotently", async () => {
    const fixture = await createFixture(unit);
    const store = new PostgresRuntimeCustodyStore(unit.database, { now: () => fixture.now });
    expect(await store.getDelivery(randomUUID())).toBeUndefined();
    await expect(store.getDelivery(fixture.deliveryId)).resolves.toBeUndefined();
    await store.beginDeliveryDispatch(fixture.direct, computeDirectInputHash(fixture.direct), fixture.dispatchContext);
    await store.acceptDelivery(fixture.direct, computeDirectInputHash(fixture.direct), "turn-1", fixture.context);
    await expect(store.getDelivery(fixture.deliveryId)).resolves.toMatchObject({
      deliveryId: fixture.deliveryId,
      turnId: "turn-1",
    });
    await expect(store.getDeliveryByTurn("turn-1")).resolves.toMatchObject({ deliveryId: fixture.deliveryId });
    await expect(store.getDeliveryByTurn("missing")).resolves.toBeUndefined();

    const report = turnReport(fixture, "turn-1");
    await expect(store.recordTurn({ ...report, deliveryId: randomUUID() }, fixture.context)).resolves.toBeUndefined();
    await expect(store.recordTurn({ ...report, agentId: randomUUID() }, fixture.context)).resolves.toBe("conflict");
    await expect(store.recordTurn({ ...report, placementGeneration: 2 }, fixture.context)).resolves.toBe(
      "stale_generation",
    );
    await expect(store.recordTurn(report, { ...fixture.context, instanceId: randomUUID() })).resolves.toBeUndefined();
    await expect(store.recordTurn(report, fixture.context)).resolves.toBe("recorded");
    await expect(store.recordTurn(report, fixture.context)).resolves.toBe("already_recorded");
    await expect(
      store.recordTurn(
        { ...report, requestId: randomUUID(), finalText: "different", resultHash: "different" },
        fixture.context,
      ),
    ).resolves.toBe("conflict");
    await expect(store.getTurn("turn-1")).resolves.toMatchObject({
      instanceId: fixture.instanceId,
      report: { finalText: "done" },
    });
    await expect(store.getTurn("missing")).resolves.toBeUndefined();
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(unit: UnitDatabase, options: { withRoot?: boolean } = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const computerId = randomUUID();
  const workspaceComputerId = computerId;
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const instanceId = randomUUID();
  await unit.database.insert(users).values({ id: userId, email: `${userId}@example.com`, displayName: "User" });
  await unit.database.insert(workspaces).values({ id: workspaceId, name: workspaceId, displayName: "Workspace" });
  await unit.database.insert(computers).values({ id: computerId });
  await unit.database.insert(accountComputers).values({
    id: computerId,
    ownerAccountId: userId,
    currentInstallationId: computerId,
    displayName: "Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
  });
  await unit.database.insert(workspaceComputers).values({
    id: workspaceComputerId,
    workspaceId,
    computerId,
    displayName: "Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
    enrolledByUserId: userId,
  });
  await unit.database.insert(agents).values({
    id: agentId,
    workspaceId,
    createdByUserId: userId,
    workspaceComputerId,
    computerId,
    name: `agent-${agentId}`,
    displayName: "Agent",
    runtimeProvider: "codex",
  });
  await unit.database.insert(imBindings).values({ id: bindingId, agentId, provider: "slack", status: "provisioning" });
  await unit.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "channel",
    conversationKind: "channel",
    kind: "channel",
  });
  await unit.database.insert(sessionPlacements).values({ sessionId, workspaceComputerId, computerId, generation: 1 });
  await unit.database.insert(imMessages).values({
    id: messageId,
    imBindingId: bindingId,
    channelId: "channel",
    externalMessageId: `message-${messageId}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "human",
    content: { fallbackText: "hello" },
    providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "1" },
    occurredAt: now,
  });
  const direct: DirectImMessageDeliveryRequest = {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: messageId,
    sessionId,
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app",
        teamId: "team",
        botUserId: "bot",
        channelId: "channel",
        messageTs: "1",
      },
    },
    runtime: {
      revision: { agent: { sequence: 1, id: agentId }, session: { sequence: 1, id: sessionId } },
      agentId,
      provider: "codex",
      instructions: { platform: "", agent: "", session: "" },
      execution: { approvalPolicy: "never", networkAccess: false },
      workspace: { workspaceId, mode: "empty_on_create", sharing: "agent" },
    },
  };
  await unit.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    placementGeneration: 1,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const context: RuntimeBusinessContext = {
    computerId,
    workspaceComputerId,
    workspaceId,
    instanceId,
    signal: new AbortController().signal,
  };
  const dispatchContext = { workspaceComputerId, instanceId };
  const reconcile: SessionReconcileRequest = {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId,
    agentId,
    placementGeneration: 1,
    desired: "ready",
    runtime: direct.runtime,
  };
  const result = {
    direct,
    deliveryId,
    instanceId,
    context,
    dispatchContext,
    now,
    sessionId,
    agentId,
    rootDeliveryId: deliveryId,
    reconcile,
  };
  if (!options.withRoot) return result;

  const rootMessageId = randomUUID();
  const rootDeliveryId = randomUUID();
  const steerMessageId = randomUUID();
  const absorbedMessageId = randomUUID();
  const steerDeliveryId = randomUUID();
  const absorbedDeliveryId = randomUUID();
  for (const [id, externalMessageId] of [
    [rootMessageId, "root"],
    [steerMessageId, "steer"],
    [absorbedMessageId, "absorbed"],
  ] as const) {
    await unit.database.insert(imMessages).values({
      id,
      imBindingId: bindingId,
      channelId: "channel",
      externalMessageId,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "human",
      content: { fallbackText: externalMessageId },
      providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: externalMessageId },
      occurredAt: now,
    });
  }
  await unit.database
    .update(imMessageDeliveries)
    .set({
      state: "accepted",
      inputHash: "root-input",
      turnId: "turn-root",
      reportOwnerInstanceId: instanceId,
      acceptedAt: now,
    })
    .where((await import("drizzle-orm")).eq(imMessageDeliveries.id, deliveryId));
  await unit.database
    .update(imMessageDeliveries)
    .set({ id: rootDeliveryId, messageId: rootMessageId })
    .where((await import("drizzle-orm")).eq(imMessageDeliveries.id, deliveryId));
  await unit.database.insert(imMessageDeliveries).values([
    {
      id: steerDeliveryId,
      messageId: steerMessageId,
      sessionId,
      attention: "ambient",
      placementGeneration: 1,
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: absorbedDeliveryId,
      messageId: absorbedMessageId,
      sessionId,
      attention: "direct",
      placementGeneration: 1,
      expiresAt: new Date(now.getTime() + 60_000),
    },
  ]);
  const steer: RuntimeImSteerRequest = {
    type: "im:steer",
    requestId: randomUUID(),
    deliveryId: steerDeliveryId,
    imMessageId: steerMessageId,
    sessionId,
    agentId,
    placementGeneration: 1,
    rootDeliveryId,
    expectedTurnId: "turn-root",
    attention: "ambient",
    content: direct.content,
  };
  return {
    ...result,
    direct: { ...direct, deliveryId: steerDeliveryId, imMessageId: steerMessageId },
    deliveryId: steerDeliveryId,
    rootDeliveryId,
    steer,
    absorbedDeliveryId,
    absorbedMessageId,
    releaseDeliveryId: absorbedDeliveryId,
    reconcile,
    sessionId,
  };
}

function turnReport(fixture: Fixture, turnId: string): TurnReportRequest {
  const body = {
    deliveryId: fixture.deliveryId,
    turnId,
    sessionId: fixture.sessionId,
    agentId: fixture.agentId,
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "done",
    usage: { inputTokens: 1, outputTokens: 1 },
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
