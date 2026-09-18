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
import { SandboxRunnerService } from "../../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { FakeCloudRunAdmin } from "../support/fake-cloud-run-admin.js";
import { FakeWorkspaceObjectStore } from "../support/fake-workspace-store.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const RUNNER_VERSION = "0.0.5";
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
