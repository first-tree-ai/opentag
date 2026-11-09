import { randomUUID } from "node:crypto";
import type { NormalizedInboundImEvent } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imMessageDeliveries, imMessages } from "../../db/schema/index.js";
import { runImDeliveryExpiry } from "../../runtime/im-delivery-janitor.js";
import { ImMessageInbox } from "../../services/im/im-message-inbox.js";
import { repeatsPendingInput } from "../../services/im/im-queue-policy.js";
import { createFailureReactionFixture } from "../support/failure-reaction-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);
beforeEach(async () => testDatabase.reset());
afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

async function pendingInputs(size: number) {
  const now = new Date();
  const fixture = await createFailureReactionFixture(client.database, () => now);
  const entries = await Promise.all(Array.from({ length: size }, () => fixture.delivery()));
  await client.database.update(imMessageDeliveries).set({
    state: "pending",
    inputHash: null,
    turnId: null,
    reportOwnerInstanceId: null,
    acceptedAt: null,
    dispatchRequestId: null,
    dispatchInputHash: null,
    dispatchPayload: null,
  });
  return { ...fixture, entries, now };
}

function inbound(): NormalizedInboundImEvent {
  const id = randomUUID();
  return {
    providerEventId: id,
    externalAppId: "A1",
    externalTeamId: "T1",
    providerContext: { provider: "slack", channelType: "channel" },
    conversation: { externalId: "C1", kind: "channel" },
    message: {
      externalId: id,
      revisionKey: "1",
      operation: "created",
      threadKey: null,
      replyToExternalId: null,
      author: { externalId: "U2", kind: "human", displayName: "Human" },
      occurredAt: new Date(),
      content: { version: 1, fallbackText: id, blocks: [{ type: "text", text: id }], truncated: false },
      resources: [],
    },
    mentions: [{ externalId: "U1", displayName: "Agent" }],
  };
}

it("uses the UUID predecessor when provider timestamp and revision keys are equal", async () => {
  const h = await pendingInputs(3);
  try {
    const ordered = h.entries.toSorted((a, b) => a.request.imMessageId.localeCompare(b.request.imMessageId));
    const currentId = ordered[1]?.request.imMessageId;
    const successorId = ordered[2]?.request.imMessageId;
    if (!currentId || !successorId) throw new Error("missing tied inputs");
    await client.database
      .update(imMessages)
      .set({ content: { version: 1, fallbackText: "different", blocks: [], truncated: false } })
      .where(eq(imMessages.id, successorId));
    const [current] = await client.database.select().from(imMessages).where(eq(imMessages.id, currentId));
    if (!current) throw new Error("missing current input");
    expect(
      await client.database.transaction((transaction) =>
        repeatsPendingInput(transaction, current, h.sessionId, "direct", new Date()),
      ),
    ).toBe(true);
  } finally {
    await h.reactions.close();
  }
});

it.each([9, 10])(
  "counts only %s live inputs for backlog feedback and ignores the overdue target",
  async (liveCount) => {
    const h = await pendingInputs(liveCount + 1);
    try {
      const overdue = h.entries[0];
      const live = h.entries[1];
      if (!overdue || !live) throw new Error("missing inputs");
      await client.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, overdue.frame.deliveryId));
      await h.reactions.sync(live.frame.deliveryId);
      expect(h.setFailureReaction).toHaveBeenCalledTimes(liveCount === 10 ? 1 : 0);
      h.setFailureReaction.mockClear();
      await h.reactions.sync(overdue.frame.deliveryId);
      expect(h.setFailureReaction).not.toHaveBeenCalled();
    } finally {
      await h.reactions.close();
    }
  },
);

it.each([false, true])(
  "retains 99 live inputs without relabelling an overdue pending row (newer provider timestamp=%s)",
  async (newerTimestamp) => {
    const h = await pendingInputs(100);
    const overdue = h.entries[0];
    if (!overdue) throw new Error("missing overdue input");
    const changed = vi.fn();
    try {
      await client.database
        .update(imMessages)
        .set({ occurredAt: new Date(h.now.getTime() + (newerTimestamp ? 3_600_000 : -3_600_000)) })
        .where(eq(imMessages.id, overdue.request.imMessageId));
      await client.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, overdue.frame.deliveryId));
      const inbox = new ImMessageInbox(client.database, { onDeliveryChanged: changed });
      await inbox.ingest(h.binding.id, 1, inbound());
      await expect
        .poll(
          async () =>
            (await client.database.select().from(imMessageDeliveries)).filter((d) => d.reason === "capacity").length,
        )
        .toBeGreaterThan(0);
      const rows = await client.database.select().from(imMessageDeliveries);
      expect(rows.find((d) => d.id === overdue.frame.deliveryId)).toMatchObject({ state: "pending", reason: null });
      expect(rows.filter((d) => d.reason === "capacity")).toHaveLength(1);
      expect(rows.filter((d) => d.state === "pending" && d.expiresAt > h.now)).toHaveLength(99);
      await runImDeliveryExpiry(client.database, {
        clock: () => new Date(),
        expiryBatchSize: 100,
        retentionBatchSize: 100,
        imMessagesRetentionMs: 86_400_000,
        imMessageDeliveriesRetentionMs: 86_400_000,
        slackWebhookReceiptsRetentionMs: 86_400_000,
        feishuInboundReceiptsRetentionMs: 86_400_000,
      });
      expect(
        (
          await client.database
            .select()
            .from(imMessageDeliveries)
            .where(eq(imMessageDeliveries.id, overdue.frame.deliveryId))
        )[0],
      ).toMatchObject({ state: "expired", reason: "ttl" });
    } finally {
      await h.reactions.close();
    }
  },
);

it("rechecks the ingress deadline after waiting for the final capacity write lock", async () => {
  const h = await pendingInputs(99);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = () => {};
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const oldest = h.entries[0];
  if (!oldest) throw new Error("missing oldest input");
  await client.database
    .update(imMessages)
    .set({ occurredAt: new Date(0) })
    .where(eq(imMessages.id, oldest.request.imMessageId));
  const write = client.sql.begin(async (transaction) => {
    await transaction`update im_message_deliveries set expires_at = now() - interval '1 second' where id = ${oldest.frame.deliveryId}`;
    locked();
    await gate;
  });
  const settled = vi.fn();
  try {
    await ready;
    const inbox = new ImMessageInbox(client.database, {
      afterOverflowExpiry: async () => {
        settled();
      },
    });
    await inbox.ingest(h.binding.id, 1, inbound());
    await expect
      .poll(async () => {
        const rows = await client.database.execute(sql`select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%with overflow as%'`);
        return (rows as unknown[]).length;
      })
      .toBe(1);
    release();
    await write;
    await expect.poll(() => settled.mock.calls.length).toBe(1);
    expect(
      (
        await client.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, oldest.frame.deliveryId))
      )[0],
    ).toMatchObject({ state: "pending", reason: null });
  } finally {
    release();
    await write;
    await h.reactions.close();
  }
}, 15_000);
