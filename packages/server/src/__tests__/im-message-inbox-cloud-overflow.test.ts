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

describe("ImMessageInbox Cloud overflow retention", () => {
  it("retains every Cloud-placed pending delivery beyond capacity while the Local bucket prunes as before", async () => {
    const cloud = await inboxFixture("cloud");
    const local = await inboxFixture("local");
    const cloudLogger = { error: vi.fn() };
    const localLogger = { error: vi.fn() };
    const cloudBeforeOverflowExpiry = vi.fn();
    const localBeforeOverflowExpiry = vi.fn();
    const localPassCompleted = deferred<void>();
    const cloudInbox = new ImMessageInbox(unit.database, {
      beforeOverflowExpiry: cloudBeforeOverflowExpiry,
      logger: cloudLogger,
    });
    const localInbox = new ImMessageInbox(unit.database, {
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
    const localRows = await unit.database
      .select({ state: imMessageDeliveries.state, reason: imMessageDeliveries.reason })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.sessionId, localSession.id));
    expect(localRows.filter((row) => row.state === "expired")).toEqual([{ state: "expired", reason: "capacity" }]);
    const localFirstDeliveryId = localFirst.deliveryIds[0];
    if (!localFirstDeliveryId) throw new Error("Local fixture did not create the first delivery");
    expect(await deliveryState(localFirstDeliveryId)).toBe("expired");

    expect(cloudBeforeOverflowExpiry).not.toHaveBeenCalled();
    expect(await pendingDeliveryCount(cloudSession.id)).toBe(DIRECT_CAPACITY + 1);
    const cloudFirstDeliveryId = cloudFirst.deliveryIds[0];
    if (!cloudFirstDeliveryId) throw new Error("Cloud fixture did not create the first delivery");
    expect(await deliveryState(cloudFirstDeliveryId)).toBe("pending");

    await cloudInbox.ingest(cloud.imBindingId, 1, event(cloud, "next", DIRECT_CAPACITY + 2));
    expect(cloudBeforeOverflowExpiry).not.toHaveBeenCalled();
    expect(await pendingDeliveryCount(cloudSession.id)).toBe(DIRECT_CAPACITY + 2);
    expect(cloudLogger.error).not.toHaveBeenCalled();
    expect(localLogger.error).not.toHaveBeenCalled();
  });

  it("keeps a bucket whose placement turns Cloud before the queued overflow pass runs", async () => {
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

    await inbox.ingest(value.imBindingId, 1, event(value, "first", 1));
    const session = await onlySession(value.imBindingId);
    await seedPendingDeliveries(value, session.id, DIRECT_CAPACITY - 1, "flip-filler");

    await inbox.ingest(value.imBindingId, 1, event(value, "trigger", DIRECT_CAPACITY + 1));

    await passCompleted.promise;
    expect(beforeOverflowExpiry).toHaveBeenCalledTimes(1);
    expect(await pendingDeliveryCount(session.id)).toBe(DIRECT_CAPACITY + 1);
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
    expect(await pendingDeliveryCount(session.id)).toBe(DIRECT_CAPACITY + 1);
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

async function seedPendingDeliveries(scope: InboxScope, sessionId: string, count: number, prefix: string) {
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
  await unit.database.insert(imMessageDeliveries).values(
    messages.map((message) => ({
      messageId: message.id,
      sessionId,
      attention: "direct" as const,
      placementGeneration: 1,
      expiresAt: new Date("2026-08-26T00:00:00.000Z"),
    })),
  );
}

async function deliveryState(deliveryId: string) {
  const [row] = await unit.database
    .select({ state: imMessageDeliveries.state })
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, deliveryId));
  return row?.state;
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
