import { randomUUID } from "node:crypto";
import type {
  SessionMessageDeliveryRequestV3,
  SessionMessageDeliveryResult,
  SessionReconcileRequest,
  SessionReconcileResult,
} from "@opentag/shared";
import { eq, sql as sqlTag } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
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
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import {
  type RuntimeDispatchAdmission,
  RuntimeDomainOwner,
  RuntimeDomainRequestError,
} from "../../runtime/runtime-domain-owner.js";
import { PostgresRuntimeExecutionAuthority } from "../../runtime-credentials/execution-authority.js";
import { RuntimeValidationRunRegistry } from "../../runtime-credentials/validation-runs.js";
import { DatabaseAgentOwnerResolver } from "../../services/agents/index.js";
import { ScheduleScheduler, ScheduleService, scheduledMessageId } from "../../services/schedules/index.js";
import { SessionCollaborationService, SessionService } from "../../services/sessions/index.js";
import { SessionCliProofService } from "../../services/sessions/session-cli-proof-service.js";
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
const proofClients: ReturnType<typeof createDatabaseClient>[] = [];

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
  await Promise.all(proofClients.splice(0).map((client) => client.sql.end()));
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

async function dispatchWithAdmission<T>(
  operation: () => Promise<T>,
  admission?: RuntimeDispatchAdmission<T>,
  onDispatched?: () => void,
): Promise<T> {
  const send = (mark?: () => void) => {
    mark?.();
    onDispatched?.();
    return operation();
  };
  if (!admission) return send();
  const admitted = await admission(send);
  if (!admitted.admitted) throw new RuntimeDomainRequestError("authority_unavailable", "Admission rejected");
  return admitted.result;
}

function makeDispatchStack(
  database: DatabaseClient,
  seedValue: Seed,
  options: { afterPlacementLock?: () => Promise<void> } = {},
): DispatchStack {
  const sessionsService = new SessionService(database, options);
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
        (
          _c: string,
          _i: string,
          request: { requestId: string },
          onDispatched?: () => void,
          admission?: RuntimeDispatchAdmission<SessionReconcileResult>,
        ) =>
          dispatchWithAdmission<SessionReconcileResult>(
            async () => ({
              type: "session:reconcile:result",
              requestId: request.requestId,
              sessionId: seedValue.targetSessionId,
              placementGeneration: 1,
              status: "ready",
            }),
            admission,
            onDispatched,
          ),
      ),
      requestSessionMessageDelivery: vi.fn(
        (
          _c: string,
          _i: string,
          request: SessionMessageDeliveryRequestV3,
          onDispatched?: () => void,
          admission?: RuntimeDispatchAdmission<SessionMessageDeliveryResult>,
        ) =>
          dispatchWithAdmission(
            () => {
              deliveryFrames.push(request);
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
              return new Promise<SessionMessageDeliveryResult>((resolve) =>
                pendingReceipts.push(() => resolve(accept)),
              );
            },
            admission,
            onDispatched,
          ),
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

async function makeRuntimeDispatchStack(
  seedValue: Seed,
  options: {
    afterPreparation?: () => Promise<void>;
    beforeReconcileResult?: () => Promise<void>;
    localBudgetMs?: number;
  } = {},
) {
  const proofClient = createDatabaseClient(testDatabase.databaseUrl, {
    max: 1,
    statementTimeoutMs: 1_000,
    queryTimeoutMs: 2_000,
  });
  proofClients.push(proofClient);
  const registry = new ConnectionRegistry();
  const proofs = new SessionCliProofService(proofClient.database, registry, new Uint8Array(32).fill(7));
  const frames: Array<SessionReconcileRequest | SessionMessageDeliveryRequestV3> = [];
  const preparationErrors: unknown[] = [];
  const domain = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(clientA.database), {
    requestTimeoutMs: 2_000,
    prepareReconcile: async (computerId, instanceId, request) => {
      try {
        const prepared = await proofs.prepareReconcile(computerId, instanceId, request);
        await options.afterPreparation?.();
        return prepared;
      } catch (error) {
        preparationErrors.push(error);
        throw error;
      }
    },
  });
  const context = {
    computerId: seedValue.computerId,
    installationId: seedValue.installationId,
    instanceId: seedValue.instanceId,
    signal: new AbortController().signal,
  };
  const responses: Promise<unknown>[] = [];
  await registry.register(
    {
      ...context,
      clientVersion: "0.1.4",
      lastHeartbeatAt: Date.now(),
      negotiatedCapabilities: {
        "runtime.sessionReconcile": 1,
        "runtime.sessionCollaboration": 3,
        "runtime.imCredentialGrant": 2,
      },
      socket: {
        readyState: WebSocket.OPEN,
        close: vi.fn(),
        send: (serialized: string, callback: (error?: Error) => void) => {
          const frame = JSON.parse(serialized) as (typeof frames)[number];
          frames.push(frame);
          callback();
          responses.push(
            (async () => {
              if (frame.type === "session:reconcile") await options.beforeReconcileResult?.();
              return domain.handle(
                frame.type === "session:reconcile"
                  ? {
                      type: "session:reconcile:result",
                      requestId: frame.requestId,
                      sessionId: frame.sessionId,
                      placementGeneration: frame.placementGeneration,
                      status: "ready",
                    }
                  : {
                      type: "session:message:deliver:result",
                      requestId: frame.requestId,
                      messageId: frame.messageId,
                      targetSessionId: frame.targetSessionId,
                      placementGeneration: frame.placementGeneration,
                      status: "accepted",
                    },
                context,
              );
            })(),
          );
        },
      } as unknown as WebSocket,
    },
    async () => undefined,
  );
  const sessionsService = new SessionService(clientA.database);
  const collaboration = new SessionCollaborationService({
    assembler: { assembleForSession: vi.fn(async () => runtimeSnapshot(seedValue.agentId)) },
    domain,
    registry,
    sessions: sessionsService,
    logger: { error: vi.fn() },
    scheduledBudgets: { localMs: options.localBudgetMs },
  });
  const scheduler = new ScheduleScheduler({
    database: clientA.database,
    dispatch: collaboration,
    sessions: sessionsService,
    publicUrl: PUBLIC_URL,
  });
  const scheduledFor = new Date();
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
    })
    .returning();
  if (!row) throw new Error("schedule fixture missing");
  const claimed = await scheduler.claimOccurrence(row.id, { allowDispatch: true });
  if (claimed.kind !== "claimed") throw new Error("expected a claim");
  return { collaboration, domain, registry, frames, preparationErrors, responses, snapshot: claimed.snapshot };
}

describe("scheduled reconcile with real Session CLI proof preparation", () => {
  it("mints the proof before final admission without waiting on its own placement lock", async () => {
    const stack = await makeRuntimeDispatchStack(await seed(clientA.database));
    const outcome = await stack.collaboration.dispatchScheduledMessage(stack.snapshot);
    await Promise.all(stack.responses);
    expect(stack.preparationErrors).toEqual([]);
    expect(outcome).toEqual({ outcome: "accepted", code: null });
    expect(stack.frames).toHaveLength(2);
    expect(stack.frames[0]).toMatchObject({
      type: "session:reconcile",
      sessionCliProof: { token: expect.any(String) },
    });
    expect(stack.frames[1]).toMatchObject({ type: "session:message:deliver", messageId: stack.snapshot.messageId });
    await expect(stack.collaboration.dispatchScheduledMessage(stack.snapshot)).resolves.toEqual({
      outcome: "unknown",
      code: null,
    });
    expect(stack.frames).toHaveLength(2);
  }, 10_000);

  it.each(["preparation", "reconcile send"] as const)(
    "rechecks pause, deletion and revision changes after %s",
    async (stage) => {
      for (const mutation of ["pause", "delete", "edit"] as const) {
        const seedValue = await seed(clientA.database);
        const management = new ScheduleService({
          database: clientB.database,
          owners: new DatabaseAgentOwnerResolver(clientB.database),
          proofs: { authenticate: () => Promise.reject(new Error("no external proofs")) },
          publicUrl: PUBLIC_URL,
        });
        const mutate = async () => {
          const scope = {
            accountId: seedValue.accountId,
            agentId: seedValue.agentId,
            sessionId: seedValue.targetSessionId,
            sessionKind: "channel" as const,
          };
          if (mutation === "pause") await management.pauseForAgent(scope, stack.snapshot.scheduleId, 1);
          else if (mutation === "delete") await management.deleteForAgent(scope, stack.snapshot.scheduleId, 1);
          else
            await management.updateForAgent(scope, stack.snapshot.scheduleId, {
              expectedRevision: 1,
              prompt: "New prompt",
            });
        };
        const stack = await makeRuntimeDispatchStack(seedValue, {
          ...(stage === "preparation" ? { afterPreparation: mutate } : { beforeReconcileResult: mutate }),
        });
        const outcome = await stack.collaboration.dispatchScheduledMessage(stack.snapshot);
        await Promise.all(stack.responses);
        expect(stack.preparationErrors).toEqual([]);
        expect(outcome).toEqual({
          outcome: "rejected",
          code:
            mutation === "pause"
              ? "schedule_disabled"
              : mutation === "delete"
                ? "schedule_deleted"
                : "schedule_changed",
        });
        expect(stack.frames.map((frame) => frame.type)).toEqual(stage === "preparation" ? [] : ["session:reconcile"]);
        const [message] = await clientA.database
          .select()
          .from(sessionMessages)
          .where(eq(sessionMessages.id, stack.snapshot.messageId));
        expect(message).toMatchObject({ attemptCount: 1, lastOutcome: "rejected", lastErrorCode: outcome.code });
      }
    },
    15_000,
  );

  it.each(["placement", "agent", "binding"] as const)(
    "rechecks %s authority after proof preparation",
    async (mutation) => {
      const seedValue = await seed(clientA.database);
      const stack = await makeRuntimeDispatchStack(seedValue, {
        afterPreparation: async () => {
          if (mutation === "placement")
            await clientB.database
              .update(sessionPlacements)
              .set({ generation: 2 })
              .where(eq(sessionPlacements.sessionId, seedValue.targetSessionId));
          else if (mutation === "agent")
            await clientB.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, seedValue.agentId));
          else
            await clientB.database
              .update(imBindings)
              .set({ status: "disabled", disabledAt: new Date(), encryptedCredential: null })
              .where(eq(imBindings.id, seedValue.bindingId));
        },
      });
      await expect(stack.collaboration.dispatchScheduledMessage(stack.snapshot)).resolves.toEqual({
        outcome: mutation === "binding" ? "rejected" : "unreachable",
        code:
          mutation === "placement"
            ? "authority_unavailable"
            : mutation === "agent"
              ? "agent_suspended"
              : "binding_invalid",
      });
      expect(stack.preparationErrors).toEqual([]);
      expect(stack.frames).toEqual([]);
    },
    10_000,
  );

  it.each(["preparation", "reconcile send"] as const)(
    "refuses a disconnected runtime after %s",
    async (stage) => {
      const seedValue = await seed(clientA.database);
      const disconnect = async () => {
        await stack.registry.closeComputer(seedValue.computerId);
      };
      const stack = await makeRuntimeDispatchStack(seedValue, {
        ...(stage === "preparation" ? { afterPreparation: disconnect } : { beforeReconcileResult: disconnect }),
      });
      await expect(stack.collaboration.dispatchScheduledMessage(stack.snapshot)).resolves.toEqual({
        outcome: "unreachable",
        code: "runtime_not_ready",
      });
      await Promise.all(stack.responses);
      expect(stack.preparationErrors).toEqual([]);
      expect(stack.frames.map((frame) => frame.type)).toEqual(stage === "preparation" ? [] : ["session:reconcile"]);
    },
    10_000,
  );

  it.each(["cancel", "deadline"] as const)(
    "never sends late when %s interrupts proof preparation",
    async (reason) => {
      let markPrepared: () => void = () => undefined;
      const prepared = new Promise<void>((resolve) => {
        markPrepared = resolve;
      });
      let releasePreparation: () => void = () => undefined;
      const release = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      const stack = await makeRuntimeDispatchStack(await seed(clientA.database), {
        afterPreparation: async () => {
          markPrepared();
          await release;
        },
        localBudgetMs: reason === "deadline" ? 500 : undefined,
      });
      const reconcile = vi.spyOn(stack.domain, "requestReconcile");
      const controller = new AbortController();
      const dispatching = stack.collaboration.dispatchScheduledMessage(stack.snapshot, controller.signal);
      try {
        await prepared;
        if (reason === "cancel") controller.abort();
        await expect(dispatching).resolves.toEqual({ outcome: "unreachable", code: "delivery_timeout" });
      } finally {
        releasePreparation();
      }
      await expect(reconcile.mock.results[0]?.value).rejects.toMatchObject({ name: "ScheduledDispatchAbortError" });
      expect(stack.frames).toEqual([]);
      expect(stack.preparationErrors).toEqual([]);
    },
    10_000,
  );
});

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
    try {
      await vi.waitFor(() => expect(pauseSettled).toBe(true), { timeout: 2_000 });
    } finally {
      stack.releaseReceipts();
    }
    await expect(dispatching).resolves.toEqual({ outcome: "accepted", code: null });
    await pausing;
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

  it("claims the next occurrence of the same plan while its earlier send holds Session admission locks", async () => {
    const seedValue = await seed(clientA.database);
    let admissionEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => (admissionEntered = resolve));
    let releaseAdmission: () => void = () => undefined;
    const admissionGate = new Promise<void>((resolve) => (releaseAdmission = resolve));
    const stack = makeDispatchStack(clientA.database, seedValue, {
      afterPlacementLock: async () => {
        admissionEntered();
        await admissionGate;
      },
    });
    const [nowRow] = await clientA.database.execute<{ at: Date }>(sqlTag`select clock_timestamp() as at`);
    if (!nowRow) throw new Error("database clock missing");
    const firstDue = new Date(nowRow.at);
    let claimNow = firstDue;
    let secondClaim = false;
    let rowLocked: () => void = () => undefined;
    const nextRowLocked = new Promise<void>((resolve) => (rowLocked = resolve));
    let messageInserted: () => void = () => undefined;
    const nextMessageInserted = new Promise<void>((resolve) => (messageInserted = resolve));
    const scheduler = new ScheduleScheduler({
      database: clientA.database,
      dispatch: stack.collaboration,
      sessions: stack.sessions,
      publicUrl: PUBLIC_URL,
      clock: { now: async () => claimNow },
      afterRowLock: async () => {
        if (secondClaim) rowLocked();
      },
      afterMessageInsert: async () => {
        if (secondClaim) messageInserted();
      },
    });
    const [row] = await clientA.database
      .insert(agentSchedules)
      .values({
        agentId: seedValue.agentId,
        targetSessionId: seedValue.targetSessionId,
        name: "Same plan",
        prompt: "Check the build.",
        schedule: { kind: "every", intervalSeconds: 60, anchorAt: firstDue.toISOString() },
        timezone: "UTC",
        enabled: true,
        nextTriggerAt: firstDue,
      })
      .returning();
    if (!row) throw new Error("schedule fixture missing");
    const first = await scheduler.claimOccurrence(row.id, { allowDispatch: true });
    if (first.kind !== "claimed") throw new Error("expected the first claim");
    const dispatching = stack.collaboration.dispatchScheduledMessage(first.snapshot);
    await entered;

    // Admission holds the Session and placement locks. Claim locks this SAME Schedule, then its
    // message insert checks the target Session FK. That KEY SHARE must be compatible with the
    // admission's Session lock, otherwise releasing admission would form a two-row deadlock.
    claimNow = new Date(firstDue.getTime() + 60_000);
    secondClaim = true;
    const claiming = scheduler.claimOccurrence(row.id, { allowDispatch: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let insertedBeforeRelease = false;
    try {
      await nextRowLocked;
      insertedBeforeRelease = await Promise.race([
        nextMessageInserted.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 3_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      releaseAdmission();
    }
    const [dispatchResult, claimResult] = await Promise.allSettled([dispatching, claiming]);
    expect(insertedBeforeRelease).toBe(true);
    expect(dispatchResult).toMatchObject({ status: "fulfilled", value: { outcome: "accepted" } });
    expect(claimResult).toMatchObject({ status: "fulfilled", value: { kind: "claimed" } });
    expect(stack.deliveryFrames).toHaveLength(1);
  }, 20_000);
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
