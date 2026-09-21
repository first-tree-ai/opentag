import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  RunnerClientFrameSchema,
  type RunnerServerFrame,
  RunnerServerFrameSchema,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  users,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { dispatchClaimToken } from "../../runtime/im-delivery-claim.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../../services/runtime-config/index.js";
import { CloudDeliveryOwner } from "../../services/sandboxes/cloud-delivery-owner.js";
import { createStaticCloudModelCatalog } from "../../services/sandboxes/cloud-model-catalog.js";
import { CloudModelGrantService } from "../../services/sandboxes/cloud-model-grants.js";
import { CloudRuntimeFence } from "../../services/sandboxes/cloud-runtime-fence.js";
import { RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { SandboxService } from "../../services/sandboxes/sandbox-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * Real PostgreSQL claim races and real loopback WebSockets into the production delivery owner.
 * Runner peers begin at an authenticated allocation and simulate bounded execution/report events.
 * Bootstrap authentication, native execution, model calls, and GCS are not replaced by a cloud claim.
 */
const cloudIdentities = { enabled: true, runnerVersion: "0.0.5", storageBase: "gs://unit-cloud/e6" };
const MODEL = "fixture-cloud-model";
let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);
beforeEach(async () => testDatabase.reset());
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const accountId = randomUUID();
  await client.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "E6" });
  const cloud = await new ComputerService(
    client.database,
    {
      getActiveUserById: async () => {
        throw new Error("unused projection");
      },
    },
    { cloudIdentities },
  ).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(client.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e6-${randomUUID().slice(0, 8)}`,
    displayName: "Concurrent Agent",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  await client.database
    .update(agentRuntimeConfigs)
    .set({ model: MODEL, instructions: "E6 fixture" })
    .where(eq(agentRuntimeConfigs.agentId, agent.id));
  const bindingId = randomUUID();
  await client.database.insert(imBindings).values({
    id: bindingId,
    agentId: agent.id,
    provider: "feishu",
    status: "active",
    externalAppId: `unit-${randomUUID()}`,
    externalBotId: "unit-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: new Date(),
  });
  const service = new SandboxService(client.database, new SessionService(client.database), { cloudIdentities });
  const scopes: RunnerScope[] = [];
  for (const channelId of ["session-a", "session-b"]) {
    const sandbox = await service.ensureForAccount(accountId, {
      imBindingId: bindingId,
      channelId,
      conversationKind: "channel",
      kind: "channel",
    });
    const resourceName = `projects/unit/locations/us-west1/instances/ots-${sandbox.sandboxId}-1`;
    await client.database
      .update(sandboxes)
      .set({
        lifecycle: "ready",
        environmentGeneration: 1,
        currentResourceName: resourceName,
        currentResourceUid: randomUUID(),
      })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    scopes.push({ sandboxId: sandbox.sandboxId, sessionId: sandbox.sessionId, environmentGeneration: 1, resourceName });
  }
  const [a, b] = scopes;
  if (!a || !b) throw new Error("missing Session fixture");
  let sequence = 0;
  const receivedBase = Date.now() - 60_000;
  const enqueue = async (scope: RunnerScope, nextAttemptAt = new Date(receivedBase + sequence * 10)) => {
    const id = randomUUID();
    const messageId = randomUUID();
    const receivedAt = new Date(receivedBase + sequence++ * 10);
    await client.database.insert(imMessages).values({
      id: messageId,
      imBindingId: bindingId,
      channelId: scope.sessionId === a.sessionId ? "session-a" : "session-b",
      externalMessageId: `ext-${messageId}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "unit-user",
      content: { version: 1, fallbackText: id, blocks: [], truncated: false },
      providerContext: { provider: "feishu" },
      occurredAt: receivedAt,
      receivedAt,
    });
    await client.database.insert(imMessageDeliveries).values({
      id,
      messageId,
      sessionId: scope.sessionId,
      attention: "direct",
      state: "pending",
      placementGeneration: 1,
      nextAttemptAt,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return id;
  };
  const hub = new RunnerHub();
  const fence = new CloudRuntimeFence();
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const grants = new CloudModelGrantService("unit-test-jwt-secret-at-least-32-characters", {
    catalog: createStaticCloudModelCatalog([MODEL]),
    maxStreamsPerToken: 2,
    ttlSeconds: 600,
  });
  cleanup.push(async () => grants.close());
  const owner = new CloudDeliveryOwner({
    database: client.database,
    custody,
    hub,
    fence,
    modelGrants: grants,
    modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
  });
  const worker = (options: { afterClaimRowLocked?: () => Promise<void> } = {}) => {
    const instance = new ImDeliveryWorker({
      database: client.database,
      assembler: new EffectiveRuntimeSnapshotAssembler(client.database),
      registry: new ConnectionRegistry(),
      domain: {} as never,
      cloudDelivery: owner,
      cloudAllocation: {
        ensureSandbox: async () => {
          throw new Error("unexpected allocation");
        },
        ensureEnvironmentAllocated: async () => "ready",
      },
      ...options,
    });
    cleanup.push(async () => instance.stop());
    return instance;
  };
  return { accountId, agent, cloud, a, b, enqueue, hub, fence, grants, owner, worker };
}

type Stack = Awaited<ReturnType<typeof fixture>>;
async function runner(stack: Stack, scope: RunnerScope) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const connected = once(wss, "connection");
  const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const [socket] = (await connected) as [WebSocket];
  await once(peer, "open");
  const frames: RunnerServerFrame[] = [];
  const waiters = new Set<() => void>();
  peer.on("message", (raw) => {
    frames.push(RunnerServerFrameSchema.parse(JSON.parse(String(raw))));
    for (const check of waiters) check();
  });
  const control = {
    send: (frame: RunnerServerFrame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
  };
  stack.hub.attach(scope, control);
  stack.hub.markReady(
    scope,
    {
      sandboxName: `ots-${scope.sandboxId}`,
      rootfs: "/opt/sandbox-root",
      nodeVersion: "v24.20.0",
      piVersion: "0.84.2",
      runnerVersion: "0.0.5",
      reportedAt: new Date().toISOString(),
    },
    control,
  );
  const connection = stack.owner.attachConnection({
    computerId: stack.cloud.computerId,
    installationId: randomUUID(),
    scope,
    socket: control,
  });
  let handling = Promise.resolve();
  const errors: unknown[] = [];
  socket.on("message", (raw) => {
    handling = handling
      .then(async () => {
        const frame = RunnerClientFrameSchema.parse(JSON.parse(String(raw)));
        if (frame.type === "delivery:received") await stack.owner.handleDeliveryReceived(connection, frame);
        else if (frame.type === "delivery:report") await stack.owner.handleDeliveryReport(connection, frame);
        else throw new Error(`unexpected Runner frame ${frame.type}`);
      })
      .catch((error) => {
        errors.push(error);
      });
  });
  cleanup.push(async () => {
    stack.owner.detachConnection(connection.connectionId);
    peer.terminate();
    socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await handling;
    expect(errors).toEqual([]);
  });
  const wait = <T extends RunnerServerFrame["type"]>(
    type: T,
    after = 0,
  ): Promise<Extract<RunnerServerFrame, { type: T }>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`missing ${type}`));
      }, 5_000);
      const check = () => {
        const frame = frames.slice(after).find((entry) => entry.type === type);
        if (!frame) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(frame as Extract<RunnerServerFrame, { type: T }>);
      };
      waiters.add(check);
      check();
    });
  const send = (frame: object) => peer.send(JSON.stringify(frame));
  const start = async () => {
    const run = await wait("delivery:run");
    const turnId = randomUUID();
    send({ type: "delivery:received", requestId: run.requestId, deliveryId: run.delivery.deliveryId, turnId });
    const verified = await wait("delivery:verified");
    expect(verified.status).toBe("verified");
    return { request: run.delivery, turnId, model: verified.model };
  };
  const finish = async (request: DirectImMessageDeliveryRequest, turnId: string) => {
    const report = completedReport(request, turnId);
    const after = frames.length;
    send({ type: "delivery:report", requestId: randomUUID(), report });
    expect((await wait("delivery:report:ack", after)).status).toBe("recorded");
    return report;
  };
  return { frames, send, wait, start, finish, connection };
}

function completedReport(request: DirectImMessageDeliveryRequest, turnId: string): TurnReportRequest {
  const base = {
    type: "turn:report" as const,
    requestId: randomUUID(),
    deliveryId: request.deliveryId,
    turnId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "done",
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
  };
  return { ...base, resultHash: computeTurnResultHash(base) };
}

async function row(id: string) {
  const [delivery] = await client.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, id));
  if (!delivery) throw new Error("missing delivery");
  return delivery;
}

describe("E6 Cloud Session concurrency on PostgreSQL and WebSockets", { timeout: 15_000 }, () => {
  it("lets B finish while A is executing, fences A2, and durably deduplicates B's report", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const b = await runner(stack, stack.b);
    const a1 = await stack.enqueue(stack.a);
    const a2 = await stack.enqueue(stack.a);
    const b1 = await stack.enqueue(stack.b);
    const worker = stack.worker();
    await worker.runOnce();
    const activeA = await a.start();
    expect(activeA.request.deliveryId).toBe(a1);
    await worker.runOnce();
    const activeB = await b.start();
    expect(activeB.request.deliveryId).toBe(b1);
    expect((await row(a2)).dispatchRequestId).toBeNull();
    const reportB = await b.finish(activeB.request, activeB.turnId);
    expect((await row(a1)).reportedAt).toBeNull();
    expect((await row(b1)).reportedAt).not.toBeNull();
    const after = b.frames.length;
    b.send({ type: "delivery:report", requestId: randomUUID(), report: reportB });
    expect((await b.wait("delivery:report:ack", after)).status).toBe("already_recorded");
    await a.finish(activeA.request, activeA.turnId);
    const aAfter = a.frames.length;
    await worker.runOnce();
    expect((await a.wait("delivery:run", aAfter)).delivery.deliveryId).toBe(a2);
  });

  it("keeps a claimed Session exclusive across Workers without blocking another Session", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const b = await runner(stack, stack.b);
    const a1 = await stack.enqueue(stack.a);
    const a2 = await stack.enqueue(stack.a);
    const b1 = await stack.enqueue(stack.b);
    const held = deferred();
    const release = deferred();
    const first = stack.worker({
      afterClaimRowLocked: async () => {
        held.resolve();
        await release.promise;
      },
    });
    const second = stack.worker();
    const pending = first.runOnce();
    try {
      await held.promise;
      await second.runOnce();
      expect((await b.wait("delivery:run")).delivery.deliveryId).toBe(b1);
      expect((await row(a2)).dispatchRequestId).toBeNull();
      expect((await row(a1)).dispatchRequestId).toBeNull();
    } finally {
      release.resolve();
      await pending;
    }
    expect((await a.wait("delivery:run")).delivery.deliveryId).toBe(a1);
  });

  it("does not overtake an earlier input in retry backoff", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const b = await runner(stack, stack.b);
    const a1 = await stack.enqueue(stack.a, new Date(Date.now() + 60_000));
    const a2 = await stack.enqueue(stack.a);
    const b1 = await stack.enqueue(stack.b);
    await stack.worker().runOnce();
    expect((await b.wait("delivery:run")).delivery.deliveryId).toBe(b1);
    expect(a.frames.filter((frame) => frame.type === "delivery:run")).toEqual([]);
    expect((await row(a1)).dispatchRequestId).toBeNull();
    expect((await row(a2)).dispatchRequestId).toBeNull();
  });

  it("admits each Session once when several Workers race for the same pending inputs", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const b = await runner(stack, stack.b);
    const a1 = await stack.enqueue(stack.a);
    const a2 = await stack.enqueue(stack.a);
    const b1 = await stack.enqueue(stack.b);
    await Promise.all(Array.from({ length: 4 }, () => stack.worker().runOnce()));
    const [activeA, activeB] = await Promise.all([a.start(), b.start()]);
    expect(activeA.request.deliveryId).toBe(a1);
    expect(activeB.request.deliveryId).toBe(b1);
    expect((await row(a2)).dispatchRequestId).toBeNull();
    expect(a.frames.filter((frame) => frame.type === "delivery:run")).toHaveLength(1);
    expect(b.frames.filter((frame) => frame.type === "delivery:run")).toHaveLength(1);
    expect(stack.grants.trackedGrantCount).toBe(2);
  });

  it("does not let SKIP LOCKED skip the head of one Session while other Sessions progress", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const b = await runner(stack, stack.b);
    const a1 = await stack.enqueue(stack.a);
    const a2 = await stack.enqueue(stack.a);
    const b1 = await stack.enqueue(stack.b);
    const held = deferred();
    const release = deferred();
    const transaction = client.sql.begin(async (sql) => {
      await sql`select id from im_message_deliveries where id = ${a1} for update`;
      held.resolve();
      await release.promise;
    });
    try {
      await held.promise;
      await stack.worker().runOnce();
      expect((await b.wait("delivery:run")).delivery.deliveryId).toBe(b1);
      expect((await row(a2)).dispatchRequestId).toBeNull();
      expect(a.frames.filter((frame) => frame.type === "delivery:run")).toEqual([]);
    } finally {
      release.resolve();
      await transaction;
    }
  });

  it("recovers an expired claim when an earlier provider event arrives after that claim", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const older = await stack.enqueue(stack.a);
    const claimed = await stack.enqueue(stack.a);
    // The newer event was claimed before the older event became visible. A Worker then died
    // before dispatch: only the expired durable claim remains to be recovered.
    await client.database
      .update(imMessageDeliveries)
      .set({
        lastErrorCode: dispatchClaimToken(),
        nextAttemptAt: new Date(Date.now() - 1_000),
      })
      .where(eq(imMessageDeliveries.id, claimed));
    await stack.worker().runOnce();
    const active = await a.start();
    expect(active.request.deliveryId).toBe(claimed);
    expect((await row(older)).dispatchRequestId).toBeNull();
    await a.finish(active.request, active.turnId);
    const after = a.frames.length;
    await stack.worker().runOnce();
    expect((await a.wait("delivery:run", after)).delivery.deliveryId).toBe(older);
  });

  it("cancels and disconnects A without revoking B's model authority or completion", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const b = await runner(stack, stack.b);
    await stack.enqueue(stack.a);
    await stack.enqueue(stack.b);
    await stack.worker().runOnce();
    const activeA = await a.start();
    await stack.worker().runOnce();
    const activeB = await b.start();
    if (!activeA.model || !activeB.model) throw new Error("missing model grant");
    expect(await stack.grants.verify(activeB.model.token)).toBeDefined();
    const cancelled = await stack.owner.cancelSessionDeliveries(stack.a.sessionId);
    expect(cancelled).toHaveLength(1);
    expect((await a.wait("delivery:cancel")).deliveryId).toBe(activeA.request.deliveryId);
    stack.owner.detachConnection(a.connection.connectionId);
    expect(await stack.grants.verify(activeA.model.token)).toBeUndefined();
    expect(await stack.grants.verify(activeB.model.token)).toBeDefined();
    expect(b.frames.some((frame) => frame.type === "delivery:cancel")).toBe(false);
    await b.finish(activeB.request, activeB.turnId);
  });

  it("rejects another Session's receipt and result while both Sessions execute", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const b = await runner(stack, stack.b);
    const aId = await stack.enqueue(stack.a);
    const bId = await stack.enqueue(stack.b);
    const worker = stack.worker();
    await worker.runOnce();
    const activeA = await a.start();
    await worker.runOnce();
    const activeB = await b.start();
    if (!activeA.model || !activeB.model) throw new Error("missing model grants");

    const beforeReceipt = b.frames.length;
    b.send({
      type: "delivery:received",
      requestId: activeA.request.requestId,
      deliveryId: aId,
      turnId: activeA.turnId,
    });
    expect((await b.wait("delivery:verified", beforeReceipt)).status).toBe("rejected");
    const beforeReport = b.frames.length;
    b.send({
      type: "delivery:report",
      requestId: randomUUID(),
      report: completedReport(activeA.request, activeA.turnId),
    });
    expect((await b.wait("delivery:report:ack", beforeReport)).status).toBe("conflict");
    expect((await row(aId)).reportedAt).toBeNull();
    expect((await row(bId)).reportedAt).toBeNull();
    expect(await stack.grants.verify(activeA.model.token)).toBeDefined();
    expect(await stack.grants.verify(activeB.model.token)).toBeDefined();
    await a.finish(activeA.request, activeA.turnId);
    await b.finish(activeB.request, activeB.turnId);
  });

  it("retains Agent-wide pause authority across all of its Cloud Sessions", async () => {
    const stack = await fixture();
    const a = await runner(stack, stack.a);
    const b = await runner(stack, stack.b);
    await stack.enqueue(stack.a);
    await stack.enqueue(stack.b);
    await client.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, stack.agent.id));
    await Promise.all([stack.worker().runOnce(), stack.worker().runOnce()]);
    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
    expect(stack.grants.trackedGrantCount).toBe(0);
  });
});
