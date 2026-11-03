import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  DirectImMessageDeliveryRequest,
  RunnerServerFrame,
  ServerRuntimeBusinessFrame,
  SessionReconcileRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../../services/runtime-config/index.js";
import { CloudDeliveryOwner } from "../../services/sandboxes/cloud-delivery-owner.js";
import { createStaticCloudModelCatalog } from "../../services/sandboxes/cloud-model-catalog.js";
import { CloudModelGrantService } from "../../services/sandboxes/cloud-model-grants.js";
import { CloudRuntimeFence } from "../../services/sandboxes/cloud-runtime-fence.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { SandboxService } from "../../services/sandboxes/sandbox-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const RUNNER_VERSION = "0.0.5";
const cloudIdentities = { enabled: true as const, runnerVersion: RUNNER_VERSION, storageBase: "gs://unit-cloud/x" };
const MODEL = "fixture-cloud-model";
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};
const READINESS = {
  sandboxName: "ots-s-unit-1",
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: RUNNER_VERSION,
  reportedAt: new Date().toISOString(),
};
let fixture: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let observer: ReturnType<typeof createDatabaseClient>;
let cleanups: Array<() => unknown> = [];
let tasks: Promise<unknown>[] = [];
beforeAll(async () => {
  fixture = await startMigratedTestDatabase();
  client = createDatabaseClient(fixture.databaseUrl, { max: 6, statementTimeoutMs: 6_000, queryTimeoutMs: 8_000 });
  observer = createDatabaseClient(fixture.databaseUrl, { max: 4 });
}, 120_000);
beforeEach(async () => {
  await fixture.reset();
  cleanups = [];
  tasks = [];
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await Promise.allSettled(tasks);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await client?.sql.end({ timeout: 1 });
  await observer?.sql.end({ timeout: 1 });
  await fixture?.stop();
});
function track<T>(promise: Promise<T>): Promise<T> {
  tasks.push(promise);
  void promise.catch(() => undefined);
  return promise;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(release);
  return { promise, release };
}
async function row(id: string) {
  return (await client.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, id)))[0];
}
async function healthy() {
  const [result] = await client.sql.unsafe("select 1 as healthy", [], { no_pipeline: true });
  expect(result?.healthy).toBe(1);
}
async function holdPlacement(sessionId: string) {
  const ready = gate(),
    released = gate();
  const holding = track(
    observer.sql.begin(async (tx) => {
      await tx`select session_id from session_placements where session_id = ${sessionId} for update`;
      ready.release();
      await released.promise;
    }),
  );
  await ready.promise;
  return async () => {
    released.release();
    await holding;
  };
}
async function waitForLock() {
  await expect
    .poll(
      async () =>
        (
          await observer.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
        )[0]?.count,
      { timeout: 2_000 },
    )
    .toBeGreaterThan(0);
}
async function local(
  options: {
    preparation?: () => Promise<void>;
    beforeAdmission?: (signal: AbortSignal) => Promise<void>;
    database?: DatabaseClient;
    timeout?: number;
    steer?: boolean;
    beforeReconcileReply?: (frame: ServerRuntimeBusinessFrame) => Promise<void>;
  } = {},
) {
  const h = await workerFixture({ database: client.database });
  const database = options.database ?? client.database;
  const custody = new PostgresRuntimeCustodyStore(database);
  const frames: ServerRuntimeBusinessFrame[] = [];
  const registry = new ConnectionRegistry();
  const context = {
    computerId: h.computerId,
    instanceId: h.instanceId,
    installationId: randomUUID(),
    signal: new AbortController().signal,
  };
  let domain!: RuntimeDomainOwner;
  const socket = {
    readyState: 1,
    close: vi.fn(),
    terminate: vi.fn(),
    send(serialized: string, callback: (error?: Error) => void) {
      const frame = JSON.parse(serialized);
      frames.push(frame);
      callback();
      const answer =
        frame.type === "session:reconcile"
          ? {
              type: "session:reconcile:result",
              requestId: frame.requestId,
              sessionId: frame.sessionId,
              placementGeneration: frame.placementGeneration,
              status: frame.desired === "stopped" ? "stopped" : "ready",
            }
          : frame.type === "im:deliver"
            ? {
                type: "im:deliver:result",
                requestId: frame.requestId,
                deliveryId: frame.deliveryId,
                sessionId: frame.sessionId,
                placementGeneration: frame.placementGeneration,
                status: "accepted",
                turnId: `turn-${frame.deliveryId}`,
              }
            : frame.type === "im:steer"
              ? {
                  type: "im:steer:result",
                  requestId: frame.requestId,
                  deliveryId: frame.deliveryId,
                  sessionId: frame.sessionId,
                  placementGeneration: frame.placementGeneration,
                  rootDeliveryId: frame.rootDeliveryId,
                  expectedTurnId: frame.expectedTurnId,
                  status: "steered",
                }
              : undefined;
      if (answer)
        track(
          Promise.resolve().then(async () => {
            if (frame.type === "session:reconcile") await options.beforeReconcileReply?.(frame);
            return domain.handle(answer as never, context);
          }),
        );
    },
  };
  await registry.register(
    {
      computerId: h.computerId,
      instanceId: h.instanceId,
      installationId: context.installationId,
      clientVersion: "0.1.1",
      lastHeartbeatAt: Date.now(),
      socket: socket as never,
      ...(options.steer
        ? { negotiatedCapabilities: { "runtime.imSteer": 2, "runtime.imDelivery": 2, "runtime.sessionReconcile": 1 } }
        : {}),
    },
    async () => undefined,
  );
  domain = new RuntimeDomainOwner(registry, custody, {
    requestTimeoutMs: 4_000,
    ...(options.preparation
      ? {
          prepareReconcile: async (_computer: string, _instance: string, request: SessionReconcileRequest) => {
            await options.preparation?.();
            return { request };
          },
        }
      : {}),
  });
  const diagnostic = vi.fn();
  const worker = new ImDeliveryWorker({
    database,
    domain,
    registry,
    assembler: { assembleForSession: async () => h.runtime },
    operationTimeoutMs: options.timeout ?? 400,
    onDiagnostic: diagnostic,
    ...(options.beforeAdmission ? { beforeDeliveryAdmission: options.beforeAdmission } : {}),
  });
  cleanups.push(
    () => domain.close(),
    () => worker.stop(),
  );
  return { ...h, worker, domain, custody, frames, diagnostic, context };
}
async function cloud(
  options: {
    beforeAdmission?: (signal: AbortSignal) => Promise<void>;
    allocation?: import("../../runtime/im-delivery-worker.types.js").CloudSessionAllocationPort;
    noteActivity?: () => Promise<void>;
  } = {},
) {
  const h = await cloudScope();
  const stack = makeOwner();
  const sent: RunnerServerFrame[] = [];
  const socket = fakeSocket(sent);
  stack.hub.attach(h.scope, socket);
  stack.hub.markReady(h.scope, READINESS, socket);
  const connection = stack.fence.attach({
    computerId: h.cloud.computerId,
    installationId: randomUUID(),
    scope: h.scope,
    socket,
    imInputVersion: 1,
  });
  const input = await agedPendingDelivery(h.scope.sessionId);
  await client.database
    .update(imMessageDeliveries)
    .set({ expiresAt: new Date(Date.now() + 60_000) })
    .where(eq(imMessageDeliveries.id, input.deliveryId));
  const diagnostic = vi.fn();
  const worker = new ImDeliveryWorker({
    database: client.database,
    assembler: new EffectiveRuntimeSnapshotAssembler(client.database),
    domain: {} as never,
    registry: new ConnectionRegistry(),
    cloudDelivery: stack.owner,
    cloudAllocation: options.allocation ?? {
      ensureSandbox: async () => {
        throw new Error("unused ensure");
      },
      ensureEnvironmentAllocated: async () => "ready",
    },
    operationTimeoutMs: 400,
    onDiagnostic: diagnostic,
    ...(options.beforeAdmission ? { beforeDeliveryAdmission: options.beforeAdmission } : {}),
  });
  cleanups.push(() => worker.stop());
  return { ...h, ...stack, ...input, sent, socket, connection, worker, diagnostic };
}

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

function fakeSocket(sent: RunnerServerFrame[]): RunnerControlSocket {
  return {
    send(frame) {
      sent.push(frame);
    },
    close() {
      // no-op
    },
  };
}

async function cloudScope() {
  const accountId = randomUUID();
  await client.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "E4" });
  const cloud = await new ComputerService(client.database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(client.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e4-pi-${randomUUID().slice(0, 8)}`,
    displayName: "E4 Pi",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  await client.database
    .update(agentRuntimeConfigs)
    .set({ instructions: "Agent instructions.", model: MODEL })
    .where(eq(agentRuntimeConfigs.agentId, agent.id));
  const bindingId = randomUUID();
  await client.database.insert(imBindings).values({
    id: bindingId,
    agentId: agent.id,
    provider: "feishu",
    status: "active",
    externalAppId: `unit-app-${randomUUID().slice(0, 8)}`,
    externalBotId: "unit-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: new Date(),
  });
  const sandbox = await new SandboxService(client.database, new SessionService(client.database), {
    cloudIdentities,
  }).ensureForAccount(accountId, {
    imBindingId: bindingId,
    channelId: "unit-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  const resourceName = `projects/unit/locations/us-west1/instances/ots-s-${sandbox.sandboxId.slice(0, 8)}-1`;
  await client.database
    .update(sandboxes)
    .set({
      lifecycle: "ready",
      environmentGeneration: 1,
      currentResourceName: resourceName,
      currentResourceUid: `unit-uid-${sandbox.sandboxId.slice(0, 8)}`,
    })
    .where(eq(sandboxes.id, sandbox.sandboxId));
  const scope: RunnerScope = {
    sandboxId: sandbox.sandboxId,
    sessionId: sandbox.sessionId,
    environmentGeneration: 1,
    resourceName,
  };
  return { accountId, agent, bindingId, sandbox, scope, cloud };
}

async function agedPendingDelivery(sessionId: string) {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const [binding] = await client.database.select().from(imBindings).limit(1);
  if (!binding) throw new Error("fixture binding missing");
  await client.database.insert(imMessages).values({
    id: messageId,
    imBindingId: binding.id,
    channelId: "unit-channel",
    externalMessageId: `ext-${messageId.slice(0, 8)}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "unit-user",
    content: { version: 1, fallbackText: "hello cloud", blocks: [], truncated: false },
    providerContext: { provider: "feishu" },
    occurredAt: new Date(),
  });
  await client.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    state: "pending",
    placementGeneration: 1,
    expiresAt: new Date(Date.now() - 6 * 60 * 60 * 1_000),
  });
  return { deliveryId, messageId };
}

function makeOwner() {
  const hub = new RunnerHub();
  const fence = new CloudRuntimeFence();
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const grants = new CloudModelGrantService("unit-test-jwt-secret-at-least-32-characters", {
    catalog: createStaticCloudModelCatalog([MODEL]),
    maxStreamsPerToken: 2,
    ttlSeconds: 600,
  });
  const owner = new CloudDeliveryOwner({
    custody,
    database: client.database,
    fence,
    hub,
    modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
    modelGrants: grants,
  });
  return { hub, fence, custody, grants, owner };
}

async function addLocalRoot(h: Awaited<ReturnType<typeof local>>) {
  const rootMessageId = randomUUID(),
    rootId = randomUUID();
  const [message] = await client.database.select().from(imMessages).where(eq(imMessages.id, h.messageId));
  assert(message);
  await client.database.insert(imMessages).values({ ...message, id: rootMessageId, externalMessageId: rootMessageId });
  await client.database.insert(imMessageDeliveries).values({
    id: rootId,
    messageId: rootMessageId,
    sessionId: h.sessionId,
    attention: "direct",
    state: "accepted",
    placementGeneration: 1,
    inputHash: "root-hash",
    turnId: "root-turn",
    reportOwnerInstanceId: h.instanceId,
    acceptedAt: new Date(),
    nextAttemptAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 60_000),
  });
  return rootId;
}

it("normal Local handoff releases SQL before sends", async () => {
  const h = await local({ timeout: 3000 });
  await h.worker.runOnce();
  expect(h.frames.map((frame) => frame.type)).toEqual(["session:reconcile", "im:deliver"]);
  expect(await row(h.deliveryId)).toMatchObject({ state: "accepted" });
  await healthy();
});

it.each(["timeout", "suspended"] as const)("rechecks %s after Local reconcile preparation", async (cause) => {
  const entered = gate(),
    release = gate();
  const h = await local({
    timeout: cause === "timeout" ? 400 : 4000,
    preparation: async () => {
      entered.release();
      await release.promise;
    },
  });
  const original = h.domain.requestReconcile.bind(h.domain);
  vi.spyOn(h.domain, "requestReconcile").mockImplementation((...args) => track(original(...args)));
  const running = track(h.worker.runOnce());
  await entered.promise;
  if (cause === "timeout") await running;
  else await client.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, h.agentId));
  release.release();
  await Promise.allSettled(tasks);
  expect(h.frames).toHaveLength(0);
  if (cause === "suspended") expect((await row(h.deliveryId))?.lastErrorCode).toBe("IM_DELIVERY_AGENT_NOT_ACTIVE");
  await healthy();
});

it("retains committed Local dispatch correlation but sends nothing after a custody lock outlives the deadline", async () => {
  let unlock: (() => Promise<void>) | undefined;
  const entered = gate();
  const h = await local({
    beforeAdmission: async () => {
      unlock = await holdPlacement(h.sessionId);
      entered.release();
    },
  });
  const original = h.domain.requestDelivery.bind(h.domain);
  vi.spyOn(h.domain, "requestDelivery").mockImplementation((...args) => track(original(...args)));
  const running = track(h.worker.runOnce());
  await entered.promise;
  await waitForLock();
  await running;
  expect(h.diagnostic.mock.calls.flat()).toContain("IM_DELIVERY_OPERATION_ABANDONED");
  await unlock?.();
  await Promise.allSettled(tasks);
  expect(h.frames.filter((frame) => frame.type === "im:deliver")).toHaveLength(0);
  expect(await row(h.deliveryId)).toMatchObject({ state: "pending", reportedAt: null });
  expect((await row(h.deliveryId))?.dispatchRequestId).not.toBeNull();
  await healthy();
});

it("does not send Cloud input when shared model preparation outlives the deadline", async () => {
  const h = await cloud(),
    entered = gate(),
    release = gate();
  const original = h.grants.isModelAllowed.bind(h.grants);
  let calls = 0;
  vi.spyOn(h.grants, "isModelAllowed").mockImplementation(async (model) => {
    if (++calls === 2) {
      entered.release();
      await release.promise;
    }
    return original(model);
  });
  const dispatch = h.owner.dispatchDelivery.bind(h.owner);
  vi.spyOn(h.owner, "dispatchDelivery").mockImplementation((...args) => track(dispatch(...args)));
  const running = track(h.worker.runOnce());
  await entered.promise;
  await running;
  release.release();
  await Promise.allSettled(tasks);
  expect(h.sent.filter((frame) => frame.type === "delivery:run")).toHaveLength(0);
  expect((await row(h.deliveryId))?.dispatchRequestId).toBeNull();
  await healthy();
});

it("does not start an allocation after the Sandbox lookup exhausts the deadline", async () => {
  const allocated = vi.fn(async () => "ready" as const),
    entered = gate(),
    release = gate();
  const h = await cloud({
    allocation: {
      ensureSandbox: async () => {
        throw new Error("unused ensure");
      },
      ensureEnvironmentAllocated: allocated,
    },
  });
  const original = h.grants.isModelAllowed.bind(h.grants);
  let holder: Promise<unknown> | undefined;
  vi.spyOn(h.grants, "isModelAllowed").mockImplementationOnce(async (model) => {
    const allowed = await original(model);
    holder = track(
      observer.sql.begin(async (tx) => {
        await tx`lock table sandboxes in access exclusive mode`;
        entered.release();
        await release.promise;
      }),
    );
    await entered.promise;
    return allowed;
  });
  const running = track(h.worker.runOnce());
  await entered.promise;
  await waitForLock();
  await expect.poll(() => h.diagnostic.mock.calls.flat()).toContain("IM_DELIVERY_OPERATION_TIMEOUT");
  release.release();
  await holder;
  await running;
  expect(allocated).not.toHaveBeenCalled();
  expect(h.sent.filter((frame) => frame.type === "delivery:run")).toHaveLength(0);
  await healthy();
});

it("keeps already sent accepted Local custody after timeout", async () => {
  const h = await local(),
    accepted = gate(),
    release = gate();
  const original = h.custody.acceptDelivery.bind(h.custody);
  vi.spyOn(h.custody, "acceptDelivery").mockImplementation(async (...args) => {
    const result = await original(...args);
    accepted.release();
    await release.promise;
    return result;
  });
  const running = track(h.worker.runOnce());
  await accepted.promise;
  await running;
  expect(h.diagnostic.mock.calls.flat()).toContain("IM_DELIVERY_OPERATION_ABANDONED");
  release.release();
  await Promise.allSettled(tasks);
  expect(await row(h.deliveryId)).toMatchObject({ state: "accepted", lastErrorCode: null });
  expect(h.frames.filter((frame) => frame.type === "im:deliver")).toHaveLength(1);
});

it("retains Local steer correlation without sending after delayed custody", async () => {
  const h = await local({ steer: true });
  await addLocalRoot(h);
  const entered = gate();
  let unlock: (() => Promise<void>) | undefined;
  const original = h.custody.beginSteerDispatch.bind(h.custody);
  vi.spyOn(h.custody, "beginSteerDispatch").mockImplementation(async (...args) => {
    unlock = await holdPlacement(h.sessionId);
    entered.release();
    return original(...args);
  });
  const dispatch = h.domain.requestSteer.bind(h.domain);
  vi.spyOn(h.domain, "requestSteer").mockImplementation((...args) => track(dispatch(...args)));
  const running = track(h.worker.runOnce());
  await entered.promise;
  await waitForLock();
  await running;
  await unlock?.();
  await Promise.allSettled(tasks);
  expect(h.frames.map((frame) => frame.type)).not.toContain("im:steer");
  expect((await row(h.deliveryId))?.dispatchRequestId).not.toBeNull();
  expect((await row(h.deliveryId))?.state).toBe("pending");
});

it("retains Cloud steer correlation without sending after delayed custody", async () => {
  const h = await cloud();
  await h.worker.runOnce();
  const run = h.sent.find((frame) => frame.type === "delivery:run");
  if (!run || run.type !== "delivery:run") throw new Error("missing delivery run");
  await h.owner.handleDeliveryReceived(h.connection, {
    deliveryId: h.deliveryId,
    requestId: run.requestId,
    turnId: "root-cloud-turn",
  });
  expect(await row(h.deliveryId)).toMatchObject({ state: "accepted", turnId: "root-cloud-turn" });
  await client.database
    .update(imMessageDeliveries)
    .set({ nextAttemptAt: new Date(Date.now() + 60000) })
    .where(eq(imMessageDeliveries.id, h.deliveryId));
  const next = await agedPendingDelivery(h.scope.sessionId);
  await client.database
    .update(imMessageDeliveries)
    .set({ expiresAt: new Date(Date.now() + 60000) })
    .where(eq(imMessageDeliveries.id, next.deliveryId));
  const entered = gate();
  let custodyEntered = false;
  let unlock: (() => Promise<void>) | undefined;
  const original = h.custody.beginSteerDispatch.bind(h.custody);
  vi.spyOn(h.custody, "beginSteerDispatch").mockImplementation(async (...args) => {
    unlock = await holdPlacement(h.scope.sessionId);
    custodyEntered = true;
    entered.release();
    return original(...args);
  });
  const dispatch = h.owner.requestSteer.bind(h.owner);
  vi.spyOn(h.owner, "requestSteer").mockImplementation((...args) => track(dispatch(...args)));
  const running = track(h.worker.runOnce());
  await Promise.race([
    entered.promise,
    running.then(async () => {
      if (custodyEntered) return;
      const pending = await row(next.deliveryId);
      const root = await row(h.deliveryId);
      throw new Error(
        `Cloud steer ended before custody: ${JSON.stringify({
          diagnostic: h.diagnostic.mock.calls,
          pending: { state: pending?.state, errorCode: pending?.lastErrorCode },
          root: { state: root?.state, turnId: root?.turnId },
        })}`,
      );
    }),
  ]);
  await waitForLock();
  await running;
  await unlock?.();
  await Promise.allSettled(tasks);
  expect(h.sent.filter((frame) => frame.type === "delivery:steer")).toHaveLength(0);
  expect((await row(next.deliveryId))?.dispatchRequestId).not.toBeNull();
  expect((await row(next.deliveryId))?.state).toBe("pending");
});
