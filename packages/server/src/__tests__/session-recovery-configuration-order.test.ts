import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { imMessageDeliveries, sessions } from "../db/schema/index.js";
import { turnReport } from "./integration/im-recovery-locks-fixture.js";
import { acceptNewerTurn, restartedTurn } from "./support/session-recovery-harness.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const DEFERRED = { status: "retry", reason: "older_configuration_recovering" };
const SCHEDULED = { status: "scheduled" };

describe("Session recovery order across configuration revisions", () => {
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

  const legacyClient = () => restartedTurn(unit.database, { current: false });

  it("defers the newer Turn on a Client without the capability until the older one reports", async () => {
    const h = await legacyClient();
    const newer = await acceptNewerTurn(h);

    expect(await h.service.recover(newer, h.context)).toEqual(DEFERRED);
    expect(h.requestReconcile).not.toHaveBeenCalled();

    expect(await h.service.recover(h.frame, h.context)).toEqual(SCHEDULED);
    await h.service.settled();
    expect(h.requestReconcile).toHaveBeenCalledOnce();
    expect(h.requestReconcile.mock.calls[0]?.[2]).toMatchObject({ sessionId: h.frame.sessionId });

    expect(await h.service.recover(newer, h.context)).toEqual(DEFERRED);
    expect(h.requestReconcile).toHaveBeenCalledOnce();

    expect(await h.custody.recordTurn(turnReport(h.f, "completed"), h.context)).toBe("recorded");
    expect(await h.service.recover(newer, h.context)).toEqual(SCHEDULED);
    await h.service.settled();
    expect(h.requestReconcile).toHaveBeenCalledTimes(2);
    expect(h.requestReconcile.mock.calls[1]?.[2]).toMatchObject({ sessionId: newer.sessionId });
  });

  it("recovers in any order on a Client with the capability", async () => {
    const h = await restartedTurn(unit.database);
    const newer = await acceptNewerTurn(h);

    expect(await h.service.recover(newer, h.context)).toEqual(SCHEDULED);
    expect(await h.service.recover(h.frame, h.context)).toEqual(SCHEDULED);
    await h.service.settled();
    expect(h.requestReconcile.mock.calls.map(([, , request]) => request.sessionId)).toEqual([
      newer.sessionId,
      h.frame.sessionId,
    ]);
  });

  it("does not defer between Turns on the same revision", async () => {
    const h = await legacyClient();
    const same = await acceptNewerTurn(h, h.f.runtime.revision.agent.sequence);

    expect(await h.service.recover(same, h.context)).toEqual(SCHEDULED);
    expect(await h.service.recover(h.frame, h.context)).toEqual(SCHEDULED);
  });

  it("does not wait for an older Turn whose Session has ended", async () => {
    const h = await legacyClient();
    const newer = await acceptNewerTurn(h);
    await h.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, h.frame.sessionId));

    expect(await h.service.recover(newer, h.context)).toEqual(SCHEDULED);
  });

  it("does not wait for a Turn whose frozen configuration cannot be read", async () => {
    const h = await legacyClient();
    const newer = await acceptNewerTurn(h);
    await h.database
      .update(imMessageDeliveries)
      .set({ dispatchPayload: { unreadable: true } as never })
      .where(eq(imMessageDeliveries.id, h.frame.deliveryId));

    expect(await h.service.recover(newer, h.context)).toEqual(SCHEDULED);
  });
});
