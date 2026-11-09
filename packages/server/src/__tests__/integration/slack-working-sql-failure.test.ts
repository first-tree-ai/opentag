import { computeTurnResultHash } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imMessageDeliveries, slackWorkingTargets, slackWorkingTurns } from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { WORKING_LEASE_MS, type WorkingTarget } from "../../services/im/slack-working-store.js";
import { SlackWorkingWorker, slackWorkingCredentialResolver } from "../../services/im/slack-working-worker.js";
import { createSlackWorkingFixture } from "../support/slack-working-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let fixture: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let observer: ReturnType<typeof createDatabaseClient>;
let clock = new Date();
const cipher = new ApplicationCipher(Buffer.alloc(32, 11));

beforeAll(async () => {
  fixture = await startMigratedTestDatabase();
  client = createDatabaseClient(fixture.databaseUrl, {
    max: 2,
    statementTimeoutMs: 200,
    queryTimeoutMs: 2_000,
    idleInTransactionTimeoutMs: 10_000,
  });
  observer = createDatabaseClient(fixture.databaseUrl, { max: 2 });
}, 120_000);
beforeEach(async () => {
  await fixture.reset();
  clock = new Date();
});
afterAll(async () => {
  await client?.sql.end({ timeout: 1 });
  await observer?.sql.end({ timeout: 1 });
  await fixture?.stop();
});

function sqlstate(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth += 1) {
    const value = current as { code?: string; cause?: unknown };
    if (value.code) return value.code;
    current = value.cause;
  }
  return undefined;
}

async function tableLock(table: "im_bindings" | "slack_working_turns" | "slack_working_targets") {
  let release!: () => void;
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const holding = observer.sql.begin(async (tx) => {
    await tx.unsafe(`lock table public.${table} in access exclusive mode`);
    ready();
    await released;
  });
  void holding.catch(failed);
  await locked;
  return async () => {
    release();
    await holding;
  };
}

type Harness = Awaited<ReturnType<typeof createSlackWorkingFixture>>;
type Stage = "token" | "desired" | "ownsClaim" | "settle";

function faultWorker(h: Harness, stage: Stage, count = 1) {
  let remaining = count;
  const errors: Array<string | undefined> = [];
  const warn = vi.fn();
  const token = slackWorkingCredentialResolver(client.database, cipher);
  const invoke = async <T>(name: Stage, action: () => Promise<T>): Promise<T> => {
    if (name !== stage || remaining <= 0) return action();
    remaining -= 1;
    const table =
      name === "token" ? "im_bindings" : name === "desired" ? "slack_working_turns" : "slack_working_targets";
    const unlock = await tableLock(table);
    try {
      const work = action();
      void work.catch(() => undefined);
      const [control] = await client.sql.unsafe("select 1 as healthy", [], { no_pipeline: true });
      expect(control?.healthy).toBe(1);
      try {
        return await work;
      } catch (error) {
        errors.push(sqlstate(error));
        throw error;
      }
    } finally {
      // Recover the database before the real worker receives the statement failure.
      await unlock();
    }
  };
  const worker = new SlackWorkingWorker({
    store: {
      claim: () => h.store.claim(),
      desired: (target) => invoke("desired", () => h.store.desired(target)),
      ownsClaim: (target) => invoke("ownsClaim", () => h.store.ownsClaim(target)),
      settle: (target, input) => invoke("settle", () => h.store.settle(target, input)),
    },
    token: (target) => invoke("token", () => token(target)),
    api: h.api,
    logger: { warn },
  });
  return { worker, errors, warn };
}

async function target(id?: string): Promise<WorkingTarget> {
  const query = client.database.select().from(slackWorkingTargets);
  const [row] = await (id ? query.where(eq(slackWorkingTargets.id, id)) : query);
  if (!row) throw new Error("missing target");
  return row;
}

it.each(["token", "desired", "ownsClaim", "settle"] as const)(
  "keeps a real SQL timeout at %s outside the provider failure budget",
  async (stage) => {
    const h = await createSlackWorkingFixture(client.database, cipher, () => clock);
    const { frame } = await h.delivery();
    await h.store.record(frame, h.context);
    const original = await target();
    await client.database
      .update(slackWorkingTargets)
      .set({ failures: 3 })
      .where(eq(slackWorkingTargets.id, original.id));
    const probe = faultWorker(h, stage);
    await probe.worker.runOnce();
    expect(probe.errors).toEqual(["57014"]);
    expect(h.api.setThreadStatus).toHaveBeenCalledTimes(stage === "settle" ? 1 : 0);
    expect(await target()).toMatchObject({ failures: 3, disabled: false, claimId: expect.any(String) });
    expect(probe.warn).toHaveBeenCalledWith({ code: "SLACK_WORKING_PUMP_FAILED" }, "Slack working status pump failed");
    await probe.worker.stop();
    const [healthy] = await client.sql`select 1 as healthy`;
    expect(healthy?.healthy).toBe(1);
  },
);

it("preserves a target through four SQL-only failures and recovers after the claim lease", async () => {
  const h = await createSlackWorkingFixture(client.database, cipher, () => clock);
  const { frame } = await h.delivery();
  await h.store.record(frame, h.context);
  const original = await target();
  const probe = faultWorker(h, "desired", 4);
  for (let index = 0; index < 4; index += 1) {
    if (index > 0) {
      clock = new Date(clock.getTime() + WORKING_LEASE_MS + 1);
      await h.store.record({ ...frame, sequence: index + 1 }, h.context);
    }
    await probe.worker.runOnce();
    expect(await target(original.id)).toMatchObject({ failures: 0, disabled: false });
  }
  expect(probe.errors).toEqual(["57014", "57014", "57014", "57014"]);
  clock = new Date(clock.getTime() + WORKING_LEASE_MS + 1);
  await h.store.record({ ...frame, sequence: 5 }, h.context);
  await probe.worker.runOnce();
  expect(h.api.setThreadStatus).toHaveBeenCalledTimes(1);
  expect(await target(original.id)).toMatchObject({ failures: 0, disabled: false });
  const second = await h.delivery("2.2");
  await h.store.record(second.frame, h.context);
  await probe.worker.runOnce();
  expect(h.api.setThreadStatus).toHaveBeenCalledTimes(2);
  expect(await target(original.id)).toMatchObject({ disabled: false });
  await probe.worker.stop();
});

it("a failed claim settles the pass, keeps provider counters unchanged, and recovers", async () => {
  const h = await createSlackWorkingFixture(client.database, cipher, () => clock);
  const { frame } = await h.delivery();
  await h.store.record(frame, h.context);
  const unlock = await tableLock("slack_working_targets");
  const warn = vi.fn();
  const errors: Array<string | undefined> = [];
  const worker = new SlackWorkingWorker({
    store: {
      claim: async () => {
        try {
          return await h.store.claim();
        } catch (error) {
          errors.push(sqlstate(error));
          throw error;
        }
      },
      desired: (row) => h.store.desired(row),
      ownsClaim: (row) => h.store.ownsClaim(row),
      settle: (row, input) => h.store.settle(row, input),
    },
    api: h.api,
    token: slackWorkingCredentialResolver(client.database, cipher),
    logger: { warn },
  });
  try {
    await worker.runOnce();
  } finally {
    await unlock();
  }
  expect(errors).toEqual(["57014"]);
  expect(await target()).toMatchObject({ failures: 0, disabled: false, claimId: null });
  expect(warn).toHaveBeenCalledWith({ code: "SLACK_WORKING_PUMP_FAILED" }, "Slack working status pump failed");
  await worker.runOnce();
  expect(h.api.setThreadStatus).toHaveBeenCalledOnce();
  await worker.stop();
});

it("stop drains one admitted API call without a database transaction and prevents another claim", async () => {
  const h = await createSlackWorkingFixture(client.database, cipher, () => clock);
  for (const thread of ["1.1", "2.2"]) {
    const { frame } = await h.delivery(thread);
    await h.store.record(frame, h.context);
  }
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.api.setThreadStatus.mockImplementationOnce(async () => {
    enter();
    await released;
  });
  const pass = h.worker.runOnce();
  await entered;
  const [state] =
    await observer.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`;
  expect(state?.count).toBe(0);
  let stopped = false;
  const stop = h.worker.stop().then(() => {
    stopped = true;
  });
  try {
    await Promise.resolve();
    expect(stopped).toBe(false);
    const [healthy] = await client.sql`select 1 as healthy`;
    expect(healthy?.healthy).toBe(1);
  } finally {
    release();
    await Promise.all([pass, stop]);
  }
  expect(h.api.setThreadStatus).toHaveBeenCalledOnce();
  await h.worker.runOnce();
  expect(h.api.setThreadStatus).toHaveBeenCalledOnce();
});

it("a preparation read failure does not retain a transaction or prevent a fresh pass", async () => {
  const h = await createSlackWorkingFixture(client.database, cipher, () => clock);
  const { frame } = await h.delivery();
  await h.store.record(frame, h.context);
  const probe = faultWorker(h, "desired");
  await probe.worker.runOnce();
  const [state] =
    await observer.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`;
  expect(state?.count).toBe(0);
  expect(await target()).toMatchObject({ failures: 0, disabled: false });
  clock = new Date(clock.getTime() + WORKING_LEASE_MS + 1);
  await probe.worker.runOnce();
  expect(h.api.setThreadStatus).toHaveBeenCalledOnce();
  expect(await target()).toMatchObject({ failures: 0, disabled: false });
  await probe.worker.stop();
});

it("terminal report and working cleanup roll back together after an actual SQL timeout", async () => {
  const h = await createSlackWorkingFixture(client.database, cipher, () => clock);
  const { frame } = await h.delivery();
  await h.store.record(frame, h.context);
  const before = await target();
  const body = {
    type: "turn:report" as const,
    requestId: "00000000-0000-4000-8000-000000000001",
    deliveryId: frame.deliveryId,
    turnId: frame.turnId,
    sessionId: frame.sessionId,
    agentId: frame.agentId,
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  const report = { ...body, resultHash: computeTurnResultHash(body) };
  const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => clock });
  const unlock = await tableLock("slack_working_targets");
  let error: unknown;
  try {
    await custody.recordTurn(report, h.context);
  } catch (failure) {
    error = failure;
  } finally {
    await unlock();
  }
  expect(sqlstate(error)).toBe("57014");
  const [delivery] = await client.database
    .select()
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, frame.deliveryId));
  const [turn] = await client.database.select().from(slackWorkingTurns);
  expect(delivery).toMatchObject({ reportedAt: null, resultHash: null, turnReport: null });
  expect(delivery?.dispatchPayload).not.toBeNull();
  expect(turn?.phase).toBe("running");
  expect(await target()).toEqual(before);
  expect(await custody.recordTurn(report, h.context)).toBe("recorded");
  const [committed] = await client.database.select().from(slackWorkingTurns);
  expect(committed?.phase).toBe("terminal");
});

it("does not classify a committed settlement with a lost acknowledgement as a provider failure", async () => {
  const h = await createSlackWorkingFixture(client.database, cipher, () => clock);
  const { frame } = await h.delivery();
  await h.store.record(frame, h.context);
  let settlements = 0;
  const warn = vi.fn();
  const worker = new SlackWorkingWorker({
    store: {
      claim: () => h.store.claim(),
      desired: (target) => h.store.desired(target),
      ownsClaim: (target) => h.store.ownsClaim(target),
      settle: async (...args: Parameters<typeof h.store.settle>) => {
        settlements++;
        await h.store.settle(...args);
        throw new Error("Lost settlement acknowledgement");
      },
    },
    token: slackWorkingCredentialResolver(client.database, cipher),
    api: h.api,
    logger: { warn },
  });
  try {
    await worker.runOnce();
    expect(settlements).toBe(1);
    expect(h.api.setThreadStatus).toHaveBeenCalledOnce();
    expect(await target()).toMatchObject({ failures: 0, disabled: false, claimId: null });
    expect(warn).toHaveBeenCalledWith({ code: "SLACK_WORKING_PUMP_FAILED" }, "Slack working status pump failed");
  } finally {
    await worker.stop();
  }
});
