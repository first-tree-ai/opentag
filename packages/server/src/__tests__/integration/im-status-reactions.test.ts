import { computeDirectInputHash } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imMessageDeliveries } from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ImStatusReactionWorker } from "../../services/im/im-status-reaction-worker.js";
import { createStatusReactionFixture, statusReactionReport } from "../support/status-reaction-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("status reaction custody concurrency", () => {
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

  it("does not block Turn Reports and reconciles a completion arriving during a reaction", async () => {
    const fixture = await createStatusReactionFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    const hash = computeDirectInputHash(fixture.request);
    await custody.beginDeliveryDispatch(fixture.request, hash, fixture.context);
    await custody.acceptDelivery(fixture.request, hash, "turn-status", fixture.context);
    const entered = deferred();
    const release = deferred();
    const setStatusReaction = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const first = new ImStatusReactionWorker({
      database: client.database,
      resolveAdapter: async () => ({ setStatusReaction }) as never,
      logger: { warn: vi.fn() },
      now: () => fixture.now,
    });
    const otherReaction = vi.fn();
    const second = new ImStatusReactionWorker({
      database: client.database,
      resolveAdapter: async () => ({ setStatusReaction: otherReaction }) as never,
      logger: { warn: vi.fn() },
      now: () => fixture.now,
    });
    const syncing = first.runOnce();
    try {
      await entered.promise;
      let recorded = false;
      const report = custody.recordTurn(statusReactionReport(fixture), fixture.context).then((status) => {
        recorded = true;
        return status;
      });
      await vi.waitFor(() => expect(recorded).toBe(true), { timeout: 2_000 });
      await expect(report).resolves.toBe("recorded");
      await second.runOnce();
      expect(otherReaction).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await syncing;
    }
    await second.runOnce();
    expect(otherReaction).toHaveBeenCalledExactlyOnceWith({
      channelId: "chat",
      messageExternalId: "om_message",
      status: "completed",
    });
    const [delivery] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(delivery).toMatchObject({
      statusReactionDesired: "completed",
      statusReactionApplied: "completed",
      statusReactionRetryAt: null,
    });
  });
});
