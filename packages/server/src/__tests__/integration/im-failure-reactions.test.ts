import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imMessageDeliveries } from "../../db/schema/index.js";
import { runImDeliveryExpiry } from "../../runtime/im-delivery-janitor.js";
import { createFailureReactionFixture } from "../support/failure-reaction-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
}, 120_000);
afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

it("keeps a single-connection pool available while an expiry reaction call is blocked", async () => {
  const clock = new Date(),
    h = await createFailureReactionFixture(client.database, () => clock);
  const deliveries = await Promise.all(Array.from({ length: 8 }, () => h.delivery()));
  for (const { frame } of deliveries) {
    await client.database
      .update(imMessageDeliveries)
      .set({
        state: "pending",
        inputHash: null,
        turnId: null,
        reportOwnerInstanceId: null,
        acceptedAt: null,
        expiresAt: clock,
      })
      .where(eq(imMessageDeliveries.id, frame.deliveryId));
  }
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    peak = 0;
  h.setFailureReaction.mockImplementation(async () => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await gate;
    } finally {
      active -= 1;
    }
  });
  try {
    await runImDeliveryExpiry(
      client.database,
      {
        clock: () => clock,
        expiryBatchSize: 100,
        retentionBatchSize: 100,
        imMessagesRetentionMs: 1,
        imMessageDeliveriesRetentionMs: 1,
        slackWebhookReceiptsRetentionMs: 1,
        feishuInboundReceiptsRetentionMs: 1,
      },
      (id) => h.reactions.notify(id),
    );
    await expect.poll(() => active).toBe(1);
    const jobs = deliveries.map(({ frame }) => h.reactions.sync(frame.deliveryId));
    // The reaction call remains blocked, so a query can finish only if it released the connection.
    await expect(client.sql`select 1 as available`).resolves.toMatchObject([{ available: 1 }]);
    release();
    await Promise.all(jobs);
    expect(peak).toBe(1);
    expect(h.setFailureReaction).toHaveBeenCalledTimes(deliveries.length);
  } finally {
    release();
    await h.reactions.close();
  }
}, 10_000);
