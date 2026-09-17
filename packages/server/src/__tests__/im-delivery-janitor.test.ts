import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
} from "../db/schema/index.js";
import {
  type ImDeliveryJanitorOptions,
  runImDeliveryExpiry,
  runImDeliveryRetention,
} from "../runtime/im-delivery-janitor.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const AGED_MS = 10 * 24 * 60 * 60 * 1_000;
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

describe("runImDeliveryExpiry", () => {
  it("expires an aged pending Local delivery as ttl and leaves a fresh Local delivery pending", async () => {
    const now = new Date();
    const agedLocal = await seedScope(unit, { kind: "local", occurredAt: aged(now), expiresAt: aged(now) });
    const fresh = await seedScope(unit, {
      kind: "local",
      occurredAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await runImDeliveryExpiry(unit.database, janitorOptions(now));

    expect(await deliveryRow(unit, agedLocal.deliveryId)).toMatchObject({ state: "expired", reason: "ttl" });
    expect(await deliveryRow(unit, fresh.deliveryId)).toMatchObject({ state: "pending", reason: null });
  });

  it("keeps an aged pending Cloud delivery and its original input durable through expiry and retention", async () => {
    const now = new Date();
    const cloud = await seedScope(unit, { kind: "cloud", occurredAt: aged(now), expiresAt: aged(now), ended: true });

    await runImDeliveryExpiry(unit.database, janitorOptions(now));
    await runImDeliveryRetention(unit.database, janitorOptions(now));

    expect(await deliveryRow(unit, cloud.deliveryId)).toMatchObject({ state: "pending", reason: null });
    expect(await messageRow(unit, cloud.messageId)).toBeDefined();
  });

  it("keeps an aged pending delivery when its Session placement classification is missing", async () => {
    const now = new Date();
    const unplaced = await seedScope(unit, { kind: "unplaced", occurredAt: aged(now), expiresAt: aged(now) });

    await runImDeliveryExpiry(unit.database, janitorOptions(now));

    expect(await deliveryRow(unit, unplaced.deliveryId)).toMatchObject({ state: "pending", reason: null });
  });

  it("never lets a durable Cloud backlog starve Local expiry within one batch", async () => {
    const now = new Date();
    const older = aged(aged(now));
    const cloud = await seedScope(unit, { kind: "cloud", occurredAt: older, expiresAt: older });
    const local = await seedScope(unit, { kind: "local", occurredAt: aged(now), expiresAt: aged(now) });

    await runImDeliveryExpiry(unit.database, janitorOptions(now, { expiryBatchSize: 1 }));

    expect(await deliveryRow(unit, local.deliveryId)).toMatchObject({ state: "expired", reason: "ttl" });
    expect(await deliveryRow(unit, cloud.deliveryId)).toMatchObject({ state: "pending", reason: null });
  });
});

describe("runImDeliveryRetention", () => {
  it("retains an accepted-unreported Cloud delivery and its original input past retention", async () => {
    const now = new Date();
    const cloud = await seedScope(unit, {
      kind: "cloud",
      occurredAt: aged(now),
      expiresAt: aged(now),
      ended: true,
      state: "accepted-unreported",
    });

    await runImDeliveryExpiry(unit.database, janitorOptions(now));
    await runImDeliveryRetention(unit.database, janitorOptions(now));

    expect(await deliveryRow(unit, cloud.deliveryId)).toMatchObject({
      state: "accepted",
      reason: null,
      inputHash: "input-hash",
      turnId: "turn-id",
      reportOwnerInstanceId: cloud.instanceId,
      reportedAt: null,
    });
    expect(await messageRow(unit, cloud.messageId)).toBeDefined();
  });

  it("applies bounded terminal retention to a Cloud delivery with an explicit terminal disposition", async () => {
    const now = new Date();
    const cloud = await seedScope(unit, {
      kind: "cloud",
      occurredAt: aged(now),
      expiresAt: aged(now),
      ended: true,
      state: "expired-superseded",
    });

    await runImDeliveryRetention(unit.database, janitorOptions(now));

    expect(await deliveryRow(unit, cloud.deliveryId)).toBeUndefined();
    expect(await messageRow(unit, cloud.messageId)).toBeUndefined();
  });

  it("keeps an aged pending Cloud delivery of an ended Session while sweeping terminal Local rows", async () => {
    const now = new Date();
    const cloud = await seedScope(unit, { kind: "cloud", occurredAt: aged(now), expiresAt: aged(now), ended: true });
    const local = await seedScope(unit, {
      kind: "local",
      occurredAt: aged(now),
      expiresAt: aged(now),
      ended: true,
      state: "expired-ttl",
    });

    await runImDeliveryRetention(unit.database, janitorOptions(now));

    expect(await deliveryRow(unit, cloud.deliveryId)).toMatchObject({ state: "pending", reason: null });
    expect(await messageRow(unit, cloud.messageId)).toBeDefined();
    expect(await deliveryRow(unit, local.deliveryId)).toBeUndefined();
    expect(await messageRow(unit, local.messageId)).toBeUndefined();
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

type SeedState = "pending" | "accepted-unreported" | "expired-ttl" | "expired-superseded";

interface SeedScopeInput {
  kind: "local" | "cloud" | "unplaced";
  occurredAt: Date;
  expiresAt: Date;
  ended?: boolean;
  state?: SeedState;
}

async function seedScope(unit: UnitDatabase, input: SeedScopeInput) {
  const userId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const instanceId = randomUUID();
  await unit.database.insert(users).values({ id: userId, email: `${userId}@example.com`, displayName: "User" });
  await unit.database.insert(computers).values({
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
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `agent-${agentId}`,
    displayName: "Agent",
    runtimeProvider: "codex",
  });
  const slackInstallationId = randomUUID();
  await unit.database.insert(slackInstallations).values({
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
  await unit.database.insert(imBindings).values({
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
  await unit.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "channel",
    conversationKind: "channel",
    kind: "channel",
    ...(input.ended ? { endedAt: input.occurredAt } : {}),
  });
  if (input.kind !== "unplaced") {
    await unit.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  }
  await unit.database.insert(imMessages).values({
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
  await unit.database.insert(imMessageDeliveries).values({
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
      : state === "expired-ttl"
        ? { state: "expired" as const, reason: "ttl" }
        : state === "expired-superseded"
          ? { state: "expired" as const, reason: "superseded_revision" }
          : {}),
  });
  return { userId, computerId, agentId, bindingId, sessionId, messageId, deliveryId, instanceId };
}

async function deliveryRow(unit: UnitDatabase, deliveryId: string) {
  const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
  return row;
}

async function messageRow(unit: UnitDatabase, messageId: string) {
  const [row] = await unit.database.select().from(imMessages).where(eq(imMessages.id, messageId));
  return row;
}
