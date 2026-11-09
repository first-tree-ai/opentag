import type { NormalizedInboundImEvent } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imBindings, imMessageDeliveries, imMessages } from "../../db/schema/index.js";
import { ImMessageInbox } from "../../services/im/im-message-inbox.js";
import { createFixture } from "./im-recovery-locks-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

describe("pending IM queue concurrency", () => {
  let database: MigratedTestDatabase;
  let first: ReturnType<typeof createDatabaseClient>;
  let second: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    database = await startMigratedTestDatabase();
    first = createDatabaseClient(database.databaseUrl);
    second = createDatabaseClient(database.databaseUrl);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([first?.sql.end(), second?.sql.end()]);
    await database?.stop();
  });
  beforeEach(async () => database.reset());

  it("serializes concurrent repeated input on the shared custody fence", async () => {
    const fixture = await createFixture(first.database);
    const [binding] = await first.database.select().from(imBindings);
    if (!binding) throw new Error("missing binding");
    const paused = barrier();
    const release = barrier();
    const inbox = new ImMessageInbox(first.database, {
      now: () => fixture.now,
      afterMessageAuthority: async () => {
        paused.resolve();
        await release.promise;
      },
    });
    const following = vi.fn(async () => undefined);
    const otherInbox = new ImMessageInbox(second.database, {
      now: () => fixture.now,
      afterMessageAuthority: following,
    });
    const initial = inbox.ingest(binding.id, 1, event("first", fixture.now));
    let repeated: ReturnType<ImMessageInbox["ingest"]> | undefined;
    try {
      await paused.promise;
      repeated = otherInbox.ingest(binding.id, 1, event("second", new Date(fixture.now.getTime() + 1)));
      const [probe] = await second.database.transaction((transaction) =>
        transaction.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`im-agent-custody:${fixture.agentId}`}, 0)) as acquired`,
        ),
      );
      expect(probe?.acquired).toBe(false);
      expect(following).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect((await initial).deliveryIds).toHaveLength(1);
    expect((await repeated)?.deliveryIds).toEqual([]);
    const rows = await first.database.select().from(imMessageDeliveries);
    expect(rows.filter((row) => row.reason === "duplicate_pending")).toHaveLength(1);
    expect(await first.database.select().from(imMessages)).toHaveLength(5);
  });

  it("does not suppress a repeat when a concurrent worker claims its predecessor", async () => {
    const fixture = await createFixture(first.database);
    const [binding] = await first.database.select().from(imBindings);
    if (!binding) throw new Error("missing binding");
    const inbox = new ImMessageInbox(first.database, { now: () => fixture.now });
    const initial = await inbox.ingest(binding.id, 1, event("first", fixture.now));
    const deliveryId = initial.deliveryIds[0];
    if (!deliveryId) throw new Error("missing initial delivery");
    const paused = barrier();
    const release = barrier();
    const claim = first.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`im-agent-custody:${fixture.agentId}`}, 0))`,
      );
      await transaction
        .update(imMessageDeliveries)
        .set({ lastErrorCode: "IM_DELIVERY_CLAIM_ACTIVE" })
        .where(eq(imMessageDeliveries.id, deliveryId));
      paused.resolve();
      await release.promise;
    });
    const other = new ImMessageInbox(second.database, { now: () => fixture.now });
    let next: ReturnType<ImMessageInbox["ingest"]> | undefined;
    try {
      await paused.promise;
      next = other.ingest(binding.id, 1, event("second", new Date(fixture.now.getTime() + 1)));
    } finally {
      release.resolve();
    }
    await claim;
    expect((await next)?.deliveryIds).toHaveLength(1);
    expect(
      (await first.database.select().from(imMessageDeliveries)).filter((row) => row.reason === "duplicate_pending"),
    ).toEqual([]);
  });

  it("rechecks a claimed row after an overflow UPDATE waits on its row lock", async () => {
    const fixture = await createFixture(first.database);
    const [binding] = await first.database.select().from(imBindings);
    if (!binding) throw new Error("missing binding");
    const messages = await first.database
      .insert(imMessages)
      .values(
        Array.from({ length: 98 }, (_, index) => ({
          imBindingId: binding.id,
          channelId: "channel",
          externalMessageId: `filler-${index}`,
          providerRevisionKey: "1",
          operation: "created" as const,
          direction: "inbound" as const,
          authorKind: "human" as const,
          authorExternalId: "human",
          providerContext: { provider: "feishu" as const },
          content: { version: 1 as const, fallbackText: `filler-${index}`, blocks: [], truncated: false },
          occurredAt: new Date(fixture.now.getTime() + 100 + index),
        })),
      )
      .returning({ id: imMessages.id });
    await first.database.insert(imMessageDeliveries).values(
      messages.map((message) => ({
        messageId: message.id,
        sessionId: fixture.sessionId,
        attention: "ambient" as const,
        placementGeneration: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    );
    const ready = barrier();
    const startExpiry = barrier();
    const completed = barrier();
    const inbox = new ImMessageInbox(first.database, {
      now: () => new Date(),
      beforeOverflowExpiry: async () => {
        ready.resolve();
        await startExpiry.promise;
      },
      afterOverflowExpiry: async () => completed.resolve(),
    });
    await inbox.ingest(binding.id, 1, event("trigger", new Date(fixture.now.getTime() + 1_000)));
    await ready.promise;
    const claimed = barrier();
    const commitClaim = barrier();
    const claim = second.database.transaction(async (transaction) => {
      await transaction
        .update(imMessageDeliveries)
        .set({ lastErrorCode: "IM_DELIVERY_CLAIM_ACTIVE" })
        .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      claimed.resolve();
      await commitClaim.promise;
    });
    try {
      await claimed.promise;
      startExpiry.resolve();
      await expect
        .poll(async () => {
          const [row] = await second.database.execute(
            sql`select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and position('with overflow' in query) > 0`,
          );
          return row?.waiting;
        })
        .toBe(1);
    } finally {
      commitClaim.resolve();
      startExpiry.resolve();
    }
    await claim;
    await completed.promise;
    const rows = await first.database.select().from(imMessageDeliveries);
    expect(rows.find((row) => row.id === fixture.rootDeliveryId)).toMatchObject({
      state: "pending",
      reason: null,
      lastErrorCode: "IM_DELIVERY_CLAIM_ACTIVE",
    });
    expect(rows.filter((row) => row.reason === "capacity")).toHaveLength(2);
    expect(rows.filter((row) => row.state === "pending" && row.lastErrorCode === null)).toHaveLength(99);
  });
});

function event(id: string, occurredAt: Date): NormalizedInboundImEvent {
  return {
    providerEventId: id,
    externalAppId: "app",
    externalTeamId: "team",
    providerContext: { provider: "feishu" },
    conversation: { externalId: "channel", kind: "channel" },
    message: {
      externalId: `message-${id}`,
      revisionKey: "1",
      operation: "created",
      author: { externalId: "human", kind: "human" },
      occurredAt: new Date(occurredAt.getTime() + 10_000),
      content: {
        version: 1,
        fallbackText: "repeat this instruction",
        blocks: [{ type: "text", text: "repeat this instruction" }],
        truncated: false,
      },
      resources: [],
    },
    mentions: [{ externalId: "bot", displayName: null }],
  };
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
