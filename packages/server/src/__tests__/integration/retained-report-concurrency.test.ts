import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type SessionReconcileRequest,
  type SessionReconcileResult,
} from "@opentag/shared";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  imBindings,
  imFeedbackTargets,
  imMessageDeliveries,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/im-binding-service.js";
import { deferred } from "../support/deferred.js";
import { transferLegacyAgentFixture } from "../support/legacy-agent-fixture.js";
import { createFixture, turnReport } from "./im-recovery-locks-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

type Claim = NonNullable<SessionReconcileResult["retainedReports"]>[number];
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

function actor() {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(client);
  return client;
}

async function prepared() {
  const observer = actor();
  const f = await createFixture(observer.database);
  const custody = new PostgresRuntimeCustodyStore(observer.database);
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
  const claim: Claim = {
    deliveryId: f.rootDeliveryId,
    dispatchRequestId: f.rootRequest.requestId,
    inputHash,
    turnId: f.rootTurnId,
    placementGeneration: 1,
    resultHash: report.resultHash,
  };
  const [agent] = await observer.database.select().from(agents).where(eq(agents.id, f.agentId));
  assert(agent);
  return { observer, f, custody, request, claim, report, accountId: agent.createdByUserId };
}
type Harness = Awaited<ReturnType<typeof prepared>>;

async function sibling(h: Harness): Promise<Claim> {
  const child = h.f.steerRequests[0];
  const direct = {
    ...h.f.rootRequest,
    deliveryId: child.deliveryId,
    imMessageId: child.imMessageId,
    requestId: randomUUID(),
  };
  const inputHash = computeDirectInputHash(direct);
  expect(await h.custody.beginDeliveryDispatch(direct, inputHash, h.f.dispatchContext)).toBe("dispatched");
  const report = { ...h.report, deliveryId: child.deliveryId, turnId: randomUUID() };
  return {
    deliveryId: child.deliveryId,
    turnId: report.turnId,
    dispatchRequestId: direct.requestId,
    inputHash,
    placementGeneration: 1,
    resultHash: computeTurnResultHash(report),
  };
}

async function backend(client: ReturnType<typeof actor>) {
  const [row] = await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  assert(row);
  return row.pid;
}
async function blocked(observer: ReturnType<typeof actor>, waiter: number, blocker: number) {
  await expect
    .poll(
      async () => {
        const [row] = await observer.sql<{ blockers: number[] }[]>`select pg_blocking_pids(${waiter}) as blockers`;
        return row?.blockers;
      },
      { timeout: 3_000, interval: 10 },
    )
    .toContain(blocker);
}
function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

async function startBlockedClaim(h: Harness, claimant: ReturnType<typeof actor>, claims: Claim[] = [h.claim]) {
  const gate = actor();
  const gatePid = await backend(gate),
    pid = await backend(claimant);
  const entered = deferred(),
    release = deferred();
  const holding = gate.database.transaction(async (transaction) => {
    await transaction
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, h.f.sessionId))
      .for("update");
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const result = settle(
    new PostgresRuntimeCustodyStore(claimant.database).claimRetainedReports(h.request, claims, h.f.context),
  );
  const close = async () => {
    release.resolve();
    await Promise.all([holding, result]);
  };
  try {
    await blocked(h.observer, pid, gatePid);
  } catch (error) {
    await close();
    throw error;
  }
  return { pid, result, resume: () => release.resolve(), close };
}

it.each(["same", "conflicting"] as const)("serializes reverse-order manifests with %s hashes", async (hash) => {
  const h = await prepared();
  const other = await sibling(h);
  const first = actor(),
    second = actor();
  const secondPid = await backend(second);
  const parked = await startBlockedClaim(h, first, [h.claim, other]);
  const context = { ...h.f.context, instanceId: randomUUID() };
  const competing = settle(
    new PostgresRuntimeCustodyStore(second.database).claimRetainedReports(
      h.request,
      [other, { ...h.claim, resultHash: hash === "same" ? h.claim.resultHash : "b".repeat(64) }],
      context,
    ),
  );
  try {
    await blocked(h.observer, secondPid, parked.pid);
    parked.resume();
    expect(await parked.result).toMatchObject({ status: "fulfilled" });
    expect(await competing).toMatchObject({ status: "fulfilled" });
    const [root] = await h.observer.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, h.claim.deliveryId));
    expect(root).toMatchObject({
      resultHash: h.claim.resultHash,
      reportOwnerInstanceId: hash === "same" ? context.instanceId : h.f.context.instanceId,
    });
    const [child] = await h.observer.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, other.deliveryId));
    expect(child?.reportOwnerInstanceId).toBe(context.instanceId);
    expect(await h.custody.recordTurn(h.report, hash === "same" ? context : h.f.context)).toBe("recorded");
  } finally {
    await parked.close();
    await competing;
  }
});

it.each(["claim-first", "disable-first"] as const)("preserves binding disable ordering: %s", async (order) => {
  const h = await prepared();
  const lifecycle = actor();
  const service = new ImBindingService(lifecycle.database, new ApplicationCipher(Buffer.alloc(32, 11)));
  if (order === "disable-first") {
    await service.disable(h.accountId, h.f.bindingId);
    await h.custody.claimRetainedReports(h.request, [h.claim], h.f.context);
    const [row] = await h.observer.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, h.claim.deliveryId));
    expect(row).toMatchObject({ state: "pending", turnId: null, reportedAt: null });
    return;
  }
  const parked = await startBlockedClaim(h, actor());
  const pid = await backend(lifecycle);
  const disabling = settle(service.disable(h.accountId, h.f.bindingId));
  try {
    await blocked(h.observer, pid, parked.pid);
    parked.resume();
    expect(await parked.result).toMatchObject({ status: "fulfilled" });
    expect(await disabling).toMatchObject({ status: "fulfilled" });
    const [binding] = await h.observer.database.select().from(imBindings).where(eq(imBindings.id, h.f.bindingId));
    const [session] = await h.observer.database.select().from(sessions).where(eq(sessions.id, h.f.sessionId));
    expect(binding?.status).toBe("disabled");
    expect(session?.endedAt).not.toBeNull();
    expect(await h.custody.recordTurn(h.report, h.f.context)).toBe("recorded");
  } finally {
    await parked.close();
    await disabling;
  }
});

async function transferTarget(h: Harness) {
  const id = randomUUID();
  await h.observer.database.insert(users).values({ id, displayName: "Next owner", email: `${id}@example.test` });
  await h.observer.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, h.f.agentId));
  await h.observer.database.insert(agentRuntimeConfigs).values({ agentId: h.f.agentId, instructions: "" });
  await h.observer.database.delete(imMessageDeliveries).where(
    inArray(
      imMessageDeliveries.id,
      h.f.steerRequests.map((child) => child.deliveryId),
    ),
  );
  return id;
}

it("refuses Account transfer while a retained claim has unsettled custody", async () => {
  const h = await prepared();
  const targetAccountId = await transferTarget(h);
  const parked = await startBlockedClaim(h, actor());
  try {
    await expect(
      new AgentService(actor().database).transferToAccount({ agentId: h.f.agentId, targetAccountId, slack: "disable" }),
    ).rejects.toMatchObject({ reason: "sessions_blocked" });
    parked.resume();
    expect(await parked.result).toMatchObject({ status: "fulfilled" });
    const [agent] = await h.observer.database.select().from(agents).where(eq(agents.id, h.f.agentId));
    expect(agent?.createdByUserId).toBe(h.accountId);
    expect(await h.custody.recordTurn(h.report, h.f.context)).toBe("recorded");
  } finally {
    await parked.close();
  }
});

it("ignores the old Session's manifest after an actual Account transfer", async () => {
  const h = await prepared();
  const targetAccountId = await transferTarget(h);
  await h.custody.claimRetainedReports(h.request, [h.claim], h.f.context);
  expect(await h.custody.recordTurn(h.report, h.f.context)).toBe("recorded");
  expect(
    await transferLegacyAgentFixture(actor().database, {
      agentId: h.f.agentId,
      targetAccountId,
      slack: "disable",
    }),
  ).toMatchObject({ targetAccountId });
  const before = await h.observer.database.select().from(imMessageDeliveries);
  await h.custody.claimRetainedReports(h.request, [h.claim], { ...h.f.context, instanceId: randomUUID() });
  expect(await h.observer.database.select().from(imMessageDeliveries)).toEqual(before);
});

it("rolls back earlier delivery and feedback recovery when a later claim fails", async () => {
  const h = await prepared();
  const claims = [h.claim, await sibling(h)].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId));
  const failureId = claims[1]?.deliveryId;
  assert(failureId);
  const before = await h.observer.database.select().from(imMessageDeliveries).orderBy(imMessageDeliveries.id);
  await h.observer.sql.unsafe(`
    create function fail_retained_claim() returns trigger language plpgsql as $$
    begin
      if new.id = '${failureId}'::uuid then
        raise exception using errcode = '40001', message = 'Retained claim fault';
      end if;
      return new;
    end $$;
    create trigger fail_retained_claim before update on im_message_deliveries for each row execute function fail_retained_claim();
  `);
  try {
    await expect(h.custody.claimRetainedReports(h.request, claims, h.f.context)).rejects.toMatchObject({
      cause: { code: "40001" },
    });
    expect(await h.observer.database.select().from(imMessageDeliveries).orderBy(imMessageDeliveries.id)).toEqual(
      before,
    );
    expect(await h.observer.database.select().from(imFeedbackTargets)).toEqual([]);
    expect(await h.observer.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
  } finally {
    await h.observer.sql.unsafe(
      "drop trigger fail_retained_claim on im_message_deliveries; drop function fail_retained_claim();",
    );
  }
  await h.custody.claimRetainedReports(h.request, claims, h.f.context);
  expect(await h.observer.database.select().from(imFeedbackTargets)).toHaveLength(2);
});
