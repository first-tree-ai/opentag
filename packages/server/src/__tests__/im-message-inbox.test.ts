import { type NormalizedInboundImEvent, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { computers, imMessageDeliveries, imMessages, sessions } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImMessageInbox } from "../services/im/index.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const fixedNow = new Date("2026-08-19T00:00:00.000Z");
let unitDatabase: UnitDatabase;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unitDatabase?.close();
});

beforeEach(async () => {
  await unitDatabase.reset();
});

describe("ImMessageInbox overflow scheduling", () => {
  it("runs one post-commit pass and de-duplicates a queued session pass", async () => {
    const value = await inboxFixture();
    const gate = deferred<void>();
    const passStarted = deferred<void>();
    const beforeOverflowExpiry = vi.fn(async () => {
      passStarted.resolve(undefined);
      await gate.promise;
    });
    const inbox = new ImMessageInbox(unitDatabase.database, { beforeOverflowExpiry });

    try {
      const first = await inbox.ingest(value.imBindingId, 1, event("unit-overflow-first", 1));
      const firstDeliveryId = first.deliveryIds[0];
      if (!firstDeliveryId) throw new Error("Overflow fixture did not create the first delivery");
      const [session] = await unitDatabase.database.select().from(sessions);
      if (!session) throw new Error("Overflow fixture did not create a session");
      await seedPendingDeliveries(value.imBindingId, session.id, 99, "unit-overflow-filler");

      await inbox.ingest(value.imBindingId, 1, event("unit-overflow-second", 102));
      await passStarted.promise;
      await inbox.ingest(value.imBindingId, 1, event("unit-overflow-third", 103));

      expect(beforeOverflowExpiry).toHaveBeenCalledTimes(1);
      gate.resolve(undefined);
      await expect.poll(() => deliveryState(firstDeliveryId)).toBe("expired");
    } finally {
      gate.resolve(undefined);
    }
  });

  it("logs a failed pass, clears its key, and retries on the next overflow", async () => {
    const value = await inboxFixture();
    let attempts = 0;
    const logger = { error: vi.fn() };
    const beforeOverflowExpiry = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("unit overflow failure");
    });
    const inbox = new ImMessageInbox(unitDatabase.database, { beforeOverflowExpiry, logger });

    const first = await inbox.ingest(value.imBindingId, 1, event("unit-failure-first", 1));
    const firstDeliveryId = first.deliveryIds[0];
    if (!firstDeliveryId) throw new Error("Failure fixture did not create the first delivery");
    const [session] = await unitDatabase.database.select().from(sessions);
    if (!session) throw new Error("Failure fixture did not create a session");
    await seedPendingDeliveries(value.imBindingId, session.id, 99, "unit-failure-filler");

    await inbox.ingest(value.imBindingId, 1, event("unit-failure-second", 102));
    await expect.poll(() => logger.error.mock.calls.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ attention: "direct", sessionId: session.id, err: expect.any(Error) }),
      "IM message inbox overflow expiry failed",
    );

    await inbox.ingest(value.imBindingId, 1, event("unit-failure-third", 103));
    await expect.poll(() => beforeOverflowExpiry.mock.calls.length).toBe(2);
    await expect.poll(() => deliveryState(firstDeliveryId)).toBe("expired");
  });

  it.each([
    { attention: "direct" as const, capacity: 100 },
    { attention: "ambient" as const, capacity: 500 },
  ])("rechecks $attention overflow after a delayed cleanup commit acknowledgement", async ({ attention, capacity }) => {
    const value = await inboxFixture();
    const delayed = delayTransactionCompletion(unitDatabase.database);
    const beforeOverflowExpiry = vi.fn(async () => {
      if (beforeOverflowExpiry.mock.calls.length === 1) delayed.arm();
    });
    const inbox = new ImMessageInbox(delayed.database, { beforeOverflowExpiry });

    try {
      await inbox.ingest(value.imBindingId, 1, event("late-overflow-first", 1, attention));
      const [session] = await unitDatabase.database.select().from(sessions);
      if (!session) throw new Error("Delayed completion fixture did not create a session");
      await seedPendingDeliveries(value.imBindingId, session.id, capacity - 1, "late-overflow-filler", attention);

      await inbox.ingest(value.imBindingId, 1, event("late-overflow-trigger", capacity + 1, attention));
      await delayed.committed;
      expect(await pendingDeliveryCount(session.id, attention)).toBe(capacity);

      const late = await inbox.ingest(value.imBindingId, 1, event("late-overflow-next", capacity + 2, attention));
      expect(late.deliveryIds).toHaveLength(1);
      expect(await pendingDeliveryCount(session.id, attention)).toBe(capacity + 1);
      expect(beforeOverflowExpiry).toHaveBeenCalledTimes(1);

      await inbox.ingest(value.imBindingId, 1, event("late-overflow-last", capacity + 3, attention));
      expect(beforeOverflowExpiry).toHaveBeenCalledTimes(1);
      delayed.release();

      await expect.poll(() => pendingDeliveryCount(session.id, attention)).toBe(capacity);
      expect(beforeOverflowExpiry).toHaveBeenCalledTimes(2);
      const rows = await unitDatabase.database
        .select({ state: imMessageDeliveries.state, reason: imMessageDeliveries.reason })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.sessionId, session.id));
      expect(rows.filter((row) => row.state === "expired")).toEqual(
        Array.from({ length: 3 }, () => ({ state: "expired", reason: "capacity" })),
      );
      expect(rows.filter((row) => row.state === "pending")).toEqual(
        Array.from({ length: capacity }, () => ({ state: "pending", reason: null })),
      );
    } finally {
      delayed.release();
    }
  });
});

async function inboxFixture() {
  const bootstrap = await bootstrapInitialAdmin(unitDatabase.database, {
    displayName: "Inbox Test Admin",
    email: `inbox-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "Inbox Test Computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(unitDatabase.database).createForAccount(bootstrap.userId, {
    name: "inbox-test-agent",
    displayName: "Inbox Test Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const bindingService = new ImBindingService(unitDatabase.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => fixedNow,
    imCliReadiness: () => "ready",
    credentialExecutionReadiness: () => ({ status: "ready" }),
  });
  const activated = await bindingService.activateSlack(
    {
      intent: "create",
      agentId: agent.id,
      appId: "A_UNIT_INBOX",
      teamId: "T_UNIT_INBOX",
      botUserId: "U_UNIT_INBOX",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "xoxb-unit-inbox",
      signingSecret: "unit-inbox-signing-secret",
      installedAt: fixedNow,
    },
    "B_UNIT_INBOX",
  );
  await bindingService.recordSlackIdentityClosure(activated.imBindingId, activated.credentialGeneration);
  return { imBindingId: activated.imBindingId };
}

async function seedPendingDeliveries(
  imBindingId: string,
  sessionId: string,
  count: number,
  prefix: string,
  attention: "direct" | "ambient" = "direct",
): Promise<void> {
  const messages = await unitDatabase.database
    .insert(imMessages)
    .values(
      Array.from({ length: count }, (_, index) => ({
        imBindingId,
        providerEventId: `${prefix}-${index}`,
        channelId: "C_UNIT_INBOX",
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
  await unitDatabase.database.insert(imMessageDeliveries).values(
    messages.map((message) => ({
      messageId: message.id,
      sessionId,
      attention,
      placementGeneration: 1,
      expiresAt: new Date("2026-08-26T00:00:00.000Z"),
    })),
  );
}

async function deliveryState(deliveryId: string) {
  const [row] = await unitDatabase.database
    .select({ state: imMessageDeliveries.state })
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, deliveryId));
  return row?.state;
}

async function pendingDeliveryCount(sessionId: string, attention: "direct" | "ambient") {
  const [row] = await unitDatabase.database
    .select({ count: count() })
    .from(imMessageDeliveries)
    .where(
      and(
        eq(imMessageDeliveries.sessionId, sessionId),
        eq(imMessageDeliveries.attention, attention),
        eq(imMessageDeliveries.state, "pending"),
        isNull(imMessageDeliveries.reason),
      ),
    );
  return row?.count ?? 0;
}

function event(
  providerEventId: string,
  millisecondsAfterEpoch: number,
  attention: "direct" | "ambient" = "direct",
): NormalizedInboundImEvent {
  return {
    providerEventId,
    externalAppId: "A_UNIT_INBOX",
    externalTeamId: "T_UNIT_INBOX",
    providerContext: { provider: "slack", channelType: "channel" },
    conversation: { externalId: "C_UNIT_INBOX", kind: "channel" },
    message: {
      externalId: `unit-message-${providerEventId}`,
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
    mentions: attention === "direct" ? [{ externalId: "U_UNIT_INBOX", displayName: "Inbox Test Agent" }] : [],
  };
}

function delayTransactionCompletion(database: DatabaseClient) {
  const committed = deferred<void>();
  const release = deferred<void>();
  let armed = false;
  const delayedDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) => {
        const delayCompletion = armed;
        armed = false;
        const result = await target.transaction(callback);
        if (delayCompletion) {
          // The real transaction has committed; only its acknowledgement remains blocked.
          committed.resolve(undefined);
          await release.promise;
        }
        return result;
      };
    },
  });
  return {
    database: delayedDatabase,
    arm: () => {
      armed = true;
    },
    committed: committed.promise,
    release: () => release.resolve(undefined),
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
