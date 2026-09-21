/**
 * E7 idle reclamation + same-account physical Instance reuse on the embedded PostgreSQL engine.
 * The cloud side is the deterministic fake admin; workspace sealing uses the fake GCS store with
 * the same generation/owner CAS discipline as production. The automatic sweep and the ownership
 * transfer run through the real SandboxRunnerService transactions, so the CAS behavior proven
 * here is the production one.
 */
import { randomUUID } from "node:crypto";
import { RUNNER_WORKSPACE_TIMEOUT_MS } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  imBindings,
  imMessageDeliveries,
  imMessages,
  runtimeDurableWork,
  sandboxes,
  users,
} from "../db/schema/index.js";
import { PostgresRuntimeDurableWorkStore } from "../runtime/runtime-durable-work-store.js";
import { AgentService } from "../services/agents/index.js";
import { ComputerService } from "../services/computers/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../services/runtime-config/index.js";
import { CloudRuntimeFence } from "../services/sandboxes/cloud-runtime-fence.js";
import {
  CloudSessionCollaborationOwner,
  CloudSessionWorkTracker,
} from "../services/sandboxes/cloud-session-collaboration-owner.js";
import { SandboxService } from "../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../services/sandboxes/runner-bootstrap-token.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../services/sandboxes/runner-hub.js";
import { SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../services/sessions/index.js";
import { FakeCloudRunAdmin } from "./support/fake-cloud-run-admin.js";
import { FakeWorkspaceObjectStore } from "./support/fake-workspace-store.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
const RUNNER_VERSION = "0.0.5";
const UPGRADED_VERSION = "0.0.6";
/** A deployment target image distinct from the fake's default, pinned only at Instance creation. */
const UPGRADED_IMAGE = `unit/image@sha256:${"2".repeat(64)}`;
const IDLE_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 30_000 + 4 * RUNNER_WORKSPACE_TIMEOUT_MS;
const JWT_SECRET = "unit-test-jwt-secret-at-least-32-characters";
const cloudIdentities = { enabled: true, runnerVersion: RUNNER_VERSION, storageBase: "gs://unit-cloud/sandboxes" };
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

async function account() {
  const id = randomUUID();
  await unit.database.insert(users).values({ id, email: `${id}@example.test`, displayName: "E7 fixture" });
  return id;
}

async function ownedSandbox(accountId: string, channel: string) {
  const cloud = await new ComputerService(unit.database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(unit.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e7-${randomUUID().slice(0, 8)}`,
    displayName: "E7 Pi",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  const bindingId = randomUUID();
  await unit.database.insert(imBindings).values({
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
  const sandbox = await new SandboxService(unit.database, new SessionService(unit.database), {
    cloudIdentities,
  }).ensureForAccount(accountId, {
    imBindingId: bindingId,
    channelId: channel,
    conversationKind: "channel",
    kind: "channel",
  });
  return { sandbox, agent, bindingId, cloud };
}

async function sandboxRow(sandboxId: string) {
  const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
  return row as typeof sandboxes.$inferSelect;
}

interface Stack {
  fake: FakeCloudRunAdmin;
  store: FakeWorkspaceObjectStore;
  hub: RunnerHub;
  tokens: RunnerBootstrapTokenService;
  service: SandboxRunnerService;
  now: () => Date;
  advance: (ms: number) => void;
}

function makeStack(
  options: {
    workspace?: boolean;
    capacity?: { accountLimit: number; platformLimit: number };
    sessionWorkBusy?: ConstructorParameters<typeof SandboxRunnerService>[1]["sessionWorkBusy"];
    sessionWorkBarrier?: ConstructorParameters<typeof SandboxRunnerService>[1]["sessionWorkBarrier"];
  } = {},
): Stack {
  const fake = new FakeCloudRunAdmin();
  const store = new FakeWorkspaceObjectStore();
  const tokens = new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: 600 });
  const hub = new RunnerHub();
  let current = new Date("2026-01-01T00:00:00.000Z");
  const service = new SandboxRunnerService(unit.database, {
    cloudAdmin: fake as never,
    tokens,
    hub,
    environment: "staging",
    backendUrl: "wss://unit.example/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: RUNNER_VERSION,
    acceptanceTimeoutMs: 10_000,
    createConvergeTimeoutMs: 30_000,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    sleep: () => Promise.resolve(),
    now: () => current,
    ...(options.workspace === false ? {} : { workspace: { store } }),
    ...(options.capacity ? { capacity: options.capacity } : {}),
    ...(options.sessionWorkBusy ? { sessionWorkBusy: options.sessionWorkBusy } : {}),
    ...(options.sessionWorkBarrier ? { sessionWorkBarrier: options.sessionWorkBarrier } : {}),
  });
  return {
    fake,
    store,
    hub,
    tokens,
    service,
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

/** A fresh Server process over the same database/cloud/store, for restart-recovery assertions. */
function restartService(stack: Stack): SandboxRunnerService {
  return new SandboxRunnerService(unit.database, {
    cloudAdmin: stack.fake as never,
    tokens: stack.tokens,
    hub: new RunnerHub(),
    environment: "staging",
    backendUrl: "wss://unit.example/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: RUNNER_VERSION,
    acceptanceTimeoutMs: 10_000,
    createConvergeTimeoutMs: 30_000,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    sleep: () => Promise.resolve(),
    now: stack.now,
    workspace: { store: stack.store },
  });
}

/**
 * A fresh Server process after a deployment target change: new in-memory hub, new expected
 * Runner version, and the fake provider's target image moved. Existing Instances keep the image
 * they pinned at creation, exactly like the immutable real resource.
 */
function restartedWithUpgradedTarget(stack: Stack): { service: SandboxRunnerService; hub: RunnerHub } {
  stack.fake.targetImage = UPGRADED_IMAGE;
  const hub = new RunnerHub();
  const service = new SandboxRunnerService(unit.database, {
    cloudAdmin: stack.fake as never,
    tokens: stack.tokens,
    hub,
    environment: "staging",
    backendUrl: "wss://unit.example/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: UPGRADED_VERSION,
    acceptanceTimeoutMs: 10_000,
    createConvergeTimeoutMs: 30_000,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    sleep: () => Promise.resolve(),
    now: stack.now,
    workspace: { store: stack.store },
  });
  return { service, hub };
}

/** A reconnecting original-image Runner that answers workspace seals like the ready fixture. */
function attachOriginalImageRunner(
  stack: Stack,
  hub: RunnerHub,
  row: typeof sandboxes.$inferSelect,
): { scope: RunnerScope; socket: RunnerControlSocket } {
  const scope: RunnerScope = {
    sandboxId: row.id,
    sessionId: row.sessionId,
    environmentGeneration: row.environmentGeneration,
    resourceName: row.currentResourceName as string,
  };
  const socket: RunnerControlSocket = {
    send(frame) {
      if (frame.type !== "workspace:seal") return;
      stack.store.plant(
        {
          storageUri: row.storageUri,
          sandboxId: row.id,
          sessionId: row.sessionId,
          environmentGeneration: row.environmentGeneration,
        },
        { saved: true, sealed: true, ownerGeneration: row.environmentGeneration },
      );
      hub.settleWorkspaceSeal(row.id, { type: "workspace:seal:result", requestId: frame.requestId, ok: true }, socket);
    },
    close() {
      // The hub owns connection replacement; tests only need the send surface.
    },
  };
  hub.attach(scope, socket, { reuseCapable: true });
  return { scope, socket };
}

function originalImageReadiness(stack: Stack, scope: RunnerScope) {
  return {
    sandboxName: scope.resourceName.split("/").at(-1) as string,
    rootfs: "/opt/sandbox-root",
    nodeVersion: "v24.19.0",
    piVersion: "0.84.2",
    runnerVersion: RUNNER_VERSION,
    reportedAt: stack.now().toISOString(),
  };
}

/**
 * One Sandbox allocated and promoted to `ready` with a connected reuse-capable E7 Runner. The
 * fake socket answers `workspace:seal` exactly as a Runner would: on success it plants the sealed
 * object before acknowledging; on failure it returns the terminal failure code.
 */
async function readySandbox(
  stack: Stack,
  accountId: string,
  channel: string,
  options: { reuseCapable?: boolean; seal?: "ok" | "fail" } = {},
) {
  const owned = await ownedSandbox(accountId, channel);
  await stack.service.startForAccount(accountId, owned.sandbox.sandboxId);
  const row = await sandboxRow(owned.sandbox.sandboxId);
  const scope: RunnerScope = {
    sandboxId: row.id,
    sessionId: row.sessionId,
    environmentGeneration: row.environmentGeneration,
    resourceName: row.currentResourceName as string,
  };
  const socket: RunnerControlSocket = {
    send(frame) {
      if (frame.type !== "workspace:seal") return;
      if (options.seal === "fail") {
        stack.hub.settleWorkspaceSeal(
          row.id,
          { type: "workspace:seal:result", requestId: frame.requestId, ok: false, code: "workspace_save_failed" },
          socket,
        );
        return;
      }
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
    close() {
      // The hub owns connection replacement; tests only need the send surface.
    },
  };
  stack.hub.attach(scope, socket, { reuseCapable: options.reuseCapable !== false });
  stack.hub.markReady(
    scope,
    {
      sandboxName: scope.resourceName.split("/").at(-1) as string,
      rootfs: "/opt/sandbox-root",
      nodeVersion: "v24.19.0",
      piVersion: "0.84.2",
      runnerVersion: RUNNER_VERSION,
      reportedAt: stack.now().toISOString(),
    },
    socket,
  );
  await stack.service.promoteDeferredReadiness(row.id);
  const ready = await sandboxRow(row.id);
  expect(ready.lifecycle).toBe("ready");
  return { owned, row: ready, scope, socket };
}

async function insertDelivery(
  bindingId: string,
  sessionId: string,
  input: { state: "pending" | "accepted"; reported?: boolean },
): Promise<void> {
  const messageId = randomUUID();
  await unit.database.insert(imMessages).values({
    id: messageId,
    imBindingId: bindingId,
    channelId: `unit-${randomUUID().slice(0, 8)}`,
    externalMessageId: randomUUID(),
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "unit-author",
    content: {} as never,
    providerContext: {} as never,
    occurredAt: new Date(),
  });
  if (input.state === "accepted") {
    await unit.database.insert(imMessageDeliveries).values({
      messageId,
      sessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      inputHash: randomUUID().replaceAll("-", ""),
      turnId: randomUUID(),
      reportOwnerInstanceId: randomUUID(),
      acceptedAt: new Date(),
      ...(input.reported ? { reportedAt: new Date(), turnReport: {} as never, resultHash: randomUUID() } : {}),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return;
  }
  await unit.database.insert(imMessageDeliveries).values({
    messageId,
    sessionId,
    attention: "direct",
    state: "pending",
    placementGeneration: 1,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

describe("E7 automatic idle reclamation", () => {
  it("lets a previously verified READY Instance continue after a target upgrade and reclaims it normally", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-upgrade");
    const restarted = restartedWithUpgradedTarget(stack);
    const runner = attachOriginalImageRunner(stack, restarted.hub, ready.row);
    const readiness = originalImageReadiness(stack, runner.scope);

    // The original build reconnects with its restored workspace: the tracked READY allocation is
    // re-verified against the provider (ownership + non-image policy + provably original image).
    expect(await restarted.service.markRunnerReady(runner.scope, readiness, { workspaceRestored: true })).toBe("ready");
    restarted.hub.markReady(runner.scope, readiness, runner.socket);
    expect((await restarted.service.statusForAccount(accountId, ready.row.id)).runnerReady).toBe(true);
    expect(stack.fake.createCalls).toHaveLength(1);
    expect(stack.fake.deleteCalls).toHaveLength(0);

    // Idle reclamation still seals and deletes the legacy Instance through the normal E5 path.
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    const result = await restarted.service.reclaimIdleSandboxes();
    expect(result.released).toBe(1);
    expect(await sandboxRow(ready.row.id)).toMatchObject({
      lifecycle: "unallocated",
      currentResourceName: null,
      currentResourceUid: null,
      idleReclaimAt: null,
    });
    expect(stack.store.stored(ready.row.storageUri)).toMatchObject({ saved: true, sealed: true });
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("still requires the workspace restore proof from an original-image reconnect", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-upgrade-unrestored");
    const restarted = restartedWithUpgradedTarget(stack);
    const runner = attachOriginalImageRunner(stack, restarted.hub, ready.row);
    const readiness = originalImageReadiness(stack, runner.scope);

    // The original-image re-verification passes, but without the restore proof the readiness is
    // still refused: a blank environment must never report ready.
    expect(await restarted.service.markRunnerReady(runner.scope, readiness)).toBe("workspace_not_restored");
    expect((await sandboxRow(ready.row.id)).lifecycle).toBe("ready");
    expect(restarted.hub.describe(ready.row.id).ready).toBe(false);
    expect(stack.fake.liveInstanceCount()).toBe(1);
  });

  it("rotates a full batch of failed seals so another Session is reclaimed on the next sweep", async () => {
    const accountId = await account();
    // Sweep-fairness fixture: deliberately above the E9 default ceilings (3/20) so the full
    // 26-environment batch can be allocated; admission is not what this test exercises.
    const stack = makeStack({ capacity: { accountLimit: 100, platformLimit: 1_000 } });
    for (let index = 0; index < 25; index += 1) {
      await readySandbox(stack, accountId, `failed-${index}`, { reuseCapable: false, seal: "fail" });
      stack.advance(1);
    }
    const healthy = await readySandbox(stack, accountId, "healthy", { reuseCapable: false });
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    const first = await stack.service.reclaimIdleSandboxes();
    expect(first.failed).toBe(25);
    expect((await sandboxRow(healthy.row.id)).lifecycle).toBe("ready");
    stack.advance(15_000);
    const second = await stack.service.reclaimIdleSandboxes();
    expect(second.released).toBe(1);
    expect((await sandboxRow(healthy.row.id)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(25);
  });

  it("seals and deletes a ready environment after the single idle budget, clearing every binding", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-idle");

    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    const result = await stack.service.reclaimIdleSandboxes();
    expect(result.released).toBe(1);
    expect(stack.fake.liveInstanceCount()).toBe(0);
    const row = await sandboxRow(ready.row.id);
    expect(row).toMatchObject({
      lifecycle: "unallocated",
      currentResourceName: null,
      currentResourceUid: null,
      idleReclaimAt: null,
      lastErrorCode: null,
    });
  });

  it("never reclaims while a pending or accepted-unreported delivery exists", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-busy");
    await insertDelivery(ready.owned.bindingId, ready.row.sessionId, { state: "pending" });

    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).idleReclaimAt).toBeNull();
    expect(stack.fake.liveInstanceCount()).toBe(1);

    // Accepted but unreported custody is still work: the environment stays untouched.
    const second = await readySandbox(stack, accountId, "room-busy-2");
    await insertDelivery(second.owned.bindingId, second.row.sessionId, { state: "accepted" });
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(second.row.id)).idleReclaimAt).toBeNull();

    // A reported turn is settled: the same environment is then reclaimable.
    const third = await readySandbox(stack, accountId, "room-busy-3");
    await insertDelivery(third.owned.bindingId, third.row.sessionId, { state: "accepted", reported: true });
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(third.row.id)).lifecycle).toBe("unallocated");
  });

  it("keeps a ready environment when business activity arrived inside the budget", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-active");

    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.noteActivity(ready.row.id);
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).idleReclaimAt).toBeNull();
    expect(stack.fake.liveInstanceCount()).toBe(1);
  });

  it("retains the binding on seal failure, then converges on retry using the same budget", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-save-fail", { seal: "fail" });

    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    const failed = await sandboxRow(ready.row.id);
    expect(failed).toMatchObject({ lifecycle: "ready", lastErrorCode: "workspace_save_failed" });
    expect(failed.idleReclaimAt).not.toBeNull();
    expect(stack.fake.liveInstanceCount()).toBe(1);

    // A retry after the same budget short-circuits on the sealed proof and releases the resource.
    stack.store.plant(
      {
        storageUri: ready.row.storageUri,
        sandboxId: ready.row.id,
        sessionId: ready.row.sessionId,
        environmentGeneration: ready.row.environmentGeneration,
      },
      { saved: true, sealed: true, ownerGeneration: ready.row.environmentGeneration },
    );
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("recovers a stale preparing allocation after the startup deadline and preserves the archive", async () => {
    const accountId = await account();
    const stack = makeStack();
    const owned = await ownedSandbox(accountId, "room-stale");
    await stack.service.startForAccount(accountId, owned.sandbox.sandboxId);
    const preparing = await sandboxRow(owned.sandbox.sandboxId);
    expect(preparing.lifecycle).toBe("preparing");
    expect(stack.store.stored(preparing.storageUri)).toBeDefined();

    stack.advance(STARTUP_TIMEOUT_MS + 1_000);
    const result = await stack.service.reclaimIdleSandboxes();
    expect(result.recovered).toBe(1);
    const recovered = await sandboxRow(owned.sandbox.sandboxId);
    expect(recovered).toMatchObject({ lifecycle: "unallocated", currentResourceName: null });
    expect(stack.fake.liveInstanceCount()).toBe(0);
    // The borrower/origin archive is never deleted by adoption recovery: a later start restores it.
    expect(stack.store.stored(preparing.storageUri)).toBeDefined();
  });

  it("promotes instead of recycling a stale preparing allocation whose Runner became ready", async () => {
    const accountId = await account();
    const stack = makeStack();
    const owned = await ownedSandbox(accountId, "room-stale-connected");
    await stack.service.startForAccount(accountId, owned.sandbox.sandboxId);
    const row = await sandboxRow(owned.sandbox.sandboxId);
    const scope = {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName as string,
    };
    const socket = { send() {}, close() {} };
    stack.hub.attach(scope, socket);
    stack.hub.markReady(
      scope,
      {
        sandboxName: scope.resourceName.split("/").at(-1) as string,
        rootfs: "/opt/sandbox-root",
        nodeVersion: "v24.19.0",
        piVersion: "0.84.2",
        runnerVersion: RUNNER_VERSION,
        reportedAt: stack.now().toISOString(),
      },
      socket,
    );
    // Deliberately leave the row `preparing`: the sweep must promote a late readiness report
    // rather than recycle a live environment as disposable startup.
    stack.advance(STARTUP_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(row.id)).lifecycle).toBe("ready");
    expect(stack.fake.liveInstanceCount()).toBe(1);
  });

  it("retries an automatic releasing row after a delete failure without waiting out another budget", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-retry");
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    // Two failures: the ready-phase delete and the same-pass automatic-releasing retry.
    stack.fake.deleteFailures = 2;
    const first = await stack.service.reclaimIdleSandboxes();
    expect(first.released).toBe(0);
    expect(first.failed).toBeGreaterThanOrEqual(2);
    const releasing = await sandboxRow(ready.row.id);
    expect(releasing.lifecycle).toBe("releasing");
    expect(releasing.idleReclaimAt).not.toBeNull();
    expect(stack.fake.liveInstanceCount()).toBe(1);
    // The budget was already spent before the transition: the durable marker alone authorizes the
    // retry — here from a fresh Server process over the same database — without a second window.
    const second = await restartService(stack).reclaimIdleSandboxes();
    expect(second.released).toBe(1);
    expect((await sandboxRow(ready.row.id)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("explicit stop replaces automatic release intent even after a failed delete", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-stop-releasing");
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    stack.fake.deleteFailures = 3;
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).idleReclaimAt).not.toBeNull();
    await expect(stack.service.stopForAccount(accountId, ready.row.id)).rejects.toMatchObject({ statusCode: 503 });
    expect(await sandboxRow(ready.row.id)).toMatchObject({ lifecycle: "releasing", idleReclaimAt: null });
    expect(await stack.service.ensureIngressAllocation(accountId, ready.row.id)).toBe("stopped");
    await stack.service.stopForAccount(accountId, ready.row.id);
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("keeps a legacy Instance's sole local copy when Server persistence was enabled later", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-legacy-storage", { reuseCapable: false });
    const instance = stack.fake.instances.get(ready.row.currentResourceName as string);
    if (!instance) throw new Error("Missing fixture Instance");
    instance.spec.workspacePersistence = false;
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect(await sandboxRow(ready.row.id)).toMatchObject({
      lifecycle: "ready",
      currentResourceUid: ready.row.currentResourceUid,
      idleReclaimAt: null,
    });
    expect(stack.fake.deleteCalls).toHaveLength(0);
    await stack.service.reclaimIdleSandboxes();
    expect(stack.fake.liveInstanceCount()).toBe(1);
    expect(await stack.service.ensureIngressAllocation(accountId, ready.row.id)).toBe("ready");
    expect(await stack.service.validateRunnerScope(ready.scope)).toMatchObject({ sandboxId: ready.row.id });
    // Explicit Account cleanup retains the established legacy behavior.
    await stack.service.stopForAccount(accountId, ready.row.id);
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("uses lastActivityAt as the only budget clock for an abandoned claim", async () => {
    // Separate accounts: one account's second start would legitimately borrow the first sibling.
    const spentAccount = await account();
    const freshAccount = await account();
    const stack = makeStack();
    const spent = await readySandbox(stack, spentAccount, "room-budget-spent");
    const fresh = await readySandbox(stack, freshAccount, "room-budget-fresh");
    const now = stack.now();
    await unit.database
      .update(sandboxes)
      .set({ idleReclaimAt: now, lastActivityAt: new Date(now.getTime() - IDLE_TIMEOUT_MS - 1_000) })
      .where(eq(sandboxes.id, spent.row.id));
    await unit.database
      .update(sandboxes)
      .set({ idleReclaimAt: now, lastActivityAt: now })
      .where(eq(sandboxes.id, fresh.row.id));

    const result = await stack.service.reclaimIdleSandboxes();
    expect(result.released).toBe(1);
    expect((await sandboxRow(spent.row.id)).lifecycle).toBe("unallocated");
    // The fresh claim marker is NOT a new clock: the row's activity budget has not passed.
    expect((await sandboxRow(fresh.row.id)).lifecycle).toBe("ready");
    expect((await sandboxRow(fresh.row.id)).idleReclaimAt).not.toBeNull();
  });

  it("keeps a pending Session input retryable while an automatic adoption releases", async () => {
    const accountId = await account();
    const stack = makeStack();
    const owned = await ownedSandbox(accountId, "room-pending-release");
    await stack.service.startForAccount(accountId, owned.sandbox.sandboxId);
    const row = await sandboxRow(owned.sandbox.sandboxId);
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "releasing", idleReclaimAt: stack.now() })
      .where(eq(sandboxes.id, row.id));
    expect(await stack.service.ensureIngressAllocation(accountId, row.id)).toBe("pending");
  });

  it("never auto-deletes an environment when workspace persistence is not configured", async () => {
    const accountId = await account();
    const stack = makeStack({ workspace: false });
    const owned = await ownedSandbox(accountId, "room-no-store");
    await stack.service.startForAccount(accountId, owned.sandbox.sandboxId);
    const row = await sandboxRow(owned.sandbox.sandboxId);
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    const result = await stack.service.reclaimIdleSandboxes();
    expect(result).toEqual({ claimed: 0, released: 0, recovered: 0, failed: 0 });
    expect((await sandboxRow(row.id)).currentResourceUid).not.toBeNull();
    expect(stack.fake.liveInstanceCount()).toBe(1);
  });

  it("recovers a connected-but-never-ready stale preparing allocation after the startup deadline", async () => {
    const accountId = await account();
    const stack = makeStack();
    const owned = await ownedSandbox(accountId, "room-stale-never-ready");
    await stack.service.startForAccount(accountId, owned.sandbox.sandboxId);
    const row = await sandboxRow(owned.sandbox.sandboxId);
    stack.hub.attach(
      {
        sandboxId: row.id,
        sessionId: row.sessionId,
        environmentGeneration: row.environmentGeneration,
        resourceName: row.currentResourceName as string,
      },
      { send() {}, close() {} },
    );
    expect(stack.hub.describe(row.id).ready).toBe(false);
    // A connected Runner still has time to claim/download/checkpoint its restored workspace.
    stack.advance(31_000);
    expect((await stack.service.reclaimIdleSandboxes()).recovered).toBe(0);
    stack.advance(120_000);
    expect((await stack.service.reclaimIdleSandboxes()).recovered).toBe(0);
    expect(stack.fake.deleteCalls).toHaveLength(0);
    // A restore that never finishes still converges after the complete startup budget.
    stack.advance(STARTUP_TIMEOUT_MS);
    const result = await stack.service.reclaimIdleSandboxes();
    expect(result.recovered).toBe(1);
    expect((await sandboxRow(row.id)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("blocks an automatic idle claim while an acceptance is registered under the row lock", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-acceptance");
    const controller = new AbortController();
    const acceptance = stack.service.runAcceptanceForAccount(
      accountId,
      ready.row.id,
      { mode: "offline" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(stack.hub.isBusy(ready.row.id)).toBe(true));
    // The acceptance touched the activity clock; age the row under the acceptance to prove the
    // busy fence itself (under the same Sandbox row lock) refuses the claim.
    const now = stack.now();
    await unit.database
      .update(sandboxes)
      .set({ lastActivityAt: new Date(now.getTime() - IDLE_TIMEOUT_MS - 1_000) })
      .where(eq(sandboxes.id, ready.row.id));
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).idleReclaimAt).toBeNull();
    expect(stack.fake.liveInstanceCount()).toBe(1);

    controller.abort();
    await expect(acceptance).rejects.toMatchObject({ statusCode: 409 });
    await unit.database
      .update(sandboxes)
      .set({ lastActivityAt: new Date(stack.now().getTime() - IDLE_TIMEOUT_MS - 1_000) })
      .where(eq(sandboxes.id, ready.row.id));
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).lifecycle).toBe("unallocated");
  });

  it("blocks an automatic idle claim while accepted Session-message work is durably unfinished", async () => {
    const accountId = await account();
    const owner = new CloudSessionCollaborationOwner({
      assembler: new EffectiveRuntimeSnapshotAssembler(unit.database),
      database: unit.database,
      durableWork: new PostgresRuntimeDurableWorkStore(unit.database),
      fence: new CloudRuntimeFence(),
      hub: new RunnerHub(),
      work: new CloudSessionWorkTracker(),
    });
    const stack = makeStack({ sessionWorkBarrier: (input) => owner.hasUnsettledSessionWork(input) });
    const ready = await readySandbox(stack, accountId, "room-session-work");
    // Age the row past the idle budget: only the durable collaboration barrier can refuse it.
    const now = stack.now();
    await unit.database
      .update(sandboxes)
      .set({ lastActivityAt: new Date(now.getTime() - IDLE_TIMEOUT_MS - 1_000) })
      .where(eq(sandboxes.id, ready.row.id));
    const recordKey = `${ready.row.sessionId}:${randomUUID()}`;
    await unit.database.insert(runtimeDurableWork).values({
      acceptedAt: now.getTime(),
      attempts: 0,
      computerId: ready.owned.cloud.computerId,
      kind: "session-message",
      payload: { messageId: recordKey.split(":")[1] },
      recordKey,
      status: "accepted",
      updatedAt: now.getTime(),
    });

    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).idleReclaimAt).toBeNull();
    expect(stack.fake.liveInstanceCount()).toBe(1);

    // A verified terminal outcome clears the barrier and the same sweep reclaims normally.
    await unit.database
      .update(runtimeDurableWork)
      .set({ status: "succeeded", updatedAt: now.getTime() + 1 })
      .where(eq(runtimeDurableWork.recordKey, recordKey));
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).lifecycle).toBe("unallocated");
  });

  /** Attach a reuse-capable Runner for the row's current allocation, answering seals like a Runner. */
  async function attachReadyRunner(stack: Stack, row: typeof sandboxes.$inferSelect) {
    const scope: RunnerScope = {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName as string,
    };
    const socket: RunnerControlSocket = {
      send(frame) {
        if (frame.type !== "workspace:seal") return;
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
      close() {
        // The hub owns connection replacement; tests only need the send surface.
      },
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
        reportedAt: stack.now().toISOString(),
      },
      socket,
    );
    await stack.service.promoteDeferredReadiness(row.id);
    const ready = await sandboxRow(row.id);
    expect(ready.lifecycle).toBe("ready");
    return { row: ready, scope, socket };
  }

  /** Accepted Session-collaboration work on one allocation: tracker registration + durable envelope. */
  async function plantSessionWork(
    stack: Stack,
    ready: Awaited<ReturnType<typeof readySandbox>>,
    work: CloudSessionWorkTracker,
  ): Promise<void> {
    const messageId = randomUUID();
    const now = stack.now();
    work.register(ready.scope, messageId, "turn-old");
    await unit.database.insert(runtimeDurableWork).values({
      acceptedAt: now.getTime(),
      attempts: 0,
      computerId: ready.owned.cloud.computerId,
      kind: "session-message",
      payload: {
        type: "cloud-session-message-work",
        request: {
          type: "session:message:deliver",
          requestId: randomUUID(),
          messageId,
          sourceSessionId: ready.row.sessionId,
          targetSessionId: ready.row.sessionId,
          agentId: ready.owned.agent.id,
          placementGeneration: 1,
          content: { kind: "text", text: "old work" },
          runtime: {
            contextTreeRepository: null,
            revision: { agent: { sequence: 1, id: "agent" }, session: { sequence: 1, id: "session" } },
            agentId: ready.owned.agent.id,
            provider: "codex",
            instructions: { platform: "platform", agent: "agent" },
            execution: { approvalPolicy: "never", networkAccess: false },
            workspace: { workspaceId: "workspace", mode: "empty_on_create", sharing: "agent" },
          },
        },
        allocation: {
          sandboxId: ready.scope.sandboxId,
          environmentGeneration: ready.scope.environmentGeneration,
          resourceName: ready.scope.resourceName,
        },
        turnId: "turn-old",
      },
      recordKey: `${ready.row.sessionId}:${messageId}`,
      status: "accepted",
      updatedAt: now.getTime(),
    });
  }

  /**
   * The IM ingress replacement path: provider-confirmed loss of the old Instance, then a normal
   * start allocating the next generation. No Session-collaboration dispatch or reconcile runs.
   */
  async function replaceAllocation(
    stack: Stack,
    ready: Awaited<ReturnType<typeof readySandbox>>,
    accountId: string,
  ): Promise<Awaited<ReturnType<typeof attachReadyRunner>>> {
    const instance = stack.fake.instances.get(ready.row.currentResourceName as string);
    if (!instance) throw new Error("Missing fixture Instance");
    instance.gone = true;
    stack.hub.detach(ready.row.id, ready.socket);
    await stack.service.startForAccount(accountId, ready.row.id);
    const replaced = await sandboxRow(ready.row.id);
    expect(replaced.environmentGeneration).toBe(ready.row.environmentGeneration + 1);
    expect(replaced.currentResourceName).not.toBe(ready.row.currentResourceName);
    return attachReadyRunner(stack, replaced);
  }

  function sessionWorkStack(work: CloudSessionWorkTracker) {
    const owner = new CloudSessionCollaborationOwner({
      assembler: new EffectiveRuntimeSnapshotAssembler(unit.database),
      database: unit.database,
      durableWork: new PostgresRuntimeDurableWorkStore(unit.database),
      fence: new CloudRuntimeFence(),
      hub: new RunnerHub(),
      work,
    });
    // Exactly the production composition: the allocation-scoped fast pre-filter plus the durable
    // barrier.
    return makeStack({
      sessionWorkBarrier: (input) => owner.hasUnsettledSessionWork(input),
      sessionWorkBusy: (allocation) => work.isBusy(allocation),
    });
  }

  it("does not pin an IM-created replacement allocation through a stale Session-work registration", async () => {
    const accountId = await account();
    const work = new CloudSessionWorkTracker();
    const stack = sessionWorkStack(work);
    const ready = await readySandbox(stack, accountId, "room-replaced-session-work");
    await plantSessionWork(stack, ready, work);

    // The IM ingress path replaces the allocation; reconcile never runs for it.
    const replacement = await replaceAllocation(stack, ready, accountId);
    expect(work.isBusy(ready.scope)).toBe(true); // the stale generation's own picture stays on record
    expect(work.isBusy(replacement.scope)).toBe(false);

    // The sweep claims and reclaims the replacement: neither the stale in-memory registration nor
    // the stale durable record is a barrier for the new allocation, and no reconcile was invoked.
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("lets a same-account sibling borrow a replaced allocation despite a stale Session-work registration", async () => {
    const accountId = await account();
    const work = new CloudSessionWorkTracker();
    const stack = sessionWorkStack(work);
    const ready = await readySandbox(stack, accountId, "room-replaced-borrow-source");
    await plantSessionWork(stack, ready, work);
    const replacement = await replaceAllocation(stack, ready, accountId);
    const b = await ownedSandbox(accountId, "room-replaced-borrower");

    const createsBefore = stack.fake.createCalls.length;
    await stack.service.startForAccount(accountId, b.sandbox.sandboxId);

    // The borrow used the replacement's exact physical Instance: no new create happened, and the
    // stale Session-work registration never excluded the candidate from reuse selection.
    expect(stack.fake.createCalls.length).toBe(createsBefore);
    expect((await sandboxRow(ready.row.id)).lifecycle).toBe("unallocated");
    const rowB = await sandboxRow(b.sandbox.sandboxId);
    expect(rowB.currentResourceName).toBe(replacement.row.currentResourceName);
    expect(rowB.currentResourceUid).toBe(replacement.row.currentResourceUid);
  });

  it("clears a claimed binding that the provider confirms absent without a delete call", async () => {
    const accountId = await account();
    const stack = makeStack();
    const ready = await readySandbox(stack, accountId, "room-absent");
    // The Instance vanished between the claim and the seal: only a provider-confirmed absence may
    // clear the reference, and no delete request is issued for it.
    const instance = stack.fake.instances.get(ready.row.currentResourceName as string);
    if (instance) instance.gone = true;
    stack.advance(IDLE_TIMEOUT_MS + 1_000);
    await stack.service.reclaimIdleSandboxes();
    expect((await sandboxRow(ready.row.id)).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });
});

describe("E7 same-account physical reuse", () => {
  it.each(["persistence", "policy"] as const)(
    "skips incompatible %s before claiming or sealing a usable sibling",
    async (reason) => {
      const accountId = await account();
      const stack = makeStack();
      const a = await readySandbox(stack, accountId, "old-policy");
      const b = await ownedSandbox(accountId, "new-policy");
      const instance = stack.fake.instances.get(a.row.currentResourceName as string);
      if (!instance) throw new Error("Missing fixture Instance");
      if (reason === "persistence") instance.spec.workspacePersistence = false;
      else
        vi.spyOn(stack.fake, "verifyTrackedInstance").mockImplementation(() => {
          throw new Error("Deployment policy changed");
        });
      const seal = vi.spyOn(stack.hub, "requestWorkspaceSeal");
      await stack.service.startForAccount(accountId, b.sandbox.sandboxId);
      expect(seal).not.toHaveBeenCalled();
      expect(await sandboxRow(a.row.id)).toMatchObject({
        lifecycle: "ready",
        idleReclaimAt: null,
        currentResourceUid: a.row.currentResourceUid,
      });
      expect(await stack.service.ensureIngressAllocation(accountId, a.row.id)).toBe("ready");
      expect(stack.fake.deleteCalls).toHaveLength(0);
      expect(stack.fake.createCalls).toHaveLength(2);
    },
  );

  it("releases the sealed sibling immediately when a concurrent start already allocated the borrower", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "unused-seal");
    const b = await ownedSandbox(accountId, "concurrent-start");
    const seal = stack.hub.requestWorkspaceSeal.bind(stack.hub);
    vi.spyOn(stack.hub, "requestWorkspaceSeal").mockImplementationOnce(async (...args) => {
      const result = await seal(...args);
      // A is claimed, so this independent starter cold-allocates B while the borrow awaits seal.
      await stack.service.startForAccount(accountId, b.sandbox.sandboxId);
      return result;
    });
    await stack.service.startForAccount(accountId, b.sandbox.sandboxId);
    expect(await sandboxRow(a.row.id)).toMatchObject({ lifecycle: "unallocated", idleReclaimAt: null });
    expect(stack.store.stored(a.row.storageUri)).toMatchObject({ saved: true, sealed: true });
    expect((await sandboxRow(b.sandbox.sandboxId)).currentResourceName).not.toBe(a.row.currentResourceName);
    expect(stack.fake.deleteCalls).toHaveLength(1);
    expect(stack.fake.liveInstanceCount()).toBe(1);
  });

  it("never borrows an old-image sibling after a target upgrade; the borrower cold-allocates", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "room-old-image");
    // The target moved: the sibling's pinned image is now legacy, so it must never cross a
    // Session boundary even though it remains a valid reclaim candidate for its own Session.
    stack.fake.targetImage = UPGRADED_IMAGE;
    const b = await ownedSandbox(accountId, "room-old-image-borrower");
    const seal = vi.spyOn(stack.hub, "requestWorkspaceSeal");
    const createsBefore = stack.fake.createCalls.length;

    await stack.service.startForAccount(accountId, b.sandbox.sandboxId);

    // The legacy sibling was skipped BEFORE any claim or seal; the borrower cold-allocated the
    // current target instead, and the sibling keeps its binding for its own Session.
    expect(seal).not.toHaveBeenCalled();
    expect(stack.fake.createCalls.length).toBe(createsBefore + 1);
    expect(await sandboxRow(a.row.id)).toMatchObject({
      lifecycle: "ready",
      idleReclaimAt: null,
      currentResourceUid: a.row.currentResourceUid,
    });
    expect(stack.fake.deleteCalls).toHaveLength(0);
    expect(stack.fake.liveInstanceCount()).toBe(2);
    expect(await stack.service.ensureIngressAllocation(accountId, a.row.id)).toBe("ready");
  });

  it("borrows a same-account sibling at the Account ceiling while a brand-new reservation is rejected", async () => {
    const accountId = await account();
    const stack = makeStack({ capacity: { accountLimit: 1, platformLimit: 20 } });
    const a = await readySandbox(stack, accountId, "cap-room-a");
    const b = await ownedSandbox(accountId, "cap-room-b");
    const createsBefore = stack.fake.createCalls.length;

    // A occupies the single Account slot. The borrow moves the same physical Instance to B: no
    // new reservation is created, so admission never blocks a same-account reuse.
    await stack.service.startForAccount(accountId, b.sandbox.sandboxId);
    expect(stack.fake.createCalls.length).toBe(createsBefore);
    expect(await sandboxRow(b.sandbox.sandboxId)).toMatchObject({
      lifecycle: "preparing",
      currentResourceName: a.row.currentResourceName,
      currentResourceUid: a.row.currentResourceUid,
    });
    expect(await sandboxRow(a.row.id)).toMatchObject({ lifecycle: "unallocated", currentResourceName: null });

    // A brand-new physical reservation at the same ceiling is the only path admission rejects.
    const c = await ownedSandbox(accountId, "cap-room-c");
    await expect(stack.service.startForAccount(accountId, c.sandbox.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
      statusCode: 429,
    });
    expect(stack.fake.createCalls.length).toBe(createsBefore);
    expect(stack.fake.liveInstanceCount()).toBe(1);
  });

  it("transfers the exact physical UID and generation fencing to a same-account sibling with zero create", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "room-a");
    const b = await ownedSandbox(accountId, "room-b");
    const createsBefore = stack.fake.createCalls.length;

    await stack.service.startForAccount(accountId, b.sandbox.sandboxId);

    expect(stack.fake.createCalls.length).toBe(createsBefore);
    const rowB = await sandboxRow(b.sandbox.sandboxId);
    const rowA = await sandboxRow(a.row.id);
    expect(rowB).toMatchObject({
      lifecycle: "preparing",
      // Generation counters are per Sandbox row: the borrower starts its own next generation, and
      // the transferred physical name stays opaque.
      environmentGeneration: 1,
      currentResourceName: a.row.currentResourceName,
      currentResourceUid: a.row.currentResourceUid,
      idleReclaimAt: null,
    });
    expect(rowA).toMatchObject({
      lifecycle: "unallocated",
      currentResourceName: null,
      currentResourceUid: null,
      idleReclaimAt: null,
    });
    // Stable per-Session storage: the borrower never inherits the origin's storage address, and
    // the origin keeps its own archive for a later cold restore.
    expect(rowA.storageUri).toBe(a.row.storageUri);
    expect(rowB.storageUri).not.toBe(a.row.storageUri);
    expect(stack.hub.describe(a.row.id).connected).toBe(false);
  });

  it("never borrows across accounts, and never borrows from a non-reuse-capable Runner", async () => {
    const owner = await account();
    const stranger = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, owner, "room-cross");
    const foreign = await ownedSandbox(stranger, "room-cross-b");
    await stack.service.startForAccount(stranger, foreign.sandbox.sandboxId);
    expect((await sandboxRow(foreign.sandbox.sandboxId)).currentResourceName).not.toBe(a.row.currentResourceName);
    expect((await sandboxRow(a.row.id)).lifecycle).toBe("ready");

    const legacy = await readySandbox(stack, owner, "room-legacy", { reuseCapable: false });
    const claimant = await ownedSandbox(owner, "room-legacy-b");
    const createsBefore = stack.fake.createCalls.length;
    await stack.service.startForAccount(owner, claimant.sandbox.sandboxId);
    expect(stack.fake.createCalls.length).toBe(createsBefore + 1);
    expect((await sandboxRow(legacy.row.id)).lifecycle).toBe("ready");
  });

  it("an explicit stop clears the automatic claim before a later transfer attempt (sequential, not a race)", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "room-stop");
    const b = await ownedSandbox(accountId, "room-stop-b");

    await stack.service.stopForAccount(accountId, a.row.id);
    const stopped = await sandboxRow(a.row.id);
    expect(stopped).toMatchObject({ lifecycle: "unallocated", idleReclaimAt: null });
    expect(stack.fake.liveInstanceCount()).toBe(0);

    const createsBefore = stack.fake.createCalls.length;
    await stack.service.startForAccount(accountId, b.sandbox.sandboxId);
    expect(stack.fake.createCalls.length).toBe(createsBefore + 1);
  });

  it("an automatic claim blocks execution authority while keeping the report/seal channel alive", async () => {
    const accountId = await account();
    const stack = makeStack();
    const a = await readySandbox(stack, accountId, "room-claimed");
    await unit.database.update(sandboxes).set({ idleReclaimAt: stack.now() }).where(eq(sandboxes.id, a.row.id));

    expect(await stack.service.validateRunnerScope(a.scope)).toBeUndefined();
    expect(await stack.service.validateRunnerChannelScope(a.scope)).toMatchObject({ sandboxId: a.row.id });
    expect(await stack.service.ensureIngressAllocation(accountId, a.row.id)).toBe("pending");
    expect(await stack.service.startForAccount(accountId, a.row.id)).toMatchObject({ lifecycle: "ready" });
    await expect(stack.service.runAcceptanceForAccount(accountId, a.row.id, { mode: "offline" })).rejects.toMatchObject(
      { statusCode: 409 },
    );
  });
});
