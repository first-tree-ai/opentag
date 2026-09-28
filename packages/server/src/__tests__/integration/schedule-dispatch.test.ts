import { randomUUID } from "node:crypto";
import type { SessionMessageDeliveryRequestV3, SessionMessageDeliveryResult } from "@opentag/shared";
import { eq, sql as sqlTag } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  sessionMessages,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { PostgresRuntimeExecutionAuthority } from "../../runtime-credentials/execution-authority.js";
import { RuntimeValidationRunRegistry } from "../../runtime-credentials/validation-runs.js";
import { DatabaseAgentOwnerResolver } from "../../services/agents/index.js";
import { ScheduleScheduler, ScheduleService, scheduledMessageId } from "../../services/schedules/index.js";
import { SessionCollaborationService, SessionService } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/*
 * Real-PostgreSQL schedule dispatch proofs that need true concurrency: the locked claim reads the
 * database clock only after the row lock (D03), two concurrent claims of one row (D11), the
 * dispatch-wins ordering against pause (P09), the multi-party lock-order smoke (P12), and the
 * execution-credential boundary for scheduled messages (P13/P14).
 */

const PUBLIC_URL = "https://opentag.example.com";

let testDatabase: MigratedTestDatabase;
let clientA: { database: DatabaseClient; sql: ReturnType<typeof createDatabaseClient>["sql"] };
let clientB: { database: DatabaseClient; sql: ReturnType<typeof createDatabaseClient>["sql"] };

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDatabase.stop();
});

beforeEach(async () => {
  await testDatabase.reset();
  clientA = createDatabaseClient(testDatabase.databaseUrl);
  clientB = createDatabaseClient(testDatabase.databaseUrl);
});

afterEach(async () => {
  await clientA.sql.end();
  await clientB.sql.end();
});

interface Seed {
  accountId: string;
  agentId: string;
  bindingId: string;
  computerId: string;
  installationId: string;
  instanceId: string;
  targetSessionId: string;
}

async function seed(database: DatabaseClient): Promise<Seed> {
  const accountId = randomUUID();
  const computerId = randomUUID();
  const installationId = randomUUID();
  const instanceId = randomUUID();
  await database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "Owner" });
  await database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: "local",
    currentInstallationId: installationId,
    currentInstanceId: instanceId,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const agentId = randomUUID();
  await database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
  });
  const bindingId = randomUUID();
  await database.insert(imBindings).values({
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
  await database.insert(sessions).values({
    id: targetSessionId,
    imBindingId: bindingId,
    channelId: "oc_channel",
    conversationKind: "dm",
    kind: "channel",
  });
  await database.insert(sessionPlacements).values({ sessionId: targetSessionId, computerId, generation: 1 });
  return { accountId, agentId, bindingId, computerId, installationId, instanceId, targetSessionId };
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

interface DispatchStack {
  collaboration: SessionCollaborationService;
  sessions: SessionService;
  deliveryFrames: SessionMessageDeliveryRequestV3[];
  /** Gate the business send: the fake holds the receipt until released. */
  holdReceipts: boolean;
  releaseReceipts(): void;
  /** Resolves once the next business frame is actually sent and marked. */
  nextSendMarked(): Promise<void>;
  domain: {
    requestReconcile: ReturnType<typeof vi.fn>;
    requestSessionMessageDelivery: ReturnType<typeof vi.fn>;
  };
}

function makeDispatchStack(database: DatabaseClient, seedValue: Seed): DispatchStack {
  const sessionsService = new SessionService(database);
  const deliveryFrames: SessionMessageDeliveryRequestV3[] = [];
  const pendingReceipts: Array<(result: SessionMessageDeliveryResult) => void> = [];
  const sendMarks: Array<() => void> = [];
  const stack: DispatchStack = {
    collaboration: undefined as unknown as SessionCollaborationService,
    sessions: sessionsService,
    deliveryFrames,
    holdReceipts: false,
    releaseReceipts() {
      for (const release of pendingReceipts.splice(0)) {
        release({
          type: "session:message:deliver:result",
          requestId: randomUUID(),
          messageId: randomUUID(),
          targetSessionId: seedValue.targetSessionId,
          placementGeneration: 1,
          status: "accepted",
        });
      }
    },
    nextSendMarked() {
      return new Promise((resolve) => sendMarks.push(resolve));
    },
    domain: {
      requestReconcile: vi.fn(
        async (_c: string, _i: string, request: { requestId: string }, onDispatched?: () => void) => {
          onDispatched?.();
          return {
            type: "session:reconcile:result",
            requestId: request.requestId,
            sessionId: seedValue.targetSessionId,
            placementGeneration: 1,
            status: "ready",
          };
        },
      ),
      requestSessionMessageDelivery: vi.fn(
        (_c: string, _i: string, request: SessionMessageDeliveryRequestV3, onDispatched?: () => void) => {
          deliveryFrames.push(request);
          onDispatched?.();
          for (const mark of sendMarks.splice(0)) mark();
          const accept = {
            type: "session:message:deliver:result" as const,
            requestId: request.requestId,
            messageId: request.messageId,
            targetSessionId: request.targetSessionId,
            placementGeneration: request.placementGeneration,
            status: "accepted" as const,
          };
          if (!stack.holdReceipts) return Promise.resolve(accept);
          return new Promise<SessionMessageDeliveryResult>((resolve) => pendingReceipts.push(() => resolve(accept)));
        },
      ),
    },
  };
  stack.collaboration = new SessionCollaborationService({
    assembler: { assembleForSession: vi.fn(async () => runtimeSnapshot(seedValue.agentId)) },
    domain: stack.domain as never,
    registry: {
      currentInstanceId: vi.fn(() => seedValue.instanceId),
      capabilityVersion: vi.fn((_c: string, _i: string, capability: string) => {
        if (capability === "runtime.sessionCollaboration") return 3;
        if (capability === "runtime.imCredentialGrant") return 2;
        return undefined;
      }),
      supportsCapability: vi.fn(() => true),
    } as never,
    sessions: sessionsService,
    logger: { error: vi.fn() },
  });
  return stack;
}

describe("schedule claim against the real database clock", () => {
  it("samples the production database clock inside the locked claim (D03 production half)", async () => {
    const seedValue = await seed(clientA.database);
    const sessionsService = new SessionService(clientA.database);
    const dispatch = { dispatchScheduledMessage: vi.fn(async () => ({ outcome: "accepted" as const, code: null })) };
    // No clock injection: the production adapter reads PostgreSQL `clock_timestamp()`.
    const scheduler = new ScheduleScheduler({
      database: clientA.database,
      dispatch: dispatch as never,
      sessions: sessionsService,
      publicUrl: PUBLIC_URL,
    });
    const [nowRow] = await clientA.database.execute<{ at: Date }>(sqlTag`select clock_timestamp() as at`);
    if (!nowRow) throw new Error("database clock missing");
    const scheduledFor = new Date(nowRow.at);
    const [row] = await clientA.database
      .insert(agentSchedules)
      .values({
        agentId: seedValue.agentId,
        targetSessionId: seedValue.targetSessionId,
        name: "Daily check",
        prompt: "Check the build.",
        schedule: { kind: "every", intervalSeconds: 60, anchorAt: scheduledFor.toISOString() },
        timezone: "UTC",
        enabled: true,
        nextTriggerAt: scheduledFor,
        revision: 1,
      })
      .returning();
    if (!row) throw new Error("schedule fixture missing");
    const claimed = await scheduler.claimOccurrence(row.id, { allowDispatch: true });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    // The claim time is the database clock, within a couple of seconds of the real now.
    expect(Math.abs(claimed.snapshot.attemptedAt.getTime() - Date.now())).toBeLessThan(5_000);
    const [after] = await clientA.database.select().from(agentSchedules).where(eq(agentSchedules.id, row.id));
    expect(after?.lastDispatch?.attemptedAt).toBe(claimed.snapshot.attemptedAt.toISOString());

    // And a row due 31s in the real past is honestly late for the production adapter.
    const past = new Date(Date.now() - 31_000);
    const [staleRow] = await clientA.database
      .insert(agentSchedules)
      .values({
        agentId: seedValue.agentId,
        targetSessionId: seedValue.targetSessionId,
        name: "Daily check",
        prompt: "Check the build.",
        schedule: { kind: "every", intervalSeconds: 60, anchorAt: past.toISOString() },
        timezone: "UTC",
        enabled: true,
        nextTriggerAt: past,
        revision: 1,
      })
      .returning();
    if (!staleRow) throw new Error("schedule fixture missing");
    await expect(scheduler.claimOccurrence(staleRow.id, { allowDispatch: true })).resolves.toEqual({
      kind: "skipped",
      code: "late",
    });
  }, 20_000);

  it("lets exactly one of two concurrent claims insert the occurrence message (D11)", async () => {
    const seedValue = await seed(clientA.database);
    const sessionsService = new SessionService(clientA.database);
    const dispatch = { dispatchScheduledMessage: vi.fn(async () => ({ outcome: "accepted" as const, code: null })) };
    const schedulerA = new ScheduleScheduler({
      database: clientA.database,
      dispatch,
      sessions: new SessionService(clientA.database),
      publicUrl: PUBLIC_URL,
    });
    const schedulerB = new ScheduleScheduler({
      database: clientB.database,
      dispatch,
      sessions: new SessionService(clientB.database),
      publicUrl: PUBLIC_URL,
    });
    const [nowRow] = await clientA.database.execute<{ at: Date }>(sqlTag`select clock_timestamp() as at`);
    if (!nowRow) throw new Error("database clock missing");
    const scheduledFor = new Date(nowRow.at);
    const [row] = await clientA.database
      .insert(agentSchedules)
      .values({
        agentId: seedValue.agentId,
        targetSessionId: seedValue.targetSessionId,
        name: "Daily check",
        prompt: "Check the build.",
        schedule: { kind: "every", intervalSeconds: 60, anchorAt: scheduledFor.toISOString() },
        timezone: "UTC",
        enabled: true,
        nextTriggerAt: scheduledFor,
        revision: 1,
      })
      .returning();
    if (!row) throw new Error("schedule fixture missing");
    const [first, second] = await Promise.all([
      schedulerA.claimOccurrence(row.id, { allowDispatch: true }),
      schedulerB.claimOccurrence(row.id, { allowDispatch: true }),
    ]);
    const outcomes = [first.kind, second.kind].sort();
    // SKIP LOCKED: the loser sees nothing; only the winner ever materializes the message.
    expect(outcomes).toEqual(["claimed", "none"]);
    const messages = await clientA.database.select().from(sessionMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(scheduledMessageId(row.id, scheduledFor));
    expect(sessionsService).toBeDefined();
  }, 20_000);
});

describe("dispatch admission races against management mutations", () => {
  it("lets a committed send finish before a waiting pause, then pauses (P09)", async () => {
    const seedValue = await seed(clientA.database);
    const stack = makeDispatchStack(clientA.database, seedValue);
    const management = new ScheduleService({
      database: clientA.database,
      owners: new DatabaseAgentOwnerResolver(clientA.database),
      proofs: { authenticate: () => Promise.reject(new Error("no proofs in this suite")) },
      publicUrl: PUBLIC_URL,
    });
    const scheduler = new ScheduleScheduler({
      database: clientA.database,
      dispatch: stack.collaboration,
      sessions: stack.sessions,
      publicUrl: PUBLIC_URL,
    });
    const [nowRow] = await clientA.database.execute<{ at: Date }>(sqlTag`select clock_timestamp() as at`);
    if (!nowRow) throw new Error("database clock missing");
    const scheduledFor = new Date(nowRow.at);
    const [row] = await clientA.database
      .insert(agentSchedules)
      .values({
        agentId: seedValue.agentId,
        targetSessionId: seedValue.targetSessionId,
        name: "Daily check",
        prompt: "Check the build.",
        schedule: { kind: "every", intervalSeconds: 60, anchorAt: scheduledFor.toISOString() },
        timezone: "UTC",
        enabled: true,
        nextTriggerAt: scheduledFor,
        revision: 1,
      })
      .returning();
    if (!row) throw new Error("schedule fixture missing");
    const claimed = await scheduler.claimOccurrence(row.id, { allowDispatch: true });
    if (claimed.kind !== "claimed") throw new Error("expected a claim");

    stack.holdReceipts = true;
    const sendMarked = stack.nextSendMarked();
    const dispatching = stack.collaboration.dispatchScheduledMessage(claimed.snapshot);
    // Wait until the final admission passed and the frame is marked sent: the pause can then only
    // queue behind the send mark, never prevent it.
    await sendMarked;
    let pauseSettled = false;
    const scope = {
      accountId: seedValue.accountId,
      agentId: seedValue.agentId,
      sessionId: seedValue.targetSessionId,
      sessionKind: "channel" as const,
    };
    const pausing = management.pauseForAgent(scope, row.id, 1).then(() => {
      pauseSettled = true;
    });
    // The mutation waits through the send marking only: settle the receipt, then both finish.
    expect(pauseSettled).toBe(false);
    stack.releaseReceipts();
    await expect(dispatching).resolves.toEqual({ outcome: "accepted", code: null });
    await pausing;
    expect(pauseSettled).toBe(true);
    expect(stack.deliveryFrames).toHaveLength(1);
    const [message] = await clientA.database
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.id, claimed.snapshot.messageId));
    expect(message).toMatchObject({ lastOutcome: "accepted" });
    const [schedule] = await clientA.database.select().from(agentSchedules).where(eq(agentSchedules.id, row.id));
    expect(schedule).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });
    // The summary still points at this occurrence, so the accepted receipt lands in it.
    expect(schedule?.lastDispatch).toMatchObject({ outcome: "accepted", messageId: claimed.snapshot.messageId });
  }, 20_000);

  it("never deadlocks claim, dispatch admission, pause, and placement moves together (P12)", async () => {
    const seedValue = await seed(clientA.database);
    // A second Computer so the placement move has somewhere to go.
    const computerB = randomUUID();
    await clientA.database.insert(computers).values({
      id: computerB,
      ownerAccountId: seedValue.accountId,
      kind: "local",
      currentInstallationId: randomUUID(),
      currentInstanceId: randomUUID(),
      displayName: "second",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    });
    const stack = makeDispatchStack(clientA.database, seedValue);
    const management = new ScheduleService({
      database: clientA.database,
      owners: new DatabaseAgentOwnerResolver(clientA.database),
      proofs: { authenticate: () => Promise.reject(new Error("no proofs in this suite")) },
      publicUrl: PUBLIC_URL,
    });
    const scheduler = new ScheduleScheduler({
      database: clientA.database,
      dispatch: stack.collaboration,
      sessions: stack.sessions,
      publicUrl: PUBLIC_URL,
    });
    const [nowRow] = await clientA.database.execute<{ at: Date }>(sqlTag`select clock_timestamp() as at`);
    if (!nowRow) throw new Error("database clock missing");
    const scheduledFor = new Date(nowRow.at);
    const makeSchedule = async (name: string) => {
      const [row] = await clientA.database
        .insert(agentSchedules)
        .values({
          agentId: seedValue.agentId,
          targetSessionId: seedValue.targetSessionId,
          name,
          prompt: "Check the build.",
          schedule: { kind: "every", intervalSeconds: 60, anchorAt: scheduledFor.toISOString() },
          timezone: "UTC",
          enabled: true,
          nextTriggerAt: scheduledFor,
          revision: 1,
        })
        .returning();
      if (!row) throw new Error("schedule fixture missing");
      return row;
    };
    const first = await makeSchedule("First");
    const second = await makeSchedule("Second");
    const claimed = await scheduler.claimOccurrence(first.id, { allowDispatch: true });
    if (claimed.kind !== "claimed") throw new Error("expected a claim");

    stack.holdReceipts = true;
    const sendMarked = stack.nextSendMarked();
    const dispatching = stack.collaboration.dispatchScheduledMessage(claimed.snapshot);
    await sendMarked;
    const scope = {
      accountId: seedValue.accountId,
      agentId: seedValue.agentId,
      sessionId: seedValue.targetSessionId,
      sessionKind: "channel" as const,
    };
    // Every party runs at once: the dispatch holds its admission until the send mark, the pause
    // and the placement move queue behind the shared lock order, and an unrelated claim proceeds.
    const pausing = management.pauseForAgent(scope, first.id, 1);
    const moving = stack.sessions.movePlacement(seedValue.targetSessionId, computerB);
    const secondClaim = scheduler.claimOccurrence(second.id, { allowDispatch: true });
    stack.releaseReceipts();
    const [dispatchOutcome, , , otherClaim] = await Promise.all([dispatching, pausing, moving, secondClaim]);
    expect(dispatchOutcome).toEqual({ outcome: "accepted", code: null });
    expect(otherClaim.kind).toBe("claimed");
    const [firstRow] = await clientA.database.select().from(agentSchedules).where(eq(agentSchedules.id, first.id));
    expect(firstRow?.enabled).toBe(false);
    const [placement] = await clientA.database
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, seedValue.targetSessionId));
    expect(placement).toMatchObject({ computerId: computerB, generation: 2 });
    expect(stack.deliveryFrames).toHaveLength(1);
  }, 30_000);
});

describe("execution authority for scheduled messages (P13, P14)", () => {
  async function authorityFor(database: DatabaseClient) {
    return new PostgresRuntimeExecutionAuthority({
      database,
      custody: new PostgresRuntimeCustodyStore(database),
      validationRuns: new RuntimeValidationRunRegistry(),
    });
  }

  it("keeps accepted scheduled work executable after the schedule is deleted, but never by a foreign identity", async () => {
    const seedValue = await seed(clientA.database);
    const stack = makeDispatchStack(clientA.database, seedValue);
    const management = new ScheduleService({
      database: clientA.database,
      owners: new DatabaseAgentOwnerResolver(clientA.database),
      proofs: { authenticate: () => Promise.reject(new Error("no proofs in this suite")) },
      publicUrl: PUBLIC_URL,
    });
    const scheduler = new ScheduleScheduler({
      database: clientA.database,
      dispatch: stack.collaboration,
      sessions: stack.sessions,
      publicUrl: PUBLIC_URL,
    });
    const [nowRow] = await clientA.database.execute<{ at: Date }>(sqlTag`select clock_timestamp() as at`);
    if (!nowRow) throw new Error("database clock missing");
    const scheduledFor = new Date(nowRow.at);
    const [row] = await clientA.database
      .insert(agentSchedules)
      .values({
        agentId: seedValue.agentId,
        targetSessionId: seedValue.targetSessionId,
        name: "Daily check",
        prompt: "Check the build.",
        schedule: { kind: "every", intervalSeconds: 60, anchorAt: scheduledFor.toISOString() },
        timezone: "UTC",
        enabled: true,
        nextTriggerAt: scheduledFor,
        revision: 1,
      })
      .returning();
    if (!row) throw new Error("schedule fixture missing");
    const claimed = await scheduler.claimOccurrence(row.id, { allowDispatch: true });
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    await expect(stack.collaboration.dispatchScheduledMessage(claimed.snapshot)).resolves.toEqual({
      outcome: "accepted",
      code: null,
    });

    const authority = await authorityFor(clientA.database);
    const context = {
      sessionId: seedValue.targetSessionId,
      agentId: seedValue.agentId,
      computerId: seedValue.computerId,
      instanceId: seedValue.instanceId,
      placementGeneration: 1,
    };
    const source = { kind: "session-message" as const, messageId: claimed.snapshot.messageId };
    await expect(authority.authorize(source, context)).resolves.toEqual({ status: "authorized" });

    // Deleting the schedule never revokes the already-accepted message.
    await management.deleteForAgent(
      {
        accountId: seedValue.accountId,
        agentId: seedValue.agentId,
        sessionId: seedValue.targetSessionId,
        sessionKind: "channel",
      },
      row.id,
      1,
    );
    await expect(authority.authorize(source, context)).resolves.toEqual({ status: "authorized" });
    // A foreign Agent can never borrow the message's authority.
    await expect(authority.authorize(source, { ...context, agentId: randomUUID() })).resolves.toEqual({
      status: "invalid",
    });
  }, 20_000);

  it("refuses forged or never-accepted scheduled messages (P14)", async () => {
    const seedValue = await seed(clientA.database);
    const stack = makeDispatchStack(clientA.database, seedValue);
    const scheduler = new ScheduleScheduler({
      database: clientA.database,
      dispatch: stack.collaboration,
      sessions: stack.sessions,
      publicUrl: PUBLIC_URL,
    });
    const authority = await authorityFor(clientA.database);
    const context = {
      sessionId: seedValue.targetSessionId,
      agentId: seedValue.agentId,
      computerId: seedValue.computerId,
      instanceId: seedValue.instanceId,
      placementGeneration: 1,
    };
    // An unknown message id: nothing to authorize.
    await expect(authority.authorize({ kind: "session-message", messageId: randomUUID() }, context)).resolves.toEqual({
      status: "invalid",
    });

    // A forged enabled schedule row alone never authorizes: no accepted message exists.
    const [nowRow] = await clientA.database.execute<{ at: Date }>(sqlTag`select clock_timestamp() as at`);
    if (!nowRow) throw new Error("database clock missing");
    const scheduledFor = new Date(nowRow.at);
    const [row] = await clientA.database
      .insert(agentSchedules)
      .values({
        agentId: seedValue.agentId,
        targetSessionId: seedValue.targetSessionId,
        name: "Daily check",
        prompt: "Check the build.",
        schedule: { kind: "every", intervalSeconds: 60, anchorAt: scheduledFor.toISOString() },
        timezone: "UTC",
        enabled: true,
        nextTriggerAt: scheduledFor,
        revision: 1,
      })
      .returning();
    if (!row) throw new Error("schedule fixture missing");
    await expect(
      authority.authorize({ kind: "session-message", messageId: scheduledMessageId(row.id, scheduledFor) }, context),
    ).resolves.toEqual({ status: "invalid" });

    // A claimed but never-accepted message is not authority either (not_ready, not invalid).
    const claimed = await scheduler.claimOccurrence(row.id, { allowDispatch: true });
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    await expect(
      authority.authorize({ kind: "session-message", messageId: claimed.snapshot.messageId }, context),
    ).resolves.toEqual({ status: "not_ready" });
    // Nor can it be borrowed against a different target Session.
    await expect(
      authority.authorize(
        { kind: "session-message", messageId: claimed.snapshot.messageId },
        { ...context, sessionId: randomUUID() },
      ),
    ).resolves.toEqual({ status: "invalid" });
  }, 20_000);
});
