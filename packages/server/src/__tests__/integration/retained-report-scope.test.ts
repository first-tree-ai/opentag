import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeRuntimeImMessageSemanticHash,
  type SessionReconcileRequest,
} from "@opentag/shared";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imBindings, imFeedbackTargets, imMessageDeliveries, sessions } from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { createFixture, turnReport } from "./im-recovery-locks-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 180_000);
beforeEach(async () => pg.reset());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.sql.end({ timeout: 5 })));
});
afterAll(async () => pg?.stop());

async function prepared(rootDeliveryId?: ReturnType<typeof randomUUID>) {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(client);
  const f = await createFixture(client.database, rootDeliveryId);
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const inputHash = computeDirectInputHash(f.rootRequest);
  expect(await custody.beginDeliveryDispatch(f.rootRequest, inputHash, f.dispatchContext)).toBe("dispatched");
  const report = turnReport(f, "completed");
  const request: SessionReconcileRequest = {
    type: "session:reconcile",
    requestId: randomUUID(),
    installationId: f.context.installationId,
    sessionId: f.sessionId,
    agentId: f.agentId,
    placementGeneration: 1,
    desired: "stopped",
  };
  const claim = {
    deliveryId: f.rootDeliveryId,
    dispatchRequestId: f.rootRequest.requestId,
    inputHash,
    turnId: f.rootTurnId,
    placementGeneration: 1,
    resultHash: report.resultHash,
  };
  const read = async () => {
    const [row] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
    assert(row);
    return row;
  };
  return { client, custody, f, request, claim, report, read };
}

it.each(["dispatch", "input", "generation", "agent", "computer", "ended-session"] as const)(
  "rejects a retained claim with mismatched %s authority or identity",
  async (mismatch) => {
    const h = await prepared();
    const claim = { ...h.claim };
    const request = { ...h.request };
    const context = { ...h.f.context };
    if (mismatch === "dispatch") claim.dispatchRequestId = randomUUID();
    if (mismatch === "input") claim.inputHash = "a".repeat(64);
    if (mismatch === "generation") claim.placementGeneration++;
    if (mismatch === "agent") request.agentId = randomUUID();
    if (mismatch === "computer") context.computerId = randomUUID();
    if (mismatch === "ended-session") {
      await h.client.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, h.f.sessionId));
    }
    const before = await h.read();
    await expect(h.custody.claimRetainedReports(request, [claim], context)).resolves.toEqual([]);
    expect(await h.read()).toEqual(before);
  },
);

it("cannot claim another Account's delivery through an owned Session", async () => {
  const owned = await prepared();
  await owned.client.database
    .update(imBindings)
    .set({ externalAppId: randomUUID() })
    .where(eq(imBindings.id, owned.f.bindingId));
  const foreign = await prepared();
  const before = await foreign.read();
  await expect(owned.custody.claimRetainedReports(owned.request, [foreign.claim], owned.f.context)).resolves.toEqual(
    [],
  );
  expect(await foreign.read()).toEqual(before);
  expect((await owned.read()).state).toBe("pending");
});

it.each(["pending", "expired", "accepted"] as const)(
  "restores an unreported %s delivery to a new instance and records its exact report",
  async (state) => {
    const h = await prepared();
    if (state === "expired") {
      await h.client.database
        .update(imMessageDeliveries)
        .set({ state })
        .where(eq(imMessageDeliveries.id, h.f.rootDeliveryId));
    } else if (state === "accepted") {
      expect(await h.custody.acceptDelivery(h.f.rootRequest, h.claim.inputHash, h.f.rootTurnId, h.f.context)).toBe(
        "accepted",
      );
    }
    const context = { ...h.f.context, instanceId: randomUUID() };
    await expect(h.custody.claimRetainedReports(h.request, [h.claim], context)).resolves.toEqual([h.claim]);
    expect(await h.read()).toMatchObject({
      state: "accepted",
      turnId: h.report.turnId,
      reportOwnerInstanceId: context.instanceId,
      resultHash: h.report.resultHash,
      reportedAt: null,
    });
    expect(await h.custody.recordTurn(h.report, h.f.context)).toBeUndefined();
    expect(await h.custody.recordTurn(h.report, context)).toBe("recorded");
    expect(await h.custody.recordTurn(h.report, context)).toBe("already_recorded");
  },
);

it("preserves an existing retained result hash against a competing claim", async () => {
  const h = await prepared();
  await h.custody.claimRetainedReports(h.request, [h.claim], h.f.context);
  const before = await h.read();
  await h.custody.claimRetainedReports(h.request, [{ ...h.claim, resultHash: "b".repeat(64) }], {
    ...h.f.context,
    instanceId: randomUUID(),
  });
  expect(await h.read()).toEqual(before);
});

it("acknowledges an exact terminal replay from a new instance without reclaiming report ownership", async () => {
  const h = await prepared();
  expect(await h.custody.acceptDelivery(h.f.rootRequest, h.claim.inputHash, h.f.rootTurnId, h.f.context)).toBe(
    "accepted",
  );
  expect(await h.custody.recordTurn(h.report, h.f.context)).toBe("recorded");
  const before = await h.read();
  const context = { ...h.f.context, instanceId: randomUUID() };
  const feedback = await h.client.database.select().from(imFeedbackTargets);
  await expect(h.custody.claimRetainedReports(h.request, [h.claim], context)).resolves.toEqual([]);
  expect(await h.custody.recordTurn(h.report, context)).toBe("already_recorded");
  expect(await h.read()).toEqual(before);
  expect(await h.client.database.select().from(imFeedbackTargets)).toEqual(feedback);
});

it.each(["missing", "queued"] as const)(
  "recovers %s feedback without rewriting unchanged delivery fields",
  async (state) => {
    const h = await prepared();
    await h.custody.claimRetainedReports(h.request, [h.claim], h.f.context);
    if (state === "missing") await h.client.database.delete(imFeedbackTargets);
    else await h.client.database.update(imFeedbackTargets).set({ state: "queued", desiredReaction: "none" });
    const before = await h.read();
    await h.custody.claimRetainedReports(h.request, [h.claim], h.f.context);
    expect(await h.read()).toEqual(before);
    const [target] = await h.client.database.select().from(imFeedbackTargets);
    expect(target).toMatchObject({ state: "working", desiredReaction: "working", turnId: h.claim.turnId });
  },
);

it("pins a previously null result hash without changing accepted timestamps", async () => {
  const h = await prepared();
  expect(await h.custody.acceptDelivery(h.f.rootRequest, h.claim.inputHash, h.f.rootTurnId, h.f.context)).toBe(
    "accepted",
  );
  const before = await h.read();
  expect(before.resultHash).toBeNull();
  await h.custody.claimRetainedReports(h.request, [h.claim], h.f.context);
  expect(await h.read()).toMatchObject({
    acceptedAt: before.acceptedAt,
    resultHash: h.claim.resultHash,
    reportedAt: null,
  });
});

it("restores a retained initial batch without promoting its prefetched reserved members to separate Turns", async () => {
  const h = await prepared("00000000-0000-4000-8000-000000000001");
  await h.custody.releaseDeliveryDispatch(h.f.rootRequest, h.claim.inputHash, "retry");
  const request = {
    ...h.f.rootRequest,
    requestId: randomUUID(),
    batch: h.f.steerRequests.map((child) => ({
      deliveryId: child.deliveryId,
      imMessageId: child.imMessageId,
      inputHash: computeRuntimeImMessageSemanticHash(child),
    })),
  };
  const inputHash = computeDirectInputHash(request);
  expect(await h.custody.beginDeliveryDispatch(request, inputHash, h.f.dispatchContext)).toBe("dispatched");
  const member = request.batch[0];
  assert(member);
  await h.custody.claimRetainedReports(
    h.request,
    [
      { ...h.claim, dispatchRequestId: request.requestId, inputHash },
      {
        ...h.claim,
        deliveryId: member.deliveryId,
        dispatchRequestId: request.requestId,
        inputHash: member.inputHash,
        turnId: randomUUID(),
      },
    ],
    h.f.context,
  );
  expect(await h.read()).toMatchObject({ state: "accepted", turnId: h.claim.turnId, resultHash: h.claim.resultHash });
  const children = await h.client.database
    .select()
    .from(imMessageDeliveries)
    .where(
      inArray(
        imMessageDeliveries.id,
        request.batch.map((child) => child.deliveryId),
      ),
    );
  expect(children).toHaveLength(2);
  expect(
    children.every(
      (child) =>
        child.state === "steered" &&
        child.reason === "batch_initial" &&
        child.steerTargetDeliveryId === h.claim.deliveryId &&
        child.turnId === null,
    ),
  ).toBe(true);
  expect(await h.custody.recordTurn(h.report, h.f.context)).toBe("recorded");
});
