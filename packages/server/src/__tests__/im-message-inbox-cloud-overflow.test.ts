import { randomUUID } from "node:crypto";
import { type NormalizedInboundImEvent, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computers, imMessageDeliveries, imMessages, sessionPlacements, sessions, users } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImMessageInbox } from "../services/im/index.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const fixedNow = new Date("2026-08-19T00:00:00.000Z");
const DIRECT_CAPACITY = 100;
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

describe("ImMessageInbox Cloud overflow capacity", () => {
  it("bounds undispatched Cloud pending with the Local capacity and never prunes dispatched or accepted custody", async () => {
    const value = await inboxFixture("cloud");
    const logger = { error: vi.fn() };
    const passCompleted = deferred<void>();
    const beforeOverflowExpiry = vi.fn();
    const inbox = new ImMessageInbox(unit.database, {
      beforeOverflowExpiry,
      afterOverflowExpiry: async () => {
        passCompleted.resolve();
      },
      logger,
    });

    const first = await inbox.ingest(value.imBindingId, 1, event(value, "first", 1));
    const firstDeliveryId = first.deliveryIds[0];
    if (!firstDeliveryId) throw new Error("Cloud fixture did not create the first delivery");
    const session = await onlySession(value.imBindingId);
    await placeSessionOnCloudComputer(value.accountId, session.id);
    const fillerIds = await seedPendingDeliveries(value, session.id, DIRECT_CAPACITY - 1, "cloud-filler");
    // Older than every prunable row: if a dispatched window or accepted custody were counted or
    // pruned, the oldest-row assertion below would change.
    const protectedRows = await seedProtectedDeliveries(value, session.id);

    await inbox.ingest(value.imBindingId, 1, event(value, "trigger", DIRECT_CAPACITY + 1));

    await passCompleted.promise;
    expect(beforeOverflowExpiry).toHaveBeenCalledTimes(1);
    // One over capacity: the oldest prunable row is expired...
    expect(await deliveryState(firstDeliveryId)).toMatchObject({ state: "expired", reason: "capacity" });
    expect(await expiredCount(session.id)).toBe(1);
    // ...the dispatched execution window and accepted custody are untouched...
    expect(await deliveryState(protectedRows.dispatchedDeliveryId)).toMatchObject({ state: "pending", reason: null });
    expect(await deliveryState(protectedRows.acceptedDeliveryId)).toMatchObject({ state: "accepted", reason: null });
    // ...and exactly the capacity bound of undispatched input remains.
    expect(await undispatchedPendingCount(session.id)).toBe(DIRECT_CAPACITY);
    expect(fillerIds).toHaveLength(DIRECT_CAPACITY - 1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("applies capacity after a bucket turns Cloud before the queued pass runs", async () => {
    const value = await inboxFixture("flip");
    const logger = { error: vi.fn() };
    const passCompleted = deferred<void>();
    const beforeOverflowExpiry = vi.fn(async () => {
      const session = await onlySession(value.imBindingId);
      await placeSessionOnCloudComputer(value.accountId, session.id);
    });
    const inbox = new ImMessageInbox(unit.database, {
      beforeOverflowExpiry,
      afterOverflowExpiry: async () => {
        passCompleted.resolve();
      },
      logger,
    });

    const first = await inbox.ingest(value.imBindingId, 1, event(value, "first", 1));
    const firstDeliveryId = first.deliveryIds[0];
    if (!firstDeliveryId) throw new Error("Cloud fixture did not create the first delivery");
    const session = await onlySession(value.imBindingId);
    await seedPendingDeliveries(value, session.id, DIRECT_CAPACITY - 1, "flip-filler");

    await inbox.ingest(value.imBindingId, 1, event(value, "trigger", DIRECT_CAPACITY + 1));

    await passCompleted.promise;
    expect(beforeOverflowExpiry).toHaveBeenCalledTimes(1);
    // The bucket became Cloud while the pass was queued; undispatched Cloud pending still obeys
    // the capacity bound, so the delete transaction prunes the oldest row.
    expect(await deliveryState(firstDeliveryId)).toMatchObject({ state: "expired", reason: "capacity" });
    expect(await undispatchedPendingCount(session.id)).toBe(DIRECT_CAPACITY);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps a bucket whose placement row disappears before the queued overflow pass runs", async () => {
    const value = await inboxFixture("unplaced");
    const logger = { error: vi.fn() };
    const passCompleted = deferred<void>();
    const beforeOverflowExpiry = vi.fn(async () => {
      const session = await onlySession(value.imBindingId);
      await unit.database.delete(sessionPlacements).where(eq(sessionPlacements.sessionId, session.id));
    });
    const inbox = new ImMessageInbox(unit.database, {
      beforeOverflowExpiry,
      afterOverflowExpiry: async () => {
        passCompleted.resolve();
      },
      logger,
    });

    await inbox.ingest(value.imBindingId, 1, event(value, "first", 1));
    const session = await onlySession(value.imBindingId);
    await seedPendingDeliveries(value, session.id, DIRECT_CAPACITY - 1, "unplaced-filler");

    await inbox.ingest(value.imBindingId, 1, event(value, "trigger", DIRECT_CAPACITY + 1));

    await passCompleted.promise;
    expect(beforeOverflowExpiry).toHaveBeenCalledTimes(1);
    // Unknown placement is conservative: nothing is counted or deleted.
    expect(await pendingDeliveryCount(session.id)).toBe(DIRECT_CAPACITY + 1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps a Cloud row that became dispatched before the queued pass deletes it", async () => {
    const value = await inboxFixture("dispatch-race");
    const logger = { error: vi.fn() };
    const passCompleted = deferred<void>();
    let firstDeliveryId: string | undefined;
    const beforeOverflowExpiry = vi.fn(async () => {
      // The oldest prunable row becomes a dispatched execution window between the count and the
      // delete; the delete must re-evaluate and leave it alone.
      if (!firstDeliveryId) return;
      const dispatchRequestId = randomUUID();
      await unit.database
        .update(imMessageDeliveries)
        .set({
          dispatchRequestId,
          dispatchInputHash: "race-dispatch-hash",
          dispatchPayload: { deliveryId: firstDeliveryId, requestId: dispatchRequestId } as never,
        })
        .where(eq(imMessageDeliveries.id, firstDeliveryId));
    });
    const inbox = new ImMessageInbox(unit.database, {
      beforeOverflowExpiry,
      afterOverflowExpiry: async () => {
        passCompleted.resolve();
      },
      logger,
    });
    const first = await inbox.ingest(value.imBindingId, 1, event(value, "first", 1));
    firstDeliveryId = first.deliveryIds[0];
    const session = await onlySession(value.imBindingId);
    await placeSessionOnCloudComputer(value.accountId, session.id);
    // One extra filler keeps the bucket over capacity even after the oldest row is dispatched.
    const fillerIds = await seedPendingDeliveries(value, session.id, DIRECT_CAPACITY, "race-filler");
    const nextOldestId = fillerIds[0];
    if (!firstDeliveryId || !nextOldestId) throw new Error("Cloud fixture did not create deliveries");

    await inbox.ingest(value.imBindingId, 1, event(value, "trigger", DIRECT_CAPACITY + 1));

    await passCompleted.promise;
    expect(beforeOverflowExpiry).toHaveBeenCalledTimes(1);
    // The now-dispatched row survives; the next-oldest undispatched row is the one pruned.
    expect(await deliveryState(firstDeliveryId)).toMatchObject({ state: "pending", reason: null });
    expect(await deliveryState(nextOldestId)).toMatchObject({ state: "expired", reason: "capacity" });
    expect(await undispatchedPendingCount(session.id)).toBe(DIRECT_CAPACITY);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

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
  const accountId = randomUUID();
  await unit.database
    .insert(users)
    .values({ id: accountId, email: `inbox-${scope}-${randomUUID()}@example.com`, displayName: "Inbox Test Admin" });
  const [computer] = await unit.database
    .insert(computers)
    .values({
      ownerAccountId: accountId,
      currentInstallationId: randomUUID(),
      displayName: "Inbox Test Computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(unit.database).createForAccount(accountId, {
    name: `inbox-test-agent-${scope}`,
    displayName: "Inbox Test Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const identity = {
    appId: `A_UNIT_INBOX_${scope}`,
    teamId: `T_UNIT_INBOX_${scope}`,
    botUserId: `U_UNIT_INBOX_${scope}`,
  };
  const bindingService = new ImBindingService(unit.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => fixedNow,
    imCliReadiness: () => "ready",
    credentialExecutionReadiness: () => ({ status: "ready" }),
  });
  const activated = await bindingService.activateSlack(
    {
      intent: "create",
      agentId: agent.id,
      appId: identity.appId,
      teamId: identity.teamId,
      botUserId: identity.botUserId,
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "xoxb-unit-inbox",
      signingSecret: "unit-inbox-signing-secret",
      installedAt: fixedNow,
    },
    `B_UNIT_INBOX_${scope}`,
  );
  await bindingService.recordSlackIdentityClosure(activated.imBindingId, activated.credentialGeneration);
  return {
    imBindingId: activated.imBindingId,
    accountId,
    computerId: computer.id,
    ...identity,
    channelId: `C_UNIT_INBOX_${scope}`,
  };
}

async function onlySession(imBindingId: string) {
  const [session] = await unit.database.select().from(sessions).where(eq(sessions.imBindingId, imBindingId));
  if (!session) throw new Error("Inbox fixture did not create a session");
  return session;
}

async function placeSessionOnCloudComputer(accountId: string, sessionId: string): Promise<void> {
  const [cloudComputer] = await unit.database
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
  await unit.database
    .update(sessionPlacements)
    .set({ computerId: cloudComputer.id })
    .where(eq(sessionPlacements.sessionId, sessionId));
}

async function seedPendingDeliveries(
  scope: InboxScope,
  sessionId: string,
  count: number,
  prefix: string,
): Promise<string[]> {
  const messages = await unit.database
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
        occurredAt: new Date(fixedNow.getTime() + index + 2),
      })),
    )
    .returning({ id: imMessages.id });
  const deliveries = await unit.database
    .insert(imMessageDeliveries)
    .values(
      messages.map((message) => ({
        messageId: message.id,
        sessionId,
        attention: "direct" as const,
        placementGeneration: 1,
        expiresAt: new Date("2026-08-26T00:00:00.000Z"),
      })),
    )
    .returning({ id: imMessageDeliveries.id });
  return deliveries.map((delivery) => delivery.id);
}

/** Oldest possible rows: one dispatched execution window and one accepted-unreported custody. */
async function seedProtectedDeliveries(scope: InboxScope, sessionId: string) {
  const messages = await unit.database
    .insert(imMessages)
    .values(
      ["dispatched", "accepted"].map((kind) => ({
        imBindingId: scope.imBindingId,
        providerEventId: `protected-${kind}-${randomUUID()}`,
        channelId: scope.channelId,
        externalMessageId: `protected-${kind}-message`,
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
          fallbackText: "protected",
          blocks: [{ type: "text" as const, text: "protected" }],
          truncated: false,
        },
        // Older than every prunable filler row.
        occurredAt: new Date(fixedNow.getTime()),
      })),
    )
    .returning({ id: imMessages.id });
  const dispatchRequestId = randomUUID();
  const [dispatched] = await unit.database
    .insert(imMessageDeliveries)
    .values({
      messageId: messages[0]?.id as string,
      sessionId,
      attention: "direct",
      placementGeneration: 1,
      expiresAt: new Date("2026-08-26T00:00:00.000Z"),
      dispatchRequestId,
      dispatchInputHash: "protected-dispatch-hash",
      dispatchPayload: { requestId: dispatchRequestId } as never,
    })
    .returning({ id: imMessageDeliveries.id });
  const [accepted] = await unit.database
    .insert(imMessageDeliveries)
    .values({
      messageId: messages[1]?.id as string,
      sessionId,
      attention: "direct",
      placementGeneration: 1,
      expiresAt: new Date("2026-08-26T00:00:00.000Z"),
      state: "accepted",
      inputHash: "protected-input-hash",
      turnId: "protected-turn",
      reportOwnerInstanceId: randomUUID(),
      acceptedAt: fixedNow,
    })
    .returning({ id: imMessageDeliveries.id });
  if (!dispatched || !accepted) throw new Error("Protected fixture rows were not created");
  return { dispatchedDeliveryId: dispatched.id, acceptedDeliveryId: accepted.id };
}

async function deliveryState(deliveryId: string) {
  const [row] = await unit.database
    .select({ state: imMessageDeliveries.state, reason: imMessageDeliveries.reason })
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, deliveryId));
  return row;
}

async function pendingDeliveryCount(sessionId: string) {
  const [row] = await unit.database
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

async function undispatchedPendingCount(sessionId: string) {
  const [row] = await unit.database
    .select({ count: count() })
    .from(imMessageDeliveries)
    .where(
      and(
        eq(imMessageDeliveries.sessionId, sessionId),
        eq(imMessageDeliveries.attention, "direct"),
        eq(imMessageDeliveries.state, "pending"),
        isNull(imMessageDeliveries.reason),
        isNull(imMessageDeliveries.dispatchRequestId),
      ),
    );
  return row?.count ?? 0;
}

async function expiredCount(sessionId: string) {
  const [row] = await unit.database
    .select({ count: count() })
    .from(imMessageDeliveries)
    .where(
      and(
        eq(imMessageDeliveries.sessionId, sessionId),
        eq(imMessageDeliveries.state, "expired"),
        eq(imMessageDeliveries.reason, "capacity"),
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
      externalId: `unit-message-${eventSuffix}`,
      revisionKey: "1",
      operation: "created",
      threadKey: null,
      replyToExternalId: null,
      author: { externalId: "U_HUMAN", kind: "human", displayName: "Human" },
      occurredAt: new Date(fixedNow.getTime() + millisecondsAfterEpoch),
      content: {
        version: 1,
        fallbackText: "unit inbox event",
        blocks: [{ type: "text", text: "unit inbox event" }],
        truncated: false,
      },
      resources: [],
    },
    mentions: [{ externalId: scope.botUserId, displayName: "Inbox Test Agent" }],
  };
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
