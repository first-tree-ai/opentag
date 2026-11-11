/**
 * E7 transfer races on real PostgreSQL: two same-account claimants compete for one idle physical
 * Instance, and an explicit stop competes with an on-demand borrow. Exactly one row may own the
 * physical name/UID, and the losing path must cold-allocate — never duplicate, never strand.
 */
import { randomUUID } from "node:crypto";
import type { DirectImMessageDeliveryRequest } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  imBindings,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { SandboxService } from "../../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../../services/sandboxes/runner-bootstrap-token.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import {
  SandboxRunnerService,
  WORKSPACE_RECOVERY_RETRY_DELAY_MS,
} from "../../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { FakeCloudRunAdmin } from "../support/fake-cloud-run-admin.js";
import { FakeWorkspaceObjectStore } from "../support/fake-workspace-store.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const RUNNER_VERSION = "0.0.5";
const UPGRADED_VERSION = "0.0.6";
/** A deployment target image distinct from the fake's default, pinned only at Instance creation. */
const UPGRADED_IMAGE = `unit/image@sha256:${"2".repeat(64)}`;
const JWT_SECRET = "integration-test-jwt-secret-at-least-32-characters";
const cloudIdentities = {
  enabled: true,
  runnerVersion: RUNNER_VERSION,
  storageBase: "gs://integration-cloud/sandboxes",
};
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

let testDatabase: MigratedTestDatabase;
let sql: ReturnType<typeof createDatabaseClient>["sql"];
let database: DatabaseClient;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  const client = createDatabaseClient(testDatabase.databaseUrl);
  sql = client.sql;
  database = client.database;
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await testDatabase?.stop();
});

beforeEach(async () => testDatabase.reset());

async function account() {
  const id = randomUUID();
  await database.insert(users).values({ id, email: `${id}@example.test`, displayName: "E7 race" });
  return id;
}

async function ownedSandbox(accountId: string, channel: string) {
  const cloud = await new ComputerService(database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e7-race-${randomUUID().slice(0, 8)}`,
    displayName: "E7 race",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  const bindingId = randomUUID();
  await database.insert(imBindings).values({
    id: bindingId,
    agentId: agent.id,
    provider: "feishu",
    status: "active",
    externalAppId: `it-app-${randomUUID().slice(0, 8)}`,
    externalBotId: "it-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "integration-only-unused",
    activatedAt: new Date(),
  });
  return new SandboxService(database, new SessionService(database), { cloudIdentities }).ensureForAccount(accountId, {
    imBindingId: bindingId,
    channelId: channel,
    conversationKind: "channel",
    kind: "channel",
  });
}

interface RaceStack {
  fake: FakeCloudRunAdmin;
  store: FakeWorkspaceObjectStore;
  hub: RunnerHub;
  service: SandboxRunnerService;
}

function makeStack(): RaceStack {
  const fake = new FakeCloudRunAdmin();
  const store = new FakeWorkspaceObjectStore();
  const hub = new RunnerHub();
  const tokens = new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: 600 });
  const service = new SandboxRunnerService(database, {
    cloudAdmin: fake as never,
    tokens,
    hub,
    environment: "staging",
    backendUrl: "wss://unit.example/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: RUNNER_VERSION,
    acceptanceTimeoutMs: 10_000,
    createConvergeTimeoutMs: 30_000,
    idleTimeoutMs: 120_000,
    sleep: () => Promise.resolve(),
    workspace: { store },
  });
  return { fake, store, hub, service };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * One ready Sandbox whose Instance can answer the E5 seal through a connected E7 Runner. An
 * optional `sealGate` parks the seal acknowledgement so a test can interleave another real
 * database operation while the claim/seal is genuinely in flight (no sleeps).
 */
async function readySandbox(
  stack: RaceStack,
  accountId: string,
  channel: string,
  options: { sealGate?: { started: () => void; allow: Promise<void> } } = {},
) {
  const sandbox = await ownedSandbox(accountId, channel);
  await stack.service.startForAccount(accountId, sandbox.sandboxId);
  const [row] = await database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
  if (!row) throw new Error("Missing Sandbox row");
  const scope: RunnerScope = {
    sandboxId: row.id,
    sessionId: row.sessionId,
    environmentGeneration: row.environmentGeneration,
    resourceName: row.currentResourceName as string,
  };
  const socket: RunnerControlSocket = {
    async send(frame) {
      if (frame.type !== "workspace:seal") return;
      options.sealGate?.started();
      if (options.sealGate) await options.sealGate.allow;
      stack.store.plant(
        {
          storageUri: row.storageUri,
          sandboxId: row.id,
          sessionId: row.sessionId,
          environmentGeneration: row.environmentGeneration,
        },
        { saved: true, sealed: true, ownerGeneration: row.environmentGeneration },
      );
      stack.hub.settleWorkspaceSeal(
        row.id,
        { type: "workspace:seal:result", requestId: frame.requestId, ok: true },
        socket,
      );
    },
    close() {},
  };
  stack.hub.attach(scope, socket, { reuseCapable: true });
  stack.hub.markReady(
    scope,
    {
      sandboxName: scope.resourceName.split("/").at(-1) as string,
      rootfs: "/opt/sandbox-root",
      nodeVersion: "v24.19.0",
      piVersion: "0.84.2",
      runnerVersion: RUNNER_VERSION,
      reportedAt: new Date().toISOString(),
    },
    socket,
  );
  await stack.service.promoteDeferredReadiness(row.id);
  return { sandbox, row };
}

async function rowFor(sandboxId: string) {
  const [row] = await database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
  if (!row) throw new Error("Missing Sandbox row");
  return row;
}

describe("E7 transfer races on PostgreSQL", () => {
  it("lets exactly one of two concurrent claimants own the idle physical Instance", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "race-a");
    const b1 = await ownedSandbox(accountId, "race-b1");
    const b2 = await ownedSandbox(accountId, "race-b2");
    const createsBefore = stack.fake.createCalls.length;

    const results = await Promise.allSettled([
      stack.service.startForAccount(accountId, b1.sandboxId),
      stack.service.startForAccount(accountId, b2.sandboxId),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const [rowA, rowB1, rowB2] = await Promise.all([
      rowFor(a.sandbox.sandboxId),
      rowFor(b1.sandboxId),
      rowFor(b2.sandboxId),
    ]);
    const owners = [rowB1, rowB2].filter((row) => row.currentResourceName === a.row.currentResourceName);
    expect(owners).toHaveLength(1);
    const loser = [rowB1, rowB2].find((row) => row.currentResourceName !== a.row.currentResourceName);
    // The loser cold-allocates its own Instance: one physical create, never a duplicate owner.
    expect(stack.fake.createCalls.length).toBe(createsBefore + 1);
    expect(loser?.lifecycle).toBe("preparing");
    expect(loser?.currentResourceName).not.toBe(a.row.currentResourceName);
    expect(rowA).toMatchObject({ lifecycle: "unallocated", currentResourceName: null, currentResourceUid: null });
  });

  it("gives an explicit stop and a concurrent borrow a single winner", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "race-stop-a");
    const b = await ownedSandbox(accountId, "race-stop-b");
    const createsBefore = stack.fake.createCalls.length;

    const results = await Promise.allSettled([
      stack.service.stopForAccount(accountId, a.sandbox.sandboxId),
      stack.service.startForAccount(accountId, b.sandboxId),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const [rowA, rowB] = await Promise.all([rowFor(a.sandbox.sandboxId), rowFor(b.sandboxId)]);
    expect(rowA).toMatchObject({
      lifecycle: "unallocated",
      currentResourceName: null,
      currentResourceUid: null,
      idleReclaimAt: null,
    });
    if (rowB.currentResourceName === a.row.currentResourceName) {
      // Borrow won: the stop observed the row as already transferred and deleted nothing.
      expect(rowB.currentResourceUid).toBe(a.row.currentResourceUid);
      expect(stack.fake.liveInstanceCount()).toBe(1);
    } else {
      // Stop won: the borrower cold-allocated and the origin Instance was deleted.
      expect(stack.fake.createCalls.length).toBe(createsBefore + 1);
      expect(stack.fake.liveInstanceCount()).toBe(1);
    }
    const liveOwners = await database
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(and(eq(sandboxes.currentResourceName, a.row.currentResourceName as string)));
    expect(liveOwners.length).toBeLessThanOrEqual(1);
  });
});

describe("E7 legacy-image Instances after a target change on PostgreSQL", () => {
  it("reclaims an old-image READY Instance through the normal seal + verified delete path", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "legacy-reclaim");
    // The deployment target moved; the Instance keeps its original pinned image. Ownership-only
    // save/cleanup must not depend on the target image.
    stack.fake.targetImage = UPGRADED_IMAGE;
    const now = new Date();
    await database
      .update(sandboxes)
      .set({ lastActivityAt: new Date(now.getTime() - 120_000 - 1_000) })
      .where(eq(sandboxes.id, a.sandbox.sandboxId));

    const result = await stack.service.reclaimIdleSandboxes();
    expect(result.released).toBe(1);
    expect(await rowFor(a.sandbox.sandboxId)).toMatchObject({
      lifecycle: "unallocated",
      currentResourceName: null,
      currentResourceUid: null,
      idleReclaimAt: null,
    });
    expect(stack.store.stored(a.row.storageUri)).toMatchObject({ saved: true, sealed: true });
    expect(stack.fake.deleteCalls).toEqual([{ name: a.row.currentResourceName, uid: a.row.currentResourceUid }]);
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("never borrows an old-image sibling after a target upgrade; the borrower cold-allocates", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "legacy-borrow-source");
    stack.fake.targetImage = UPGRADED_IMAGE;
    const b = await ownedSandbox(accountId, "legacy-borrow-claimant");
    const createsBefore = stack.fake.createCalls.length;

    await stack.service.startForAccount(accountId, b.sandboxId);

    // The legacy sibling was skipped before any claim/seal; the borrower cold-allocated the
    // current target and the sibling keeps its binding for its own Session.
    expect(stack.fake.createCalls.length).toBe(createsBefore + 1);
    expect(await rowFor(a.sandbox.sandboxId)).toMatchObject({
      lifecycle: "ready",
      idleReclaimAt: null,
      currentResourceUid: a.row.currentResourceUid,
    });
    expect((await rowFor(b.sandboxId)).currentResourceName).not.toBe(a.row.currentResourceName);
    expect(stack.fake.deleteCalls).toHaveLength(0);
    expect(stack.fake.liveInstanceCount()).toBe(2);
  });

  it("lets the original-image Runner reconnect after a restart with a new target, then saves on stop", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "legacy-restart-save");
    // Server restart with a new deployment target: fresh in-memory hub, new expected version,
    // same database/store and the same physical Instance with its original pinned image.
    stack.fake.targetImage = UPGRADED_IMAGE;
    const hub = new RunnerHub();
    const restarted = new SandboxRunnerService(database, {
      cloudAdmin: stack.fake as never,
      tokens: new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: 600 }),
      hub,
      environment: "staging",
      backendUrl: "wss://unit.example/api/v1/sandbox-runners/ws",
      expectedRunnerVersion: UPGRADED_VERSION,
      acceptanceTimeoutMs: 10_000,
      createConvergeTimeoutMs: 30_000,
      idleTimeoutMs: 120_000,
      sleep: () => Promise.resolve(),
      workspace: { store: stack.store },
    });
    const scope: RunnerScope = {
      sandboxId: a.row.id,
      sessionId: a.row.sessionId,
      environmentGeneration: a.row.environmentGeneration,
      resourceName: a.row.currentResourceName as string,
    };
    const socket: RunnerControlSocket = {
      async send(frame) {
        if (frame.type !== "workspace:seal") return;
        stack.store.plant(
          {
            storageUri: a.row.storageUri,
            sandboxId: a.row.id,
            sessionId: a.row.sessionId,
            environmentGeneration: a.row.environmentGeneration,
          },
          { saved: true, sealed: true, ownerGeneration: a.row.environmentGeneration },
        );
        hub.settleWorkspaceSeal(
          a.row.id,
          { type: "workspace:seal:result", requestId: frame.requestId, ok: true },
          socket,
        );
      },
      close() {},
    };
    hub.attach(scope, socket, { reuseCapable: true });
    const readiness = {
      sandboxName: scope.resourceName.split("/").at(-1) as string,
      rootfs: "/opt/sandbox-root",
      nodeVersion: "v24.19.0",
      piVersion: "0.84.2",
      runnerVersion: RUNNER_VERSION,
      reportedAt: new Date().toISOString(),
    };
    expect(await restarted.markRunnerReady(scope, readiness, { workspaceRestored: true })).toBe("ready");
    hub.markReady(scope, readiness, socket);
    expect((await restarted.statusForAccount(accountId, a.row.id)).runnerReady).toBe(true);
    expect(stack.fake.createCalls).toHaveLength(1);
    expect(stack.fake.deleteCalls).toHaveLength(0);

    // An explicit stop still saves and releases the legacy Instance through the E5 path.
    const stopped = await restarted.stopForAccount(accountId, a.row.id);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(stack.store.stored(a.row.storageUri)).toMatchObject({ saved: true, sealed: true });
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });
});

async function insertPendingDelivery(sandboxId: string, sessionId: string) {
  void sandboxId;
  const [session] = await database
    .select({ imBindingId: sessions.imBindingId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const [placement] = await database
    .select({ computerId: sessionPlacements.computerId, generation: sessionPlacements.generation })
    .from(sessionPlacements)
    .where(eq(sessionPlacements.sessionId, sessionId));
  if (!session || !placement) throw new Error("Missing Session placement");
  const [binding] = await database
    .select({ agentId: imBindings.agentId })
    .from(imBindings)
    .where(eq(imBindings.id, session.imBindingId));
  if (!binding) throw new Error("Missing IM binding");
  const messageId = randomUUID();
  await database.insert(imMessages).values({
    id: messageId,
    imBindingId: session.imBindingId,
    channelId: `it-${randomUUID().slice(0, 8)}`,
    externalMessageId: randomUUID(),
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "it-author",
    content: {} as never,
    providerContext: {} as never,
    occurredAt: new Date(),
  });
  const deliveryId = randomUUID();
  await database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    state: "pending",
    placementGeneration: placement.generation,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const request = {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: messageId,
    sessionId,
    agentId: binding.agentId,
    placementGeneration: placement.generation,
    attention: "direct",
    content: { kind: "text", text: "gated" },
    runtime: { model: "deepseek-v4.1-flash-expires-on-0910" },
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as DirectImMessageDeliveryRequest;
  return { deliveryId, request, computerId: placement.computerId };
}

async function idleReadySandbox(stack: RaceStack, accountId: string, channel: string) {
  const sealStarted = deferred();
  const sealAllow = deferred();
  const ready = await readySandbox(stack, accountId, channel, {
    sealGate: { started: sealStarted.resolve, allow: sealAllow.promise },
  });
  const now = new Date();
  await database
    .update(sandboxes)
    .set({ lastActivityAt: new Date(now.getTime() - 120_000 - 1_000) })
    .where(eq(sandboxes.id, ready.sandbox.sandboxId));
  return { ...ready, sealStarted, sealAllow };
}

describe("E7 gated interleavings on PostgreSQL", () => {
  it("cleans a sealed origin when a concurrent start wins the same borrower reservation", async () => {
    const accountId = await account();
    const stack = makeStack();
    const started = deferred();
    const allow = deferred();
    const a = await readySandbox(stack, accountId, "gate-same-origin", {
      sealGate: { started: started.resolve, allow: allow.promise },
    });
    const b = await ownedSandbox(accountId, "gate-same-borrower");
    const first = stack.service.startForAccount(accountId, b.sandboxId);
    await started.promise;
    await stack.service.startForAccount(accountId, b.sandboxId);
    const winner = await rowFor(b.sandboxId);
    allow.resolve();
    await first;
    expect(await rowFor(a.sandbox.sandboxId)).toMatchObject({
      lifecycle: "unallocated",
      idleReclaimAt: null,
      currentResourceName: null,
    });
    expect(await rowFor(b.sandboxId)).toMatchObject({
      currentResourceName: winner.currentResourceName,
      currentResourceUid: winner.currentResourceUid,
    });
    expect(stack.fake.liveInstanceCount()).toBe(1);
    expect(stack.fake.deleteCalls).toEqual([{ name: a.row.currentResourceName, uid: a.row.currentResourceUid }]);
    expect(stack.store.stored(a.row.storageUri)).toMatchObject({ saved: true, sealed: true });
  });

  it("gates two borrowers on one physical Instance: the first claimant transfers, the second cold-allocates", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await idleReadySandbox(stack, accountId, "gate-two-a");
    const b1 = await ownedSandbox(accountId, "gate-two-b1");
    const b2 = await ownedSandbox(accountId, "gate-two-b2");
    const createsBefore = stack.fake.createCalls.length;

    const first = stack.service.startForAccount(accountId, b1.sandboxId);
    await a.sealStarted.promise; // B1 owns the claim and is sealing A
    expect((await rowFor(a.sandbox.sandboxId)).idleReclaimAt).not.toBeNull();

    // The second borrower runs while the first borrow is genuinely in flight. No free candidate
    // exists, so it must cold-allocate rather than wait or duplicate the physical owner.
    await stack.service.startForAccount(accountId, b2.sandboxId);
    a.sealAllow.resolve();
    await first;

    const [rowA, rowB1, rowB2] = await Promise.all([
      rowFor(a.sandbox.sandboxId),
      rowFor(b1.sandboxId),
      rowFor(b2.sandboxId),
    ]);
    expect(rowB1).toMatchObject({
      lifecycle: "preparing",
      currentResourceName: a.row.currentResourceName,
      currentResourceUid: a.row.currentResourceUid,
    });
    expect(rowB2.currentResourceName).not.toBe(a.row.currentResourceName);
    expect(stack.fake.createCalls.length).toBe(createsBefore + 1);
    expect(rowA).toMatchObject({ lifecycle: "unallocated", currentResourceName: null });
  });

  it("gates an explicit stop against an in-flight borrow: the stop wins and the borrower cold-allocates", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await idleReadySandbox(stack, accountId, "gate-stop-a");
    const b = await ownedSandbox(accountId, "gate-stop-b");
    const createsBefore = stack.fake.createCalls.length;

    const borrow = stack.service.startForAccount(accountId, b.sandboxId);
    await a.sealStarted.promise; // the borrow claimed A and is sealing it
    const stop = stack.service.stopForAccount(accountId, a.sandbox.sandboxId);
    // The stop transition clears the automatic marker BEFORE it joins the pending seal; wait for
    // that committed state instead of sleeping.
    await vi.waitFor(async () => {
      expect((await rowFor(a.sandbox.sandboxId)).idleReclaimAt).toBeNull();
    });
    a.sealAllow.resolve();
    await stop;
    await borrow;

    const [rowA, rowB] = await Promise.all([rowFor(a.sandbox.sandboxId), rowFor(b.sandboxId)]);
    expect(rowA).toMatchObject({ lifecycle: "unallocated", currentResourceName: null, idleReclaimAt: null });
    expect(rowB.currentResourceName).not.toBe(a.row.currentResourceName);
    expect(stack.fake.createCalls.length).toBe(createsBefore + 1);
    expect(stack.fake.deleteCalls.some((call) => call.name === a.row.currentResourceName)).toBe(true);
  });

  it("gates a new dispatch against an in-flight idle claim: the claim owns the row and the dispatch is refused", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await idleReadySandbox(stack, accountId, "gate-dispatch-a");

    const sweep = stack.service.reclaimIdleSandboxes();
    await a.sealStarted.promise; // claim committed, execution authority revoked, sealing in flight
    const delivery = await insertPendingDelivery(a.sandbox.sandboxId, a.row.sessionId);
    const custody = new PostgresRuntimeCustodyStore(database);
    const status = await custody.beginDeliveryDispatch(delivery.request, "a".repeat(64), {
      computerId: delivery.computerId,
      instanceId: randomUUID(),
    });
    expect(status).toBe("claimed");

    a.sealAllow.resolve();
    await sweep;
    const [pending] = await database
      .select({ state: imMessageDeliveries.state, dispatchRequestId: imMessageDeliveries.dispatchRequestId })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, delivery.deliveryId));
    expect(pending).toMatchObject({ state: "pending", dispatchRequestId: null });
    expect((await rowFor(a.sandbox.sandboxId)).lifecycle).toBe("unallocated");
  });

  it("gates an acceptance against an idle claim: a registered acceptance blocks reclamation", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "gate-acceptance-a");
    const controller = new AbortController();
    const acceptance = stack.service.runAcceptanceForAccount(
      accountId,
      a.sandbox.sandboxId,
      { mode: "offline" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(stack.hub.isBusy(a.sandbox.sandboxId)).toBe(true));
    const now = new Date();
    await database
      .update(sandboxes)
      .set({ lastActivityAt: new Date(now.getTime() - 120_000 - 1_000) })
      .where(eq(sandboxes.id, a.sandbox.sandboxId));

    await stack.service.reclaimIdleSandboxes();
    expect((await rowFor(a.sandbox.sandboxId)).idleReclaimAt).toBeNull();
    expect(stack.fake.liveInstanceCount()).toBe(1);

    controller.abort();
    await expect(acceptance).rejects.toMatchObject({ statusCode: 409 });
  });
});

function retryService(client: DatabaseClient, stack: RaceStack, now: () => Date) {
  return new SandboxRunnerService(client, {
    cloudAdmin: stack.fake as never,
    tokens: new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: 600 }),
    hub: stack.hub,
    environment: "staging",
    backendUrl: "wss://unit.example/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: RUNNER_VERSION,
    acceptanceTimeoutMs: 10_000,
    createConvergeTimeoutMs: 30_000,
    idleTimeoutMs: 120_000,
    sleep: () => Promise.resolve(),
    workspace: { store: stack.store },
    now,
  });
}

async function failedIdleClaim(stack: RaceStack, now: Date, lifecycle: "ready" | "releasing" = "ready") {
  const accountId = await account();
  const ready = await readySandbox(stack, accountId, `retry-${randomUUID()}`);
  const previous = new Date(now.getTime() - WORKSPACE_RECOVERY_RETRY_DELAY_MS);
  await database
    .update(sandboxes)
    .set({
      lifecycle,
      idleReclaimAt: previous,
      lastActivityAt: previous,
      lastErrorCode: "workspace_save_failed",
      lastErrorAt: previous,
      updatedAt: previous,
    })
    .where(eq(sandboxes.id, ready.row.id));
  return ready;
}

describe("automatic reclamation retry reservations on PostgreSQL", () => {
  it.each(["ready", "releasing"] as const)(
    "grants one %s retry to concurrent workers and preserves cooldown across restart",
    async (lifecycle) => {
      const stack = makeStack();
      let now = new Date(Date.now() + 1_000);
      const ready = await failedIdleClaim(stack, now, lifecycle);
      const baseline = stack.store.stored(ready.row.storageUri);
      const clients = [0, 1].map(() => createDatabaseClient(testDatabase.databaseUrl, { max: 1 }));
      const locked = deferred();
      const unlock = deferred();
      const sealing = deferred();
      const finishSeal = deferred();
      const seal = vi.spyOn(stack.hub, "requestWorkspaceSeal").mockImplementation(async () => {
        sealing.resolve();
        await finishSeal.promise;
        return { type: "workspace:seal:result", requestId: randomUUID(), ok: false, code: "workspace_save_failed" };
      });
      const reads = vi.spyOn(stack.fake, "getInstance");
      const block = database.transaction(async (transaction) => {
        await transaction.select().from(sandboxes).where(eq(sandboxes.id, ready.row.id)).for("update");
        locked.resolve();
        await unlock.promise;
      });
      const attempts: Promise<unknown>[] = [];
      try {
        const pids = await Promise.all(
          clients.map(async (client) => {
            const [row] = await client.sql`select pg_backend_pid() as pid`;
            return row?.pid as number;
          }),
        );
        await locked.promise;
        const outcomes: { released: number; failed: number }[] = [];
        for (const client of clients) {
          const worker = retryService(client.database, stack, () => now);
          attempts.push(
            worker.reclaimIdleSandboxes().then((result) => {
              outcomes.push(result);
            }),
          );
        }
        await vi.waitFor(
          async () => {
            const waiting = await sql`
          select pid from pg_stat_activity
          where pid in (${pids[0] as number}, ${pids[1] as number}) and wait_event_type = 'Lock'
        `;
            expect(waiting).toHaveLength(2);
          },
          { timeout: 2_000 },
        );
        unlock.resolve();
        await block;
        await sealing.promise;
        await vi.waitFor(() => expect(outcomes).toHaveLength(1));
        expect(reads).toHaveBeenCalledOnce();
        expect(seal).toHaveBeenCalledOnce();
        expect((await rowFor(ready.row.id)).updatedAt).toEqual(now);
        finishSeal.resolve();
        await Promise.all(attempts);
        expect(outcomes.reduce((sum, result) => sum + result.failed, 0)).toBe(1);
        expect(stack.store.stored(ready.row.storageUri)).toEqual(baseline);
        const fresh = retryService((clients[0] as (typeof clients)[number]).database, stack, () => now);
        await fresh.reclaimIdleSandboxes();
        expect(seal).toHaveBeenCalledOnce();
        now = new Date(now.getTime() + WORKSPACE_RECOVERY_RETRY_DELAY_MS);
        await fresh.reclaimIdleSandboxes();
        expect(seal).toHaveBeenCalledTimes(2);
        expect((await rowFor(ready.row.id)).currentResourceUid).toBe(ready.row.currentResourceUid);
      } finally {
        unlock.resolve();
        finishSeal.resolve();
        await Promise.allSettled([block, ...attempts]);
        await Promise.all(clients.map((client) => client.sql.end()));
      }
    },
  );

  it.each(["stop", "generation", "uid"])(
    "leaves newer %s state untouched when a reserved seal fails late",
    async (change) => {
      const stack = makeStack();
      const now = new Date(Date.now() + 1_000);
      const ready = await failedIdleClaim(stack, now);
      const baseline = stack.store.stored(ready.row.storageUri);
      const entered = deferred();
      const finish = deferred();
      vi.spyOn(stack.hub, "requestWorkspaceSeal").mockImplementation(async () => {
        entered.resolve();
        await finish.promise;
        return { type: "workspace:seal:result", requestId: randomUUID(), ok: false, code: "workspace_save_failed" };
      });
      const client = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const worker = retryService(client.database, stack, () => now);
      const attempt = worker.reclaimIdleSandboxes();
      try {
        await entered.promise;
        const replacement: Partial<typeof sandboxes.$inferInsert> = {
          updatedAt: new Date(now.getTime() + 1),
          lastErrorCode: "workspace_discard_requested",
          idleReclaimAt: null,
          ...(change === "stop" ? { lifecycle: "releasing" as const } : {}),
          ...(change === "generation" ? { environmentGeneration: ready.row.environmentGeneration + 1 } : {}),
          ...(change === "uid" ? { currentResourceUid: "replacement-uid" } : {}),
        };
        await database.update(sandboxes).set(replacement).where(eq(sandboxes.id, ready.row.id));
        finish.resolve();
        await attempt;
        expect(await rowFor(ready.row.id)).toMatchObject(replacement);
        expect(stack.store.stored(ready.row.storageUri)).toEqual(baseline);
        expect(stack.fake.liveInstanceCount()).toBe(1);
      } finally {
        finish.resolve();
        await attempt;
        await client.sql.end();
      }
    },
  );
});

describe("automatic deletion confirmation on PostgreSQL", () => {
  function pendingDeletes(stack: RaceStack) {
    const remove = stack.fake.deleteInstance.bind(stack.fake);
    vi.spyOn(stack.fake, "deleteInstance").mockImplementation(async (name, uid) => {
      const result = await remove(name, uid);
      const instance = stack.fake.instances.get(name);
      if (instance && !result.alreadyGone) instance.gone = false;
      return result;
    });
  }

  it("reserves one late confirmation across concurrent Server connections", async () => {
    const stack = makeStack();
    let now = new Date(Date.now() + 1_000);
    const ready = await failedIdleClaim(stack, now, "releasing");
    pendingDeletes(stack);
    await retryService(database, stack, () => now).reclaimIdleSandboxes();
    expect((await rowFor(ready.row.id)).lastErrorCode).toBe("cloud_delete_pending");
    now = new Date(now.getTime() + 60_000);
    expect(await retryService(database, stack, () => now).reclaimIdleSandboxes()).toMatchObject({
      released: 0,
      failed: 0,
    });
    now = new Date(now.getTime() + 15_000);
    const clients = [0, 1].map(() => createDatabaseClient(testDatabase.databaseUrl, { max: 1 }));
    const locked = deferred();
    const unlock = deferred();
    const reading = deferred();
    const finish = deferred();
    const reads = vi.spyOn(stack.fake, "getInstance").mockImplementation(async () => {
      reading.resolve();
      await finish.promise;
      return undefined;
    });
    const block = database.transaction(async (transaction) => {
      await transaction.select().from(sandboxes).where(eq(sandboxes.id, ready.row.id)).for("update");
      locked.resolve();
      await unlock.promise;
    });
    const attempts: Promise<unknown>[] = [];
    const outcomes: { released: number }[] = [];
    try {
      const pids = await Promise.all(
        clients.map(async (client) => {
          const [row] = await client.sql`select pg_backend_pid() as pid`;
          return row?.pid as number;
        }),
      );
      await locked.promise;
      for (const client of clients) {
        attempts.push(
          retryService(client.database, stack, () => now)
            .reclaimIdleSandboxes()
            .then((result) => {
              outcomes.push(result);
            }),
        );
      }
      await vi.waitFor(async () => {
        const waiting =
          await sql`select pid from pg_stat_activity where pid in (${pids[0] as number}, ${pids[1] as number}) and wait_event_type = 'Lock'`;
        expect(waiting).toHaveLength(2);
      });
      unlock.resolve();
      await reading.promise;
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(reads).toHaveBeenCalledOnce();
      finish.resolve();
      await Promise.all(attempts);
      expect(outcomes.reduce((sum, result) => sum + result.released, 0)).toBe(1);
      expect(stack.fake.deleteCalls).toHaveLength(1);
      expect((await rowFor(ready.row.id)).lifecycle).toBe("unallocated");
    } finally {
      unlock.resolve();
      finish.resolve();
      await Promise.allSettled([block, ...attempts]);
      await Promise.all(clients.map((client) => client.sql.end()));
    }
  });

  it.each(["stop", "generation", "uid"])("does not stamp a late pending marker onto newer %s state", async (change) => {
    const stack = makeStack();
    const now = new Date(Date.now() + 1_000);
    const ready = await failedIdleClaim(stack, now, "releasing");
    pendingDeletes(stack);
    const entered = deferred();
    const finish = deferred();
    const get = stack.fake.getInstance.bind(stack.fake);
    vi.spyOn(stack.fake, "getInstance").mockImplementation(async (name) => {
      const view = await get(name);
      if (stack.fake.deleteCalls.length > 0) {
        entered.resolve();
        await finish.promise;
      }
      return view;
    });
    const client = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const attempt = retryService(client.database, stack, () => now).reclaimIdleSandboxes();
    try {
      await entered.promise;
      const replacement = {
        updatedAt: new Date(now.getTime() + 1),
        lastErrorCode: "workspace_discard_requested",
        idleReclaimAt: null,
        ...(change === "generation" ? { environmentGeneration: ready.row.environmentGeneration + 1 } : {}),
        ...(change === "uid" ? { currentResourceUid: "replacement-uid" } : {}),
      };
      await database.update(sandboxes).set(replacement).where(eq(sandboxes.id, ready.row.id));
      finish.resolve();
      expect(await attempt).toMatchObject({ released: 0, failed: 0 });
      expect(await rowFor(ready.row.id)).toMatchObject(replacement);
      expect(stack.fake.deleteCalls).toEqual([
        { name: ready.row.currentResourceName, uid: ready.row.currentResourceUid },
      ]);
    } finally {
      finish.resolve();
      await attempt;
      await client.sql.end();
    }
  });

  it("does not clear a newer allocation after a late 404 confirmation", async () => {
    const stack = makeStack();
    let now = new Date(Date.now() + 1_000);
    const ready = await failedIdleClaim(stack, now, "releasing");
    pendingDeletes(stack);
    await retryService(database, stack, () => now).reclaimIdleSandboxes();
    now = new Date(now.getTime() + 15_000);
    const entered = deferred();
    const finish = deferred();
    vi.spyOn(stack.fake, "getInstance").mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return undefined;
    });
    const client = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const attempt = retryService(client.database, stack, () => now).reclaimIdleSandboxes();
    try {
      await entered.promise;
      const replacement = {
        lifecycle: "preparing" as const,
        environmentGeneration: ready.row.environmentGeneration + 1,
        currentResourceName: "replacement-name",
        currentResourceUid: "replacement-uid",
        lastErrorCode: "cloud_create_pending",
        lastActivityAt: now,
        idleReclaimAt: null,
        updatedAt: now,
      };
      await database.update(sandboxes).set(replacement).where(eq(sandboxes.id, ready.row.id));
      finish.resolve();
      expect(await attempt).toMatchObject({ released: 0, failed: 0 });
      expect(await rowFor(ready.row.id)).toMatchObject(replacement);
      expect(stack.fake.deleteCalls).toHaveLength(1);
    } finally {
      finish.resolve();
      await attempt;
      await client.sql.end();
    }
  });

  it.each([false, true])("recovers a pending-marker write with an unknown result (committed=%s)", async (committed) => {
    const stack = makeStack();
    let now = new Date(Date.now() + 1_000);
    const ready = await failedIdleClaim(stack, now, "releasing");
    pendingDeletes(stack);
    const client = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const update = client.database.update.bind(client.database);
    vi.spyOn(client.database, "update").mockImplementation(((table) => {
      const builder = update(table);
      const set = builder.set.bind(builder);
      builder.set = ((values) => {
        if ((values as { lastErrorCode?: unknown }).lastErrorCode !== "cloud_delete_pending") return set(values);
        return {
          where: async (condition: Parameters<ReturnType<typeof set>["where"]>[0]) => {
            if (committed) await set(values).where(condition);
            throw new Error("Pending marker acknowledgement lost");
          },
        };
      }) as typeof builder.set;
      return builder;
    }) as typeof client.database.update);
    try {
      expect((await retryService(client.database, stack, () => now).reclaimIdleSandboxes()).failed).toBe(1);
      expect(await rowFor(ready.row.id)).toMatchObject({
        lifecycle: "releasing",
        currentResourceUid: ready.row.currentResourceUid,
        lastErrorCode: committed ? "cloud_delete_pending" : "workspace_save_failed",
      });
      const instance = stack.fake.instances.get(ready.row.currentResourceName as string);
      if (!instance) throw new Error("Missing fixture Instance");
      instance.gone = true;
      now = new Date(now.getTime() + (committed ? 15_000 : WORKSPACE_RECOVERY_RETRY_DELAY_MS));
      expect((await retryService(database, stack, () => now).reclaimIdleSandboxes()).released).toBe(1);
      expect((await rowFor(ready.row.id)).lifecycle).toBe("unallocated");
      expect(stack.store.stored(ready.row.storageUri)).toMatchObject({ saved: true, sealed: true });
    } finally {
      await client.sql.end();
    }
  });
});
