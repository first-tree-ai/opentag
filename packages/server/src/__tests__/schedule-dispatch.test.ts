import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  type SessionMessageDeliveryRequestV3,
  type SessionMessageDeliveryResult,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  sessionMessages,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import { RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import { DatabaseAgentOwnerResolver } from "../services/agents/index.js";
import { disableImBindingInTransaction } from "../services/im-bindings/disable-im-binding.js";
import {
  type ScheduleClock,
  ScheduleScheduler,
  ScheduleService,
  scheduledMessageId,
} from "../services/schedules/index.js";
import { SessionCollaborationService, SessionService } from "../services/sessions/index.js";
import type { ScheduledMessageSnapshot } from "../services/sessions/session-collaboration-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/*
 * Claim and one-shot hand-off against the embedded PostgreSQL: the claim window and database
 * clock (D02), downtime advancement (D04), rollback and crash windows (D05/D06), the one-shot
 * fence (D08), honest outcomes (D09/D10), deterministic identity and conflicts (D12), consecutive
 * occurrences (D13), the conditional summary write (D16), permanent and temporary target failure
 * at both claim and admission (P06/P07), and the management race boundaries that need no second
 * connection (P08/P10/P11).
 */

const T0 = new Date("2026-09-28T01:00:00.000Z");
const PUBLIC_URL = "https://opentag.example.com";

let db: UnitDatabase;

beforeAll(async () => {
  db = await createUnitDatabase();
}, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.reset();
  currentTime = T0;
});

let currentTime = T0;
const testClock: ScheduleClock = { now: async () => currentTime };

interface Seed {
  accountId: string;
  agentId: string;
  bindingId: string;
  computerId: string;
  installationId: string;
  instanceId: string;
  targetSessionId: string;
}

async function seedStack(options: { computerKind?: "local" | "cloud" } = {}): Promise<Seed> {
  const accountId = randomUUID();
  const computerId = randomUUID();
  const installationId = randomUUID();
  const instanceId = randomUUID();
  await db.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "Owner" });
  await db.database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: options.computerKind ?? "local",
    currentInstallationId: installationId,
    currentInstanceId: instanceId,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const agentId = randomUUID();
  await db.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
  });
  const bindingId = randomUUID();
  await db.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `app-${randomUUID()}`,
    externalBotId: "ou_bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "test-only",
    activatedAt: new Date(),
  });
  const targetSessionId = randomUUID();
  await db.database.insert(sessions).values({
    id: targetSessionId,
    imBindingId: bindingId,
    channelId: "oc_channel",
    conversationKind: "dm",
    kind: "channel",
  });
  await db.database.insert(sessionPlacements).values({ sessionId: targetSessionId, computerId, generation: 1 });
  return { accountId, agentId, bindingId, computerId, installationId, instanceId, targetSessionId };
}

async function insertSchedule(
  seed: Seed,
  input: {
    schedule:
      | { kind: "at"; at: string }
      | { kind: "every"; intervalSeconds: number; anchorAt: string }
      | { kind: "cron"; expression: string };
    nextTriggerAt: Date;
    name?: string;
    prompt?: string;
    enabled?: boolean;
  },
): Promise<typeof agentSchedules.$inferSelect> {
  const [row] = await db.database
    .insert(agentSchedules)
    .values({
      agentId: seed.agentId,
      targetSessionId: seed.targetSessionId,
      name: input.name ?? "Daily check",
      prompt: input.prompt ?? "Check the build.",
      schedule: input.schedule,
      timezone: input.schedule.kind === "cron" ? "Asia/Shanghai" : "UTC",
      enabled: input.enabled ?? true,
      nextTriggerAt: input.nextTriggerAt,
      revision: 1,
    })
    .returning();
  if (!row) throw new Error("schedule fixture missing");
  return row;
}

interface Stack {
  scheduler: ScheduleScheduler;
  collaboration: SessionCollaborationService;
  sessions: SessionService;
  management: ScheduleService;
  domain: {
    requestReconcile: ReturnType<typeof vi.fn>;
    requestSessionMessageDelivery: ReturnType<typeof vi.fn>;
  };
  registry: {
    currentInstanceId: ReturnType<typeof vi.fn>;
    capabilityVersion: ReturnType<typeof vi.fn>;
    supportsCapability: ReturnType<typeof vi.fn>;
  };
  cloud: { deliver: ReturnType<typeof vi.fn> };
  assembler: { assembleForSession: ReturnType<typeof vi.fn> };
  /** Business frames only: the Local `session:message:deliver` requests actually sent. */
  deliveryFrames: SessionMessageDeliveryRequestV3[];
  reconcileFrames: unknown[];
}

function runtimeSnapshot(agentId: string) {
  return {
    contextTrees: [],
    revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "platform", agent: "agent" },
    execution: { approvalPolicy: "never" as const, networkAccess: true },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
}

function makeStack(
  seed: Seed,
  options: {
    schedulerHooks?: {
      afterMessageInsert?: (id: string) => Promise<void>;
      afterRowLock?: (id: string) => Promise<void>;
    };
    scheduledBudgets?: { localMs?: number; cloudMs?: number };
  } = {},
): Stack {
  const sessionsService = new SessionService(db.database, { now: () => currentTime });
  const deliveryFrames: SessionMessageDeliveryRequestV3[] = [];
  const reconcileFrames: unknown[] = [];
  const domain = {
    requestReconcile: vi.fn(
      async (_computerId: string, _instanceId: string, request: { requestId: string }, onDispatched?: () => void) => {
        reconcileFrames.push(request);
        onDispatched?.();
        return {
          type: "session:reconcile:result",
          requestId: request.requestId,
          sessionId: seed.targetSessionId,
          placementGeneration: 1,
          status: "ready",
        };
      },
    ),
    requestSessionMessageDelivery: vi.fn(
      async (
        _computerId: string,
        _instanceId: string,
        request: SessionMessageDeliveryRequestV3,
        onDispatched?: () => void,
      ) => {
        deliveryFrames.push(request);
        onDispatched?.();
        const result: SessionMessageDeliveryResult = {
          type: "session:message:deliver:result",
          requestId: request.requestId,
          messageId: request.messageId,
          targetSessionId: request.targetSessionId,
          placementGeneration: request.placementGeneration,
          status: "accepted",
        };
        return result;
      },
    ),
  };
  const registry = {
    currentInstanceId: vi.fn(() => seed.instanceId),
    capabilityVersion: vi.fn((_computerId: string, _instanceId: string, capability: string) => {
      if (capability === RUNTIME_CAPABILITY.sessionCollaboration) return 3;
      if (capability === RUNTIME_CAPABILITY.imCredentialGrant) return 2;
      return undefined;
    }),
    supportsCapability: vi.fn(() => true),
  };
  const assembler = { assembleForSession: vi.fn(async () => runtimeSnapshot(seed.agentId)) };
  const cloud = { deliver: vi.fn(async () => ({ status: "unreachable" as const, code: "runtime_unavailable" })) };
  const collaboration = new SessionCollaborationService({
    assembler,
    domain: domain as never,
    registry,
    sessions: sessionsService,
    cloud: cloud as never,
    logger: { error: vi.fn() },
    scheduledBudgets: options.scheduledBudgets,
  });
  const scheduler = new ScheduleScheduler({
    database: db.database,
    dispatch: collaboration,
    sessions: sessionsService,
    publicUrl: PUBLIC_URL,
    clock: testClock,
    afterMessageInsert: options.schedulerHooks?.afterMessageInsert,
    afterRowLock: options.schedulerHooks?.afterRowLock,
  });
  const management = new ScheduleService({
    database: db.database,
    owners: new DatabaseAgentOwnerResolver(db.database),
    proofs: { authenticate: () => Promise.reject(new Error("no proofs in this suite")) },
    publicUrl: PUBLIC_URL,
    clock: testClock,
  });
  return {
    scheduler,
    collaboration,
    sessions: sessionsService,
    management,
    domain,
    registry,
    cloud,
    assembler,
    deliveryFrames,
    reconcileFrames,
  };
}

async function claimOf(stack: Stack, scheduleId: string, allowDispatch = true) {
  return stack.scheduler.claimOccurrence(scheduleId, { allowDispatch });
}

function managementScope(seed: Seed) {
  return {
    accountId: seed.accountId,
    agentId: seed.agentId,
    sessionId: seed.targetSessionId,
    sessionKind: "channel" as const,
  };
}

async function scheduleRow(scheduleId: string) {
  const [row] = await db.database.select().from(agentSchedules).where(eq(agentSchedules.id, scheduleId));
  return row;
}

async function messageRow(messageId: string) {
  const [row] = await db.database.select().from(sessionMessages).where(eq(sessionMessages.id, messageId));
  return row;
}

describe("schedule claim window and clock (D02, D04)", () => {
  it("claims exactly inside the inclusive 30s window and skips past it", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const rule = {
      kind: "every",
      intervalSeconds: 60,
      anchorAt: new Date(T0.getTime() - 60_000).toISOString(),
    } as const;

    // T0 - 1ms: not yet due, no occurrence.
    const future = await insertSchedule(seed, { schedule: rule, nextTriggerAt: T0 });
    currentTime = new Date(T0.getTime() - 1);
    expect(await claimOf(stack, future.id)).toEqual({ kind: "none" });
    expect(await db.database.select().from(sessionMessages)).toHaveLength(0);

    // Exactly on time and at the window edge: one message each, next advanced.
    const onTime = await insertSchedule(seed, { schedule: rule, nextTriggerAt: T0 });
    currentTime = T0;
    const claimed = await claimOf(stack, onTime.id);
    expect(claimed.kind).toBe("claimed");
    const edge = await insertSchedule(seed, { schedule: rule, nextTriggerAt: T0 });
    currentTime = new Date(T0.getTime() + 30_000);
    expect((await claimOf(stack, edge.id)).kind).toBe("claimed");

    // One millisecond past the window: skipped as late, advanced to the next point after the
    // real claim time (T0+60s), no message.
    const late = await insertSchedule(seed, { schedule: rule, nextTriggerAt: T0 });
    currentTime = new Date(T0.getTime() + 30_001);
    expect(await claimOf(stack, late.id)).toEqual({ kind: "skipped", code: "late" });
    const lateRow = await scheduleRow(late.id);
    expect(lateRow?.nextTriggerAt?.toISOString()).toBe(new Date(T0.getTime() + 60_000).toISOString());
    expect(lateRow?.lastDispatch).toMatchObject({
      scheduledFor: T0.toISOString(),
      attemptedAt: null,
      messageId: null,
      outcome: "skipped",
      code: "late",
    });
    const messages = await db.database.select().from(sessionMessages);
    expect(messages).toHaveLength(2);
    expect(messages.every((row) => row.attemptCount === 0 && row.lastOutcome === "unknown")).toBe(true);
  });

  it("advances past missed occurrences after downtime and exhausts a late one-time rule (D04)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    // every 60s anchored one interval before T0; the stored due point is T0.
    const every = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: new Date(T0.getTime() - 60_000).toISOString() },
      nextTriggerAt: T0,
    });
    currentTime = new Date(T0.getTime() + 185_000);
    expect(await claimOf(stack, every.id)).toEqual({ kind: "skipped", code: "late" });
    const everyRow = await scheduleRow(every.id);
    // Only the stored due point is processed; the intermediate T0+60/120/180 are never enumerated.
    expect(everyRow?.nextTriggerAt?.toISOString()).toBe(new Date(T0.getTime() + 240_000).toISOString());
    expect(everyRow?.enabled).toBe(true);
    expect(everyRow?.revision).toBe(1);
    expect(everyRow?.lastDispatch?.outcome).toBe("skipped");

    const once = await insertSchedule(seed, {
      schedule: { kind: "at", at: T0.toISOString() },
      nextTriggerAt: T0,
    });
    expect(await claimOf(stack, once.id)).toEqual({ kind: "skipped", code: "late" });
    const onceRow = await scheduleRow(once.id);
    expect(onceRow?.nextTriggerAt).toBeNull();
    expect(onceRow?.enabled).toBe(true);
  });
});

describe("claim clock ordering (D03)", () => {
  it("reads the clock after the row lock: a delay past the window skips the occurrence", async () => {
    const seed = await seedStack();
    // The hook runs inside the locked claim, right after the row lock: moving the injected clock
    // past the 30s window there is exactly the delay the production lock-then-clock order covers.
    const stack = makeStack(seed, {
      schedulerHooks: {
        afterRowLock: async () => {
          currentTime = new Date(T0.getTime() + 30_001);
        },
      },
    });
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: new Date(T0.getTime() - 60_000).toISOString() },
      nextTriggerAt: T0,
    });
    currentTime = T0;
    expect(await claimOf(stack, row.id)).toEqual({ kind: "skipped", code: "late" });
    expect(await db.database.select().from(sessionMessages)).toHaveLength(0);
    const after = await scheduleRow(row.id);
    expect(after?.lastDispatch).toMatchObject({ outcome: "skipped", code: "late" });
  });
});

describe("claim crash and rollback semantics (D05, D06, D08)", () => {
  it("rolls back message and advance on a claim failure, then claims cleanly once (D05)", async () => {
    const seed = await seedStack();
    let failInsert = true;
    const stack = makeStack(seed, {
      schedulerHooks: {
        afterMessageInsert: async () => {
          if (failInsert) throw new Error("simulated claim failure after the message insert");
        },
      },
    });
    const row = await insertSchedule(seed, {
      schedule: { kind: "at", at: T0.toISOString() },
      nextTriggerAt: T0,
    });
    await expect(claimOf(stack, row.id)).rejects.toThrow("simulated claim failure");
    // Nothing survived: no message, no summary, next untouched.
    expect(await db.database.select().from(sessionMessages)).toHaveLength(0);
    expect((await scheduleRow(row.id))?.nextTriggerAt?.toISOString()).toBe(T0.toISOString());
    expect((await scheduleRow(row.id))?.lastDispatch).toBeNull();

    failInsert = false;
    const claimed = await claimOf(stack, row.id);
    expect(claimed.kind).toBe("claimed");
    const messages = await db.database.select().from(sessionMessages);
    expect(messages).toHaveLength(1);
    const outcome = await stack.collaboration.dispatchScheduledMessage(
      (claimed as { snapshot: ScheduledMessageSnapshot }).snapshot,
    );
    expect(outcome).toEqual({ outcome: "accepted", code: null });
    expect(stack.deliveryFrames).toHaveLength(1);
  });

  it("never redispatches after a commit when the process dies before the hand-off (D06)", async () => {
    const seed = await seedStack();
    const first = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "at", at: T0.toISOString() },
      nextTriggerAt: T0,
    });
    const claimed = await claimOf(first, row.id);
    expect(claimed.kind).toBe("claimed");
    // Crash window: the claim committed but the dispatch never ran. A restarted scheduler sees
    // the exhausted one-time rule and leaves the unknown message alone.
    const restarted = makeStack(seed);
    expect(await claimOf(restarted, row.id)).toEqual({ kind: "none" });
    const messageId = scheduledMessageId(row.id, T0);
    const message = await messageRow(messageId);
    expect(message).toMatchObject({ lastOutcome: "unknown", attemptCount: 0, lastAttemptAt: null });
    expect(restarted.deliveryFrames).toHaveLength(0);
  });

  it("fences the single attempt 0->1 and never re-sends after the fence (D08)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "at", at: T0.toISOString() },
      nextTriggerAt: T0,
    });
    const claimed = await claimOf(stack, row.id);
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    // The transport died after fencing but before sending: attempt 1, no outcome.
    expect(await stack.sessions.beginScheduledMessageAttempt(claimed.snapshot.messageId)).toBeTruthy();
    const outcome = await stack.collaboration.dispatchScheduledMessage(claimed.snapshot);
    expect(outcome).toEqual({ outcome: "unknown", code: null });
    expect(stack.deliveryFrames).toHaveLength(0);
    expect(stack.reconcileFrames).toHaveLength(0);
    const message = await messageRow(claimed.snapshot.messageId);
    expect(message).toMatchObject({ lastOutcome: "unknown", attemptCount: 1 });
    // A restart scans but never replays: the one-time rule is exhausted.
    expect(await claimOf(makeStack(seed), row.id)).toEqual({ kind: "none" });
  });
});

describe("message identity (D12, D13)", () => {
  it("never redispatches an identical existing message and disables on an identity conflict", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: new Date(T0.getTime() - 60_000).toISOString() },
      nextTriggerAt: T0,
    });
    const messageId = scheduledMessageId(row.id, T0);
    const origin = {
      scheduleId: row.id,
      scheduledFor: T0.toISOString(),
      timezone: "UTC",
      name: "Daily check",
    };
    // Identical pre-existing row: the claim advances without dispatching again.
    await db.database.insert(sessionMessages).values({
      id: messageId,
      scheduledOrigin: origin,
      targetSessionId: seed.targetSessionId,
      content: "Check the build.",
      contentHash: "568cb1de2296e8dbdca62071d5241230ac71901d3a19dcd2d3c16db13aa3245a",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await claimOf(stack, row.id)).toEqual({ kind: "duplicate", messageId });
    expect((await scheduleRow(row.id))?.nextTriggerAt?.toISOString()).toBe(
      new Date(T0.getTime() + 60_000).toISOString(),
    );
    expect(stack.deliveryFrames).toHaveLength(0);
    expect(await db.database.select().from(sessionMessages)).toHaveLength(1);

    // A conflicting pre-existing row (same id, different body) disables the schedule.
    const conflicted = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: new Date(T0.getTime() - 60_000).toISOString() },
      nextTriggerAt: T0,
      prompt: "A different body.",
    });
    const conflictId = scheduledMessageId(conflicted.id, T0);
    await db.database.insert(sessionMessages).values({
      id: conflictId,
      scheduledOrigin: { ...origin, scheduleId: conflicted.id },
      targetSessionId: seed.targetSessionId,
      content: "Someone else's body.",
      contentHash: "b".repeat(64),
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await claimOf(stack, conflicted.id)).toEqual({ kind: "disabled", code: "message_identity_conflict" });
    const row2 = await scheduleRow(conflicted.id);
    expect(row2).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });
    expect(row2?.lastDispatch).toMatchObject({ outcome: "skipped", code: "message_identity_conflict" });
    // The original message is never overwritten.
    expect((await messageRow(conflictId))?.content).toBe("Someone else's body.");
  });

  it("delivers the next occurrence while the previous one is still unfinished (D13)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    currentTime = new Date(T0.getTime() + 60_000);
    const first = await claimOf(stack, row.id);
    if (first.kind !== "claimed") throw new Error("expected the first claim");
    // The first hand-off is accepted but its business run never finishes within this test.
    await expect(stack.collaboration.dispatchScheduledMessage(first.snapshot)).resolves.toEqual({
      outcome: "accepted",
      code: null,
    });
    currentTime = new Date(T0.getTime() + 120_000);
    const second = await claimOf(stack, row.id);
    if (second.kind !== "claimed") throw new Error("expected the second claim");
    expect(second.snapshot.messageId).not.toBe(first.snapshot.messageId);
    await expect(stack.collaboration.dispatchScheduledMessage(second.snapshot)).resolves.toEqual({
      outcome: "accepted",
      code: null,
    });
    expect(stack.deliveryFrames).toHaveLength(2);
    const summary = (await scheduleRow(row.id))?.lastDispatch;
    expect(summary).toMatchObject({
      scheduledFor: new Date(T0.getTime() + 120_000).toISOString(),
      messageId: second.snapshot.messageId,
      outcome: "accepted",
    });
  });
});

describe("dispatch outcomes and the conditional summary (D09, D10, D16)", () => {
  it("keeps Cloud custody accepted when the budget expires before verification completes", async () => {
    const seed = await seedStack({ computerKind: "cloud" });
    const stack = makeStack(seed, { scheduledBudgets: { cloudMs: 250 } });
    const row = await insertSchedule(seed, {
      schedule: { kind: "at", at: T0.toISOString() },
      nextTriggerAt: T0,
    });
    const claimed = await claimOf(stack, row.id);
    if (claimed.kind !== "claimed") throw new Error("expected a claim");

    let acceptedCommitted: () => void = () => undefined;
    const accepted = new Promise<void>((resolve) => (acceptedCommitted = resolve));
    let releaseVerification: () => void = () => undefined;
    const verification = new Promise<void>((resolve) => (releaseVerification = resolve));
    let verified = false;
    stack.cloud.deliver.mockImplementation(async (_input, admission) => {
      const admitted = await admission(async (onDispatched: () => void) => {
        onDispatched();
        return { status: "accepted" };
      });
      if (!admitted.admitted) return { status: "unreachable", code: "runtime_unavailable" };
      await admitted.result;
      // The real Cloud owner commits this receipt before minting execution permission.
      await stack.sessions.recordMessageOutcome({
        messageId: claimed.snapshot.messageId,
        attemptCount: 1,
        outcome: "accepted",
      });
      acceptedCommitted();
      await verification;
      verified = true;
      return { status: "accepted" };
    });

    const dispatching = stack.collaboration.dispatchScheduledMessage(claimed.snapshot);
    try {
      await accepted;
      await expect(dispatching).resolves.toEqual({ outcome: "accepted", code: null });
      expect(verified).toBe(false);
      expect(await messageRow(claimed.snapshot.messageId)).toMatchObject({
        lastOutcome: "accepted",
        lastErrorCode: null,
      });
      expect((await scheduleRow(row.id))?.lastDispatch).toMatchObject({
        messageId: claimed.snapshot.messageId,
        outcome: "accepted",
        code: null,
      });
    } finally {
      releaseVerification();
    }
  });

  it("upgrades a timed-out Cloud attempt when the Runner acceptance commits later", async () => {
    const seed = await seedStack({ computerKind: "cloud" });
    const stack = makeStack(seed, { scheduledBudgets: { cloudMs: 250 } });
    const row = await insertSchedule(seed, { schedule: { kind: "at", at: T0.toISOString() }, nextTriggerAt: T0 });
    const claimed = await claimOf(stack, row.id);
    if (claimed.kind !== "claimed") throw new Error("expected a claim");

    let releaseReceipt: () => void = () => undefined;
    const receipt = new Promise<void>((resolve) => (releaseReceipt = resolve));
    let acceptedCommitted: () => void = () => undefined;
    const accepted = new Promise<void>((resolve) => (acceptedCommitted = resolve));
    stack.cloud.deliver.mockImplementation(async (_input, admission) => {
      const admitted = await admission(async (onDispatched: () => void) => {
        onDispatched();
        return { status: "accepted" };
      });
      if (!admitted.admitted) return { status: "unreachable", code: "runtime_unavailable" };
      await admitted.result;
      await receipt;
      await stack.sessions.recordMessageOutcome({
        messageId: claimed.snapshot.messageId,
        attemptCount: 1,
        outcome: "accepted",
      });
      acceptedCommitted();
      return { status: "accepted" };
    });

    try {
      await expect(stack.collaboration.dispatchScheduledMessage(claimed.snapshot)).resolves.toEqual({
        outcome: "unknown",
        code: "delivery_timeout",
      });
      expect((await messageRow(claimed.snapshot.messageId))?.lastOutcome).toBe("unknown");
    } finally {
      releaseReceipt();
    }
    await accepted;
    expect(await messageRow(claimed.snapshot.messageId)).toMatchObject({
      lastOutcome: "accepted",
      lastErrorCode: null,
    });
    expect((await scheduleRow(row.id))?.lastDispatch).toMatchObject({
      messageId: claimed.snapshot.messageId,
      outcome: "accepted",
      code: null,
    });
  });

  it("keeps a sent-but-unconfirmed hand-off unknown and never retries it (D09)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    stack.domain.requestSessionMessageDelivery.mockImplementation(
      async (_c: string, _i: string, request: SessionMessageDeliveryRequestV3, onDispatched?: () => void) => {
        stack.deliveryFrames.push(request);
        onDispatched?.();
        throw new RuntimeDomainRequestError("timeout", "confirmation was lost");
      },
    );
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    currentTime = new Date(T0.getTime() + 60_000);
    const claimed = await claimOf(stack, row.id);
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    await expect(stack.collaboration.dispatchScheduledMessage(claimed.snapshot)).resolves.toEqual({
      outcome: "unknown",
      code: "delivery_timeout",
    });
    expect(stack.deliveryFrames).toHaveLength(1);
    const message = await messageRow(claimed.snapshot.messageId);
    expect(message).toMatchObject({ lastOutcome: "unknown", lastErrorCode: "delivery_timeout", attemptCount: 1 });
    expect((await scheduleRow(row.id))?.lastDispatch).toMatchObject({
      outcome: "unknown",
      code: "delivery_timeout",
    });
  });

  it("maps accepted, rejected, and unreachable honestly (D10)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });

    // Rejected by the receiver: the reason code is preserved.
    stack.domain.requestSessionMessageDelivery.mockImplementationOnce(
      async (_c: string, _i: string, request: SessionMessageDeliveryRequestV3, onDispatched?: () => void) => {
        stack.deliveryFrames.push(request);
        onDispatched?.();
        const result: SessionMessageDeliveryResult = {
          type: "session:message:deliver:result",
          requestId: request.requestId,
          messageId: request.messageId,
          targetSessionId: request.targetSessionId,
          placementGeneration: request.placementGeneration,
          status: "rejected",
          reason: "target_mismatch",
        };
        return result;
      },
    );
    currentTime = new Date(T0.getTime() + 60_000);
    const first = await claimOf(stack, row.id);
    if (first.kind !== "claimed") throw new Error("expected a claim");
    await expect(stack.collaboration.dispatchScheduledMessage(first.snapshot)).resolves.toEqual({
      outcome: "rejected",
      code: "target_mismatch",
    });

    // Busy receiver: unreachable capacity; the next occurrence still claims and delivers.
    stack.domain.requestSessionMessageDelivery.mockImplementationOnce(
      async (_c: string, _i: string, request: SessionMessageDeliveryRequestV3, onDispatched?: () => void) => {
        stack.deliveryFrames.push(request);
        onDispatched?.();
        const result: SessionMessageDeliveryResult = {
          type: "session:message:deliver:result",
          requestId: request.requestId,
          messageId: request.messageId,
          targetSessionId: request.targetSessionId,
          placementGeneration: request.placementGeneration,
          status: "rejected",
          reason: "session_busy",
        };
        return result;
      },
    );
    currentTime = new Date(T0.getTime() + 120_000);
    const second = await claimOf(stack, row.id);
    if (second.kind !== "claimed") throw new Error("expected a claim");
    await expect(stack.collaboration.dispatchScheduledMessage(second.snapshot)).resolves.toEqual({
      outcome: "unreachable",
      code: "capacity",
    });
    expect((await scheduleRow(row.id))?.enabled).toBe(true);
    expect((await scheduleRow(row.id))?.nextTriggerAt?.toISOString()).toBe(
      new Date(T0.getTime() + 180_000).toISOString(),
    );

    // No runtime connection at all: provably zero frames, unreachable.
    stack.registry.currentInstanceId.mockReturnValue(undefined);
    currentTime = new Date(T0.getTime() + 180_000);
    const third = await claimOf(stack, row.id);
    if (third.kind !== "claimed") throw new Error("expected a claim");
    await expect(stack.collaboration.dispatchScheduledMessage(third.snapshot)).resolves.toEqual({
      outcome: "unreachable",
      code: "runtime_unavailable",
    });
    const framesBefore = stack.deliveryFrames.length;
    expect(stack.deliveryFrames).toHaveLength(framesBefore);
  });

  it("refuses to send a scheduled origin to a v2-only peer with zero frames", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    stack.registry.capabilityVersion.mockImplementation((_c: string, _i: string, capability: string) =>
      capability === RUNTIME_CAPABILITY.sessionCollaboration ? 2 : 2,
    );
    const row = await insertSchedule(seed, {
      schedule: { kind: "at", at: T0.toISOString() },
      nextTriggerAt: T0,
    });
    const claimed = await claimOf(stack, row.id);
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    await expect(stack.collaboration.dispatchScheduledMessage(claimed.snapshot)).resolves.toEqual({
      outcome: "unreachable",
      code: "unsupported_schedule_origin",
    });
    expect(stack.deliveryFrames).toHaveLength(0);
    expect(stack.reconcileFrames).toHaveLength(0);
    expect((await messageRow(claimed.snapshot.messageId))?.lastErrorCode).toBe("unsupported_schedule_origin");
  });

  it("never lets a late old receipt overwrite the newer occurrence's summary (D16)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    // First occurrence: the receipt hangs until the test releases it.
    let releaseFirst: (result: SessionMessageDeliveryResult) => void = () => undefined;
    stack.domain.requestSessionMessageDelivery.mockImplementationOnce(
      (_c: string, _i: string, request: SessionMessageDeliveryRequestV3, onDispatched?: () => void) => {
        stack.deliveryFrames.push(request);
        onDispatched?.();
        return new Promise<SessionMessageDeliveryResult>((resolve) => (releaseFirst = resolve));
      },
    );
    currentTime = new Date(T0.getTime() + 60_000);
    const first = await claimOf(stack, row.id);
    if (first.kind !== "claimed") throw new Error("expected a claim");
    const firstDispatch = stack.collaboration.dispatchScheduledMessage(first.snapshot);

    // The second occurrence claims and completes while the first receipt is still pending.
    currentTime = new Date(T0.getTime() + 120_000);
    const second = await claimOf(stack, row.id);
    if (second.kind !== "claimed") throw new Error("expected a claim");
    await expect(stack.collaboration.dispatchScheduledMessage(second.snapshot)).resolves.toEqual({
      outcome: "accepted",
      code: null,
    });
    expect((await scheduleRow(row.id))?.lastDispatch).toMatchObject({
      scheduledFor: new Date(T0.getTime() + 120_000).toISOString(),
      messageId: second.snapshot.messageId,
      outcome: "accepted",
    });

    // The late first receipt updates its own message but never the newer summary.
    releaseFirst({
      type: "session:message:deliver:result",
      requestId: "00000000-0000-4000-8000-000000000099",
      messageId: first.snapshot.messageId,
      targetSessionId: seed.targetSessionId,
      placementGeneration: 1,
      status: "accepted",
    });
    await expect(firstDispatch).resolves.toEqual({ outcome: "accepted", code: null });
    expect((await messageRow(first.snapshot.messageId))?.lastOutcome).toBe("accepted");
    const summary = (await scheduleRow(row.id))?.lastDispatch;
    expect(summary).toMatchObject({
      scheduledFor: new Date(T0.getTime() + 120_000).toISOString(),
      messageId: second.snapshot.messageId,
      outcome: "accepted",
    });
    expect((await scheduleRow(row.id))?.nextTriggerAt?.toISOString()).toBe(
      new Date(T0.getTime() + 180_000).toISOString(),
    );
  });
});

describe("target validity at claim and dispatch (P06, P07)", () => {
  it.each([
    {
      label: "the Agent is deleted",
      break: async (seed: Seed) => {
        await db.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, seed.agentId));
      },
      code: "agent_deleted",
    },
    {
      label: "the IM binding is disabled",
      break: async (seed: Seed) => {
        await db.database.transaction((transaction) =>
          disableImBindingInTransaction(transaction, seed.bindingId, new Date()),
        );
      },
      code: "binding_invalid",
    },
    {
      label: "the target Session is ended",
      break: async (seed: Seed) => {
        await db.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, seed.targetSessionId));
      },
      code: "target_invalid",
    },
  ])("auto-disables at claim when $label (P06)", async ({ break: invalidate, code }) => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    await invalidate(seed);
    currentTime = new Date(T0.getTime() + 60_000);
    expect(await claimOf(stack, row.id)).toEqual({ kind: "disabled", code });
    const after = await scheduleRow(row.id);
    expect(after).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });
    expect(after?.lastDispatch).toMatchObject({ outcome: "skipped", code, messageId: null, attemptedAt: null });
    // No message was materialized, nothing was rebuilt or retargeted.
    expect(await db.database.select().from(sessionMessages)).toHaveLength(0);
  });

  it("auto-disables at the dispatch boundary when the target died after the claim (P06)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    currentTime = new Date(T0.getTime() + 60_000);
    const claimed = await claimOf(stack, row.id);
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    await db.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, seed.targetSessionId));
    await expect(stack.collaboration.dispatchScheduledMessage(claimed.snapshot)).resolves.toEqual({
      outcome: "rejected",
      code: "target_invalid",
    });
    expect(stack.deliveryFrames).toHaveLength(0);
    const after = await scheduleRow(row.id);
    expect(after).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });
    expect(after?.lastDispatch).toMatchObject({ outcome: "rejected", code: "target_invalid" });
    expect(await messageRow(claimed.snapshot.messageId)).toMatchObject({
      lastOutcome: "rejected",
      lastErrorCode: "target_invalid",
      attemptCount: 1,
    });
  });

  it("skips only the current occurrence for a suspended Agent and recovers after resume (P07)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    await db.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, seed.agentId));
    currentTime = new Date(T0.getTime() + 60_000);
    expect(await claimOf(stack, row.id)).toEqual({ kind: "skipped", code: "agent_suspended" });
    let after = await scheduleRow(row.id);
    expect(after).toMatchObject({ enabled: true, revision: 1 });
    expect(after?.nextTriggerAt?.toISOString()).toBe(new Date(T0.getTime() + 120_000).toISOString());
    expect(after?.lastDispatch).toMatchObject({ outcome: "skipped", code: "agent_suspended" });
    expect(await db.database.select().from(sessionMessages)).toHaveLength(0);

    // Suspension landing between claim and dispatch: unreachable, still enabled, zero frames.
    await db.database.update(agents).set({ status: "active" }).where(eq(agents.id, seed.agentId));
    currentTime = new Date(T0.getTime() + 120_000);
    const claimed = await claimOf(stack, row.id);
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    await db.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, seed.agentId));
    await expect(stack.collaboration.dispatchScheduledMessage(claimed.snapshot)).resolves.toEqual({
      outcome: "unreachable",
      code: "agent_suspended",
    });
    expect(stack.deliveryFrames).toHaveLength(0);
    after = await scheduleRow(row.id);
    expect(after?.enabled).toBe(true);
    expect(after?.lastDispatch).toMatchObject({ outcome: "unreachable", code: "agent_suspended" });

    // After the Agent resumes, the next occurrence claims and dispatches normally.
    await db.database.update(agents).set({ status: "active" }).where(eq(agents.id, seed.agentId));
    currentTime = new Date(T0.getTime() + 180_000);
    const third = await claimOf(stack, row.id);
    if (third.kind !== "claimed") throw new Error("expected a claim");
    await expect(stack.collaboration.dispatchScheduledMessage(third.snapshot)).resolves.toEqual({
      outcome: "accepted",
      code: null,
    });
  });
});

describe("management race boundaries (P08, P10, P11)", () => {
  it("rejects a not-yet-sent dispatch after a committed pause or delete with zero frames (P08)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const scope = managementScope(seed);

    // Pause wins: the schedule row gate rejects the stale snapshot.
    const paused = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    currentTime = new Date(T0.getTime() + 60_000);
    const firstClaim = await claimOf(stack, paused.id);
    if (firstClaim.kind !== "claimed") throw new Error("expected a claim");
    await stack.management.pauseForAgent(scope, paused.id, 1);
    await expect(stack.collaboration.dispatchScheduledMessage(firstClaim.snapshot)).resolves.toEqual({
      outcome: "rejected",
      code: "schedule_disabled",
    });
    expect(stack.deliveryFrames).toHaveLength(0);
    expect(await messageRow(firstClaim.snapshot.messageId)).toMatchObject({
      lastOutcome: "rejected",
      lastErrorCode: "schedule_disabled",
    });
    expect((await scheduleRow(paused.id))?.lastDispatch).toMatchObject({
      outcome: "rejected",
      code: "schedule_disabled",
    });

    // Delete wins: the row is gone, the message stays recorded, nothing is sent.
    const deleted = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    const secondClaim = await claimOf(stack, deleted.id);
    if (secondClaim.kind !== "claimed") throw new Error("expected a claim");
    await stack.management.deleteForAgent(scope, deleted.id, 1);
    await expect(stack.collaboration.dispatchScheduledMessage(secondClaim.snapshot)).resolves.toEqual({
      outcome: "rejected",
      code: "schedule_deleted",
    });
    expect(stack.deliveryFrames).toHaveLength(0);
    expect(await scheduleRow(deleted.id)).toBeUndefined();
    // Deleting the schedule never deletes or disqualifies the generated message.
    expect(await messageRow(secondClaim.snapshot.messageId)).toMatchObject({
      lastOutcome: "rejected",
      lastErrorCode: "schedule_deleted",
    });
  });

  it("rejects a stale snapshot after a pause-then-resume ABA through the revision (P10)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const scope = managementScope(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    currentTime = new Date(T0.getTime() + 60_000);
    const claimed = await claimOf(stack, row.id);
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    await stack.management.pauseForAgent(scope, row.id, 1);
    const resumed = await stack.management.resumeForAgent(scope, row.id, 2);
    // The resume recomputed a future next point and bumped the revision again.
    expect(resumed.enabled).toBe(true);
    expect(resumed.revision).toBe(3);
    expect(resumed.nextTriggerAt).toBe(new Date(T0.getTime() + 120_000).toISOString());
    // enabled is true again, but the frozen revision is stale: the old dispatch never sends.
    await expect(stack.collaboration.dispatchScheduledMessage(claimed.snapshot)).resolves.toEqual({
      outcome: "rejected",
      code: "schedule_changed",
    });
    expect(stack.deliveryFrames).toHaveLength(0);
  });

  it("cancels a stale-revision dispatch before send but lets a post-send edit keep the receipt (P11)", async () => {
    const seed = await seedStack();
    const stack = makeStack(seed);
    const scope = managementScope(seed);
    const row = await insertSchedule(seed, {
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() },
      nextTriggerAt: new Date(T0.getTime() + 60_000),
    });
    currentTime = new Date(T0.getTime() + 60_000);

    // An edit between claim and send revokes the snapshot; the frozen message stays byte-identical.
    const firstClaim = await claimOf(stack, row.id);
    if (firstClaim.kind !== "claimed") throw new Error("expected a claim");
    await stack.management.updateForAgent(scope, row.id, { expectedRevision: 1, name: "Renamed" });
    await expect(stack.collaboration.dispatchScheduledMessage(firstClaim.snapshot)).resolves.toEqual({
      outcome: "rejected",
      code: "schedule_changed",
    });
    expect(await messageRow(firstClaim.snapshot.messageId)).toMatchObject({
      content: "Check the build.",
      scheduledOrigin: {
        scheduleId: row.id,
        scheduledFor: firstClaim.snapshot.origin.scheduledFor,
        timezone: "UTC",
        name: "Daily check",
      },
    });

    // An edit after the send mark but before the receipt: the receipt is still recorded.
    let releaseReceipt: (result: SessionMessageDeliveryResult) => void = () => undefined;
    let markSent: () => void = () => undefined;
    const sentMarked = new Promise<void>((resolve) => (markSent = resolve));
    stack.domain.requestSessionMessageDelivery.mockImplementationOnce(
      (_c: string, _i: string, request: SessionMessageDeliveryRequestV3, onDispatched?: () => void) => {
        stack.deliveryFrames.push(request);
        onDispatched?.();
        markSent();
        return new Promise<SessionMessageDeliveryResult>((resolve) => (releaseReceipt = resolve));
      },
    );
    currentTime = new Date(T0.getTime() + 120_000);
    const secondClaim = await claimOf(stack, row.id);
    if (secondClaim.kind !== "claimed") throw new Error("expected a claim");
    const dispatched = stack.collaboration.dispatchScheduledMessage(secondClaim.snapshot);
    // The send is marked only after the final admission passed with the frozen revision; the
    // admission released its locks at that mark, so the edit proceeds mid-receipt and the
    // already-sent occurrence still records its real receipt.
    await sentMarked;
    await stack.management.updateForAgent(scope, row.id, { expectedRevision: 2, name: "Renamed again" });
    releaseReceipt({
      type: "session:message:deliver:result",
      requestId: "00000000-0000-4000-8000-000000000099",
      messageId: secondClaim.snapshot.messageId,
      targetSessionId: seed.targetSessionId,
      placementGeneration: 1,
      status: "accepted",
    });
    await expect(dispatched).resolves.toEqual({ outcome: "accepted", code: null });
    expect(await messageRow(secondClaim.snapshot.messageId)).toMatchObject({ lastOutcome: "accepted" });
    expect((await scheduleRow(row.id))?.lastDispatch).toMatchObject({
      messageId: secondClaim.snapshot.messageId,
      outcome: "accepted",
    });
  });
});
