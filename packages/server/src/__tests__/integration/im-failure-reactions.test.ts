import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imFailureReactions, imMessages } from "../../db/schema/index.js";
import { createFailureReactionFixture } from "../support/failure-reaction-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let clock = new Date();
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
  clock = new Date();
});

it("durably clears a failed message after a later successful revision on PostgreSQL", async () => {
  const h = await createFailureReactionFixture(client.database, () => clock);
  const failed = await h.delivery();
  await h.report(failed.frame, "failed");
  await h.worker.runOnce();
  clock = new Date(clock.getTime() + 1_000);
  const retry = await h.delivery();
  await client.database
    .update(imMessages)
    .set({ externalMessageId: failed.request.imMessageId, providerRevisionKey: "2", operation: "edited" })
    .where(eq(imMessages.id, retry.request.imMessageId));
  await h.report(retry.frame, "completed");
  await h.worker.runOnce();
  expect(h.setFailureReaction.mock.calls.map(([input]) => input.failed)).toEqual([true, false]);
  const [target] = await client.database.select().from(imFailureReactions);
  expect(target).toMatchObject({ desired: false, applied: false });
});

it("lets concurrent workers claim a message only once", async () => {
  const h = await createFailureReactionFixture(client.database, () => clock),
    delivery = await h.delivery();
  await h.report(delivery.frame, "failed");
  await h.store.reconcile();
  const claims = await Promise.all([h.store.claim(), h.store.claim()]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claimed = claims.find(Boolean);
  if (!claimed) throw new Error("missing claim");
  expect(await h.store.ownsClaim(claimed)).toBe(true);
});
