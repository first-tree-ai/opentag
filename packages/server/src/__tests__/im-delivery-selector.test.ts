import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, computers, imMessageDeliveries } from "../db/schema/index.js";
import { ImDeliverySelector, lockEligibleDelivery } from "../runtime/im-delivery-selector.js";
import { type DeliveryCursor, deliveryCandidatePage, readDeliveryCustody } from "../runtime/im-delivery-work-query.js";
import { deliveryTestId, seedDeliveryQuery } from "./support/im-delivery-query-fixture.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
beforeEach(async () => unit.reset());
afterAll(async () => unit?.close());

describe("indexed delivery selection", () => {
  it("continues after eight fully blocked pages instead of starving the independent Agent", async () => {
    const fixture = await seedDeliveryQuery(unit.database, 0, 1100);
    const selector = new ImDeliverySelector(unit.database);
    expect((await selector.candidates(new Date()).next()).done).toBe(true);
    const next = await selector.candidates(new Date()).next();
    expect(next.value?.row.id).toBe(fixture.deliveryId);
  });

  it("preserves microsecond cursors without skipping or repeating tied timestamps", async () => {
    await seedDeliveryQuery(unit.database, 0, 40);
    await unit.database.execute(sql`update im_message_deliveries set next_attempt_at=(
      select next_attempt_at from im_message_deliveries where id=${deliveryTestId("delivery", 1)})
      where id=${deliveryTestId("delivery", 2)}`);
    const now = new Date();
    const expected = await deliveryCandidatePage(unit.database, now, undefined, undefined, 100);
    const ids: string[] = [];
    let cursor: DeliveryCursor | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await deliveryCandidatePage(unit.database, now, cursor, undefined, 7);
      ids.push(...rows.map((row) => row.id));
      const last = rows.at(-1);
      if (!last || rows.length < 7) break;
      cursor = { time: last.cursorTime, id: last.id };
    }
    expect(ids).toEqual(expected.map((row) => row.id));
    expect(new Set(ids).size).toBe(41);
  });

  it("rechecks suspension after cached selection and repairs the hint at TTL or invalidation", async () => {
    const fixture = await seedDeliveryQuery(unit.database);
    const selector = new ImDeliverySelector(unit.database);
    const now = new Date();
    expect((await selector.candidates(now).next()).value?.row.id).toBe(fixture.deliveryId);
    await unit.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
    expect((await selector.candidates(now).next()).value?.row.id).toBe(fixture.deliveryId);
    expect(
      await unit.database.transaction((tx) => lockEligibleDelivery(tx, fixture.deliveryId, fixture.agentId, now)),
    ).toBeUndefined();
    expect((await selector.candidates(new Date(+now + 5001)).next()).done).toBe(true);
    await unit.database.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));
    selector.invalidate(fixture.sessionId);
    expect((await selector.candidates(new Date(+now + 5002)).next()).value?.row.id).toBe(fixture.deliveryId);
  });

  it("does not claim a cancelled row selected before cancellation", async () => {
    const fixture = await seedDeliveryQuery(unit.database);
    const selected = await new ImDeliverySelector(unit.database).candidates(new Date()).next();
    expect(selected.value?.row.id).toBe(fixture.deliveryId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ state: "expired", reason: "cancelled" })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(
      await unit.database.transaction((tx) =>
        lockEligibleDelivery(tx, fixture.deliveryId, fixture.agentId, new Date()),
      ),
    ).toBeUndefined();
  });

  it("rejects an unexpected Agent identity instead of claiming under the wrong advisory lock", async () => {
    const fixture = await seedDeliveryQuery(unit.database);
    expect(
      await unit.database.transaction((tx) =>
        lockEligibleDelivery(tx, fixture.deliveryId, deliveryTestId("agent", 0), new Date()),
      ),
    ).toBeUndefined();
  });

  it("observes released custody on the next scan without waiting for metadata TTL", async () => {
    const fixture = await seedDeliveryQuery(unit.database, 0, 1);
    const selector = new ImDeliverySelector(unit.database);
    expect((await selector.candidates(new Date()).next()).value?.row.id).toBe(fixture.deliveryId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ state: "expired", reason: "cancelled" })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: null })
      .where(eq(imMessageDeliveries.id, fixture.occupantId));
    expect((await selector.candidates(new Date()).next()).value?.row.id).toBe(deliveryTestId("delivery", 1));
  });

  it("keeps a reason-bearing pending claim in the work set and custody fence", async () => {
    const fixture = await seedDeliveryQuery(unit.database, 0, 1);
    await unit.database
      .update(imMessageDeliveries)
      .set({ reason: "blocked" })
      .where(eq(imMessageDeliveries.id, fixture.occupantId));
    expect((await readDeliveryCustody(unit.database)).map((row) => row.id)).toContain(fixture.occupantId);
    expect((await new ImDeliverySelector(unit.database).candidates(new Date()).next()).value?.row.id).toBe(
      fixture.deliveryId,
    );
  });

  it("preserves targeted ready eligibility and excludes unrelated errors", async () => {
    const fixture = await seedDeliveryQuery(unit.database);
    const selector = new ImDeliverySelector(unit.database);
    expect((await selector.candidates(new Date(), fixture.sessionId).next()).done).toBe(true);
    await unit.database.update(computers).set({ kind: "cloud" }).where(eq(computers.id, fixture.computerId));
    selector.invalidate(fixture.sessionId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: "IM_DELIVERY_RUNTIME_FAILED" })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect((await selector.candidates(new Date(), fixture.sessionId).next()).done).toBe(true);
    await unit.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: null })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect((await selector.candidates(new Date(), fixture.sessionId).next()).value?.row.id).toBe(fixture.deliveryId);
  });

  it("finds newly due input after the previous sweep's cursor and time boundary", async () => {
    const fixture = await seedDeliveryQuery(unit.database);
    const selector = new ImDeliverySelector(unit.database);
    const now = new Date();
    expect((await selector.candidates(now).next()).value?.row.id).toBe(fixture.deliveryId);
    await unit.database.execute(
      sql`update im_message_deliveries set next_attempt_at=${new Date(+now + 10)} where id=${fixture.deliveryId}`,
    );
    expect((await selector.candidates(new Date(+now + 20)).next()).value?.row.id).toBe(fixture.deliveryId);
  });
});
