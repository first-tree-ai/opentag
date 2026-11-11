import { createHmac, randomUUID } from "node:crypto";
import { computeTurnResultHash, SLACK_REQUIRED_BOT_SCOPES, type TurnReportRequest } from "@opentag/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  computers,
  imFeedbackActions,
  imFeedbackTargets,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessions,
  slackInstallations,
} from "../../db/schema/index.js";
import { createPerformanceLogger } from "../../observability/performance-logger.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ExternalCallPolicy } from "../../services/im/external-call-policy.js";
import { ImFeedbackActionsService } from "../../services/im/im-feedback-actions.js";
import {
  FeedbackCooldownStorageError,
  type FeedbackTransport,
  ImFeedbackMessenger,
} from "../../services/im/im-feedback-messenger.js";
import {
  createImFeedbackTarget,
  type FeedbackTarget,
  finishImFeedback,
  ImFeedbackStore,
  startImFeedback,
} from "../../services/im/im-feedback-store.js";
import { ImFeedbackWorker } from "../../services/im/im-feedback-worker.js";
import { ImBindingService } from "../../services/im-bindings/im-binding-service.js";
import { closeServerResources } from "../../shutdown.js";
import { deferred } from "../support/deferred.js";
import { createSlackWorkingFixture } from "../support/slack-working-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let fixtureDb: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let clock: Date;
beforeAll(async () => {
  fixtureDb = await startMigratedTestDatabase();
  client = createDatabaseClient(fixtureDb.databaseUrl, { max: 6 });
}, 120_000);
afterAll(async () => {
  await client?.sql.end();
  await fixtureDb?.stop();
});
beforeEach(async () => {
  await fixtureDb.reset();
  clock = new Date();
});
async function failed(reported: Partial<TurnReportRequest> = {}) {
  const h = await createSlackWorkingFixture(client.database, new ApplicationCipher(Buffer.alloc(32, 11)), () => clock);
  const { frame } = await h.delivery();
  await client.database.transaction((tx) => startImFeedback(tx, frame.deliveryId, clock));
  const report: TurnReportRequest = {
    type: "turn:report",
    requestId: randomUUID(),
    deliveryId: frame.deliveryId,
    turnId: frame.turnId,
    sessionId: frame.sessionId,
    agentId: frame.agentId,
    placementGeneration: 1,
    outcome: "failed",
    executionEffects: "not_started",
    errorReason: "provider_start_failed",
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
    resultHash: "0".repeat(64),
    ...reported,
  };
  report.resultHash = computeTurnResultHash(report);
  expect(
    await new PostgresRuntimeCustodyStore(client.database, { now: () => clock }).recordTurn(report, h.context),
  ).toBe("recorded");
  const [target] = await client.database
    .select()
    .from(imFeedbackTargets)
    .where(eq(imFeedbackTargets.deliveryId, frame.deliveryId));
  if (!target) throw new Error("Missing feedback");
  const service = new ImFeedbackActionsService({ database: client.database, secret: "test-secret", now: () => clock });
  const view = await service.getForAccount(target.accountId, target.id);
  expect(view.actions).toEqual([]);
  const body = Buffer.from(
    JSON.stringify({
      accountId: target.accountId,
      id: target.id,
      revision: view.revision,
      kind: "retry_task",
      expires: clock.getTime() + 5 * 60_000,
    }),
  ).toString("base64url");
  const key = createHmac("sha256", "test-secret").update("opentag/im-feedback-confirmation/v1").digest();
  const legacyConfirmation = `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
  return {
    ...h,
    frame,
    report,
    target,
    service,
    input: { kind: "retry_task" as const, revision: view.revision, confirmation: legacyConfirmation },
  };
}
describe("PostgreSQL feedback operations", () => {
  it("passes a quota failure's reset time from the stored Turn report to the claimed card", async () => {
    const retryAt = new Date(clock.getTime() + 3_600_000).toISOString();
    await failed({ errorReason: "provider_quota_exceeded", retryAt });
    const store = new ImFeedbackStore(client.database, () => clock);
    const claimed = await store.claim();
    expect(claimed).toMatchObject({ errorCode: "provider_quota_exceeded", retryAt });
  });

  it("excludes an active native input without blocking another input or reordering its attempts", async () => {
    const h = await failed();
    const [retry] = await client.database
      .insert(imMessageDeliveries)
      .values({
        messageId: h.target.messageId,
        sessionId: h.target.sessionId,
        attention: "direct",
        placementGeneration: 1,
        attemptOrdinal: 1,
        retryOfDeliveryId: h.target.deliveryId,
        expiresAt: h.target.actionsExpireAt,
      })
      .returning();
    if (!retry) throw new Error("Missing retry delivery");
    await client.database.transaction((tx) => createImFeedbackTarget(tx, retry.id, clock));
    const independent = await h.delivery();
    await client.database.transaction((tx) => startImFeedback(tx, independent.frame.deliveryId, clock));
    for (const [index, deliveryId] of [h.target.deliveryId, retry.id, independent.frame.deliveryId].entries()) {
      await client.database
        .update(imFeedbackTargets)
        .set({ nextAttemptAt: new Date(clock.getTime() - 3_000 + index * 1_000) })
        .where(eq(imFeedbackTargets.deliveryId, deliveryId));
    }
    const peer = createDatabaseClient(fixtureDb.databaseUrl, { max: 1 });
    try {
      const store = new ImFeedbackStore(client.database, () => clock);
      const other = new ImFeedbackStore(peer.database, () => clock);
      const first = await store.claim();
      expect(first?.id).toBe(h.target.id);
      if (!first) throw new Error("Missing first claim");
      const next = await other.claim([first]);
      expect(next?.deliveryId).toBe(independent.frame.deliveryId);
      if (!next) throw new Error("Missing independent claim");
      expect(await store.claim([first, next])).toBeUndefined();
      await store.settle(first, { dormant: true });
      expect((await other.claim([next]))?.deliveryId).toBe(retry.id);
    } finally {
      await peer.sql.end();
    }
  });

  it("admits only one simultaneous claim and fences a late settlement after expiry", async () => {
    await failed();
    const peer = createDatabaseClient(fixtureDb.databaseUrl, { max: 1 });
    try {
      const stores = [
        new ImFeedbackStore(client.database, () => clock),
        new ImFeedbackStore(peer.database, () => clock),
      ];
      const claims = (await Promise.all(stores.map((store) => store.claim()))).filter((t) => t !== undefined);
      expect(claims).toHaveLength(1);
      const old = claims[0];
      if (!old) throw new Error("Missing original claim");
      expect(await stores[1]?.markSending(old)).toBe(true);
      clock = new Date(clock.getTime() + 91_000);
      const current = await stores[1]?.claim();
      expect(current).toMatchObject({ id: old.id, cardState: "send_unknown" });
      if (!current) throw new Error("Missing replacement claim");
      expect(current.claimId).not.toBe(old.claimId);
      await stores[0]?.settle(old, { reaction: "working", cardState: "sent", cardMessageId: "late-old-write" });
      const [saved] = await client.database.select().from(imFeedbackTargets).where(eq(imFeedbackTargets.id, old.id));
      expect(saved).toMatchObject({
        claimId: current.claimId,
        appliedReaction: "none",
        cardState: "send_unknown",
        cardMessageId: null,
      });
    } finally {
      await peer.sql.end();
    }
  });

  it("drains four admitted independent projections on stop without admitting the remaining input", async () => {
    const h = await failed();
    for (let i = 0; i < 4; i++) {
      const entry = await h.delivery();
      await client.database.transaction((tx) => startImFeedback(tx, entry.frame.deliveryId, clock));
    }
    const gate = deferred();
    let admitted = 0;
    const reaction = vi.fn(async () => {
      admitted++;
      await gate.promise;
    });
    const worker = new ImFeedbackWorker({
      store: new ImFeedbackStore(client.database, () => clock),
      transport: {
        reaction,
        post: async () => "card",
        postOfflineNotice: async () => {},
        update: async () => {},
        find: async () => ({ ids: [] }),
      },
      logger: { warn: vi.fn() },
    });
    const pass = worker.runOnce();
    try {
      await vi.waitFor(() => expect(admitted).toBe(4));
      let finished = false;
      const stop = worker.stop().then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      gate.resolve();
      await Promise.all([pass, stop]);
      expect(reaction).toHaveBeenCalledTimes(4);
      const targets = await client.database.select().from(imFeedbackTargets);
      expect(targets.filter((t) => t.appliedReaction !== "none")).toHaveLength(4);
      expect(targets.every((t) => t.claimId === null)).toBe(true);
    } finally {
      gate.resolve();
      await worker.stop();
    }
  });

  it("halts new claims while a cooldown failure's settlement waits on a PostgreSQL row lock", async () => {
    const h = await failed();
    for (let i = 0; i < 4; i++) {
      const entry = await h.delivery();
      await client.database.transaction((tx) => startImFeedback(tx, entry.frame.deliveryId, clock));
    }
    const store = new ImFeedbackStore(client.database, () => clock);
    const claim = vi.spyOn(store, "claim");
    const fail = deferred();
    const siblings = deferred();
    const siblingsSettled = deferred();
    const unlock = deferred();
    const locked = deferred<number>();
    const admitted: FeedbackTarget[] = [];
    let completedSiblings = 0;
    const settle = store.settle.bind(store);
    vi.spyOn(store, "settle").mockImplementation(async (target, input) => {
      await settle(target, input);
      if (target.id !== admitted[0]?.id && ++completedSiblings === 3) siblingsSettled.resolve();
    });
    const peer = createDatabaseClient(fixtureDb.databaseUrl, { max: 1 });
    const worker = new ImFeedbackWorker({
      store,
      transport: {
        postOfflineNotice: async () => {},
        reaction: async (target) => {
          admitted.push(target);
          if (admitted[0]?.id !== target.id) return siblings.promise;
          await fail.promise;
          throw new FeedbackCooldownStorageError();
        },
        post: async () => "card",
        update: async () => {},
        find: async () => ({ ids: [] }),
      },
      logger: { warn: vi.fn() },
    });
    const pass = worker.runOnce();
    let lock: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(admitted).toHaveLength(4));
      const first = admitted[0];
      if (!first) throw new Error("Missing failed target");
      lock = peer.database.transaction(async (tx) => {
        await tx.select().from(imFeedbackTargets).where(eq(imFeedbackTargets.id, first.id)).for("update");
        const [backend] = await tx.execute(sql`select pg_backend_pid()::int as pid`);
        locked.resolve(Number(backend?.pid));
        await unlock.promise;
      });
      const lockerPid = await locked.promise;
      fail.resolve();
      await vi.waitFor(async () => {
        const [row] = await client.sql`select exists(select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
          and ${lockerPid} = any(pg_blocking_pids(pid))
          and query ilike 'update "im_feedback_targets"%') as waiting`;
        expect(row?.waiting).toBe(true);
      });
      siblings.resolve();
      await siblingsSettled.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(claim).toHaveBeenCalledTimes(4);
      expect(admitted).toHaveLength(4);
    } finally {
      const stop = worker.stop();
      fail.resolve();
      siblings.resolve();
      unlock.resolve();
      await Promise.all([pass, stop, lock]);
      await peer.sql.end();
    }
    const first = admitted[0];
    if (!first) throw new Error("Missing failed target");
    const [saved] = await client.database.select().from(imFeedbackTargets).where(eq(imFeedbackTargets.id, first.id));
    expect(saved).toMatchObject({ claimId: null, lastErrorCode: "IM_FEEDBACK_COOLDOWN_UNAVAILABLE" });
  });

  it("rejects concurrent legacy Retry confirmations without adding an attempt", async () => {
    const h = await failed();
    const results = await Promise.allSettled([
      h.service.submitForAccount(h.target.accountId, h.target.id, h.input),
      h.service.submitForAccount(h.target.accountId, h.target.id, h.input),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const deliveries = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.messageId, h.target.messageId));
    expect(deliveries).toHaveLength(1);
    expect(deliveries.find((d) => d.attemptOrdinal === 0)?.turnReport).toEqual(h.report);
    expect(await client.database.select().from(imFeedbackActions)).toHaveLength(0);
  });
  it("admits only one of simultaneous save/discard decisions before cloud I/O", async () => {
    const h = await failed();
    const [sandbox] = await client.database
      .insert(sandboxes)
      .values({
        sessionId: h.target.sessionId,
        storageUri: "gs://synthetic/workspace",
        environmentGeneration: 3,
        lifecycle: "ready",
        currentResourceName: "projects/test/locations/test/instances/example",
        currentResourceUid: "uid-3",
      })
      .returning();
    if (!sandbox) throw new Error("Missing sandbox");
    await client.database
      .update(imFeedbackTargets)
      .set({
        state: "workspace_blocked",
        errorCode: "workspace_failed",
        sandboxId: sandbox.id,
        environmentGeneration: 3,
        resourceUid: "uid-3",
      })
      .where(eq(imFeedbackTargets.id, h.target.id));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const status = {
      sandboxId: sandbox.id,
      sessionId: h.target.sessionId,
      lifecycle: "ready" as const,
      environmentGeneration: 3,
      currentResourceName: sandbox.currentResourceName,
      currentResourceUid: "uid-3",
      currentOperationName: null,
      runnerConnected: true,
      runnerReady: false,
      runnerReadiness: null,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedAt: clock.toISOString(),
    };
    const stop = vi.fn(async () => {
      await gate;
      return { ...status, lifecycle: "unallocated" as const, currentResourceUid: null };
    });
    const service = new ImFeedbackActionsService({
      database: client.database,
      secret: "secret",
      now: () => clock,
      sandboxRunner: {
        statusForAccount: async () => status,
        stopForAccount: stop,
        verifySavedForAccount: async () => true,
      },
    });
    try {
      const view = await service.getForAccount(h.target.accountId, h.target.id);
      const results = await Promise.allSettled(
        view.actions.map((a) =>
          service.submitForAccount(h.target.accountId, h.target.id, {
            ...(a.kind === "discard" ? ({ kind: a.kind, permanentLossAcknowledged: true } as const) : { kind: a.kind }),
            revision: view.revision,
            confirmation: a.confirmation,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await client.database.select().from(imFeedbackActions)).toHaveLength(1);
    } finally {
      release();
      await service.close();
    }
    expect(stop).toHaveBeenCalledOnce();
  });
  it("uses bounded due-work and attempt lookup indexes with a populated inbox", async () => {
    const h = await failed();
    await client.database.execute(
      sql`with inputs as (insert into im_messages (im_binding_id,channel_id,external_message_id,provider_revision_key,operation,direction,author_kind,author_external_id,content,provider_context,occurred_at) select ${h.target.bindingId}::uuid,'C1',gen_random_uuid()::text,'1','created','inbound','human','synthetic','{"version":1,"fallbackText":"synthetic","blocks":[],"truncated":false}'::jsonb,'{"provider":"slack"}'::jsonb,now() from generate_series(1,2000) returning id) insert into im_message_deliveries (message_id,session_id,attention,placement_generation,expires_at) select id,${h.target.sessionId}::uuid,'direct',1,now()+interval '1 day' from inputs`,
    );
    await client.database.execute(
      sql`insert into im_feedback_targets (account_id,agent_id,binding_id,binding_generation,provider,installation_id,message_id,session_id,delivery_id,placement_generation,channel_id,input_external_id,sender_external_id,card_owner_delivery_id,state,actions_expire_at,next_attempt_at) select ${h.target.accountId}::uuid,${h.target.agentId}::uuid,${h.target.bindingId}::uuid,${h.target.bindingGeneration},'slack',${h.target.installationId}::uuid,d.message_id,d.session_id,d.id,1,'C1',d.message_id::text,'synthetic',d.id,'completed',now(), '9999-12-31'::timestamptz from im_message_deliveries d where d.id <> ${h.target.deliveryId}::uuid`,
    );
    await client.sql`analyze im_feedback_targets`;
    await client.sql`analyze im_message_deliveries`;
    const due = await client.sql.unsafe(
      `explain (analyze, buffers, format json) select id from im_feedback_targets where next_attempt_at <= now() and (claim_expires_at is null or claim_expires_at <= now()) order by next_attempt_at,id limit 1 for update skip locked`,
    );
    const attempt = await client.database.execute(
      sql`explain (analyze,buffers,format json) select id from im_message_deliveries where message_id=${h.target.messageId}::uuid and session_id=${h.target.sessionId}::uuid order by attempt_ordinal`,
    );
    expect(JSON.stringify(due)).toContain("im_feedback_targets_due_idx");
    expect(JSON.stringify(attempt)).toContain("im_message_deliveries_message_session_attempt_unique");
    const delivery = await client.database.execute(
      sql`explain (analyze,buffers,format json) select id from im_feedback_targets where delivery_id=${h.target.deliveryId}::uuid`,
    );
    const owner = await client.database.execute(
      sql`explain (analyze,buffers,format json) select id from im_feedback_targets where card_owner_delivery_id=${h.target.deliveryId}::uuid order by id`,
    );
    const message = await client.database.execute(
      sql`explain (analyze,buffers,format json) select id from im_feedback_targets where message_id=${h.target.messageId}::uuid`,
    );
    expect(JSON.stringify(delivery)).toContain("im_feedback_targets_delivery_unique");
    expect(JSON.stringify(owner)).toContain("im_feedback_targets_card_owner_idx");
    expect(JSON.stringify(message)).toContain("im_feedback_targets_message_idx");
  });
  it("retains a previously admitted retry after a lost response without authorizing another attempt", async () => {
    const h = await failed();
    const [delivery] = await client.database
      .insert(imMessageDeliveries)
      .values({
        messageId: h.target.messageId,
        sessionId: h.target.sessionId,
        attention: "direct",
        placementGeneration: h.target.placementGeneration,
        attemptOrdinal: 1,
        retryOfDeliveryId: h.target.deliveryId,
        expiresAt: h.target.actionsExpireAt,
      })
      .returning();
    if (!delivery) throw new Error("Missing admitted delivery");
    await client.database.insert(imFeedbackActions).values({
      feedbackId: h.target.id,
      feedbackRevision: h.target.revision,
      kind: "retry_task",
      state: "succeeded",
      actorAccountId: h.target.accountId,
      actorDisplayName: "Account",
      bindingGeneration: h.target.bindingGeneration,
      sessionId: h.target.sessionId,
      placementGeneration: h.target.placementGeneration,
      reportHash: h.target.reportHash,
      idempotencyKey: `${h.target.id}:${h.target.revision}:retry_task`,
      resultDeliveryId: delivery.id,
      resultCode: "retry_queued",
      confirmedAt: clock,
      expiresAt: h.target.actionsExpireAt,
    });
    await h.service.submitForAccount(h.target.accountId, h.target.id, h.input);
    expect((await h.service.getForAccount(h.target.accountId, h.target.id)).action).toMatchObject({
      kind: "retry_task",
      state: "succeeded",
      resultCode: "retry_queued",
    });
    expect(
      await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.messageId, h.target.messageId)),
    ).toHaveLength(2);
    expect(await client.database.select().from(imFeedbackActions)).toHaveLength(1);
  });
  it("keeps the source and feedback rows unlocked while the provider call is blocked", async () => {
    const h = await failed();
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport: FeedbackTransport = {
      reaction: vi.fn(async () => {}),
      post: vi.fn(async () => {
        entered();
        await gate;
        return "native-card";
      }),
      postOfflineNotice: vi.fn(async () => {}),
      find: vi.fn(async () => ({ ids: [] })),
      update: vi.fn(async () => {}),
    };
    const worker = new ImFeedbackWorker({
      store: new ImFeedbackStore(client.database, () => clock),
      transport,
      logger: { warn: vi.fn() },
    });
    const pumping = worker.runOnce();
    await ready;
    try {
      await client.database.transaction(async (tx) => {
        await tx.execute((await import("drizzle-orm")).sql`set local lock_timeout='1000ms'`);
        expect(
          await tx
            .select()
            .from(imMessageDeliveries)
            .where(eq(imMessageDeliveries.id, h.frame.deliveryId))
            .for("update"),
        ).toHaveLength(1);
        expect(
          await tx.select().from(imFeedbackTargets).where(eq(imFeedbackTargets.id, h.target.id)).for("update"),
        ).toHaveLength(1);
      });
    } finally {
      release();
      await pumping;
    }
  });
});

function messengerFor(
  target: FeedbackTarget,
  store: ImFeedbackStore,
  policy = new ExternalCallPolicy({ allowedHosts: [], performanceLogger: createPerformanceLogger(() => undefined) }),
) {
  const binding = {
    getSlackConnectionMaterial: async () => ({
      installationId: target.installationId,
      generation: target.bindingGeneration,
      botAccessToken: "synthetic-feedback-token",
      botUserId: "U1",
    }),
  } as unknown as ImBindingService;
  return new ImFeedbackMessenger(binding, policy, "https://example.test", store);
}

async function failAnother(h: Awaited<ReturnType<typeof failed>>) {
  const { frame } = await h.delivery();
  await client.database.transaction((tx) => startImFeedback(tx, frame.deliveryId, clock));
  const report = { ...h.report, requestId: randomUUID(), deliveryId: frame.deliveryId, turnId: frame.turnId };
  report.resultHash = computeTurnResultHash(report);
  expect(
    await new PostgresRuntimeCustodyStore(client.database, { now: () => clock }).recordTurn(report, h.context),
  ).toBe("recorded");
}

describe("IM offline notice", () => {
  it("makes a second target of the Session wait for the first reservation, then decline", async () => {
    const h = await failed();
    const second = await h.delivery();
    const third = await h.delivery();
    const ids = [second.frame.deliveryId, third.frame.deliveryId];
    await client.database
      .update(imMessageDeliveries)
      .set({ state: "pending", acceptedAt: null, inputHash: null, turnId: null, reportOwnerInstanceId: null })
      .where(inArray(imMessageDeliveries.id, ids));
    await client.database.update(imMessages).set({ receivedAt: new Date(clock.getTime() - 300_000) });
    await client.database.transaction(async (tx) => {
      for (const id of ids) await createImFeedbackTarget(tx, id, clock);
    });
    await client.database
      .update(computers)
      .set({ currentInstanceId: null, lastSeenAt: new Date(clock.getTime() - 300_000) });
    const targets = await client.database
      .select()
      .from(imFeedbackTargets)
      .where(inArray(imFeedbackTargets.deliveryId, ids));
    expect(targets.map((target) => target.state)).toEqual(["queued", "queued"]);
    const [first, other] = targets;
    if (!first || !other) throw new Error("Missing targets");
    const store = new ImFeedbackStore(client.database, () => clock);
    const release = deferred<void>();
    const locked = deferred<void>();
    const holder = client.database.transaction(async (tx) => {
      await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, first.sessionId)).for("update");
      locked.resolve();
      await release.promise;
      await tx.update(imFeedbackTargets).set({ sendStartedAt: clock }).where(eq(imFeedbackTargets.id, first.id));
    });
    await locked.promise;
    let settled = false;
    const racing = store.reserveOfflineNotice(other).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    release.resolve();
    await holder;
    expect(await racing).toBeUndefined();

    // A reconnect committed during the lock wait wins over the earlier offline read.
    await client.database.update(imFeedbackTargets).set({ sendStartedAt: null });
    const releaseAgain = deferred<void>();
    const lockedAgain = deferred<void>();
    const holderAgain = client.database.transaction(async (tx) => {
      await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, first.sessionId)).for("update");
      lockedAgain.resolve();
      await releaseAgain.promise;
    });
    await lockedAgain.promise;
    const waiting = store.reserveOfflineNotice(other);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await client.database.update(computers).set({ currentInstanceId: randomUUID(), lastSeenAt: clock });
    releaseAgain.resolve();
    await holderAgain;
    expect(await waiting).toBeUndefined();
  });
});

describe("workspace failure format", () => {
  it("keeps the format of a send that started between the report's read and its update", async () => {
    const h = await failed();
    await client.database
      .update(imFeedbackTargets)
      .set({ messageFormat: "text_v1", cardState: "pending", cardMessageId: null })
      .where(eq(imFeedbackTargets.id, h.target.id));
    const started = deferred<void>();
    const release = deferred<void>();
    const worker = client.database.transaction(async (tx) => {
      await tx.update(imFeedbackTargets).set({ cardState: "sending" }).where(eq(imFeedbackTargets.id, h.target.id));
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const report: TurnReportRequest = { ...h.report, errorReason: "workspace_failed" };
    const finishing = client.database.transaction((tx) => finishImFeedback(tx, report, clock));
    for (let i = 0; i < 100; i += 1) {
      const blocked = await client.database.execute<{ count: string }>(
        sql`select count(*)::text as count from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'update "im_feedback_targets"%'`,
      );
      if (blocked[0]?.count !== "0") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release.resolve();
    await worker;
    await finishing;
    const [row] = await client.database.select().from(imFeedbackTargets).where(eq(imFeedbackTargets.id, h.target.id));
    expect(row).toMatchObject({ state: "workspace_blocked", messageFormat: "text_v1" });
  });
});

describe("existing installation cooldown", () => {
  it("keeps a definitely unsent card pending when the call pool is full and sends it after capacity returns", async () => {
    const h = await failed();
    await client.database.update(imFeedbackTargets).set({ appliedReaction: "warning" });
    const store = new ImFeedbackStore(client.database, () => clock);
    const policy = new ExternalCallPolicy({ maxConcurrency: 1, maxQueueDepth: 0 });
    const gate = deferred();
    const entered = deferred();
    const occupying = policy.run("busy", async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channel: h.target.channelId, ts: "after-capacity" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const worker = new ImFeedbackWorker({
      store,
      transport: messengerFor(h.target, store, policy),
      logger: { warn: vi.fn() },
      now: () => clock,
    });
    try {
      await worker.runOnce();
      const [pending] = await client.database.select().from(imFeedbackTargets);
      expect(pending).toMatchObject({
        cardState: "pending",
        cardMessageId: null,
        lastErrorCode: "IM_PROVIDER_OVERLOADED",
      });
      expect(http).not.toHaveBeenCalled();
      gate.resolve();
      await occupying;
      clock = new Date(clock.getTime() + 5_000);
      await worker.runOnce();
      const [saved] = await client.database.select().from(imFeedbackTargets);
      expect(saved).toMatchObject({ cardState: "sent", cardMessageId: "after-capacity" });
      expect(http).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await occupying;
      await worker.stop();
      http.mockRestore();
    }
  });
  it("shares a real SDK 429 across due targets, worker restarts and methods, while isolating another installation", async () => {
    const h = await failed();
    await failAnother(h);
    await client.database.update(imFeedbackTargets).set({ appliedReaction: "warning" });
    const store = new ImFeedbackStore(client.database, () => clock);
    const transport = messengerFor(h.target, store);
    const replica = createDatabaseClient(fixtureDb.databaseUrl, {
      max: 1,
      performanceLogger: createPerformanceLogger(() => undefined),
    });
    const requests: string[] = [];
    const secondAdmitted = deferred();
    const http = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      requests.push(String(url));
      if (requests.length === 1) {
        await secondAdmitted.promise;
        return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 429,
          headers: { "Retry-After": "60", "Content-Type": "application/json" },
        });
      }
      secondAdmitted.resolve();
      return new Response(JSON.stringify({ ok: true, channel: h.target.channelId, ts: "synthetic-card" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await new ImFeedbackWorker({ store, transport, logger: { warn: vi.fn() }, now: () => clock }).runOnce();
      expect(requests).toHaveLength(2);
      const targets = await client.database.select().from(imFeedbackTargets);
      expect(targets.map((t) => t.cardState).sort()).toEqual(["pending", "sent"]);
      const restartedStore = new ImFeedbackStore(replica.database, () => clock);
      const restarted = messengerFor(h.target, restartedStore);
      await client.database.update(imFeedbackTargets).set({ nextAttemptAt: clock });
      await new ImFeedbackWorker({
        store: restartedStore,
        transport: restarted,
        logger: { warn: vi.fn() },
        now: () => clock,
      }).runOnce();
      for (const call of [
        () => restarted.reaction(h.target, "warning"),
        () => restarted.find(h.target),
        () => restarted.update({ ...h.target, cardMessageId: "bound" }),
      ])
        await expect(call()).rejects.toMatchObject({ code: "IM_FEEDBACK_RATE_LIMITED", knownNotApplied: true });
      expect(requests).toHaveLength(2);
      const [installation] = await client.database
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.id, h.target.installationId ?? ""));
      if (!installation) throw new Error("Missing installation");
      const [other] = await client.database
        .insert(slackInstallations)
        .values({
          ...installation,
          id: randomUUID(),
          externalAppId: "OTHER_APP",
          externalTeamId: "OTHER_TEAM",
          workingStatusNotBeforeAt: new Date(0),
        })
        .returning();
      if (!other) throw new Error("Missing second installation");
      const otherTarget = { ...h.target, installationId: other.id };
      expect(await messengerFor(otherTarget, restartedStore).post(otherTarget)).toBe("synthetic-card");
      expect(requests).toHaveLength(3);
      await client.database
        .update(slackInstallations)
        .set({ workingStatusNotBeforeAt: new Date(0) })
        .where(eq(slackInstallations.id, installation.id));
      expect(await restarted.post(h.target)).toBe("synthetic-card");
      expect(requests).toHaveLength(4);
    } finally {
      http.mockRestore();
      await replica.sql.end();
    }
  });

  it("extends deadlines monotonically across independent connections and fences old-generation writers", async () => {
    const h = await failed();
    const store = new ImFeedbackStore(client.database);
    const replica = createDatabaseClient(fixtureDb.databaseUrl, {
      max: 1,
      performanceLogger: createPerformanceLogger(() => undefined),
    });
    const other = new ImFeedbackStore(replica.database);
    try {
      expect(
        await Promise.all([
          store.deferSlackInstallation(h.target, 90_000),
          other.deferSlackInstallation(h.target, 20_000),
        ]),
      ).toEqual([true, true]);
      const [before] = await client.database.select().from(slackInstallations);
      if (!before) throw new Error("Missing installation");
      expect(await other.slackCooldownRemaining(h.target)).toBeGreaterThan(80_000);
      await other.deferSlackInstallation(h.target, 5_000);
      expect((await client.database.select().from(slackInstallations))[0]?.workingStatusNotBeforeAt).toEqual(
        before.workingStatusNotBeforeAt,
      );
      await rotateInstallation(h.target);
      expect(await other.deferSlackInstallation(h.target, 300_000)).toBe(false);
      expect(await store.slackCooldownRemaining(h.target)).toBeUndefined();
      expect(
        await store.slackCooldownRemaining({ ...h.target, bindingGeneration: h.target.bindingGeneration + 1 }),
      ).toBeGreaterThan(80_000);
      expect((await client.database.select().from(slackInstallations))[0]?.workingStatusNotBeforeAt).toEqual(
        before.workingStatusNotBeforeAt,
      );
      await client.database
        .update(slackInstallations)
        .set({ status: "reauthorization_required" })
        .where(eq(slackInstallations.id, before.id));
      expect(
        await store.deferSlackInstallation({ ...h.target, bindingGeneration: h.target.bindingGeneration + 1 }, 400_000),
      ).toBe(false);
    } finally {
      await replica.sql.end();
    }
  });

  it.each([false, true])(
    "retains shared cooldown through legacy settlement and feedback cleanup (rate limited=%s)",
    async (limited) => {
      const h = await failed();
      const { frame } = await h.delivery();
      await h.store.record(frame, h.context);
      const claim = await h.store.claim();
      if (!claim) throw new Error("Missing legacy claim");
      const feedback = new ImFeedbackStore(client.database);
      await feedback.deferSlackInstallation(h.target, 60_000);
      const [before] = await client.database.select().from(slackInstallations);
      if (!before) throw new Error("Missing installation");
      await h.store.settle(claim, { working: false, delayMs: 0, ...(limited ? { cooldownMs: 5_000 } : {}) });
      await client.database
        .update(imFeedbackTargets)
        .set({ state: "completed", cardState: "none", settledAt: new Date(Date.now() - 91 * 86400_000) });
      await feedback.retain();
      expect(await client.database.select().from(imFeedbackTargets)).toHaveLength(0);
      expect(await h.store.claim()).toBeUndefined();
      expect((await client.database.select().from(slackInstallations))[0]?.workingStatusNotBeforeAt).toEqual(
        before.workingStatusNotBeforeAt,
      );
    },
  );
});

async function rotateInstallation(target: FeedbackTarget) {
  return new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 11))).activateSlack(
    {
      intent: "reauthorize",
      agentId: target.agentId,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "synthetic-rotated",
      signingSecret: "unit-signing",
      installedAt: new Date(),
    },
    "B1",
  );
}

it("releases the installation lock during provider I/O and ignores a late 429 after real reauthorization", async () => {
  const h = await failed();
  const store = new ImFeedbackStore(client.database);
  const transport = messengerFor(h.target, store);
  let entered = () => {};
  let release = () => {};
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    entered();
    await gate;
    return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  });
  const pending = transport.post(h.target);
  try {
    await admitted;
    await client.sql.begin(async (tx) => {
      await tx.unsafe("set local lock_timeout = '100ms'");
      await tx`select id from slack_installations where id=${h.target.installationId} for update`;
    });
    await rotateInstallation(h.target);
    release();
    await expect(pending).rejects.toMatchObject({ code: "IM_FEEDBACK_BINDING_STALE", knownNotApplied: true });
    const [installation] = await client.database.select().from(slackInstallations);
    expect(installation?.credentialGeneration).toBe(h.target.bindingGeneration + 1);
    expect(installation?.workingStatusNotBeforeAt.getTime()).toBe(0);
  } finally {
    release();
    await Promise.allSettled([pending]);
    http.mockRestore();
  }
});

it("drains workspace jobs admitted after shutdown starts before closing the SQL pool", async () => {
  const h = await failed();
  const [sandbox] = await client.database
    .insert(sandboxes)
    .values({
      sessionId: h.target.sessionId,
      storageUri: "gs://synthetic/workspace",
      environmentGeneration: 3,
      lifecycle: "ready",
      currentResourceName: "projects/test/locations/test/instances/drain",
      currentResourceUid: "drain-uid",
    })
    .returning();
  if (!sandbox) throw new Error("Missing sandbox");
  await client.database
    .update(imFeedbackTargets)
    .set({
      state: "workspace_blocked",
      errorCode: "workspace_failed",
      sandboxId: sandbox.id,
      environmentGeneration: 3,
      resourceUid: "drain-uid",
    })
    .where(eq(imFeedbackTargets.id, h.target.id));
  const owned = createDatabaseClient(fixtureDb.databaseUrl, { max: 2 });
  const locked = deferred();
  const unlock = deferred();
  const stoppingWorkspace = deferred();
  const releaseWorkspace = deferred();
  const closingStarted = deferred();
  const status = {
    sandboxId: sandbox.id,
    sessionId: h.target.sessionId,
    lifecycle: "ready" as const,
    environmentGeneration: 3,
    currentResourceName: sandbox.currentResourceName,
    currentResourceUid: "drain-uid",
    currentOperationName: null,
    runnerConnected: true,
    runnerReady: false,
    runnerReadiness: null,
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: clock.toISOString(),
  };
  const service = new ImFeedbackActionsService({
    database: owned.database,
    secret: "secret",
    now: () => clock,
    sandboxRunner: {
      statusForAccount: async () => status,
      stopForAccount: async () => {
        stoppingWorkspace.resolve();
        await releaseWorkspace.promise;
        return { ...status, lifecycle: "unallocated" as const, currentResourceUid: null };
      },
      verifySavedForAccount: async () => true,
    },
  });
  const view = await service.getForAccount(h.target.accountId, h.target.id);
  const discard = view.actions.find((action) => action.kind === "discard");
  if (!discard) throw new Error("Missing discard action");
  let poolClosed = false;
  const app = createApp({
    beginShutdown: () => closingStarted.resolve(),
    closeResources: () =>
      closeServerResources([
        ["feedback operations", () => service.close()],
        [
          "SQL pool",
          async () => {
            await owned.sql.end({ timeout: 1 });
            poolClosed = true;
          },
        ],
      ]),
  });
  app.get("/feedback-drain", () =>
    service.submitForAccount(h.target.accountId, h.target.id, {
      kind: "discard",
      permanentLossAcknowledged: true,
      revision: view.revision,
      confirmation: discard.confirmation,
    }),
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const lock = client.sql.begin(async (tx) => {
    await tx`select id from im_feedback_targets where id = ${h.target.id} for update`;
    locked.resolve();
    await unlock.promise;
  });
  await locked.promise;
  const request = fetch(`${address}/feedback-drain`, { headers: { connection: "close" } }).then((response) =>
    response.json(),
  );
  let closing: Promise<void> | undefined;
  try {
    await vi.waitFor(
      async () => {
        const [waiting] = await client.sql`select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%im_feedback_targets%'`;
        expect(waiting?.count).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    closing = app.close();
    await closingStarted.promise;
    expect(poolClosed).toBe(false);
    unlock.resolve();
    await lock;
    await stoppingWorkspace.promise;
    await request;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(poolClosed).toBe(false);
    expect(await client.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
    releaseWorkspace.resolve();
    await closing;
    expect(poolClosed).toBe(true);
    const [action] = await client.database.select().from(imFeedbackActions);
    expect(action).toMatchObject({ state: "succeeded", resultCode: "discarded" });
  } finally {
    unlock.resolve();
    releaseWorkspace.resolve();
    await lock;
    await request;
    await (closing ?? app.close());
    await owned.sql.end({ timeout: 1 });
  }
});
