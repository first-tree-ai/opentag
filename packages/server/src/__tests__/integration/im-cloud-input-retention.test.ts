import { randomUUID } from "node:crypto";
import type { NormalizedInboundImEvent } from "@opentag/shared";
import { and, count, eq, isNull } from "drizzle-orm";
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
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import {
  type ImDeliveryJanitorOptions,
  runImDeliveryExpiry,
  runImDeliveryRetention,
} from "../../runtime/im-delivery-janitor.js";
import { ImMessageInbox } from "../../services/im/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const AGED_MS = 10 * 24 * 60 * 60 * 1_000;
const DIRECT_CAPACITY = 100;
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

describe("Cloud input retention on real PostgreSQL", () => {
  it("keeps an aged Cloud pending input durable while the same aged Local input expires", async () => {
    const now = new Date();
    const cloud = await seedScope({ kind: "cloud", occurredAt: aged(now), expiresAt: aged(now), ended: true });
    const local = await seedScope({ kind: "local", occurredAt: aged(now), expiresAt: aged(now), ended: true });

    await runImDeliveryExpiry(client.database, janitorOptions(now));

    expect(await deliveryRow(cloud.deliveryId)).toMatchObject({ state: "pending", reason: null });
    expect(await deliveryRow(local.deliveryId)).toMatchObject({ state: "expired", reason: "ttl" });

    await runImDeliveryRetention(client.database, janitorOptions(now));

    expect(await deliveryRow(cloud.deliveryId)).toMatchObject({ state: "pending", reason: null });
    expect(await messageRow(cloud.messageId)).toBeDefined();
    expect(await deliveryRow(local.deliveryId)).toBeUndefined();
    expect(await messageRow(local.messageId)).toBeUndefined();
  });

  it("keeps an aged pending delivery whose placement classification is missing", async () => {
    const now = new Date();
    const unplaced = await seedScope({ kind: "unplaced", occurredAt: aged(now), expiresAt: aged(now), ended: true });

    await runImDeliveryExpiry(client.database, janitorOptions(now));

    expect(await deliveryRow(unplaced.deliveryId)).toMatchObject({ state: "pending", reason: null });
  });

  it("retains an accepted-unreported Cloud receipt and its original input past expiry and retention", async () => {
    const now = new Date();
    const cloud = await seedScope({
      kind: "cloud",
      occurredAt: aged(now),
      expiresAt: aged(now),
      ended: true,
      state: "accepted-unreported",
    });

    await runImDeliveryExpiry(client.database, janitorOptions(now));
    await runImDeliveryRetention(client.database, janitorOptions(now));

    expect(await deliveryRow(cloud.deliveryId)).toMatchObject({
      state: "accepted",
      reason: null,
      inputHash: "input-hash",
      turnId: "turn-id",
      reportOwnerInstanceId: cloud.instanceId,
      reportedAt: null,
    });
    expect(await messageRow(cloud.messageId)).toBeDefined();
  });

  it("applies bounded terminal retention to a Cloud delivery with an explicit terminal disposition", async () => {
    const now = new Date();
    const cloud = await seedScope({
      kind: "cloud",
      occurredAt: aged(now),
      expiresAt: aged(now),
      ended: true,
      state: "expired-superseded",
    });

    await runImDeliveryRetention(client.database, janitorOptions(now));

    expect(await deliveryRow(cloud.deliveryId)).toBeUndefined();
    expect(await messageRow(cloud.messageId)).toBeUndefined();
  });

  it("retains Cloud overflow deliveries while the Local overflow bucket prunes as before", async () => {
    const cloud = await inboxFixture("cloud");
    const local = await inboxFixture("local");
    const cloudLogger = { error: vi.fn() };
    const localLogger = { error: vi.fn() };
    const cloudBeforeOverflowExpiry = vi.fn();
    const localBeforeOverflowExpiry = vi.fn();
    const localPassCompleted = deferred<void>();
    const cloudInbox = new ImMessageInbox(client.database, {
      beforeOverflowExpiry: cloudBeforeOverflowExpiry,
      logger: cloudLogger,
    });
    const localInbox = new ImMessageInbox(client.database, {
      beforeOverflowExpiry: localBeforeOverflowExpiry,
      afterOverflowExpiry: async () => {
        localPassCompleted.resolve();
      },
      logger: localLogger,
    });

    const cloudFirst = await cloudInbox.ingest(cloud.imBindingId, 1, event(cloud, "first", 1));
    const cloudSession = await onlySession(cloud.imBindingId);
    await placeSessionOnCloudComputer(cloud.accountId, cloudSession.id);
    await seedPendingDeliveries(cloud, cloudSession.id, DIRECT_CAPACITY - 1, "cloud-filler");

    const localFirst = await localInbox.ingest(local.imBindingId, 1, event(local, "first", 1));
    const localSession = await onlySession(local.imBindingId);
    await seedPendingDeliveries(local, localSession.id, DIRECT_CAPACITY - 1, "local-filler");

    await cloudInbox.ingest(cloud.imBindingId, 1, event(cloud, "trigger", DIRECT_CAPACITY + 1));
    await localInbox.ingest(local.imBindingId, 1, event(local, "trigger", DIRECT_CAPACITY + 1));

    // The awaited ingests already queued every scheduled pass; awaiting the completed Local
    // mutation transaction proves the pass ran before any non-deletion assertion below.
    await localPassCompleted.promise;
    expect(localBeforeOverflowExpiry).toHaveBeenCalledTimes(1);
    expect(await pendingDeliveryCount(localSession.id)).toBe(DIRECT_CAPACITY);
    const localFirstDeliveryId = localFirst.deliveryIds[0];
    if (!localFirstDeliveryId) throw new Error("Local fixture did not create the first delivery");
    expect(await deliveryState(localFirstDeliveryId)).toMatchObject({ state: "expired", reason: "capacity" });

    expect(cloudBeforeOverflowExpiry).not.toHaveBeenCalled();
    expect(await pendingDeliveryCount(cloudSession.id)).toBe(DIRECT_CAPACITY + 1);
    const cloudFirstDeliveryId = cloudFirst.deliveryIds[0];
    if (!cloudFirstDeliveryId) throw new Error("Cloud fixture did not create the first delivery");
    expect(await deliveryState(cloudFirstDeliveryId)).toMatchObject({ state: "pending", reason: null });
    const cloudRows = await client.database
      .select({ state: imMessageDeliveries.state })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.sessionId, cloudSession.id));
    expect(cloudRows.filter((row) => row.state === "expired")).toEqual([]);
    expect(cloudLogger.error).not.toHaveBeenCalled();
    expect(localLogger.error).not.toHaveBeenCalled();
  });
});

function janitorOptions(now: Date, overrides: Partial<ImDeliveryJanitorOptions> = {}): ImDeliveryJanitorOptions {
  return {
    clock: () => now,
    expiryBatchSize: 100,
    retentionBatchSize: 100,
    imMessagesRetentionMs: 1_000,
    imMessageDeliveriesRetentionMs: 1_000,
    slackWebhookReceiptsRetentionMs: 1_000,
    feishuInboundReceiptsRetentionMs: 1_000,
    ...overrides,
  };
}

function aged(now: Date): Date {
  return new Date(now.getTime() - AGED_MS);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type SeedState = "pending" | "accepted-unreported" | "expired-superseded";

interface SeedScopeInput {
  kind: "local" | "cloud" | "unplaced";
  occurredAt: Date;
  expiresAt: Date;
  ended?: boolean;
  state?: SeedState;
}

async function seedScope(input: SeedScopeInput) {
  const userId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const instanceId = randomUUID();
  await client.database.insert(users).values({ id: userId, email: `${userId}@example.com`, displayName: "User" });
  await client.database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    kind: input.kind === "cloud" ? "cloud" : "local",
    currentInstallationId: randomUUID(),
    displayName: "Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
    currentInstanceId: instanceId,
  });
  await client.database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `agent-${agentId}`,
    displayName: "Agent",
    runtimeProvider: "codex",
  });
  const slackInstallationId = randomUUID();
  await client.database.insert(slackInstallations).values({
    id: slackInstallationId,
    agentId,
    status: "active",
    externalAppId: `app-${bindingId}`,
    externalTeamId: `team-${bindingId}`,
    externalBotId: `bot-${bindingId}`,
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "encrypted",
    activatedAt: input.occurredAt,
  });
  await client.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "slack",
    status: "active",
    externalAppId: `app-${bindingId}`,
    externalTeamId: `team-${bindingId}`,
    externalBotId: `bot-${bindingId}`,
    credentialSchemaVersion: 1,
    slackInstallationId,
    slackRouteKind: "default",
    credentialGeneration: 1,
    activatedAt: input.occurredAt,
  });
  await client.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "channel",
    conversationKind: "channel",
    kind: "channel",
    ...(input.ended ? { endedAt: input.occurredAt } : {}),
  });
  if (input.kind !== "unplaced") {
    await client.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  }
  await client.database.insert(imMessages).values({
    id: messageId,
    imBindingId: bindingId,
    channelId: "channel",
    externalMessageId: `message-${messageId}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "U_HUMAN",
    content: {
      version: 1,
      fallbackText: "original input",
      blocks: [{ type: "text" as const, text: "original input" }],
      truncated: false,
    },
    providerContext: { provider: "slack" as const, channelType: "channel" as const },
    occurredAt: input.occurredAt,
  });
  const state = input.state ?? "pending";
  await client.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    placementGeneration: 1,
    expiresAt: input.expiresAt,
    ...(state === "accepted-unreported"
      ? {
          state: "accepted" as const,
          inputHash: "input-hash",
          turnId: "turn-id",
          reportOwnerInstanceId: instanceId,
          acceptedAt: input.occurredAt,
        }
      : state === "expired-superseded"
        ? { state: "expired" as const, reason: "superseded_revision" }
        : {}),
  });
  return { userId, computerId, agentId, bindingId, sessionId, messageId, deliveryId, instanceId };
}

interface InboxScope {
  imBindingId: string;
  accountId: string;
  computerId: string;
  appId: string;
  teamId: string;
  botUserId: string;
  channelId: string;
}

async function inboxFixture(scope: string): Promise<InboxScope> {
  const userId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const identity = {
    appId: `A_E4_RETENTION_${scope}`,
    teamId: `T_E4_RETENTION_${scope}`,
    botUserId: `U_E4_RETENTION_${scope}`,
  };
  await client.database.insert(users).values({ id: userId, email: `${userId}@example.com`, displayName: "User" });
  await client.database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    currentInstallationId: randomUUID(),
    displayName: "Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
  });
  await client.database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `agent-${agentId}`,
    displayName: "Agent",
    runtimeProvider: "codex",
  });
  const slackInstallationId = randomUUID();
  await client.database.insert(slackInstallations).values({
    id: slackInstallationId,
    agentId,
    status: "active",
    externalAppId: identity.appId,
    externalTeamId: identity.teamId,
    externalBotId: identity.botUserId,
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "encrypted",
    activatedAt: new Date(),
  });
  await client.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "slack",
    status: "active",
    externalAppId: identity.appId,
    externalTeamId: identity.teamId,
    externalBotId: identity.botUserId,
    credentialSchemaVersion: 1,
    slackInstallationId,
    slackRouteKind: "default",
    credentialGeneration: 1,
    activatedAt: new Date(),
  });
  return {
    imBindingId: bindingId,
    accountId: userId,
    computerId,
    ...identity,
    channelId: `C_E4_RETENTION_${scope}`,
  };
}

async function onlySession(imBindingId: string) {
  const [session] = await client.database.select().from(sessions).where(eq(sessions.imBindingId, imBindingId));
  if (!session) throw new Error("Inbox fixture did not create a session");
  return session;
}

async function placeSessionOnCloudComputer(accountId: string, sessionId: string): Promise<void> {
  const [cloudComputer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: accountId,
      kind: "cloud",
      currentInstallationId: randomUUID(),
      displayName: "OpenTag Cloud",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.5",
    })
    .returning();
  if (!cloudComputer) throw new Error("Cloud Computer fixture was not created");
  await client.database
    .update(sessionPlacements)
    .set({ computerId: cloudComputer.id })
    .where(eq(sessionPlacements.sessionId, sessionId));
}

async function seedPendingDeliveries(scope: InboxScope, sessionId: string, count: number, prefix: string) {
  const base = Date.now();
  const messages = await client.database
    .insert(imMessages)
    .values(
      Array.from({ length: count }, (_, index) => ({
        imBindingId: scope.imBindingId,
        providerEventId: `${prefix}-${index}`,
        channelId: scope.channelId,
        externalMessageId: `${prefix}-message-${index}`,
        providerRevisionKey: "1",
        operation: "created" as const,
        direction: "inbound" as const,
        providerContext: { provider: "slack" as const, channelType: "channel" as const },
        threadKey: null,
        replyToExternalId: null,
        authorKind: "human" as const,
        authorExternalId: "U_HUMAN",
        authorDisplayName: "Human",
        content: {
          version: 1 as const,
          fallbackText: "filler",
          blocks: [{ type: "text" as const, text: "filler" }],
          truncated: false,
        },
        occurredAt: new Date(base + index + 2),
      })),
    )
    .returning({ id: imMessages.id });
  await client.database.insert(imMessageDeliveries).values(
    messages.map((message) => ({
      messageId: message.id,
      sessionId,
      attention: "direct" as const,
      placementGeneration: 1,
      expiresAt: new Date(base + 60 * 60_000),
    })),
  );
}

async function deliveryRow(deliveryId: string) {
  const [row] = await client.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
  return row;
}

async function messageRow(messageId: string) {
  const [row] = await client.database.select().from(imMessages).where(eq(imMessages.id, messageId));
  return row;
}

async function deliveryState(deliveryId: string) {
  const [row] = await client.database
    .select({ state: imMessageDeliveries.state, reason: imMessageDeliveries.reason })
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, deliveryId));
  return row;
}

async function pendingDeliveryCount(sessionId: string) {
  const [row] = await client.database
    .select({ count: count() })
    .from(imMessageDeliveries)
    .where(
      and(
        eq(imMessageDeliveries.sessionId, sessionId),
        eq(imMessageDeliveries.attention, "direct"),
        eq(imMessageDeliveries.state, "pending"),
        isNull(imMessageDeliveries.reason),
      ),
    );
  return row?.count ?? 0;
}

function event(scope: InboxScope, eventSuffix: string, millisecondsAfterEpoch: number): NormalizedInboundImEvent {
  return {
    providerEventId: `Ev-${scope.teamId}-${eventSuffix}`,
    externalAppId: scope.appId,
    externalTeamId: scope.teamId,
    providerContext: { provider: "slack", channelType: "channel" },
    conversation: { externalId: scope.channelId, kind: "channel" },
    message: {
      externalId: `e4-message-${eventSuffix}`,
      revisionKey: "1",
      operation: "created",
      threadKey: null,
      replyToExternalId: null,
      author: { externalId: "U_HUMAN", kind: "human", displayName: "Human" },
      occurredAt: new Date(Date.now() + millisecondsAfterEpoch),
      content: {
        version: 1,
        fallbackText: "e4 retention event",
        blocks: [{ type: "text", text: "e4 retention event" }],
        truncated: false,
      },
      resources: [],
    },
    mentions: [{ externalId: scope.botUserId, displayName: "E4 Retention Agent" }],
  };
}
