import { randomUUID } from "node:crypto";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import { runImDeliverySteerRecovery } from "../runtime/im-delivery-janitor.js";
import {
  requeueSteeredDeliveries,
  STEER_TARGET_ENDED_ERROR_CODE,
  STEER_TARGET_UNPLACEABLE_ERROR_CODE,
} from "../runtime/im-delivery-recovery.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { SessionServiceError } from "../services/sessions/session-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("steered delivery recovery", () => {
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

  it("requeues live-Session children in ingress order and is idempotent", async () => {
    const fixture = await seedFixture(unit);
    const sessionService = fakeSessionService(fixture.sourceSessionId, 9);

    await expect(recover(unit, fixture, sessionService)).resolves.toEqual([
      fixture.children[1]?.deliveryId,
      fixture.children[0]?.deliveryId,
    ]);

    const rows = await deliveryRows(unit, fixture);
    const ordered = fixture.children
      .slice()
      .reverse()
      .map(({ deliveryId }) => rows.get(deliveryId));
    expect(ordered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "pending",
          sessionId: fixture.sourceSessionId,
          placementGeneration: 9,
          attemptCount: 3,
          dispatchRequestId: null,
          dispatchInputHash: null,
          dispatchPayload: null,
          inputHash: null,
          turnId: null,
          steerTargetDeliveryId: null,
          steeredAt: null,
          reportOwnerInstanceId: null,
          resultHash: null,
          turnReport: null,
          reportedAt: null,
          acceptedAt: null,
          reason: null,
          lastErrorCode: STEER_TARGET_ENDED_ERROR_CODE,
        }),
      ]),
    );
    expect(ordered[0]?.nextAttemptAt).toEqual(new Date(NOW.getTime() - 1));
    expect(ordered[1]?.nextAttemptAt).toEqual(NOW);
    expect(sessionService.ensureChatSessionInTransaction).toHaveBeenCalledTimes(1);

    await expect(recover(unit, fixture, sessionService)).resolves.toEqual([]);
    expect(sessionService.ensureChatSessionInTransaction).toHaveBeenCalledTimes(1);
  });

  it("re-places ended-Session children through the SessionService in ingress order", async () => {
    const fixture = await seedFixture(unit, { withReplacement: true });
    await unit.database.update(sessions).set({ endedAt: NOW }).where(eq(sessions.id, fixture.sourceSessionId));
    const sessionService = fakeSessionService(fixture.replacementSessionId as string, 7);

    await expect(recover(unit, fixture, sessionService)).resolves.toEqual([
      fixture.children[1]?.deliveryId,
      fixture.children[0]?.deliveryId,
    ]);

    expect(sessionService.ensureChatSessionInTransaction).toHaveBeenCalledTimes(1);
    expect(sessionService.ensureChatSessionInTransaction.mock.calls[0]?.[1]).toMatchObject({
      imBindingId: fixture.bindingId,
      channelId: "channel",
      conversationKind: "channel",
      kind: "channel",
      computerId: fixture.computerId,
      now: NOW,
    });
    const rows = await deliveryRows(unit, fixture);
    expect([...rows.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "pending",
          sessionId: fixture.replacementSessionId,
          placementGeneration: 7,
          lastErrorCode: STEER_TARGET_ENDED_ERROR_CODE,
        }),
      ]),
    );
  });

  it("does nothing when the target has no steered children", async () => {
    const fixture = await seedFixture(unit, { childCount: 0 });
    const sessionService = fakeSessionService(fixture.sourceSessionId, 9);

    await expect(recover(unit, fixture, sessionService)).resolves.toEqual([]);
    expect(sessionService.ensureChatSessionInTransaction).not.toHaveBeenCalled();
  });

  for (const authorityCase of [
    {
      name: "the binding is inactive",
      invalidate: async (fixture: Fixture) => {
        await unit.database
          .update(imBindings)
          .set({ status: "disabled", disabledAt: NOW, activatedAt: null, encryptedCredential: null })
          .where(eq(imBindings.id, fixture.bindingId));
      },
    },
    {
      name: "the Agent is inactive",
      invalidate: async (fixture: Fixture) => {
        await unit.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
      },
    },
    {
      name: "the Agent has no Computer",
      invalidate: async (fixture: Fixture) => {
        await unit.database.update(agents).set({ computerId: null }).where(eq(agents.id, fixture.agentId));
      },
    },
    {
      name: "the Computer belongs to another Account",
      invalidate: async (fixture: Fixture) => {
        const otherUserId = randomUUID();
        await unit.database
          .insert(users)
          .values({ id: otherUserId, email: `${otherUserId}@example.test`, displayName: "Other User" });
        await unit.database
          .update(computers)
          .set({ ownerAccountId: otherUserId })
          .where(eq(computers.id, fixture.computerId));
      },
    },
  ]) {
    it(`terminalizes children when ${authorityCase.name}`, async () => {
      const fixture = await seedFixture(unit);
      await authorityCase.invalidate(fixture);
      const sessionService = fakeSessionService(fixture.sourceSessionId, 9);

      await expect(recover(unit, fixture, sessionService)).resolves.toEqual([
        fixture.children[1]?.deliveryId,
        fixture.children[0]?.deliveryId,
      ]);
      expect(sessionService.ensureChatSessionInTransaction).not.toHaveBeenCalled();

      const rows = await deliveryRows(unit, fixture);
      for (const row of rows.values()) {
        expect(row).toMatchObject({
          state: "terminal_rejected",
          reason: "steer_target_ended_unplaceable",
          lastErrorCode: STEER_TARGET_UNPLACEABLE_ERROR_CODE,
          attemptCount: 3,
          dispatchRequestId: null,
          dispatchInputHash: null,
          dispatchPayload: null,
          inputHash: null,
          turnId: null,
          steerTargetDeliveryId: null,
          steeredAt: null,
          reportOwnerInstanceId: null,
          resultHash: null,
          turnReport: null,
          reportedAt: null,
          acceptedAt: null,
        });
      }
    });
  }

  it("terminalizes a replaceable SessionService failure", async () => {
    const fixture = await seedFixture(unit);
    const sessionService = fakeSessionService(fixture.sourceSessionId, 9);
    sessionService.ensureChatSessionInTransaction.mockRejectedValue(
      new SessionServiceError("AGENT_NOT_ACTIVE", "Agent is not active"),
    );

    await expect(recover(unit, fixture, sessionService)).resolves.toHaveLength(2);
    expect((await deliveryRows(unit, fixture)).get(fixture.children[0]?.deliveryId ?? "")).toMatchObject({
      state: "terminal_rejected",
      lastErrorCode: STEER_TARGET_UNPLACEABLE_ERROR_CODE,
    });
  });

  it("propagates unexpected SessionService failures without partially recovering rows", async () => {
    const fixture = await seedFixture(unit);
    const sessionService = fakeSessionService(fixture.sourceSessionId, 9);
    sessionService.ensureChatSessionInTransaction.mockRejectedValue(new Error("unexpected placement failure"));

    await expect(recover(unit, fixture, sessionService)).rejects.toThrow("unexpected placement failure");
    expect([...(await deliveryRows(unit, fixture)).values()].every((row) => row.state === "steered")).toBe(true);
  });

  it("terminalizes a child when the replacement Session already has the same message", async () => {
    const fixture = await seedFixture(unit, { withReplacement: true });
    const duplicate = fixture.children[1];
    if (!duplicate) throw new Error("duplicate fixture child missing");
    await unit.database.insert(imMessageDeliveries).values({
      id: randomUUID(),
      messageId: duplicate.messageId,
      sessionId: fixture.replacementSessionId as string,
      attention: "direct",
      placementGeneration: 7,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const sessionService = fakeSessionService(fixture.replacementSessionId as string, 7);

    await expect(recover(unit, fixture, sessionService)).resolves.toEqual([
      fixture.children[1]?.deliveryId,
      fixture.children[0]?.deliveryId,
    ]);
    const rows = await deliveryRows(unit, fixture);
    expect(rows.get(duplicate.deliveryId)).toMatchObject({
      state: "terminal_rejected",
      reason: "steer_target_ended_duplicate",
      lastErrorCode: STEER_TARGET_UNPLACEABLE_ERROR_CODE,
    });
    expect(rows.get(fixture.children[0]?.deliveryId ?? "")).toMatchObject({
      state: "pending",
      sessionId: fixture.replacementSessionId,
    });
  });

  it("runs the recovery from the janitor sweep", async () => {
    const fixture = await seedFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: "IM_DELIVERY_RECOVERY_FAILED", nextAttemptAt: NOW })
      .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));

    await runImDeliverySteerRecovery(unit.database, { clock: () => NOW, expiryBatchSize: 10 });

    expect([...(await deliveryRows(unit, fixture)).values()].every((row) => row.state === "pending")).toBe(true);
  });

  it("runs the recovery from a non-completed terminal report", async () => {
    const fixture = await seedFixture(unit);
    const store = new PostgresRuntimeCustodyStore(unit.database, { now: () => NOW });

    await expect(store.recordTurn(turnReport(fixture), fixture.context)).resolves.toBe("recorded");
    expect([...(await deliveryRows(unit, fixture)).values()].every((row) => row.state === "pending")).toBe(true);
  });
});

type ChildFixture = {
  messageId: string;
  deliveryId: string;
};

type Fixture = {
  now: Date;
  userId: string;
  computerId: string;
  agentId: string;
  bindingId: string;
  sourceSessionId: string;
  replacementSessionId?: string;
  rootDeliveryId: string;
  rootTurnId: string;
  children: ChildFixture[];
  context: RuntimeBusinessContext;
};

async function seedFixture(
  unitDatabase: UnitDatabase,
  options: { childCount?: number; withReplacement?: boolean } = {},
) {
  const childCount = options.childCount ?? 2;
  const userId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sourceSessionId = randomUUID();
  const replacementSessionId = options.withReplacement ? randomUUID() : undefined;
  const rootMessageId = randomUUID();
  const rootDeliveryId = randomUUID();
  const rootTurnId = randomUUID();
  const instanceId = randomUUID();
  const children = Array.from({ length: childCount }, (_, index) => ({
    messageId: randomUUID(),
    deliveryId: randomUUID(),
    occurredAt: new Date(NOW.getTime() + (childCount - index) * 1_000),
  }));

  await unitDatabase.database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    displayName: "Recovery User",
  });
  await unitDatabase.database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    currentInstallationId: randomUUID(),
    displayName: "Recovery Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
    currentInstanceId: instanceId,
  });
  await unitDatabase.database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `recovery-agent-${agentId}`,
    displayName: "Recovery Agent",
    runtimeProvider: "codex",
  });
  await unitDatabase.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `recovery-app-${bindingId}`,
    externalBotId: "recovery-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: NOW,
  });
  await unitDatabase.database.insert(sessions).values([
    {
      id: sourceSessionId,
      imBindingId: bindingId,
      channelId: "channel",
      conversationKind: "channel",
      kind: "channel",
    },
    ...(replacementSessionId
      ? [
          {
            id: replacementSessionId,
            imBindingId: bindingId,
            channelId: "replacement-channel",
            conversationKind: "channel" as const,
            kind: "channel" as const,
          },
        ]
      : []),
  ]);
  await unitDatabase.database
    .insert(sessionPlacements)
    .values([
      { sessionId: sourceSessionId, computerId, generation: 3 },
      ...(replacementSessionId ? [{ sessionId: replacementSessionId, computerId, generation: 7 }] : []),
    ]);
  await unitDatabase.database.insert(imMessages).values([
    {
      id: rootMessageId,
      imBindingId: bindingId,
      channelId: "channel",
      externalMessageId: "root",
      providerRevisionKey: "1",
      operation: "created" as const,
      direction: "inbound" as const,
      authorKind: "human" as const,
      authorExternalId: "human",
      content: { fallbackText: "root" },
      providerContext: { provider: "feishu" },
      occurredAt: NOW,
    },
    ...children.map((child, index) => ({
      id: child.messageId,
      imBindingId: bindingId,
      channelId: "channel",
      externalMessageId: `child-${index}`,
      providerRevisionKey: "1",
      operation: "created" as const,
      direction: "inbound" as const,
      authorKind: "human" as const,
      authorExternalId: "human",
      content: { fallbackText: `child-${index}` },
      providerContext: { provider: "feishu" },
      occurredAt: child.occurredAt,
    })),
  ] as never);
  await unitDatabase.database.insert(imMessageDeliveries).values([
    {
      id: rootDeliveryId,
      messageId: rootMessageId,
      sessionId: sourceSessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 3,
      inputHash: "root-input",
      turnId: rootTurnId,
      reportOwnerInstanceId: instanceId,
      acceptedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    },
    ...children.map((child, index) => ({
      id: child.deliveryId,
      messageId: child.messageId,
      sessionId: sourceSessionId,
      attention: "direct" as const,
      state: "steered" as const,
      placementGeneration: 3,
      dispatchRequestId: randomUUID(),
      dispatchInputHash: `dispatch-${index}`,
      dispatchPayload: { type: "im:steer", deliveryId: child.deliveryId } as never,
      inputHash: `semantic-${index}`,
      steerTargetDeliveryId: rootDeliveryId,
      steeredAt: NOW,
      attemptCount: 2,
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
      expiresAt: new Date(NOW.getTime() + 60 * 60_000),
      lastErrorCode: "IM_DELIVERY_STEERED",
    })),
  ]);

  return {
    now: NOW,
    userId,
    computerId,
    agentId,
    bindingId,
    sourceSessionId,
    replacementSessionId,
    rootDeliveryId,
    rootTurnId,
    children,
    context: {
      computerId,
      installationId: randomUUID(),
      instanceId,
      signal: new AbortController().signal,
    },
  } satisfies Fixture;
}

function fakeSessionService(sessionId: string, generation: number) {
  return {
    ensureChatSessionInTransaction: vi.fn(async (_transaction: unknown, _input: unknown) => ({
      session: { id: sessionId },
      placement: { generation },
    })),
  };
}

async function recover(
  unitDatabase: UnitDatabase,
  fixture: Fixture,
  sessionService: ReturnType<typeof fakeSessionService>,
) {
  return unitDatabase.database.transaction((transaction) =>
    requeueSteeredDeliveries(transaction, fixture.rootDeliveryId, fixture.now, sessionService as never),
  );
}

async function deliveryRows(unitDatabase: UnitDatabase, fixture: Fixture) {
  const rows = await unitDatabase.database
    .select({
      id: imMessageDeliveries.id,
      state: imMessageDeliveries.state,
      sessionId: imMessageDeliveries.sessionId,
      placementGeneration: imMessageDeliveries.placementGeneration,
      dispatchRequestId: imMessageDeliveries.dispatchRequestId,
      dispatchInputHash: imMessageDeliveries.dispatchInputHash,
      dispatchPayload: imMessageDeliveries.dispatchPayload,
      inputHash: imMessageDeliveries.inputHash,
      turnId: imMessageDeliveries.turnId,
      steerTargetDeliveryId: imMessageDeliveries.steerTargetDeliveryId,
      steeredAt: imMessageDeliveries.steeredAt,
      reportOwnerInstanceId: imMessageDeliveries.reportOwnerInstanceId,
      resultHash: imMessageDeliveries.resultHash,
      turnReport: imMessageDeliveries.turnReport,
      reportedAt: imMessageDeliveries.reportedAt,
      acceptedAt: imMessageDeliveries.acceptedAt,
      attemptCount: imMessageDeliveries.attemptCount,
      nextAttemptAt: imMessageDeliveries.nextAttemptAt,
      reason: imMessageDeliveries.reason,
      lastErrorCode: imMessageDeliveries.lastErrorCode,
    })
    .from(imMessageDeliveries)
    .where(
      inArray(
        imMessageDeliveries.id,
        fixture.children.map(({ deliveryId }) => deliveryId),
      ),
    );
  return new Map(rows.map((row) => [row.id, row]));
}

function turnReport(fixture: Fixture): TurnReportRequest {
  const body = {
    deliveryId: fixture.rootDeliveryId,
    turnId: fixture.rootTurnId,
    sessionId: fixture.sourceSessionId,
    agentId: fixture.agentId,
    placementGeneration: 3,
    outcome: "cancelled" as const,
    executionEffects: "may_have_occurred" as const,
    errorReason: "client_shutdown" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
