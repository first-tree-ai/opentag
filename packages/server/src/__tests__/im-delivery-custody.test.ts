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
  users,
} from "../db/schema/index.js";
import { dispatchClaimToken } from "../runtime/im-delivery-claim.js";
import { deliveryLaneKey, findOtherCustody } from "../runtime/im-delivery-custody.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * The occupancy rule itself: a delivery owns only its Session, on any Computer, and a Local and a
 * Cloud delivery of one Agent still fence each other. The worker suites cover the claim and
 * scheduling projections of the same rule.
 */

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

describe("delivery occupancy scope", () => {
  it("puts a delivery in its Session's lane", () => {
    expect(deliveryLaneKey({ sessionId: "session-1" })).toBe("session:session-1");
  });

  it("lets different Cloud Sessions of one Agent own custody concurrently", async () => {
    const fixture = await twoSessionFixture("cloud");
    await createDelivery(fixture.firstSessionId, "occupied");
    const subjectDeliveryId = await createDelivery(fixture.secondSessionId);
    const other = await findOtherCustody(unit.database, {
      deliveryId: subjectDeliveryId,
      agentId: fixture.agentId,
      sessionId: fixture.secondSessionId,
      computerKind: "cloud",
    });
    expect(other).toBeUndefined();
  });

  it("fences the same Cloud Session until its custody is reconciled", async () => {
    const fixture = await twoSessionFixture("cloud");
    const occupant = await createDelivery(fixture.firstSessionId, "occupied");
    const subjectDeliveryId = await createDelivery(fixture.firstSessionId);
    const other = await findOtherCustody(unit.database, {
      deliveryId: subjectDeliveryId,
      agentId: fixture.agentId,
      sessionId: fixture.firstSessionId,
      computerKind: "cloud",
    });
    expect(other?.id).toBe(occupant);
  });

  it("keeps a Local occupant's Agent-wide fence for the Agent's other Cloud Session", async () => {
    const fixture = await twoSessionFixture("local");
    const cloudComputerId = await createComputer(fixture.accountId, "cloud");
    const cloudSessionId = await createSession(fixture.bindingId, cloudComputerId);
    const occupant = await createDelivery(fixture.firstSessionId, "occupied");
    const subjectDeliveryId = await createDelivery(cloudSessionId);
    const other = await findOtherCustody(unit.database, {
      deliveryId: subjectDeliveryId,
      agentId: fixture.agentId,
      sessionId: cloudSessionId,
      computerKind: "cloud",
    });
    expect(other?.id).toBe(occupant);
  });

  it("keeps a Cloud occupant's Agent-wide fence for the Agent's other Local Session", async () => {
    const fixture = await twoSessionFixture("local");
    const cloudComputerId = await createComputer(fixture.accountId, "cloud");
    const cloudSessionId = await createSession(fixture.bindingId, cloudComputerId);
    const occupant = await createDelivery(cloudSessionId, "occupied");
    const subjectDeliveryId = await createDelivery(fixture.firstSessionId);
    const other = await findOtherCustody(unit.database, {
      deliveryId: subjectDeliveryId,
      agentId: fixture.agentId,
      sessionId: fixture.firstSessionId,
      computerKind: "local",
    });
    expect(other?.id).toBe(occupant);
  });

  it("lets different Local Sessions of one Agent own custody concurrently", async () => {
    const fixture = await twoSessionFixture("local");
    await createDelivery(fixture.firstSessionId, "occupied");
    const subjectDeliveryId = await createDelivery(fixture.secondSessionId);
    const other = await findOtherCustody(unit.database, {
      deliveryId: subjectDeliveryId,
      agentId: fixture.agentId,
      sessionId: fixture.secondSessionId,
      computerKind: "local",
    });
    expect(other).toBeUndefined();
  });

  it("fences the same Local Session until its custody is reconciled", async () => {
    const fixture = await twoSessionFixture("local");
    const occupant = await createDelivery(fixture.firstSessionId, "occupied");
    const subjectDeliveryId = await createDelivery(fixture.firstSessionId);
    const other = await findOtherCustody(unit.database, {
      deliveryId: subjectDeliveryId,
      agentId: fixture.agentId,
      sessionId: fixture.firstSessionId,
      computerKind: "local",
    });
    expect(other?.id).toBe(occupant);
  });

  it("never fences custody of a different Agent", async () => {
    const fixture = await twoSessionFixture("local");
    const otherAgent = await twoSessionFixture("cloud");
    await createDelivery(otherAgent.firstSessionId, "occupied");
    const subjectDeliveryId = await createDelivery(fixture.secondSessionId);
    const other = await findOtherCustody(unit.database, {
      deliveryId: subjectDeliveryId,
      agentId: fixture.agentId,
      sessionId: fixture.secondSessionId,
      computerKind: "local",
    });
    expect(other).toBeUndefined();
  });
});

async function createComputer(accountId: string, kind: "local" | "cloud") {
  const id = randomUUID();
  await unit.database.insert(computers).values({
    id,
    ownerAccountId: accountId,
    kind,
    currentInstallationId: randomUUID(),
    displayName: `${kind} computer`,
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
  });
  return id;
}

async function twoSessionFixture(kind: "local" | "cloud") {
  const accountId = randomUUID();
  await unit.database
    .insert(users)
    .values({ id: accountId, email: `${accountId}@example.test`, displayName: "Occupancy" });
  const computerId = await createComputer(accountId, kind);
  const agentId = randomUUID();
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: `occupancy-${agentId}`,
    displayName: "Occupancy",
    runtimeProvider: "pi",
  });
  const bindingId = randomUUID();
  await unit.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `occupancy-app-${bindingId}`,
    externalBotId: "bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "encrypted",
    activatedAt: new Date(),
  });
  const firstSessionId = await createSession(bindingId, computerId);
  const secondSessionId = await createSession(bindingId, computerId);
  return { accountId, agentId, bindingId, computerId, firstSessionId, secondSessionId };
}

async function createSession(bindingId: string, computerId: string) {
  const sessionId = randomUUID();
  await unit.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: `occupancy-channel-${sessionId}`,
    conversationKind: "channel",
    kind: "channel",
  });
  await unit.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  return sessionId;
}

/** A pending delivery; `occupied` adds the durable claim marker of an in-flight Worker. */
async function createDelivery(sessionId: string, state: "pending" | "occupied" = "pending") {
  const [session] = await unit.database
    .select({ imBindingId: sessions.imBindingId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) throw new Error("fixture session missing");
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  await unit.database.insert(imMessages).values({
    id: messageId,
    imBindingId: session.imBindingId,
    channelId: `occupancy-channel-${messageId}`,
    externalMessageId: `occupancy-ext-${messageId}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "occupancy-user",
    content: { version: 1, fallbackText: "occupancy", blocks: [], truncated: false },
    providerContext: { provider: "feishu" },
    occurredAt: new Date(),
  });
  await unit.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    state: "pending",
    placementGeneration: 1,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...(state === "occupied"
      ? { lastErrorCode: dispatchClaimToken(), nextAttemptAt: new Date(Date.now() + 60_000) }
      : {}),
  });
  return deliveryId;
}
