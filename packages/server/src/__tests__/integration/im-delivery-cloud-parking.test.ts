import { randomUUID } from "node:crypto";
import { computeDirectInputHash, computeTurnResultHash, type DirectImMessageDeliveryRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { PARKED_DELIVERY_CODE } from "../../db/im-delivery-work.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { type ImDeliveryJanitorOptions, runImDeliveryExpiry } from "../../runtime/im-delivery-janitor.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * The Cloud parking bound, driven through the Cloud path rather than a Local fixture with a mutated
 * Computer kind. A parked correlated Cloud row must stop being offered to the Runner while it keeps
 * its dispatch correlation and its unreported custody until both of its bounds pass — the frozen
 * execution window and the ingress deadline — and then leave custody through the ordinary Cloud
 * expired-dispatch release, never by rebuilding the input.
 */
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

describe("Cloud dispatch parking", () => {
  it("parks a correlated Cloud dispatch and expires it only after both of its bounds", async () => {
    const fixture = await createCloudParkFixture(client.database);
    const parked = await parkCloudDispatch(client.database, fixture);

    const [row] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row).toMatchObject({
      state: "pending",
      reason: null,
      lastErrorCode: PARKED_DELIVERY_CODE,
      reportedAt: null,
      turnReport: null,
      resultHash: null,
    });
    expect(row?.dispatchRequestId).not.toBeNull();
    expect(row?.nextAttemptAt).toEqual(row?.expiresAt);
    expect(parked.diagnosticCodes.filter((code) => code === "IM_DELIVERY_DISPATCH_PARKED")).toHaveLength(1);
    expect(parked.dispatchDelivery).toHaveBeenCalledTimes(1);

    // Inside both bounds — the ingress deadline is still ahead — the row keeps its custody and is not
    // expired by the sweep.
    await runImDeliveryExpiry(client.database, janitorOptions(new Date(fixture.now.getTime() + 60_000)));
    const [beforeBound] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(beforeBound).toMatchObject({ state: "pending", dispatchRequestId: row?.dispatchRequestId });

    // A parked payload with no deadlineAt fails closed, matching cloudDispatchWindowExpired.
    const originalPayload = row?.dispatchPayload;
    const { deadlineAt: _omitted, ...payloadWithoutDeadline } = (originalPayload ?? {}) as Record<string, unknown>;
    await client.database
      .update(imMessageDeliveries)
      .set({ dispatchPayload: payloadWithoutDeadline as never })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const afterBound = new Date((row?.expiresAt.getTime() ?? 0) + 60_000);
    await runImDeliveryExpiry(client.database, janitorOptions(afterBound));
    const [withoutDeadline] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(withoutDeadline).toMatchObject({ state: "pending", dispatchRequestId: row?.dispatchRequestId });
    await client.database
      .update(imMessageDeliveries)
      .set({ dispatchPayload: originalPayload ?? null })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));

    // Past the frozen window and past the ingress deadline: the parked row leaves pending.
    await runImDeliveryExpiry(client.database, janitorOptions(afterBound));
    const [expired] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(expired).toMatchObject({ state: "expired", reason: "ttl" });
    // Custody is retained: no report was invented and the correlation is still there.
    expect(expired?.dispatchRequestId).toBe(row?.dispatchRequestId);
    expect(expired?.reportedAt).toBeNull();
    expect(expired?.turnReport).toBeNull();

    // The expired row now meets the ordinary Cloud expired-dispatch release, which never rebuilds the
    // input: no second dispatch, and the correlation is released. The expiry above ran on an advanced
    // clock, so make the reclaim due on the clock the worker reads — that is exactly the bound it
    // becomes due at in production.
    await client.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    await parked.worker.runOnce();
    const [released] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(released).toMatchObject({
      state: "expired",
      dispatchRequestId: null,
      dispatchPayload: null,
      lastErrorCode: "IM_DELIVERY_EXPIRED",
    });
    expect(parked.dispatchDelivery).toHaveBeenCalledTimes(1);
  });

  it("accepts a late authentic report for a parked Cloud dispatch", async () => {
    const fixture = await createCloudParkFixture(client.database);
    const parked = await parkCloudDispatch(client.database, fixture);
    const dispatched = parked.dispatchDelivery.mock.calls[0]?.[0]?.request;
    if (!dispatched) throw new Error("The parked Cloud dispatch was never sent");

    // The Runner answers after the park: the acceptance clears the park marker and the report records,
    // because parking kept the correlation and wrote nothing.
    await expect(
      fixture.custody.acceptDelivery(dispatched, computeDirectInputHash(dispatched), fixture.turnId, fixture.context),
    ).resolves.toBe("accepted");
    await expect(fixture.custody.recordTurn(completedTurnReport(fixture), fixture.context)).resolves.toBe("recorded");

    const [reported] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(reported).toMatchObject({ state: "accepted", lastErrorCode: null, turnId: fixture.turnId });
    expect(reported?.reportedAt).not.toBeNull();
    expect(reported?.turnReport).toMatchObject({ outcome: "completed" });
  });
});

type CloudFixture = {
  now: Date;
  deliveryId: string;
  sessionId: string;
  agentId: string;
  computerId: string;
  bindingId: string;
  instanceId: string;
  turnId: string;
  placementGeneration: number;
  context: { computerId: string; installationId: string; instanceId: string; signal: AbortSignal };
  runtime: DirectImMessageDeliveryRequest["runtime"];
  custody: PostgresRuntimeCustodyStore;
  clock: () => Date;
};

/**
 * One Cloud scope with a pending, correlated-capable delivery: a real `computers.kind = 'cloud'`
 * placement, the Session Sandbox row `#ensureEnvironment` looks for, and a runtime snapshot the
 * assembler replaces. Ids are unique per fixture so one test can build more than one.
 */
async function createCloudParkFixture(database: ReturnType<typeof createDatabaseClient>["database"]) {
  const now = new Date();
  const userId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const turnId = randomUUID();
  const instanceId = randomUUID();
  await database.insert(users).values({ id: userId, email: `${userId}@example.test`, displayName: "Cloud User" });
  await database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    kind: "cloud",
    currentInstallationId: randomUUID(),
    displayName: "Cloud Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
    currentInstanceId: instanceId,
  });
  await database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `cloud-agent-${agentId}`,
    displayName: "Cloud Agent",
    runtimeProvider: "codex",
  });
  await database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `cloud-app-${bindingId}`,
    externalBotId: "cloud-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: now,
  });
  await database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: `cloud-channel-${sessionId}`,
    conversationKind: "channel",
    kind: "channel",
  });
  await database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  // The Session Sandbox row the Cloud environment ensure looks for; no allocation port is needed when
  // the row exists.
  await database.insert(sandboxes).values({
    sessionId,
    storageUri: `gs://cloud-parking-fixture/${sessionId}`,
    lifecycle: "ready",
  });
  await database.insert(imMessages).values({
    id: messageId,
    imBindingId: bindingId,
    channelId: `cloud-channel-${sessionId}`,
    externalMessageId: `cloud-message-${messageId}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "human",
    content: { fallbackText: "cloud parking" },
    providerContext: { provider: "feishu", chatType: "group" },
    occurredAt: now,
  } as never);
  await database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    placementGeneration: 1,
    // One timeout short of the cap: the next timed-out attempt parks the row.
    attemptCount: 7,
    lastErrorCode: "IM_DELIVERY_OPERATION_TIMEOUT_7",
    nextAttemptAt: new Date(now.getTime() - 1_000),
    expiresAt: new Date(now.getTime() + 60 * 60_000),
  });
  const runtime = {
    contextTrees: [],
    revision: { agent: { sequence: 1, id: agentId }, session: { sequence: 1, id: sessionId } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "", agent: "", session: "" },
    execution: { approvalPolicy: "never" as const, networkAccess: false },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
  const fixture: CloudFixture = {
    now,
    deliveryId,
    sessionId,
    agentId,
    computerId,
    bindingId,
    instanceId,
    turnId,
    placementGeneration: 1,
    context: { computerId, installationId: randomUUID(), instanceId, signal: new AbortController().signal },
    runtime,
    custody: new PostgresRuntimeCustodyStore(database, { now: () => now }),
    clock: () => now,
  };
  return fixture;
}

/**
 * Park the Cloud row through the production Cloud path: the owner port persists durable custody, as
 * `CloudDeliveryOwner.dispatchDelivery` does, and then never answers, so the worker's operation
 * deadline fires with the correlation already in the row.
 */
async function parkCloudDispatch(database: ReturnType<typeof createDatabaseClient>["database"], fixture: CloudFixture) {
  const custody: Pick<PostgresRuntimeCustodyStore, "beginDeliveryDispatch"> = fixture.custody;
  const dispatchDelivery = vi.fn(
    async (input: { computerId: string; inputHash: string; request: DirectImMessageDeliveryRequest }) => {
      const status = await custody.beginDeliveryDispatch(input.request, input.inputHash, {
        computerId: input.computerId,
        instanceId: fixture.instanceId,
      });
      if (status !== "dispatched" && status !== "already_dispatched") {
        throw new Error(`IM_DELIVERY_TEST_CUSTODY_NOT_ACQUIRED: ${status}`);
      }
      return new Promise<never>(() => undefined);
    },
  );
  const diagnosticCodes: string[] = [];
  const worker = new ImDeliveryWorker({
    database,
    domain: {} as never,
    assembler: { assembleForSession: vi.fn(async () => fixture.runtime) },
    registry: {
      canReceiveSnapshot: () => true,
      capabilityVersion: () => 2,
      currentInstanceId: () => fixture.instanceId,
      supportsCapability: () => false,
    } as never,
    cloudDelivery: {
      canBatch: () => false,
      dispatchDelivery,
      inputInstance: () => fixture.instanceId,
      isModelPathConfigured: () => true,
      resolveRuntimeModel: async (snapshot: unknown) => snapshot,
    } as never,
    intervalMs: 60_000,
    // Far above the durable custody write production awaits before sending, and far below the retry
    // schedule, so the correlated precondition always holds before the timeout can fire.
    operationTimeoutMs: 250,
    onDiagnostic: (code: string) => diagnosticCodes.push(code),
  });
  // One iteration: the deadline aborts the hung dispatch, the exhaustion path parks, then the grace expires.
  await worker.runOnce();
  return { diagnosticCodes, dispatchDelivery, worker };
}

function janitorOptions(now: Date, overrides: Partial<ImDeliveryJanitorOptions> = {}): ImDeliveryJanitorOptions {
  return {
    clock: () => now,
    expiryBatchSize: 100,
    retentionBatchSize: 100,
    imMessagesRetentionMs: 90 * 24 * 60 * 60 * 1_000,
    imMessageDeliveriesRetentionMs: 90 * 24 * 60 * 60 * 1_000,
    slackWebhookReceiptsRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    feishuInboundReceiptsRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    ...overrides,
  };
}

function completedTurnReport(fixture: CloudFixture) {
  const body = {
    deliveryId: fixture.deliveryId,
    turnId: fixture.turnId,
    sessionId: fixture.sessionId,
    agentId: fixture.agentId,
    placementGeneration: fixture.placementGeneration,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return { type: "turn:report" as const, requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
