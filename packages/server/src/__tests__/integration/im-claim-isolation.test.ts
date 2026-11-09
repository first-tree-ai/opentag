import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  type DirectImMessageDeliveryRequest,
  type SessionReconcileRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let fixture: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let observer: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  fixture = await startMigratedTestDatabase();
  client = createDatabaseClient(fixture.databaseUrl, { max: 4, statementTimeoutMs: 1_500, queryTimeoutMs: 3_000 });
  observer = createDatabaseClient(fixture.databaseUrl, { max: 4 });
}, 120_000);
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  await client?.sql.end({ timeout: 1 });
  await observer?.sql.end({ timeout: 1 });
  await fixture?.stop();
});

async function hold(kind: "agent" | "row", id: string) {
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
  const operation = observer.sql.begin(async (tx) => {
    if (kind === "agent") await tx`select pg_advisory_xact_lock(hashtextextended(${`im-agent-custody:${id}`}, 0))`;
    else await tx`select id from im_message_deliveries where id = ${id} for update`;
    ready();
    await released;
  });
  void operation.catch(failed);
  await locked;
  return async () => {
    release();
    await operation;
  };
}

async function seedPair() {
  const a = await workerFixture({ database: client.database });
  const b = await workerFixture({ database: client.database });
  await a.registry.register(
    {
      clientVersion: "0.1.1",
      computerId: b.computerId,
      installationId: randomUUID(),
      instanceId: b.instanceId,
      lastHeartbeatAt: Date.now(),
      socket: { close: vi.fn(), terminate: vi.fn() } as never,
    },
    async () => undefined,
  );
  await client.database
    .update(imMessageDeliveries)
    .set({ nextAttemptAt: new Date(Date.now() - 2_000) })
    .where(eq(imMessageDeliveries.id, a.deliveryId));
  await client.database
    .update(imMessageDeliveries)
    .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
    .where(eq(imMessageDeliveries.id, b.deliveryId));
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const domain = {
    requestReconcile: vi.fn(
      async (_computer: string, _instance: string, request: SessionReconcileRequest, mark?: () => void) => {
        mark?.();
        return {
          type: "session:reconcile:result",
          requestId: request.requestId,
          sessionId: request.sessionId,
          placementGeneration: 1,
          status: "ready",
        };
      },
    ),
    requestDelivery: vi.fn(
      async (computerId: string, instanceId: string, request: DirectImMessageDeliveryRequest, mark?: () => void) => {
        const hash = computeDirectInputHash(request);
        expect(await custody.beginDeliveryDispatch(request, hash, { computerId, instanceId })).toBe("dispatched");
        mark?.();
        expect(
          await custody.acceptDelivery(request, hash, `turn-${request.deliveryId}`, {
            computerId,
            instanceId,
            installationId: randomUUID(),
            signal: new AbortController().signal,
          }),
        ).toBe("accepted");
        return {
          type: "im:deliver:result",
          requestId: request.requestId,
          deliveryId: request.deliveryId,
          sessionId: request.sessionId,
          placementGeneration: 1,
          status: "accepted",
          turnId: `turn-${request.deliveryId}`,
        };
      },
    ),
  };
  const diagnostic = vi.fn();
  const worker = new ImDeliveryWorker({
    database: client.database,
    registry: a.registry,
    domain: domain as never,
    assembler: {
      assembleForSession: vi.fn(async (sessionId: string) => (sessionId === a.sessionId ? a.runtime : b.runtime)),
    },
    operationTimeoutMs: 500,
    onDiagnostic: diagnostic,
  });
  return { a, b, domain, diagnostic, worker };
}

async function delivery(id: string) {
  const [row] = await client.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, id));
  return row;
}

it("skips a busy Agent fence and claims an unrelated Agent in the same pass", async () => {
  const h = await seedPair(),
    unlock = await hold("agent", h.a.agentId);
  try {
    try {
      await h.worker.runOnce();
      expect(await delivery(h.b.deliveryId)).toMatchObject({ state: "accepted", attemptCount: 1 });
      expect(await delivery(h.a.deliveryId)).toMatchObject({ state: "pending", attemptCount: 0 });
      expect(h.domain.requestDelivery).toHaveBeenCalledOnce();
      const [waiters] =
        await observer.sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event='advisory'`;
      expect(waiters?.count).toBe(0);
      expect(await client.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
    } finally {
      await unlock();
    }
    await h.worker.runOnce();
    expect(await delivery(h.a.deliveryId)).toMatchObject({ state: "accepted", attemptCount: 1 });
    expect(h.domain.requestDelivery).toHaveBeenCalledTimes(2);
  } finally {
    await h.worker.stop();
  }
});

it("a delivery row lock is already skipped, allowing the unrelated Agent in the same pass", async () => {
  const h = await seedPair();
  const unlock = await hold("row", h.a.deliveryId);
  try {
    await h.worker.runOnce();
    expect(await delivery(h.b.deliveryId)).toMatchObject({ state: "accepted", attemptCount: 1 });
    expect(await delivery(h.a.deliveryId)).toMatchObject({ state: "pending", attemptCount: 0 });
    expect(h.domain.requestDelivery).toHaveBeenCalledOnce();
  } finally {
    await unlock();
    await h.worker.stop();
  }
});

// Real custody SQL with controlled Runtime results; transport admission is covered separately.
async function workerFixture(unit: { database: DatabaseClient }) {
  const now = new Date(Date.now() + 60 * 60_000);
  const userId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const instanceId = randomUUID();
  await unit.database.insert(users).values({ id: userId, email: `${userId}@example.com`, displayName: "User" });
  await unit.database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    currentInstallationId: randomUUID(),
    displayName: "Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
    currentInstanceId: instanceId,
  });
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `agent-${agentId}`,
    displayName: "Agent",
    runtimeProvider: "codex",
  });
  const slackInstallationId = randomUUID();
  const externalAppId = `app-${bindingId}`;
  const externalTeamId = `team-${bindingId}`;
  const externalBotId = `bot-${bindingId}`;
  await unit.database.insert(slackInstallations).values({
    id: slackInstallationId,
    agentId,
    status: "active",
    externalAppId,
    externalTeamId,
    externalBotId,
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "encrypted",
    activatedAt: now,
  });
  await unit.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "slack",
    status: "active",
    externalAppId,
    externalTeamId,
    externalBotId,
    credentialSchemaVersion: 1,
    slackInstallationId,
    slackRouteKind: "default",
    credentialGeneration: 1,
    activatedAt: now,
  });
  await unit.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "channel",
    conversationKind: "channel",
    kind: "channel",
  });
  await unit.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  const content = {
    fallbackText: "hello",
    resources: [{ kind: "file" as const, filename: "note.txt", mediaType: "text/plain", sizeBytes: 5 }],
  };
  await unit.database.insert(imMessages).values({
    id: messageId,
    imBindingId: bindingId,
    channelId: "channel",
    externalMessageId: `message-${messageId}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "U_FIXTURE",
    content,
    providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "1" },
    occurredAt: now,
  } as never);
  await unit.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    placementGeneration: 1,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const runtime = {
    contextTrees: [],
    revision: { agent: { sequence: 1, id: agentId }, session: { sequence: 1, id: sessionId } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "", agent: "", session: "" },
    execution: { approvalPolicy: "never" as const, networkAccess: false },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
  const registry = new ConnectionRegistry();
  await registry.register(
    {
      clientVersion: "0.1.1",
      computerId,
      installationId: randomUUID(),
      instanceId,
      lastHeartbeatAt: Date.now(),
      socket: { close: vi.fn(), terminate: vi.fn() } as never,
    },
    async () => undefined,
  );
  const request: DirectImMessageDeliveryRequest = {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: messageId,
    sessionId,
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app",
        teamId: "team",
        botUserId: "bot",
        channelId: "channel",
        messageTs: "1",
      },
    },
    runtime,
  };
  return {
    agentId,
    bindingId,
    computerId,
    deliveryId,
    instanceId,
    messageId,
    registry,
    request,
    runtime,
    sessionId,
    slackInstallationId,
    userId,
  };
}
