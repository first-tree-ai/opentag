import { randomUUID } from "node:crypto";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imFeedbackActions, imFeedbackTargets, imMessageDeliveries, sandboxes } from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImFeedbackActionsService } from "../../services/im/im-feedback-actions.js";
import type { FeedbackTransport } from "../../services/im/im-feedback-messenger.js";
import { ImFeedbackStore, startImFeedback } from "../../services/im/im-feedback-store.js";
import { ImFeedbackWorker } from "../../services/im/im-feedback-worker.js";
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
async function failed() {
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
  const action = view.actions[0];
  if (!action) throw new Error("Missing retry");
  return {
    ...h,
    frame,
    report,
    target,
    service,
    input: { kind: "retry_task" as const, revision: view.revision, confirmation: action.confirmation },
  };
}
describe("PostgreSQL feedback operations", () => {
  it("coalesces simultaneous clicks on independent connections into one new attempt", async () => {
    const h = await failed();
    const results = await Promise.allSettled([
      h.service.submitForAccount(h.target.accountId, h.target.id, h.input),
      h.service.submitForAccount(h.target.accountId, h.target.id, h.input),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const deliveries = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.messageId, h.target.messageId));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.find((d) => d.attemptOrdinal === 0)?.turnReport).toEqual(h.report);
    expect(await client.database.select().from(imFeedbackActions)).toHaveLength(1);
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
  it("reconciles a lost COMMIT response by stable action identity", async () => {
    const h = await failed();
    let loseResponse = true;
    const database = new Proxy(client.database, {
      get(target, property) {
        if (property === "transaction")
          return async (
            callback: Parameters<typeof target.transaction>[0],
            options?: Parameters<typeof target.transaction>[1],
          ) => {
            const result = await target.transaction(callback, options);
            if (loseResponse && options?.accessMode !== "read only") {
              loseResponse = false;
              throw new Error("COMMIT response lost after commit");
            }
            return result;
          };
        return Reflect.get(target, property);
      },
    });
    const uncertain = new ImFeedbackActionsService({ database, secret: "test-secret", now: () => clock });
    await expect(uncertain.submitForAccount(h.target.accountId, h.target.id, h.input)).rejects.toThrow(
      "COMMIT response lost",
    );
    const current = await uncertain.getForAccount(h.target.accountId, h.target.id);
    expect(current.action).toMatchObject({ kind: "retry_task", state: "succeeded", resultCode: "retry_queued" });
    await uncertain.submitForAccount(h.target.accountId, h.target.id, h.input);
    expect(
      await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.messageId, h.target.messageId)),
    ).toHaveLength(2);
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
