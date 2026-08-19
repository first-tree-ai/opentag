import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  computeDirectInputHash,
  computeRuntimeSnapshotHashes,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type NormalizedInboundImEvent,
  type TurnReportRequest,
} from "@opentag/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import {
  agents,
  computers,
  imMessageDeliveries,
  imMessages,
  integrations,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImMessageInbox, ImResourceService, OutboundMessageService } from "../../services/im/index.js";
import {
  type FeishuAdapter,
  FeishuConnectionManager,
  type FeishuRegistration,
  type FeishuRegistrationGateway,
  FeishuSetupService,
} from "../../services/integrations/feishu/index.js";
import {
  createImProviderAdapterResolver,
  IntegrationService,
  ProviderAdapterResolutionError,
} from "../../services/integrations/index.js";
import { SessionService } from "../../services/sessions/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  databaseUrl = container.getConnectionUri();
}, 120_000);

afterAll(async () => container.stop());

beforeEach(async () => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("drop schema if exists drizzle cascade");
    await sql.unsafe("create schema public");
  } finally {
    await sql.end();
  }
});

async function validatingFeishuAttempt(
  database: ReturnType<typeof createDatabaseClient>["database"],
  agentId: string,
  ownerInstanceId: string,
  intent: "create" | "reauthorize" | "replace",
): Promise<string> {
  const attemptId = crypto.randomUUID();
  const [existing] = await database.select().from(integrations).where(eq(integrations.agentId, agentId)).limit(1);
  const values = {
    setupAttemptId: attemptId,
    setupIntent: intent,
    setupState: "validating" as const,
    setupOwnerInstanceId: ownerInstanceId,
    setupOwnerHeartbeatAt: new Date(),
    encryptedSetupContext: "test-only",
    setupExpiresAt: new Date(Date.now() + 60_000),
    updatedAt: new Date(),
  };
  if (existing) {
    await database.update(integrations).set(values).where(eq(integrations.id, existing.id));
  } else {
    await database.insert(integrations).values({
      agentId,
      provider: "feishu",
      status: "provisioning",
      ...values,
    });
  }
  return attemptId;
}

async function fixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    teamDisplayName: "Example",
    teamName: "example",
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      id: crypto.randomUUID(),
      ownerUserId: bootstrap.userId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(client.database).createForTeam(bootstrap.userId, bootstrap.teamId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const integrationService = new IntegrationService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => new Date("2026-08-19T00:00:00.000Z"),
  });
  const integrationId = await integrationService.activateSlack({
    agentId: agent.id,
    appId: "A1",
    teamId: "T1",
    botUserId: "U_BOT",
    grantedBotScopes: [
      "chat:write",
      "app_mentions:read",
      "im:history",
      "channels:history",
      "groups:history",
      "mpim:history",
    ],
    botAccessToken: "xoxb-secret",
    signingSecret: "signing-secret",
    installedAt: new Date("2026-08-19T00:00:00.000Z"),
  });
  return { ...client, agent, bootstrap, computer, integrationId, integrationService };
}

async function unboundFixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    teamDisplayName: "Example",
    teamName: "example",
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      id: crypto.randomUUID(),
      ownerUserId: bootstrap.userId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(client.database).createForTeam(bootstrap.userId, bootstrap.teamId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const integrationService = new IntegrationService(client.database, cipher);
  return { ...client, agent, bootstrap, computer, cipher, integrationService };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleWithin<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Concurrent database operations did not settle")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createClientSessionBindingStore(home: string) {
  const moduleUrl = new URL("../../../../client/src/runtime/session-binding-store.ts", import.meta.url).href;
  const module = (await import(moduleUrl)) as {
    SessionBindingStore: new (options: {
      home: string;
      providerHomeIdentity: string;
    }) => {
      prepare: (
        request: Parameters<PostgresRuntimeCustodyStore["claimRetainedReports"]>[0],
        hashes: ReturnType<typeof computeRuntimeSnapshotHashes>,
      ) => Promise<unknown>;
      read: (
        agentId: string,
        sessionId: string,
      ) => Promise<
        | {
            unresolvedTurn?: {
              deliveryId: string;
              inputHash: string;
              phase: string;
              requestId: string;
              resultHash?: string;
              turnId: string;
            };
          }
        | undefined
      >;
      recordAccepted: (request: DirectImMessageDeliveryRequest, inputHash: string, turnId: string) => Promise<unknown>;
      recordResult: (agentId: string, sessionId: string, turnId: string, resultHash: string) => Promise<unknown>;
      updateUnresolved: (
        agentId: string,
        sessionId: string,
        turnId: string,
        phase: "reporting",
        fields: { report: TurnReportRequest; resultHash: string },
      ) => Promise<unknown>;
    };
  };
  return new module.SessionBindingStore({ home, providerHomeIdentity: "a".repeat(64) });
}

async function respondingRuntime(input: {
  acceptDeliveries?: boolean;
  database: ReturnType<typeof createDatabaseClient>["database"];
  computerId: string;
  deliveryGate?: Promise<void>;
  instanceId: string;
  requestTimeoutMs?: number;
  reconcileResult?: (frame: Record<string, unknown>) => Record<string, unknown>;
  userId: string;
}) {
  const frames: unknown[] = [];
  const registry = new ConnectionRegistry();
  const context = {
    computerId: input.computerId,
    instanceId: input.instanceId,
    signal: new AbortController().signal,
    userId: input.userId,
  };
  let domain!: RuntimeDomainOwner;
  const socket = {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn((serialized: string, callback: (error?: Error) => void) => {
      const frame = JSON.parse(serialized) as Record<string, unknown>;
      frames.push(frame);
      callback();
      queueMicrotask(() => {
        if (frame.type === "session:reconcile") {
          void domain.handle(
            (input.reconcileResult?.(frame) ?? {
              type: "session:reconcile:result",
              requestId: frame.requestId,
              sessionId: frame.sessionId,
              placementGeneration: frame.placementGeneration,
              status: "ready",
            }) as never,
            context,
          );
        } else if (frame.type === "im:deliver") {
          if (input.acceptDeliveries === false) return;
          void (async () => {
            await input.deliveryGate;
            await domain.handle(
              {
                type: "im:deliver:result",
                requestId: frame.requestId,
                deliveryId: frame.deliveryId,
                sessionId: frame.sessionId,
                placementGeneration: frame.placementGeneration,
                status: "accepted",
                turnId: `turn-${String(frame.deliveryId)}`,
              } as never,
              context,
            );
          })();
        }
      });
    }),
  } as unknown as WebSocket;
  await registry.register(
    {
      capabilities: { imMessageTool: 1 },
      capabilitiesUpdatedAt: Date.now(),
      computerId: input.computerId,
      instanceId: input.instanceId,
      lastHeartbeatAt: Date.now(),
      socket,
      userId: input.userId,
    },
    async () => undefined,
  );
  domain = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(input.database), {
    requestTimeoutMs: input.requestTimeoutMs,
  });
  return { context, domain, frames, registry };
}

function turnReportFor(input: {
  agentId: string;
  deliveryId: string;
  placementGeneration: number;
  sessionId: string;
  turnId: string;
}): TurnReportRequest {
  const body = {
    deliveryId: input.deliveryId,
    turnId: input.turnId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    placementGeneration: input.placementGeneration,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "done",
    usage: { inputTokens: 1, outputTokens: 1 },
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: crypto.randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}

function inbound(
  providerEventId: string,
  operation: "created" | "edited" | "deleted" = "created",
): NormalizedInboundImEvent {
  return {
    providerEventId,
    externalAppId: "A1",
    externalTeamId: "T1",
    conversation: { externalId: "C1", kind: "channel" as const },
    message: {
      externalId: "1000.1",
      revisionKey: `${operation}:1000.1`,
      operation,
      threadKey: null,
      replyToExternalId: null,
      author: { externalId: "U_HUMAN", kind: "human" as const, displayName: "Human" },
      occurredAt: new Date("2026-08-19T00:00:01.000Z"),
      content: {
        version: 1 as const,
        fallbackText: "hello",
        blocks: [{ type: "text" as const, text: "hello" }],
        truncated: false,
      },
      resources: [],
    },
    mentions: [{ externalId: "U_BOT", displayName: "Assistant" }],
  };
}

function revisionEvent(input: {
  providerEventId: string;
  externalMessageId: string;
  operation: "created" | "edited" | "deleted";
  occurredAt: string;
  revisionKey: string;
}): NormalizedInboundImEvent {
  const event = inbound(input.providerEventId, input.operation);
  return {
    ...event,
    message: {
      ...event.message,
      externalId: input.externalMessageId,
      occurredAt: new Date(input.occurredAt),
      revisionKey: input.revisionKey,
      content: {
        version: 1,
        fallbackText: input.operation,
        blocks: [{ type: "text", text: input.operation }],
        truncated: false,
      },
    },
  };
}

describe("IM Integration persistence", () => {
  it("migrates the authority tables with partial Session uniqueness and self-scope provenance", async () => {
    const value = await fixture();
    try {
      const indexes = await value.sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes
        where indexname in ('sessions_active_channel_unique', 'sessions_active_thread_unique')
        order by indexname
      `;
      expect(indexes).toHaveLength(2);
      expect(indexes.every((index) => index.indexdef.includes("ended_at IS NULL"))).toBe(true);
      const [creatorForeignKey] = await value.sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'sessions_created_by_session_id_sessions_id_fk'
      `;
      expect(creatorForeignKey?.definition).toContain("REFERENCES sessions(id)");
    } finally {
      await value.sql.end();
    }
  });

  it("atomically deduplicates provider events and converges duplicate Slack message event types", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database, { now: () => new Date("2026-08-19T00:00:02.000Z") });
      const first = await inbox.ingest(value.integrationId, 1, inbound("Ev1"));
      const retry = await inbox.ingest(value.integrationId, 1, inbound("Ev1"));
      const companion = await inbox.ingest(value.integrationId, 1, inbound("Ev2"));
      expect(first.deliveryIds).toHaveLength(1);
      expect(retry).toEqual({ duplicate: true, messageId: first.messageId, deliveryIds: [] });
      expect(companion).toMatchObject({ duplicate: true, messageId: first.messageId, deliveryIds: [] });
      expect(await value.database.select().from(imMessages)).toHaveLength(1);
      expect(await value.database.select().from(imMessageDeliveries)).toHaveLength(1);
      expect(await value.database.select().from(sessions)).toHaveLength(1);
      expect(await value.database.select().from(sessionPlacements)).toMatchObject([
        { computerId: value.computer.id, generation: 1 },
      ]);

      const edit = await inbox.ingest(value.integrationId, 1, inbound("Ev3", "edited"));
      expect(edit).toMatchObject({ duplicate: false });
      expect(await value.database.select().from(imMessages)).toHaveLength(2);
      expect(await value.database.select().from(imMessageDeliveries)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ messageId: first.messageId, state: "expired", reason: "superseded_revision" }),
          expect.objectContaining({ messageId: edit.messageId, state: "pending" }),
        ]),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("keeps actionable deliveries independent of create-edit-delete arrival order", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const revisions = (externalMessageId: string) => [
        revisionEvent({
          providerEventId: `${externalMessageId}-create`,
          externalMessageId,
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
        revisionEvent({
          providerEventId: `${externalMessageId}-edit`,
          externalMessageId,
          operation: "edited",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "2",
        }),
        revisionEvent({
          providerEventId: `${externalMessageId}-delete`,
          externalMessageId,
          operation: "deleted",
          occurredAt: "2026-08-19T00:00:03.000Z",
          revisionKey: "3",
        }),
      ];
      for (const event of revisions("ordered")) await inbox.ingest(value.integrationId, 1, event);
      for (const event of revisions("reversed").reverse()) await inbox.ingest(value.integrationId, 1, event);

      const messages = await value.database.select().from(imMessages);
      expect(messages).toHaveLength(6);
      for (const externalMessageId of ["ordered", "reversed"]) {
        const current = messages
          .filter((message) => message.externalMessageId === externalMessageId)
          .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())[0];
        expect(current?.operation).toBe("deleted");
      }
      const deliveries = await value.database
        .select({
          operation: imMessages.operation,
          externalMessageId: imMessages.externalMessageId,
          state: imMessageDeliveries.state,
        })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId));
      expect(deliveries.filter((delivery) => delivery.state === "pending")).toEqual(
        expect.arrayContaining([
          { externalMessageId: "ordered", operation: "deleted", state: "pending" },
          { externalMessageId: "reversed", operation: "deleted", state: "pending" },
        ]),
      );
      expect(deliveries.filter((delivery) => delivery.state === "pending")).toHaveLength(2);
    } finally {
      await value.sql.end();
    }
  });

  it("serializes concurrent revisions under one logical message authority", async () => {
    const value = await fixture();
    try {
      const authorityHeld = deferred<void>();
      const releaseAuthority = deferred<void>();
      const olderInbox = new ImMessageInbox(value.database, {
        afterMessageAuthority: async () => {
          authorityHeld.resolve();
          await releaseAuthority.promise;
        },
      });
      const newerInbox = new ImMessageInbox(value.database);
      const older = olderInbox.ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "concurrent-create",
          externalMessageId: "concurrent-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      await authorityHeld.promise;
      let newerSettled = false;
      const newer = newerInbox
        .ingest(
          value.integrationId,
          1,
          revisionEvent({
            providerEventId: "concurrent-delete",
            externalMessageId: "concurrent-message",
            operation: "deleted",
            occurredAt: "2026-08-19T00:00:02.000Z",
            revisionKey: "2",
          }),
        )
        .finally(() => {
          newerSettled = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(newerSettled).toBe(false);
      releaseAuthority.resolve();
      await Promise.all([older, newer]);

      const deliveries = await value.database
        .select({ operation: imMessages.operation, state: imMessageDeliveries.state })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId));
      expect(deliveries).toEqual(
        expect.arrayContaining([
          { operation: "created", state: "expired" },
          { operation: "deleted", state: "pending" },
        ]),
      );
      expect(deliveries.filter((delivery) => delivery.state === "pending")).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("preserves in-flight delivery custody when a newer revision supersedes it", async () => {
    const value = await fixture();
    try {
      const first = await new ImMessageInbox(value.database).ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "custody-create",
          externalMessageId: "custody-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const deliveryId = first.deliveryIds[0];
      if (!deliveryId || !first.messageId) throw new Error("Delivery fixture was not created");
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      const deliveryGate = deferred<void>();
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: deliveryGate.promise,
        instanceId,
        userId: value.bootstrap.userId,
      });
      const deliveryRun = new ImDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      await expect
        .poll(() => runtime.frames.filter((frame) => (frame as { type?: string }).type === "im:deliver").length)
        .toBe(1);
      const newer = await new ImMessageInbox(value.database).ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "custody-delete",
          externalMessageId: "custody-message",
          operation: "deleted",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "2",
        }),
      );
      expect(newer.deliveryIds).toHaveLength(1);
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId)))[0],
      ).toMatchObject({
        state: "expired",
        reason: "superseded_revision",
      });
      deliveryGate.resolve();
      await deliveryRun;
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const turnId = `turn-${deliveryId}`;
      expect(await runtime.domain.getDelivery(deliveryId)).toMatchObject({ turnId, deliveryId });
      await expect(
        runtime.domain.handle(
          turnReportFor({
            agentId: value.agent.id,
            deliveryId,
            placementGeneration: 1,
            sessionId: session.id,
            turnId,
          }),
          runtime.context,
        ),
      ).resolves.toMatchObject({ status: "recorded" });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("preserves in-flight custody when TTL expiry commits before acceptance", async () => {
    const value = await fixture();
    try {
      const admitted = await new ImMessageInbox(value.database).ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "ttl-create",
          externalMessageId: "ttl-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const deliveryId = admitted.deliveryIds[0];
      if (!deliveryId || !admitted.messageId) throw new Error("TTL fixture was not created");
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      const deliveryGate = deferred<void>();
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: deliveryGate.promise,
        instanceId,
        userId: value.bootstrap.userId,
      });
      const deliveryRun = new ImDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      await expect
        .poll(() => runtime.frames.filter((frame) => (frame as { type?: string }).type === "im:deliver").length)
        .toBe(1);
      await value.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, deliveryId));
      await new ImDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "expired",
        reason: "ttl",
      });

      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const turnId = `turn-${deliveryId}`;
      deliveryGate.resolve();
      await deliveryRun;
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "accepted",
        reason: null,
        turnId,
      });
      await expect(
        runtime.domain.handle(
          turnReportFor({
            agentId: value.agent.id,
            deliveryId,
            placementGeneration: 1,
            sessionId: session.id,
            turnId,
          }),
          runtime.context,
        ),
      ).resolves.toMatchObject({ status: "recorded" });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("preserves in-flight custody when capacity eviction commits before acceptance", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const first = await inbox.ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "capacity-first",
          externalMessageId: "capacity-first-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const deliveryId = first.deliveryIds[0];
      if (!deliveryId || !first.messageId) throw new Error("Capacity fixture was not created");
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      const deliveryGate = deferred<void>();
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: deliveryGate.promise,
        instanceId,
        userId: value.bootstrap.userId,
      });
      const deliveryRun = new ImDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      await expect
        .poll(() => runtime.frames.filter((frame) => (frame as { type?: string }).type === "im:deliver").length)
        .toBe(1);
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const fillerMessages = await value.database
        .insert(imMessages)
        .values(
          Array.from({ length: 99 }, (_, index) => ({
            integrationId: value.integrationId,
            providerEventId: `capacity-filler-${index}`,
            channelId: "C1",
            externalMessageId: `capacity-filler-message-${index}`,
            providerRevisionKey: "1",
            operation: "created" as const,
            direction: "inbound" as const,
            threadKey: null,
            replyToExternalId: null,
            authorKind: "human" as const,
            authorExternalId: "U_HUMAN",
            authorDisplayName: "Human",
            content: {
              version: 1 as const,
              fallbackText: "filler",
              blocks: [{ type: "text" as const, text: "filler" }],
              truncated: false,
            },
            occurredAt: new Date(`2026-08-19T00:00:01.${String(index + 1).padStart(3, "0")}Z`),
          })),
        )
        .returning({ id: imMessages.id });
      await value.database.insert(imMessageDeliveries).values(
        fillerMessages.map((message) => ({
          messageId: message.id,
          sessionId: session.id,
          attention: "direct" as const,
          placementGeneration: 1,
          expiresAt: new Date("2026-08-26T00:00:00.000Z"),
        })),
      );
      await inbox.ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "capacity-second",
          externalMessageId: "capacity-second-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "1",
        }),
      );
      const [evicted] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId));
      expect(evicted).toMatchObject({ state: "expired", reason: "capacity" });
      const turnId = `turn-${deliveryId}`;
      deliveryGate.resolve();
      await deliveryRun;
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId)))[0],
      ).toMatchObject({
        state: "accepted",
        reason: null,
        turnId,
      });
      await expect(
        runtime.domain.handle(
          turnReportFor({
            agentId: value.agent.id,
            deliveryId,
            placementGeneration: 1,
            sessionId: session.id,
            turnId,
          }),
          runtime.context,
        ),
      ).resolves.toMatchObject({ status: "recorded" });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("inherits DM scope for a Feishu recall without guessing provider fields", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const created = revisionEvent({
        providerEventId: "dm-create",
        externalMessageId: "dm-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      created.conversation = { externalId: "DM1", kind: "dm" };
      created.mentions = [];
      await inbox.ingest(value.integrationId, 1, created);
      const recalled = revisionEvent({
        providerEventId: "dm-recall",
        externalMessageId: "dm-message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "2",
      });
      recalled.conversation = { externalId: "DM1", kind: "unknown" };
      recalled.mentions = [];
      const result = await inbox.ingest(value.integrationId, 1, recalled);
      const [message] = await value.database
        .select()
        .from(imMessages)
        .where(eq(imMessages.id, result.messageId as string));
      expect(message).toMatchObject({ threadKey: null, operation: "deleted" });
      expect(message).not.toHaveProperty("conversationKind");
      expect(result.deliveryIds).toHaveLength(1);
    } finally {
      await value.sql.end();
    }
  });

  it("inherits direct attention for Feishu recall and advances the latest Session input", async () => {
    const value = await fixture();
    try {
      await value.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, value.agent.id));
      const inbox = new ImMessageInbox(value.database);
      const createdEvent = revisionEvent({
        providerEventId: "mention-create",
        externalMessageId: "mention-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      const created = await inbox.ingest(value.integrationId, 1, createdEvent);
      const createdDeliveryId = created.deliveryIds[0];
      if (!created.messageId || !createdDeliveryId) throw new Error("Mention delivery fixture was not created");
      await value.database
        .update(imMessageDeliveries)
        .set({
          state: "accepted",
          inputHash: "accepted-input",
          turnId: "accepted-turn",
          reportOwnerInstanceId: crypto.randomUUID(),
          acceptedAt: new Date(),
        })
        .where(eq(imMessageDeliveries.id, createdDeliveryId));

      const recalledEvent = revisionEvent({
        providerEventId: "mention-recall",
        externalMessageId: "mention-message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "2",
      });
      recalledEvent.conversation.kind = "unknown";
      recalledEvent.mentions = [];
      const recalled = await inbox.ingest(value.integrationId, 1, recalledEvent);
      expect(recalled.deliveryIds).toHaveLength(1);
      const [recalledDelivery] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, recalled.deliveryIds[0] as string));
      expect(recalledDelivery).toMatchObject({ attention: "direct", state: "pending" });

      const computerInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: computerInstanceId })
        .where(eq(computers.id, value.computer.id));
      let providerWrites = 0;
      const outbound = new OutboundMessageService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTeamId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => {
          providerWrites += 1;
          return { ok: true as const, externalMessageId: "unused", occurredAt: new Date() };
        },
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }));
      const [session] = await value.database.select().from(sessions).where(eq(sessions.channelId, "C1")).limit(1);
      if (!session) throw new Error("Channel Session fixture was not created");
      await expect(
        outbound.execute({
          requestId: crypto.randomUUID(),
          sessionId: session.id,
          agentId: value.agent.id,
          computerId: value.computer.id,
          computerInstanceId,
          placementGeneration: 1,
          expectedLatestImMessageId: created.messageId,
          operation: "send",
          content: {
            version: 1,
            fallbackText: "stale answer",
            blocks: [{ type: "text", text: "stale answer" }],
            truncated: false,
          },
        }),
      ).rejects.toThrow("OUTBOUND_LATEST_MESSAGE_STALE");
      expect(providerWrites).toBe(0);

      await value.database.update(agents).set({ receiveMode: "all_message" }).where(eq(agents.id, value.agent.id));
      const secondCreated = revisionEvent({
        providerEventId: "all-message-create",
        externalMessageId: "all-message-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:03.000Z",
        revisionKey: "1",
      });
      const second = await inbox.ingest(value.integrationId, 1, secondCreated);
      const secondRecall = revisionEvent({
        providerEventId: "all-message-recall",
        externalMessageId: "all-message-message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:04.000Z",
        revisionKey: "2",
      });
      secondRecall.conversation.kind = "unknown";
      secondRecall.mentions = [];
      const secondRecalled = await inbox.ingest(value.integrationId, 1, secondRecall);
      expect(second.deliveryIds).toHaveLength(1);
      expect(secondRecalled.deliveryIds).toHaveLength(1);
      const [secondRecallDelivery] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, secondRecalled.deliveryIds[0] as string));
      expect(secondRecallDelivery?.attention).toBe("direct");
    } finally {
      await value.sql.end();
    }
  });

  it("inherits thread scope for a Feishu recall and targets the existing thread Session", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const created = revisionEvent({
        providerEventId: "thread-create",
        externalMessageId: "thread-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      created.message.threadKey = "thread-root";
      await inbox.ingest(value.integrationId, 1, created);
      const recalled = revisionEvent({
        providerEventId: "thread-recall",
        externalMessageId: "thread-message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "2",
      });
      recalled.conversation.kind = "unknown";
      recalled.message.threadKey = null;
      recalled.mentions = [];
      const result = await inbox.ingest(value.integrationId, 1, recalled);
      const [message] = await value.database
        .select()
        .from(imMessages)
        .where(eq(imMessages.id, result.messageId as string));
      expect(message).toMatchObject({ threadKey: "thread-root", operation: "deleted" });
      expect(message).not.toHaveProperty("conversationKind");
      const deliveryScopes = await value.database
        .select({ kind: sessions.kind, threadKey: sessions.threadKey })
        .from(imMessageDeliveries)
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .where(eq(imMessageDeliveries.messageId, result.messageId as string));
      expect(deliveryScopes).toEqual(
        expect.arrayContaining([
          { kind: "thread", threadKey: "thread-root" },
          { kind: "channel", threadKey: null },
        ]),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("stores recall-before-create history without inventing a Session or delivery", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      const recalled = revisionEvent({
        providerEventId: "early-recall",
        externalMessageId: "early-message",
        operation: "deleted",
        occurredAt: "2026-08-19T00:00:02.000Z",
        revisionKey: "2",
      });
      recalled.conversation.kind = "unknown";
      recalled.mentions = [];
      const recallResult = await inbox.ingest(value.integrationId, 1, recalled);
      expect(recallResult.deliveryIds).toEqual([]);
      const created = revisionEvent({
        providerEventId: "late-create",
        externalMessageId: "early-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      const createResult = await inbox.ingest(value.integrationId, 1, created);
      expect(createResult.deliveryIds).toEqual([]);
      expect(await value.database.select().from(sessions)).toEqual([]);
      expect(await value.database.select().from(imMessageDeliveries)).toEqual([]);
      const messages = await value.database.select().from(imMessages);
      expect(messages.find((message) => message.id === recallResult.messageId)).toMatchObject({
        operation: "deleted",
      });
      expect(messages.find((message) => message.id === recallResult.messageId)).not.toHaveProperty("conversationKind");
    } finally {
      await value.sql.end();
    }
  });

  it("keeps pending delivery durable across a failed worker and accepts it after restart", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-worker"));
      const registry = { currentInstanceId: () => instanceId };
      const failedDomain = {
        requestReconcile: vi.fn().mockRejectedValue(new Error("runtime unavailable")),
        requestDelivery: vi.fn(),
      };
      await new ImDeliveryWorker({
        database: value.database,
        registry: registry as never,
        domain: failedDomain as never,
      }).runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]?.state).toBe("pending");

      await value.database.update(imMessageDeliveries).set({ nextAttemptAt: new Date(0) });
      const recovered = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        userId: value.bootstrap.userId,
      });
      await new ImDeliveryWorker({
        database: value.database,
        registry: recovered.registry,
        domain: recovered.domain,
      }).runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({ state: "accepted" });
      expect(recovered.frames).toEqual([
        expect.objectContaining({ type: "session:reconcile" }),
        expect.objectContaining({
          type: "im:deliver",
          attention: "direct",
          runtime: expect.objectContaining({
            allowedTools: ["opentag_message_send", "opentag_message_reply", "opentag_message_react"],
          }),
        }),
      ]);
      recovered.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("expires a never-dispatched delivery even after reconcile increased its attempt count", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-reconcile-expiry"));
      const failedDomain = {
        requestReconcile: vi.fn().mockRejectedValue(new Error("reconcile failed before dispatch")),
        requestDelivery: vi.fn(),
      };
      const registry = { currentInstanceId: () => instanceId };
      const worker = new ImDeliveryWorker({
        database: value.database,
        registry: registry as never,
        domain: failedDomain as never,
      });
      await worker.runOnce();
      const [failed] = await value.database.select().from(imMessageDeliveries);
      expect(failed).toMatchObject({
        attemptCount: 1,
        dispatchRequestId: null,
        state: "pending",
      });
      await value.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(0), nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, failed?.id as string));
      await worker.runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "expired",
        reason: "ttl",
        dispatchRequestId: null,
      });
      expect(failedDomain.requestDelivery).not.toHaveBeenCalled();
    } finally {
      await value.sql.end();
    }
  });

  it("recovers accepted custody and retained Turn reports across rebuilt Server owners", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-custody-restart"));
      const first = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        userId: value.bootstrap.userId,
      });
      owners.push(first.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted?.turnId || !accepted.dispatchRequestId || !accepted.dispatchInputHash) {
        throw new Error("Accepted delivery fixture was not persisted");
      }
      const report = turnReportFor({
        agentId: value.agent.id,
        deliveryId: accepted.id,
        placementGeneration: accepted.placementGeneration,
        sessionId: accepted.sessionId,
        turnId: accepted.turnId,
      });
      first.domain.close();

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(computers.id, value.computer.id));
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, accepted.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        userId: value.bootstrap.userId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: "recovery_required",
          reason: "unresolved_turn",
          turn: { deliveryId: report.deliveryId, turnId: report.turnId },
          retainedReports: [
            {
              dispatchRequestId: accepted.dispatchRequestId,
              deliveryId: report.deliveryId,
              inputHash: accepted.dispatchInputHash,
              turnId: report.turnId,
              placementGeneration: report.placementGeneration,
              resultHash: report.resultHash,
            },
          ],
        }),
      });
      owners.push(second.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(await second.domain.getDelivery(accepted.id)).toMatchObject({ instanceId: secondInstanceId });
      await expect(second.domain.handle(report, second.context)).resolves.toMatchObject({ status: "recorded" });
      expect(await second.domain.getTurn(report.turnId)).toMatchObject({ resultHash: report.resultHash });
      second.domain.close();

      const thirdInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: thirdInstanceId })
        .where(eq(computers.id, value.computer.id));
      const third = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: thirdInstanceId,
        userId: value.bootstrap.userId,
      });
      owners.push(third.domain);
      await expect(
        third.domain.handle({ ...report, requestId: crypto.randomUUID() }, third.context),
      ).resolves.toMatchObject({ status: "already_recorded" });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it.each(["pending", "expired"] as const)(
    "recovers a retained Client Turn from a %s dispatch after rebuilding the Server owner",
    async (durableState) => {
      const value = await fixture();
      const owners: RuntimeDomainOwner[] = [];
      try {
        const firstInstanceId = crypto.randomUUID();
        await value.database
          .update(computers)
          .set({ currentInstanceId: firstInstanceId })
          .where(eq(computers.id, value.computer.id));
        await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound(`Ev-retained-${durableState}`));
        const first = await respondingRuntime({
          acceptDeliveries: false,
          database: value.database,
          computerId: value.computer.id,
          instanceId: firstInstanceId,
          requestTimeoutMs: 10,
          userId: value.bootstrap.userId,
        });
        owners.push(first.domain);
        await new ImDeliveryWorker({
          database: value.database,
          registry: first.registry,
          domain: first.domain,
        }).runOnce();
        const firstFrame = first.frames.find(
          (frame): frame is DirectImMessageDeliveryRequest =>
            typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
        );
        if (!firstFrame) throw new Error("Initial delivery frame was not dispatched");
        const turnId = `turn-${durableState}-retained`;
        const report = turnReportFor({
          agentId: firstFrame.agentId,
          deliveryId: firstFrame.deliveryId,
          placementGeneration: firstFrame.placementGeneration,
          sessionId: firstFrame.sessionId,
          turnId,
        });

        if (durableState === "expired") {
          await value.database
            .update(imMessageDeliveries)
            .set({ expiresAt: new Date(0), nextAttemptAt: new Date(0) })
            .where(eq(imMessageDeliveries.id, firstFrame.deliveryId));
          const expiryDomain = {
            requestReconcile: vi.fn().mockResolvedValue({ status: "recovery_required" }),
            requestDelivery: vi.fn(),
          };
          await new ImDeliveryWorker({
            database: value.database,
            registry: first.registry,
            domain: expiryDomain as never,
          }).runOnce();
          expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
            dispatchRequestId: firstFrame.requestId,
            state: "expired",
          });
          expect(expiryDomain.requestDelivery).not.toHaveBeenCalled();
        }
        first.domain.close();

        const secondInstanceId = crypto.randomUUID();
        await value.database
          .update(computers)
          .set({ currentInstanceId: secondInstanceId })
          .where(eq(computers.id, value.computer.id));
        await value.database
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(imMessageDeliveries.id, firstFrame.deliveryId));
        const second = await respondingRuntime({
          database: value.database,
          computerId: value.computer.id,
          instanceId: secondInstanceId,
          userId: value.bootstrap.userId,
          reconcileResult: (frame) => ({
            type: "session:reconcile:result",
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            placementGeneration: frame.placementGeneration,
            status: "recovery_required",
            reason: "unresolved_turn",
            turn: { deliveryId: firstFrame.deliveryId, turnId },
            retainedReports: [
              {
                dispatchRequestId: firstFrame.requestId,
                deliveryId: firstFrame.deliveryId,
                inputHash: computeDirectInputHash(firstFrame),
                turnId,
                placementGeneration: firstFrame.placementGeneration,
                resultHash: report.resultHash,
              },
            ],
          }),
        });
        owners.push(second.domain);
        await new ImDeliveryWorker({
          database: value.database,
          registry: second.registry,
          domain: second.domain,
        }).runOnce();
        expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
        expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
          reportOwnerInstanceId: secondInstanceId,
          state: "accepted",
          turnId,
        });
        await expect(second.domain.handle(report, second.context)).resolves.toMatchObject({ status: "recorded" });
        expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
          reportedAt: expect.any(Date),
          state: "accepted",
          turnId,
        });
      } finally {
        for (const owner of owners) owner.close();
        await value.sql.end();
      }
    },
  );

  it("releases an unclaimed persisted dispatch before creating one fresh attempt", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-immutable-dispatch"));
      const first = await respondingRuntime({
        acceptDeliveries: false,
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        requestTimeoutMs: 10,
        userId: value.bootstrap.userId,
      });
      owners.push(first.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const firstFrame = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!firstFrame) throw new Error("Initial delivery frame was not dispatched");
      first.domain.close();

      await value.database
        .update(agents)
        .set({ revision: firstFrame.runtime.revision.agent.sequence + 1 })
        .where(eq(agents.id, value.agent.id));
      await value.database
        .update(sessions)
        .set({ revision: firstFrame.runtime.revision.session.sequence + 1 })
        .where(eq(sessions.id, firstFrame.sessionId));
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, firstFrame.deliveryId));
      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(computers.id, value.computer.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        userId: value.bootstrap.userId,
      });
      owners.push(second.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchInputHash: null,
        dispatchPayload: null,
        dispatchRequestId: null,
        state: "pending",
      });

      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, firstFrame.deliveryId));
      await new ImDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      const replacement = second.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      expect(replacement).toMatchObject({
        deliveryId: firstFrame.deliveryId,
        runtime: {
          revision: {
            agent: { sequence: firstFrame.runtime.revision.agent.sequence + 1 },
            session: { sequence: firstFrame.runtime.revision.session.sequence + 1 },
          },
        },
      });
      expect(replacement?.requestId).not.toBe(firstFrame.requestId);
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toHaveLength(1);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "accepted",
        turnId: `turn-${firstFrame.deliveryId}`,
      });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("binds a pending delivery to a moved placement before send", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-move-before-send"));
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      await new SessionService(value.database).movePlacement(session.id, value.computer.id);
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        userId: value.bootstrap.userId,
      });
      await new ImDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      expect(runtime.frames).toEqual([
        expect.objectContaining({ type: "session:reconcile", placementGeneration: 2 }),
        expect.objectContaining({ type: "im:deliver", placementGeneration: 2 }),
      ]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        state: "accepted",
        placementGeneration: 2,
      });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("rejects placement movement until an in-flight delivery reports", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-move-awaiting"));
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const gate = deferred<void>();
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        deliveryGate: gate.promise,
        instanceId,
        userId: value.bootstrap.userId,
      });
      const run = new ImDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      await expect.poll(() => runtime.frames.length).toBe(2);
      const sessionService = new SessionService(value.database);
      await expect(sessionService.movePlacement(session.id, value.computer.id)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN",
      });
      gate.resolve();
      await run;
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted?.turnId) throw new Error("Accepted custody was not persisted");
      await expect(sessionService.movePlacement(session.id, value.computer.id)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_PENDING",
      });
      const report = turnReportFor({
        agentId: value.agent.id,
        deliveryId: accepted.id,
        placementGeneration: accepted.placementGeneration,
        sessionId: accepted.sessionId,
        turnId: accepted.turnId,
      });
      await expect(runtime.domain.handle(report, runtime.context)).resolves.toMatchObject({ status: "recorded" });
      await expect(sessionService.movePlacement(session.id, value.computer.id)).resolves.toMatchObject({
        generation: 2,
      });
      runtime.domain.close();
    } finally {
      await value.sql.end();
    }
  });

  it("requires old-placement reconciliation before moving a pending dispatch", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-move-persisted-pending"));
      const first = await respondingRuntime({
        acceptDeliveries: false,
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        requestTimeoutMs: 10,
        userId: value.bootstrap.userId,
      });
      owners.push(first.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const oldRequest = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!oldRequest) throw new Error("Old generation dispatch was not persisted");
      first.domain.close();

      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.computer.id),
      ).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN",
      });

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(computers.id, value.computer.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        userId: value.bootstrap.userId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: "rejected",
          reason: "session_binding_conflict",
        }),
      });
      owners.push(second.domain);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await new ImDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchRequestId: oldRequest.requestId,
        placementGeneration: 1,
        state: "pending",
      });
      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.computer.id),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN" });
      second.domain.close();

      const thirdInstanceId = crypto.randomUUID();
      const conflictingReport = turnReportFor({
        agentId: oldRequest.agentId,
        deliveryId: oldRequest.deliveryId,
        placementGeneration: oldRequest.placementGeneration,
        sessionId: oldRequest.sessionId,
        turnId: "turn-conflicting-retained-claim",
      });
      await value.database
        .update(computers)
        .set({ currentInstanceId: thirdInstanceId })
        .where(eq(computers.id, value.computer.id));
      const third = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: thirdInstanceId,
        userId: value.bootstrap.userId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: "ready",
          retainedReports: [
            {
              dispatchRequestId: oldRequest.requestId,
              deliveryId: oldRequest.deliveryId,
              inputHash: "f".repeat(64),
              turnId: conflictingReport.turnId,
              placementGeneration: oldRequest.placementGeneration,
              resultHash: conflictingReport.resultHash,
            },
          ],
        }),
      });
      owners.push(third.domain);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await new ImDeliveryWorker({
        database: value.database,
        registry: third.registry,
        domain: third.domain,
      }).runOnce();
      expect(third.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchRequestId: oldRequest.requestId,
        lastErrorCode: "IM_DELIVERY_RETAINED_CUSTODY_CONFLICT",
        placementGeneration: 1,
        state: "pending",
      });
      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.computer.id),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN" });
      third.domain.close();

      const fourthInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: fourthInstanceId })
        .where(eq(computers.id, value.computer.id));
      const fourth = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: fourthInstanceId,
        userId: value.bootstrap.userId,
      });
      owners.push(fourth.domain);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await new ImDeliveryWorker({
        database: value.database,
        registry: fourth.registry,
        domain: fourth.domain,
      }).runOnce();
      expect(fourth.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchRequestId: null,
        dispatchPayload: null,
        placementGeneration: 1,
        state: "pending",
      });
      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.computer.id),
      ).resolves.toMatchObject({ generation: 2 });
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await new ImDeliveryWorker({
        database: value.database,
        registry: fourth.registry,
        domain: fourth.domain,
      }).runOnce();
      const newRequest = fourth.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      expect(newRequest).toMatchObject({ deliveryId: oldRequest.deliveryId, placementGeneration: 2 });
      expect(newRequest?.requestId).not.toBe(oldRequest.requestId);
      expect(fourth.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toHaveLength(1);
      const custody = new PostgresRuntimeCustodyStore(value.database);
      await expect(
        custody.acceptDelivery(oldRequest, computeDirectInputHash(oldRequest), "turn-old-generation", first.context),
      ).resolves.toBe("stale_generation");
      if (!newRequest) throw new Error("New generation dispatch was not sent");
      const staleReport = turnReportFor({
        agentId: oldRequest.agentId,
        deliveryId: oldRequest.deliveryId,
        placementGeneration: oldRequest.placementGeneration,
        sessionId: oldRequest.sessionId,
        turnId: `turn-${newRequest.deliveryId}`,
      });
      await expect(fourth.domain.handle(staleReport, fourth.context)).resolves.toMatchObject({
        status: "stale_generation",
      });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("requires old-placement reconciliation before moving an expired dispatch", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-move-persisted-expired"));
      const first = await respondingRuntime({
        acceptDeliveries: false,
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        requestTimeoutMs: 10,
        userId: value.bootstrap.userId,
      });
      owners.push(first.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const oldRequest = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!oldRequest) throw new Error("Old generation dispatch was not persisted");
      await value.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(0), nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await new ImDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: {
          requestReconcile: vi.fn().mockResolvedValue({ status: "recovery_required" }),
          requestDelivery: vi.fn(),
        } as never,
      }).runOnce();
      first.domain.close();

      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.computer.id),
      ).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN",
      });
      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(computers.id, value.computer.id));
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        userId: value.bootstrap.userId,
      });
      owners.push(second.domain);
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, oldRequest.deliveryId));
      await new ImDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
        dispatchInputHash: null,
        dispatchPayload: null,
        dispatchRequestId: null,
        state: "expired",
      });
      await expect(
        new SessionService(value.database).movePlacement(oldRequest.sessionId, value.computer.id),
      ).resolves.toMatchObject({ generation: 2 });
      await expect(
        new PostgresRuntimeCustodyStore(value.database).acceptDelivery(
          oldRequest,
          computeDirectInputHash(oldRequest),
          "turn-expired-old-generation",
          first.context,
        ),
      ).resolves.toBe("stale_generation");
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("rejects placement migration while accepted custody is still unreported", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-move-accepted"));
      const runtime = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        userId: value.bootstrap.userId,
      });
      owners.push(runtime.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: runtime.registry,
        domain: runtime.domain,
      }).runOnce();
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted?.turnId) throw new Error("Accepted custody was not persisted");
      expect(accepted.dispatchPayload).toBeNull();
      const sessionsService = new SessionService(value.database);
      await expect(sessionsService.movePlacement(accepted.sessionId, value.computer.id)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_CUSTODY_PENDING",
      });
      const report = turnReportFor({
        agentId: value.agent.id,
        deliveryId: accepted.id,
        placementGeneration: accepted.placementGeneration,
        sessionId: accepted.sessionId,
        turnId: accepted.turnId,
      });
      await expect(runtime.domain.handle(report, runtime.context)).resolves.toMatchObject({ status: "recorded" });
      await expect(sessionsService.movePlacement(accepted.sessionId, value.computer.id)).resolves.toMatchObject({
        generation: 2,
      });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("rejects placement migration after the Client durably accepts but loses its accepted frame", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    const clientHome = await mkdtemp(resolve(tmpdir(), "opentag-im-client-custody-"));
    try {
      const firstInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: firstInstanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-client-custody-lost-frame"));
      const first = await respondingRuntime({
        acceptDeliveries: false,
        database: value.database,
        computerId: value.computer.id,
        instanceId: firstInstanceId,
        requestTimeoutMs: 10,
        userId: value.bootstrap.userId,
      });
      owners.push(first.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const dispatched = first.frames.find(
        (frame): frame is DirectImMessageDeliveryRequest =>
          typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
      );
      if (!dispatched) throw new Error("The Client custody fixture was not dispatched");

      const clientStore = await createClientSessionBindingStore(clientHome);
      await clientStore.prepare(
        {
          type: "session:reconcile",
          requestId: crypto.randomUUID(),
          computerId: value.computer.id,
          sessionId: dispatched.sessionId,
          agentId: dispatched.agentId,
          placementGeneration: dispatched.placementGeneration,
          desired: "ready",
          runtime: dispatched.runtime,
        },
        computeRuntimeSnapshotHashes(dispatched.runtime),
      );
      const inputHash = computeDirectInputHash(dispatched);
      const turnId = `turn-client-${dispatched.deliveryId}`;
      const report = turnReportFor({
        agentId: dispatched.agentId,
        deliveryId: dispatched.deliveryId,
        placementGeneration: dispatched.placementGeneration,
        sessionId: dispatched.sessionId,
        turnId,
      });
      await clientStore.recordAccepted(dispatched, inputHash, turnId);
      await clientStore.updateUnresolved(dispatched.agentId, dispatched.sessionId, turnId, "reporting", {
        report,
        resultHash: report.resultHash,
      });
      expect((await clientStore.read(dispatched.agentId, dispatched.sessionId))?.unresolvedTurn).toMatchObject({
        deliveryId: dispatched.deliveryId,
        phase: "reporting",
        turnId,
      });
      await expect(
        new SessionService(value.database).movePlacement(dispatched.sessionId, value.computer.id),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_CUSTODY_UNCERTAIN" });
      first.domain.close();

      const secondInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: secondInstanceId })
        .where(eq(computers.id, value.computer.id));
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, dispatched.deliveryId));
      const retained = await clientStore.read(dispatched.agentId, dispatched.sessionId);
      if (!retained?.unresolvedTurn?.resultHash) throw new Error("The Client retained report was not persisted");
      const second = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId: secondInstanceId,
        userId: value.bootstrap.userId,
        reconcileResult: (frame) => ({
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: frame.placementGeneration,
          status: "recovery_required",
          reason: "unresolved_turn",
          turn: { deliveryId: dispatched.deliveryId, turnId },
          retainedReports: [
            {
              dispatchRequestId: retained.unresolvedTurn?.requestId,
              deliveryId: dispatched.deliveryId,
              inputHash: retained.unresolvedTurn?.inputHash,
              turnId,
              placementGeneration: dispatched.placementGeneration,
              resultHash: retained.unresolvedTurn?.resultHash,
            },
          ],
        }),
      });
      owners.push(second.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: second.registry,
        domain: second.domain,
      }).runOnce();
      expect(second.frames.filter((frame) => (frame as { type?: unknown }).type === "im:deliver")).toEqual([]);
      await expect(second.domain.handle(report, second.context)).resolves.toMatchObject({ status: "recorded" });
      await clientStore.recordResult(dispatched.agentId, dispatched.sessionId, turnId, report.resultHash);
      await expect(
        new SessionService(value.database).movePlacement(dispatched.sessionId, value.computer.id),
      ).resolves.toMatchObject({ generation: 2 });
      expect((await clientStore.read(dispatched.agentId, dispatched.sessionId))?.unresolvedTurn).toBeUndefined();
    } finally {
      for (const owner of owners) owner.close();
      await rm(clientHome, { recursive: true, force: true });
      await value.sql.end();
    }
  });

  it.each(["accepted-result", "retained-claim"] as const)(
    "serializes placement movement with a concurrent %s custody transition",
    async (transition) => {
      const value = await fixture();
      const owners: RuntimeDomainOwner[] = [];
      try {
        const instanceId = crypto.randomUUID();
        await value.database
          .update(computers)
          .set({ currentInstanceId: instanceId })
          .where(eq(computers.id, value.computer.id));
        await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound(`Ev-lock-order-${transition}`));
        const runtime = await respondingRuntime({
          acceptDeliveries: false,
          database: value.database,
          computerId: value.computer.id,
          instanceId,
          requestTimeoutMs: 10,
          userId: value.bootstrap.userId,
        });
        owners.push(runtime.domain);
        await new ImDeliveryWorker({
          database: value.database,
          registry: runtime.registry,
          domain: runtime.domain,
        }).runOnce();
        const dispatched = runtime.frames.find(
          (frame): frame is DirectImMessageDeliveryRequest =>
            typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "im:deliver",
        );
        if (!dispatched) throw new Error("The lock-order fixture was not dispatched");
        const placementLocked = deferred<void>();
        const releaseMove = deferred<void>();
        const move = new SessionService(value.database, {
          afterPlacementLock: async () => {
            placementLocked.resolve();
            await releaseMove.promise;
          },
        })
          .movePlacement(dispatched.sessionId, value.computer.id)
          .then(
            () => "moved",
            (error: unknown) => (error as { code?: string }).code ?? "failed",
          );
        await placementLocked.promise;

        const custody = new PostgresRuntimeCustodyStore(value.database);
        const inputHash = computeDirectInputHash(dispatched);
        const turnId = `turn-lock-${transition}`;
        const report = turnReportFor({
          agentId: dispatched.agentId,
          deliveryId: dispatched.deliveryId,
          placementGeneration: dispatched.placementGeneration,
          sessionId: dispatched.sessionId,
          turnId,
        });
        const transitionResult =
          transition === "accepted-result"
            ? custody.acceptDelivery(dispatched, inputHash, turnId, runtime.context)
            : custody
                .claimRetainedReports(
                  {
                    type: "session:reconcile",
                    requestId: crypto.randomUUID(),
                    computerId: value.computer.id,
                    sessionId: dispatched.sessionId,
                    agentId: dispatched.agentId,
                    placementGeneration: dispatched.placementGeneration,
                    desired: "ready",
                    runtime: dispatched.runtime,
                  },
                  [
                    {
                      dispatchRequestId: dispatched.requestId,
                      deliveryId: dispatched.deliveryId,
                      inputHash,
                      turnId,
                      placementGeneration: dispatched.placementGeneration,
                      resultHash: report.resultHash,
                    },
                  ],
                  runtime.context,
                )
                .then(() => "claimed" as const);
        releaseMove.resolve();
        const [moveResult, custodyResult] = await settleWithin(Promise.all([move, transitionResult]));
        expect(moveResult).toBe("SESSION_PLACEMENT_CUSTODY_UNCERTAIN");
        expect(custodyResult).toBe(transition === "accepted-result" ? "accepted" : "claimed");
        expect((await value.database.select().from(sessionPlacements))[0]).toMatchObject({ generation: 1 });
        expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({
          placementGeneration: 1,
          state: "accepted",
          turnId,
        });
      } finally {
        for (const owner of owners) owner.close();
        await value.sql.end();
      }
    },
  );

  it("claims due report recovery fairly while newer pending deliveries remain due", async () => {
    const value = await fixture();
    const owners: RuntimeDomainOwner[] = [];
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      const inbox = new ImMessageInbox(value.database);
      await inbox.ingest(value.integrationId, 1, inbound("Ev-recovery-fair-first"));
      const first = await respondingRuntime({
        database: value.database,
        computerId: value.computer.id,
        instanceId,
        userId: value.bootstrap.userId,
      });
      owners.push(first.domain);
      await new ImDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      const [accepted] = await value.database.select().from(imMessageDeliveries);
      if (!accepted) throw new Error("Accepted recovery fixture was not persisted");

      await inbox.ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "Ev-recovery-fair-pending",
          externalMessageId: "recovery-fair-pending",
          operation: "created",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "1",
        }),
      );
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(imMessageDeliveries.id, accepted.id));
      const pendingRows = await value.database.select().from(imMessageDeliveries);
      const pending = pendingRows.find((delivery) => delivery.id !== accepted.id);
      if (!pending) throw new Error("Pending fairness fixture was not persisted");
      await value.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(1) })
        .where(eq(imMessageDeliveries.id, pending.id));

      const before = first.frames.length;
      await new ImDeliveryWorker({
        database: value.database,
        registry: first.registry,
        domain: first.domain,
      }).runOnce();
      expect(first.frames.slice(before)).toEqual([expect.objectContaining({ type: "session:reconcile" })]);
      expect(
        (await value.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, pending.id)))[0],
      ).toMatchObject({ attemptCount: 0, state: "pending" });
    } finally {
      for (const owner of owners) owner.close();
      await value.sql.end();
    }
  });

  it("fences stale placement generations and ends chat Sessions only on explicit replacement", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      await inbox.ingest(value.integrationId, 1, inbound("Ev1"));
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const sessionService = new SessionService(value.database);
      await expect(sessionService.assertPlacement(session.id, value.computer.id, 1)).resolves.toBeUndefined();
      await sessionService.movePlacement(session.id, value.computer.id);
      await expect(sessionService.assertPlacement(session.id, value.computer.id, 1)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_STALE",
      });

      const replacementIntegrationId = await value.integrationService.activateSlack({
        agentId: value.agent.id,
        appId: "A2",
        teamId: "T1",
        botUserId: "U_BOT_2",
        grantedBotScopes: [
          "chat:write",
          "app_mentions:read",
          "im:history",
          "channels:history",
          "groups:history",
          "mpim:history",
        ],
        botAccessToken: "xoxb-replacement",
        signingSecret: "replacement-secret",
        installedAt: new Date(),
      });
      expect(
        (await value.database.select().from(sessions).where(eq(sessions.id, session.id)))[0]?.endedAt,
      ).not.toBeNull();
      expect(await value.database.select().from(imMessages)).toHaveLength(1);
      const integrationRows = await value.database.select().from(integrations);
      expect(integrationRows.find((row) => row.id === value.integrationId)?.status).toBe("disabled");
      expect(integrationRows.find((row) => row.id === replacementIntegrationId)?.status).toBe("active");
      const rebound = inbound("Ev2");
      rebound.externalAppId = "A2";
      rebound.message.externalId = "1000.2";
      rebound.mentions = [{ externalId: "U_BOT_2", displayName: "Assistant" }];
      await inbox.ingest(replacementIntegrationId, 1, rebound);
      const sessionRows = await value.database.select().from(sessions);
      expect(sessionRows).toHaveLength(2);
      expect(sessionRows.find((row) => row.id !== session.id)?.endedAt).toBeNull();
    } finally {
      await value.sql.end();
    }
  });

  it("authorizes lazy resources by Session placement and preserves oversized messages", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      const event = inbound("Ev-resource");
      event.message.resources = [
        {
          providerResourceKey: "F1",
          kind: "file",
          filename: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
        },
        {
          providerResourceKey: "F2",
          kind: "file",
          filename: "oversized.bin",
          mediaType: "application/octet-stream",
          sizeBytes: 25 * 1024 * 1024 + 1,
        },
      ];
      const admitted = await new ImMessageInbox(value.database).ingest(value.integrationId, 1, event);
      if (!admitted.messageId) throw new Error("Resource message fixture was not created");
      const [message] = await value.database.select().from(imMessages).where(eq(imMessages.id, admitted.messageId));
      const [session] = await value.database.select().from(sessions);
      if (!session || !message) throw new Error("Resource fixture was not created");
      expect(message.content.resources?.map((resource) => resource.availability)).toEqual(["available", "too_large"]);

      const resources = new ImResourceService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTeamId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({
          stream: Readable.from(Buffer.from("hello world!")),
          filename: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
        }),
      }));
      const runtimeScope = {
        sessionId: session.id,
        computerId: value.computer.id,
        instanceId,
        placementGeneration: 1,
      };
      const opened = await resources.open(value.bootstrap.userId, runtimeScope, message.id, 0);
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("hello world!");
      await expect(resources.open(crypto.randomUUID(), runtimeScope, message.id, 0)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        resources.open(value.bootstrap.userId, { ...runtimeScope, placementGeneration: 2 }, message.id, 0),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(resources.open(value.bootstrap.userId, runtimeScope, message.id, 1)).rejects.toMatchObject({
        statusCode: 413,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("guards outbound writes by immutable request, latest input, and placement authority", async () => {
    const value = await fixture();
    try {
      const computerInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: computerInstanceId })
        .where(eq(computers.id, value.computer.id));
      const admitted = await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-outbound"));
      const [session] = await value.database.select().from(sessions);
      if (!session || !admitted.messageId) throw new Error("Outbound fixture was not created");
      let sends = 0;
      let rateLimited = false;
      const providerRelease = deferred<void>();
      const outbound = new OutboundMessageService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTeamId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => {
          sends += 1;
          await providerRelease.promise;
          if (rateLimited) {
            return {
              ok: false as const,
              category: "rate_limited" as const,
              code: "ratelimited",
              retryAfterSeconds: 17,
            };
          }
          return { ok: true as const, externalMessageId: "1000.2", occurredAt: new Date() };
        },
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }));
      const requestId = crypto.randomUUID();
      const request = {
        requestId,
        sessionId: session.id,
        agentId: value.agent.id,
        computerId: value.computer.id,
        computerInstanceId,
        placementGeneration: 1,
        expectedLatestImMessageId: admitted.messageId,
        operation: "send" as const,
        content: {
          version: 1 as const,
          fallbackText: "answer",
          blocks: [{ type: "text" as const, text: "answer" }],
          truncated: false,
        },
      };
      const firstWrite = outbound.execute(request);
      const concurrentWrite = outbound.execute(request);
      await expect.poll(() => sends).toBe(1);
      providerRelease.resolve();
      await expect(firstWrite).resolves.toMatchObject({ state: "succeeded" });
      await expect(concurrentWrite).resolves.toMatchObject({ state: "succeeded" });
      expect(sends).toBe(1);
      const replacementInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: replacementInstanceId })
        .where(eq(computers.id, value.computer.id));
      const replayRequest = { ...request, computerInstanceId: replacementInstanceId };
      await expect(outbound.execute(replayRequest)).resolves.toMatchObject({ state: "succeeded" });
      expect(sends).toBe(1);
      rateLimited = true;
      const rateLimitedRequest = { ...replayRequest, requestId: crypto.randomUUID() };
      await expect(outbound.execute(rateLimitedRequest)).resolves.toEqual({
        state: "transient_failed",
        code: "ratelimited",
        retryAfterSeconds: 17,
      });
      await expect(outbound.execute(rateLimitedRequest)).resolves.toEqual({
        state: "transient_failed",
        code: "ratelimited",
        retryAfterSeconds: 17,
      });
      expect(sends).toBe(2);
      await expect(
        outbound.execute({ ...replayRequest, content: { ...request.content, fallbackText: "different" } }),
      ).rejects.toThrow("OUTBOUND_REQUEST_CONFLICT");
      await expect(
        outbound.execute({
          ...replayRequest,
          requestId: crypto.randomUUID(),
          expectedLatestImMessageId: crypto.randomUUID(),
        }),
      ).rejects.toThrow("OUTBOUND_LATEST_MESSAGE_STALE");

      const internal = await new SessionService(value.database).createInternalSession(session.id);
      await expect(
        outbound.execute({ ...replayRequest, requestId: crypto.randomUUID(), sessionId: internal.session.id }),
      ).rejects.toThrow("OUTBOUND_SESSION_UNAUTHORIZED");

      let unknownWrites = 0;
      const unknownOutbound = new OutboundMessageService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTeamId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => {
          unknownWrites += 1;
          return { ok: false as const, category: "unknown" as const, code: "provider_unavailable" };
        },
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }));
      const unknownRequest = { ...replayRequest, requestId: crypto.randomUUID() };
      await expect(unknownOutbound.execute(unknownRequest)).resolves.toMatchObject({ state: "unknown" });
      await expect(unknownOutbound.execute(unknownRequest)).resolves.toMatchObject({ state: "unknown" });
      expect(unknownWrites).toBe(1);

      const resolutionFailure = new OutboundMessageService(value.database, async () => {
        throw new ProviderAdapterResolutionError("INTEGRATION_ADAPTER_UNAVAILABLE");
      });
      await expect(
        resolutionFailure.execute({ ...replayRequest, requestId: crypto.randomUUID() }),
      ).resolves.toMatchObject({ state: "transient_failed", code: "provider_unavailable" });
    } finally {
      await value.sql.end();
    }
  });

  it("marks the Integration reauthorization-required in the credential failure transaction", async () => {
    const value = await fixture();
    try {
      const computerInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: computerInstanceId })
        .where(eq(computers.id, value.computer.id));
      const admitted = await new ImMessageInbox(value.database).ingest(
        value.integrationId,
        1,
        inbound("Ev-credential-failed"),
      );
      const [session] = await value.database.select().from(sessions);
      if (!session || !admitted.messageId) throw new Error("Outbound fixture was not created");
      const outbound = new OutboundMessageService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTeamId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => ({ ok: false as const, category: "credential" as const, code: "invalid_auth" }),
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }));
      await expect(
        outbound.execute({
          requestId: crypto.randomUUID(),
          sessionId: session.id,
          agentId: value.agent.id,
          computerId: value.computer.id,
          computerInstanceId,
          placementGeneration: 1,
          expectedLatestImMessageId: admitted.messageId,
          operation: "send",
          content: {
            version: 1,
            fallbackText: "answer",
            blocks: [{ type: "text", text: "answer" }],
            truncated: false,
          },
        }),
      ).resolves.toEqual({ state: "credential_failed", code: "invalid_auth", retryAfterSeconds: undefined });
      expect((await value.database.select().from(integrations))[0]).toMatchObject({
        status: "reauthorization_required",
        lastErrorCode: "invalid_auth",
      });
      await expect(
        value.integrationService.diagnostics(value.bootstrap.userId, value.integrationId),
      ).resolves.toMatchObject({ ready: false, reauthorizationRequired: true, lastErrorCode: "invalid_auth" });
    } finally {
      await value.sql.end();
    }
  });

  it("rejects reply and reaction targets whose current provider revision is deleted", async () => {
    const value = await fixture();
    try {
      const computerInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: computerInstanceId })
        .where(eq(computers.id, value.computer.id));
      await value.database
        .update(integrations)
        .set({
          grantedCapabilities: [
            "chat:write",
            "app_mentions:read",
            "im:history",
            "channels:history",
            "groups:history",
            "mpim:history",
            "reactions:write",
          ],
        })
        .where(eq(integrations.id, value.integrationId));
      const inbox = new ImMessageInbox(value.database);
      const created = await inbox.ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "target-create",
          externalMessageId: "target-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:01.000Z",
          revisionKey: "1",
        }),
      );
      const [createdDelivery] = await value.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.messageId, created.messageId as string));
      if (!created.messageId || !createdDelivery) throw new Error("Deleted target fixture was not created");
      await value.database
        .update(imMessageDeliveries)
        .set({
          state: "accepted",
          inputHash: "input-hash",
          turnId: "accepted-target-turn",
          reportOwnerInstanceId: crypto.randomUUID(),
          acceptedAt: new Date(),
        })
        .where(eq(imMessageDeliveries.id, createdDelivery.id));
      await inbox.ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "target-delete",
          externalMessageId: "target-message",
          operation: "deleted",
          occurredAt: "2026-08-19T00:00:02.000Z",
          revisionKey: "2",
        }),
      );
      const latest = await inbox.ingest(
        value.integrationId,
        1,
        revisionEvent({
          providerEventId: "new-message",
          externalMessageId: "new-message",
          operation: "created",
          occurredAt: "2026-08-19T00:00:03.000Z",
          revisionKey: "1",
        }),
      );
      const [session] = await value.database.select().from(sessions);
      if (!session || !latest.messageId) throw new Error("Latest message fixture was not created");
      let providerCalls = 0;
      const outbound = new OutboundMessageService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTeamId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => {
          providerCalls += 1;
          return { ok: true as const, externalMessageId: "sent", occurredAt: new Date() };
        },
        react: async () => {
          providerCalls += 1;
          return { ok: true as const, externalMessageId: "reacted", occurredAt: new Date() };
        },
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }));
      const base = {
        sessionId: session.id,
        agentId: value.agent.id,
        computerId: value.computer.id,
        computerInstanceId,
        placementGeneration: 1,
        expectedLatestImMessageId: latest.messageId,
      };
      await expect(
        outbound.execute({
          ...base,
          requestId: crypto.randomUUID(),
          operation: "reply",
          replyToImMessageId: created.messageId,
          content: {
            version: 1,
            fallbackText: "reply",
            blocks: [{ type: "text", text: "reply" }],
            truncated: false,
          },
        }),
      ).rejects.toThrow("OUTBOUND_TARGET_INVALID");
      await expect(
        outbound.execute({
          ...base,
          requestId: crypto.randomUUID(),
          operation: "react",
          targetImMessageId: created.messageId,
          emoji: "thumbsup",
        }),
      ).rejects.toThrow("OUTBOUND_TARGET_INVALID");
      expect(providerCalls).toBe(0);
    } finally {
      await value.sql.end();
    }
  });

  it("does not let a delayed old-generation credential failure invalidate a rotated binding", async () => {
    const value = await fixture();
    try {
      const computerInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: computerInstanceId })
        .where(eq(computers.id, value.computer.id));
      const admitted = await new ImMessageInbox(value.database).ingest(
        value.integrationId,
        1,
        inbound("Ev-old-generation"),
      );
      const [session] = await value.database.select().from(sessions);
      if (!session || !admitted.messageId) throw new Error("Outbound fixture was not created");
      const providerResult = deferred<{ ok: false; category: "credential"; code: "invalid_auth" }>();
      const providerEntered = deferred<void>();
      const outbound = new OutboundMessageService(value.database, async (_integrationId, generation) => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTeamId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => {
          expect(generation).toBe(1);
          providerEntered.resolve();
          return providerResult.promise;
        },
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }));
      const executing = outbound.execute({
        requestId: crypto.randomUUID(),
        sessionId: session.id,
        agentId: value.agent.id,
        computerId: value.computer.id,
        computerInstanceId,
        placementGeneration: 1,
        expectedLatestImMessageId: admitted.messageId,
        operation: "send",
        content: {
          version: 1,
          fallbackText: "answer",
          blocks: [{ type: "text", text: "answer" }],
          truncated: false,
        },
      });
      await providerEntered.promise;
      await value.integrationService.activateSlack({
        agentId: value.agent.id,
        appId: "A1",
        teamId: "T1",
        botUserId: "U_BOT",
        grantedBotScopes: [
          "chat:write",
          "app_mentions:read",
          "im:history",
          "channels:history",
          "groups:history",
          "mpim:history",
        ],
        botAccessToken: "xoxb-rotated",
        signingSecret: "signing-secret-rotated",
        installedAt: new Date(),
      });
      providerResult.resolve({ ok: false, category: "credential", code: "invalid_auth" });
      await expect(executing).resolves.toMatchObject({ state: "credential_failed", code: "invalid_auth" });
      expect((await value.database.select().from(integrations))[0]).toMatchObject({
        credentialGeneration: 2,
        status: "active",
        lastErrorCode: null,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("reuses one Feishu QR attempt and activates only after candidate validation", async () => {
    const value = await unboundFixture();
    try {
      const completion = deferred<{
        appId: string;
        appSecret: string;
        teamBrand: "feishu";
        requestedScopes: string[];
      }>();
      let aborted = false;
      const registration: FeishuRegistration = {
        qrReady: Promise.resolve({
          url: "https://open.feishu.cn/qr/example",
          expiresAt: new Date(Date.now() + 60_000),
        }),
        result: completion.promise,
        abort: () => {
          aborted = true;
        },
      };
      const gateway: FeishuRegistrationGateway = { start: () => registration };
      let validations = 0;
      const instanceId = crypto.randomUUID();
      const manager = new FeishuConnectionManager({
        database: value.database,
        inbox: new ImMessageInbox(value.database),
        instanceId,
        integrations: value.integrationService,
        createAdapter: (input) =>
          ({
            channel: {
              on: () => () => undefined,
              disconnect: async () => undefined,
            },
            validateBinding: async () => {
              validations += 1;
              return {
                externalAppId: input.appId,
                externalTeamId: input.appId,
                externalBotId: "ou_bot",
              };
            },
            listGrantedTeamScopes: async () => [
              "im:message:send_as_bot",
              "im:message.p2p_msg:readonly",
              "im:message.group_at_msg:readonly",
              "im:message.group_msg",
            ],
          }) as unknown as FeishuAdapter,
        maintenanceMs: 1_000_000,
      });
      const setup = new FeishuSetupService({
        database: value.database,
        cipher: value.cipher,
        instanceId,
        integrations: value.integrationService,
        registrations: gateway,
        activation: manager,
      });
      const first = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      const second = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      expect(second.id).toBe(first.id);
      expect(first).toMatchObject({ state: "awaiting_user", qrUrl: "https://open.feishu.cn/qr/example" });
      expect(aborted).toBe(false);

      completion.resolve({
        appId: "cli_1",
        appSecret: "secret",
        teamBrand: "feishu",
        requestedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      await expect.poll(async () => (await setup.get(value.bootstrap.userId, first.id)).state).toBe("succeeded");
      expect(validations).toBe(1);
      expect(await value.integrationService.getForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
        identity: { provider: "feishu", appId: "cli_1", botOpenId: "ou_bot", teamId: null },
      });
      const [stored] = await value.database.select().from(integrations);
      expect(stored?.encryptedSetupContext).toBeNull();
      await manager.stop();
    } finally {
      await value.sql.end();
    }
  });

  it("contains setup completion when activation and failure-state persistence both fail", async () => {
    const value = await unboundFixture();
    let armed = false;
    let completionUpdates = 0;
    const database = new Proxy(value.database, {
      get(target, property) {
        if (property === "update") {
          return (...args: Parameters<typeof target.update>) => {
            if (armed) {
              completionUpdates += 1;
              if (completionUpdates >= 2) throw new Error("database unavailable");
            }
            return target.update(...args);
          };
        }
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const completion = deferred<{
      appId: string;
      appSecret: string;
      teamBrand: "feishu";
      requestedScopes: string[];
    }>();
    const diagnostics: string[] = [];
    const setup = new FeishuSetupService({
      database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      integrations: value.integrationService,
      registrations: {
        start: () => ({
          qrReady: Promise.resolve({
            url: "https://open.feishu.cn/qr/failure",
            expiresAt: new Date(Date.now() + 60_000),
          }),
          result: completion.promise,
          abort: () => undefined,
        }),
      },
      activation: {
        activateAtomicAttempt: vi.fn().mockRejectedValue(new Error("FEISHU_CONNECTION_ERROR")),
      },
      onDiagnostic: (code) => diagnostics.push(code),
    });
    try {
      await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      armed = true;
      completion.resolve({
        appId: "cli_failure",
        appSecret: "secret",
        teamBrand: "feishu",
        requestedScopes: ["im:message:send_as_bot"],
      });
      await expect.poll(() => diagnostics).toContain("FEISHU_SETUP_FAILURE_STATE_WRITE_FAILED");
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      armed = false;
      await setup.stop();
      await value.sql.end();
    }
  });

  it("requires a fresh Feishu Channel observation before diagnostics handoff", async () => {
    const value = await unboundFixture();
    try {
      const now = new Date("2026-08-19T00:00:00.000Z");
      const service = new IntegrationService(value.database, value.cipher, {
        now: () => now,
        runtimeReady: () => true,
      });
      const integrationId = await service.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_diagnostics",
        teamId: "team_diagnostics",
        botOpenId: "ou_diagnostics",
        teamBrand: "feishu",
        appSecret: "secret-diagnostics",
        grantedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      const ownerInstanceId = crypto.randomUUID();
      await value.database
        .update(integrations)
        .set({
          connectionOwnerInstanceId: ownerInstanceId,
          connectionLeaseExpiresAt: new Date("2026-08-19T00:01:00.000Z"),
          observedAt: now,
          observedConnectedAt: null,
        })
        .where(eq(integrations.id, integrationId));
      await expect(service.diagnostics(value.bootstrap.userId, integrationId)).resolves.toMatchObject({
        ready: false,
        runtimeToolAvailable: true,
        connection: { state: "disconnected" },
      });

      await value.database
        .update(integrations)
        .set({
          connectionOwnerInstanceId: ownerInstanceId,
          connectionLeaseExpiresAt: new Date("2026-08-18T23:59:59.000Z"),
          observedAt: now,
          observedConnectedAt: now,
        })
        .where(eq(integrations.id, integrationId));
      await expect(service.diagnostics(value.bootstrap.userId, integrationId)).resolves.toMatchObject({
        ready: false,
        connection: { state: "disconnected" },
      });

      await value.database
        .update(integrations)
        .set({
          connectionOwnerInstanceId: ownerInstanceId,
          connectionLeaseExpiresAt: new Date("2026-08-19T00:01:00.000Z"),
          observedAt: now,
          observedConnectedAt: now,
        })
        .where(eq(integrations.id, integrationId));
      await expect(service.diagnostics(value.bootstrap.userId, integrationId)).resolves.toMatchObject({
        ready: true,
        connection: { state: "connected" },
      });
    } finally {
      await value.sql.end();
    }
  });

  it("builds Feishu outbound and resource HTTP capability on a replica that does not own the Channel lease", async () => {
    const value = await unboundFixture();
    try {
      const integrationId = await value.integrationService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_http",
        teamId: "team_http",
        botOpenId: "ou_http",
        teamBrand: "feishu",
        appSecret: "secret-http",
        grantedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      await value.database
        .update(integrations)
        .set({
          connectionOwnerInstanceId: crypto.randomUUID(),
          connectionFencingEpoch: 7,
          connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(eq(integrations.id, integrationId));
      const sends: string[] = [];
      const resources: string[] = [];
      const resolver = createImProviderAdapterResolver({
        integrations: value.integrationService,
        slackApi: {} as never,
        createFeishuAdapter: (options) =>
          new (class {
            readonly provider = "feishu" as const;
            validateBinding = async () => ({
              externalAppId: options.appId,
              externalTeamId: options.teamId ?? "team_http",
              externalBotId: "ou_http",
            });
            normalizeInbound = () => [];
            send = async () => {
              sends.push(options.appSecret);
              return { ok: true as const, externalMessageId: "om_http", occurredAt: new Date() };
            };
            react = async () => ({ ok: true as const, externalMessageId: "om_http", occurredAt: new Date() });
            fetchResource = async () => {
              resources.push(options.appSecret);
              return { stream: Readable.from(Buffer.from("resource")) };
            };
          })(),
      });
      const adapter = await resolver(integrationId, 1);
      await expect(
        adapter.send({ requestId: crypto.randomUUID(), conversationExternalId: "chat", fallbackText: "hello" }),
      ).resolves.toMatchObject({ ok: true, externalMessageId: "om_http" });
      await expect(
        adapter.fetchResource({ messageExternalId: "om_1", providerResourceKey: "file_1", kind: "file" }),
      ).resolves.toMatchObject({ stream: expect.any(Readable) });
      expect(sends).toEqual(["secret-http"]);
      expect(resources).toEqual(["secret-http"]);
    } finally {
      await value.sql.end();
    }
  });

  it("keeps a replacement Feishu Integration Team unset until its own verified event arrives", async () => {
    const value = await unboundFixture();
    try {
      const scopes = [
        "im:message:send_as_bot",
        "im:message.p2p_msg:readonly",
        "im:message.group_at_msg:readonly",
        "im:message.group_msg",
      ];
      const oldIntegrationId = await value.integrationService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_old",
        teamId: "team_old",
        botOpenId: "ou_old",
        teamBrand: "feishu",
        appSecret: "secret-old",
        grantedScopes: scopes,
      });
      const replacementId = await value.integrationService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_new",
        teamId: null,
        botOpenId: "ou_new",
        teamBrand: "feishu",
        appSecret: "secret-new",
        grantedScopes: scopes,
      });
      expect(replacementId).not.toBe(oldIntegrationId);
      const [replacementBeforeEvent] = await value.database
        .select()
        .from(integrations)
        .where(eq(integrations.id, replacementId));
      expect(replacementBeforeEvent?.externalTeamId).toBeNull();
      const event = revisionEvent({
        providerEventId: "new-team-event",
        externalMessageId: "new-team-message",
        operation: "created",
        occurredAt: "2026-08-19T00:00:01.000Z",
        revisionKey: "1",
      });
      await expect(
        new ImMessageInbox(value.database).ingest(replacementId, 1, {
          ...event,
          externalAppId: "cli_new",
          externalTeamId: "team_new",
        }),
      ).resolves.toMatchObject({ duplicate: false });
      const [replacementAfterEvent] = await value.database
        .select()
        .from(integrations)
        .where(eq(integrations.id, replacementId));
      expect(replacementAfterEvent?.externalTeamId).toBe("team_new");
    } finally {
      await value.sql.end();
    }
  });

  it("does not persist a Feishu binding when the external Team grant omits a requested scope", async () => {
    const value = await unboundFixture();
    const instanceId = crypto.randomUUID();
    const manager = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId,
      integrations: value.integrationService,
      createAdapter: () =>
        ({
          channel: { on: () => undefined, disconnect: async () => undefined },
          validateBinding: async () => ({
            externalAppId: "cli_missing_scope",
            externalTeamId: "team",
            externalBotId: "ou_bot",
          }),
          listGrantedTeamScopes: async () => ["im:message:send_as_bot"],
        }) as unknown as FeishuAdapter,
      maintenanceMs: 1_000_000,
    });
    try {
      const attemptId = await validatingFeishuAttempt(value.database, value.agent.id, instanceId, "create");
      await expect(
        manager.activateAtomicAttempt({
          attemptId,
          ownerInstanceId: instanceId,
          agentId: value.agent.id,
          appId: "cli_missing_scope",
          appSecret: "secret",
          teamBrand: "feishu",
          requestedScopes: ["im:message:send_as_bot", "im:message.group_msg"],
        }),
      ).rejects.toThrow("FEISHU_SCOPE_REAUTH_REQUIRED");
      await expect(
        value.integrationService.getForAgent(value.bootstrap.userId, value.agent.id),
      ).resolves.toBeUndefined();
    } finally {
      await manager.stop();
      await value.sql.end();
    }
  });

  it("fails reauthorization without an existing binding and lets cancel win before activation", async () => {
    const value = await unboundFixture();
    const completion = deferred<{
      appId: string;
      appSecret: string;
      teamBrand: "feishu";
      requestedScopes: string[];
    }>();
    const start = vi.fn(() => ({
      qrReady: Promise.resolve({ url: "https://open.feishu.cn/qr/cancel", expiresAt: new Date(Date.now() + 60_000) }),
      result: completion.promise,
      abort: vi.fn(),
    }));
    const activateAtomicAttempt = vi.fn();
    const setup = new FeishuSetupService({
      database: value.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      integrations: value.integrationService,
      registrations: { start },
      activation: { activateAtomicAttempt },
    });
    try {
      await expect(setup.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize")).rejects.toThrow(
        "FEISHU_REAUTHORIZATION_REQUIRES_BINDING",
      );
      expect(start).not.toHaveBeenCalled();
      const attempt = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      await expect(setup.cancel(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({ state: "canceled" });
      completion.resolve({
        appId: "cli_canceled",
        appSecret: "secret",
        teamBrand: "feishu",
        requestedScopes: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(activateAtomicAttempt).not.toHaveBeenCalled();
      await expect(
        value.integrationService.getForAgent(value.bootstrap.userId, value.agent.id),
      ).resolves.toBeUndefined();
    } finally {
      await value.sql.end();
    }
  });

  it("fences the previous Feishu Channel owner when reauthorization moves an active lease", async () => {
    const value = await unboundFixture();
    const firstInstanceId = crypto.randomUUID();
    const secondInstanceId = crypto.randomUUID();
    const disconnects: string[] = [];
    const createAdapter = (input: { appId: string; appSecret: string; teamId: string | null }) =>
      ({
        provider: "feishu" as const,
        channel: {
          on: () => () => undefined,
          disconnect: async () => {
            disconnects.push(input.appId);
          },
        },
        validateBinding: async () => ({
          externalAppId: input.appId,
          externalTeamId: input.teamId ?? input.appId,
          externalBotId: "ou_bot",
        }),
        listGrantedTeamScopes: async () => [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
        normalizeInbound: () => [],
        send: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }) as unknown as FeishuAdapter;
    const first = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId: firstInstanceId,
      integrations: value.integrationService,
      createAdapter,
      maintenanceMs: 1_000_000,
    });
    const second = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId: secondInstanceId,
      integrations: value.integrationService,
      createAdapter,
      maintenanceMs: 1_000_000,
    });
    try {
      first.start();
      const firstAttemptId = await validatingFeishuAttempt(value.database, value.agent.id, firstInstanceId, "create");
      await first.activateAtomicAttempt({
        attemptId: firstAttemptId,
        ownerInstanceId: firstInstanceId,
        agentId: value.agent.id,
        appId: "cli_lease",
        appSecret: "secret",
        teamBrand: "feishu",
        requestedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      const [initial] = await value.database.select().from(integrations);
      expect(initial).toMatchObject({ connectionOwnerInstanceId: firstInstanceId, connectionFencingEpoch: 1 });
      if (!initial) throw new Error("Lease fixture was not created");
      second.start();
      const secondAttemptId = await validatingFeishuAttempt(
        value.database,
        value.agent.id,
        secondInstanceId,
        "reauthorize",
      );
      await second.activateAtomicAttempt({
        attemptId: secondAttemptId,
        ownerInstanceId: secondInstanceId,
        agentId: value.agent.id,
        appId: "cli_lease",
        appSecret: "secret-rotated",
        teamBrand: "feishu",
        requestedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      const [claimed] = await value.database.select().from(integrations);
      expect(claimed).toMatchObject({ connectionOwnerInstanceId: secondInstanceId, connectionFencingEpoch: 2 });
      await first.maintain();
      expect(disconnects).toContain("cli_lease");
    } finally {
      await first.stop();
      await second.stop();
      await value.sql.end();
    }
  });

  it("checks the Feishu lease holder and epoch inside the admission transaction", async () => {
    const value = await unboundFixture();
    try {
      const integrationId = await value.integrationService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_fence",
        appSecret: "secret",
        teamId: null,
        botOpenId: "ou_bot",
        teamBrand: "feishu",
        grantedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      const staleHolder = crypto.randomUUID();
      const currentHolder = crypto.randomUUID();
      await value.database
        .update(integrations)
        .set({
          connectionOwnerInstanceId: currentHolder,
          connectionFencingEpoch: 2,
          connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
          observedConnectedAt: new Date(),
          observedAt: new Date(),
        })
        .where(eq(integrations.id, integrationId));
      const fenceAcquired = deferred<void>();
      const releaseAdmission = deferred<void>();
      const inbox = new ImMessageInbox(value.database, {
        afterAdmissionFence: async () => {
          fenceAcquired.resolve();
          await releaseAdmission.promise;
        },
      });
      await expect(
        inbox.ingest(
          integrationId,
          1,
          { ...inbound("Ev-stale-fence"), externalAppId: "cli_fence" },
          {
            provider: "feishu",
            holderInstanceId: staleHolder,
            fencingEpoch: 1,
          },
        ),
      ).rejects.toThrow("FEISHU_CONNECTION_LEASE_STALE");

      const admission = inbox.ingest(
        integrationId,
        1,
        { ...inbound("Ev-current-fence"), externalAppId: "cli_fence" },
        {
          provider: "feishu",
          holderInstanceId: currentHolder,
          fencingEpoch: 2,
        },
      );
      await fenceAcquired.promise;
      const takeoverHolder = crypto.randomUUID();
      let takeoverSettled = false;
      const takeover = value.database
        .update(integrations)
        .set({
          connectionOwnerInstanceId: takeoverHolder,
          connectionFencingEpoch: 3,
          connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(eq(integrations.id, integrationId))
        .then(() => {
          takeoverSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(takeoverSettled).toBe(false);
      releaseAdmission.resolve();
      await expect(admission).resolves.toMatchObject({ duplicate: false });
      await takeover;
      await expect(
        new ImMessageInbox(value.database).ingest(
          integrationId,
          1,
          { ...inbound("Ev-after-takeover"), externalAppId: "cli_fence" },
          {
            provider: "feishu",
            holderInstanceId: currentHolder,
            fencingEpoch: 2,
          },
        ),
      ).rejects.toThrow("FEISHU_CONNECTION_LEASE_STALE");
    } finally {
      await value.sql.end();
    }
  });
});
