import { randomUUID } from "node:crypto";
import { computeDirectInputHash, type RunnerServerFrame } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  users,
} from "../db/schema/index.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { dispatchClaimToken } from "../runtime/im-delivery-claim.js";
import { ImDeliveryWorker } from "../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { AgentService } from "../services/agents/index.js";
import { ComputerService } from "../services/computers/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../services/runtime-config/index.js";
import { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import { CloudModelGrantService } from "../services/sandboxes/cloud-model-grants.js";
import { CloudRuntimeFence, cloudInstanceIdFor } from "../services/sandboxes/cloud-runtime-fence.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../services/sandboxes/runner-hub.js";
import type { IngressAllocationOutcome } from "../services/sandboxes/sandbox-runner-service.js";
import { SandboxService } from "../services/sandboxes/sandbox-service.js";
import { SessionService } from "../services/sessions/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * E4 ImDeliveryWorker Cloud routing: a normalized IM delivery for a Cloud Computer Session is
 * claimed by the same worker and routed per-Sandbox through the Cloud dispatch owner — never the
 * Local runtime registry. Local routing behavior is covered by im-delivery-worker.test.ts.
 */

const cloudIdentities = { enabled: true as const, runnerVersion: "0.0.5", storageBase: "gs://unit-cloud/sandboxes" };
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};
const MODEL = "deepseek-v4.1-flash-expires-on-0910";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

async function cloudScope(options: { ready?: boolean } = {}) {
  const accountId = randomUUID();
  await unit.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "E4" });
  const cloud = await new ComputerService(unit.database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(unit.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e4-pi-${randomUUID().slice(0, 8)}`,
    displayName: "E4 Pi",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  await unit.database
    .update(agentRuntimeConfigs)
    .set({ instructions: "Agent instructions.", model: MODEL })
    .where(eq(agentRuntimeConfigs.agentId, agent.id));
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
    channelId: "unit-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  const resourceName = `projects/unit/locations/us-west1/instances/ots-s-${sandbox.sandboxId.slice(0, 8)}-1`;
  if (options.ready !== false) {
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "ready",
        environmentGeneration: 1,
        currentResourceName: resourceName,
        currentResourceUid: `unit-uid-${sandbox.sandboxId.slice(0, 8)}`,
      })
      .where(eq(sandboxes.id, sandbox.sandboxId));
  }
  const scope: RunnerScope = {
    sandboxId: sandbox.sandboxId,
    sessionId: sandbox.sessionId,
    environmentGeneration: 1,
    resourceName,
  };
  return { accountId, agent, bindingId, sandbox, scope, cloud };
}

/** A definitively disabled binding: credentials cleared, disabledAt stamped (schema checks). */
async function disableBinding(bindingId: string): Promise<void> {
  await unit.database
    .update(imBindings)
    .set({
      status: "disabled",
      disabledAt: new Date(),
      encryptedCredential: null,
      encryptedSetupContext: null,
      setupOwnerInstanceId: null,
      connectionOwnerInstanceId: null,
      connectionLeaseExpiresAt: null,
    })
    .where(eq(imBindings.id, bindingId));
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

const READINESS = {
  sandboxName: "ots-s-unit-1",
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: "0.0.5",
  reportedAt: new Date().toISOString(),
};

async function pendingDelivery(sessionId: string, expiresAt?: Date, occurredAt?: Date) {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const [binding] = await unit.database.select().from(imBindings).limit(1);
  if (!binding) throw new Error("fixture binding missing");
  const [placement] = await unit.database
    .select()
    .from(sessionPlacements)
    .where(eq(sessionPlacements.sessionId, sessionId))
    .limit(1);
  if (!placement) throw new Error("fixture placement missing");
  await unit.database.insert(imMessages).values({
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
    occurredAt: occurredAt ?? new Date(),
  });
  await unit.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    state: "pending",
    placementGeneration: placement.generation,
    expiresAt: expiresAt ?? new Date(Date.now() + 3_600_000),
  });
  return { deliveryId, messageId };
}

/** A second Cloud Session of the SAME Agent: another channel with its own Sandbox and Runner. */
async function addCloudSession(
  origin: Awaited<ReturnType<typeof cloudScope>>,
  options: { channelId?: string; ready?: boolean } = {},
) {
  const sandbox = await new SandboxService(unit.database, new SessionService(unit.database), {
    cloudIdentities,
  }).ensureForAccount(origin.accountId, {
    imBindingId: origin.bindingId,
    channelId: options.channelId ?? `unit-channel-${randomUUID().slice(0, 8)}`,
    conversationKind: "channel",
    kind: "channel",
  });
  const resourceName = `projects/unit/locations/us-west1/instances/ots-s-${sandbox.sandboxId.slice(0, 8)}-1`;
  if (options.ready !== false) {
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "ready",
        environmentGeneration: 1,
        currentResourceName: resourceName,
        currentResourceUid: `unit-uid-${sandbox.sandboxId.slice(0, 8)}`,
      })
      .where(eq(sandboxes.id, sandbox.sandboxId));
  }
  const scope: RunnerScope = {
    sandboxId: sandbox.sandboxId,
    sessionId: sandbox.sessionId,
    environmentGeneration: 1,
    resourceName,
  };
  return { sandbox, scope };
}

/**
 * A minimal Local Agent with two Sessions on its Local Computer. Only the claim and its Agent-wide
 * occupancy fence are exercised, so the fixture stops at the claim's inputs (no runtime config).
 */
async function localScope() {
  const accountId = randomUUID();
  await unit.database
    .insert(users)
    .values({ id: accountId, email: `${accountId}@example.test`, displayName: "E6 Local" });
  const computerId = randomUUID();
  const instanceId = randomUUID();
  await unit.database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: "local",
    currentInstallationId: randomUUID(),
    currentInstanceId: instanceId,
    displayName: "Local",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
  });
  const agentId = randomUUID();
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: `e6-local-${agentId}`,
    displayName: "E6 Local",
    runtimeProvider: "pi",
  });
  const bindingId = randomUUID();
  await unit.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `unit-app-${randomUUID().slice(0, 8)}`,
    externalBotId: "unit-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: new Date(),
  });
  const firstSessionId = randomUUID();
  const secondSessionId = randomUUID();
  for (const sessionId of [firstSessionId, secondSessionId]) {
    await unit.database.insert(sessions).values({
      id: sessionId,
      imBindingId: bindingId,
      channelId: `unit-channel-${sessionId.slice(0, 8)}`,
      conversationKind: "channel",
      kind: "channel",
    });
    await unit.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  }
  const registry = new ConnectionRegistry();
  await registry.register(
    {
      computerId,
      installationId: randomUUID(),
      instanceId,
      lastHeartbeatAt: Date.now(),
      socket: { close: vi.fn(), terminate: vi.fn() } as never,
    },
    async () => undefined,
  );
  return { accountId, agentId, bindingId, computerId, instanceId, firstSessionId, secondSessionId, registry };
}

function makeStack(options: { withModel?: boolean } = {}) {
  const hub = new RunnerHub();
  const fence = new CloudRuntimeFence();
  const custody = new PostgresRuntimeCustodyStore(unit.database);
  const grants = new CloudModelGrantService("unit-test-jwt-secret-at-least-32-characters", {
    allowedModels: [MODEL],
    maxStreamsPerToken: 2,
    ttlSeconds: 600,
  });
  const owner = new CloudDeliveryOwner({
    custody,
    database: unit.database,
    fence,
    hub,
    ...(options.withModel === false ? {} : { modelBaseUrl: "https://server.example.com/api/v1/cloud-model" }),
    ...(options.withModel === false ? {} : { modelGrants: grants }),
  });
  return { hub, fence, custody, owner, grants };
}

interface AllocationCallLog {
  ensured: { accountId: string; imBindingId: string; kind: string }[];
  allocated: { accountId: string; sandboxId: string }[];
  outcome: IngressAllocationOutcome;
}

function makeWorker(
  owner?: CloudDeliveryOwner,
  allocation?: AllocationCallLog,
  options: { now?: () => Date; beforeDeliveryAdmission?: (signal: AbortSignal) => Promise<void> } = {},
) {
  return new ImDeliveryWorker({
    assembler: new EffectiveRuntimeSnapshotAssembler(unit.database),
    database: unit.database,
    domain: {} as never,
    registry: new ConnectionRegistry(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.beforeDeliveryAdmission ? { beforeDeliveryAdmission: options.beforeDeliveryAdmission } : {}),
    ...(owner ? { cloudDelivery: owner } : {}),
    ...(allocation
      ? {
          cloudAllocation: {
            ensureSandbox: async (input) => {
              allocation.ensured.push({
                accountId: input.accountId,
                imBindingId: input.imBindingId,
                kind: input.kind,
              });
              throw new Error("fixture allocation port does not create a Sandbox row");
            },
            ensureEnvironmentAllocated: async (input) => {
              allocation.allocated.push(input);
              return allocation.outcome;
            },
          },
        }
      : {}),
    intervalMs: 60_000,
  });
}

describe("ImDeliveryWorker Cloud routing", () => {
  it("routes a Cloud Session delivery through the per-Sandbox owner, never the Local registry", async () => {
    const { scope, cloud } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope });
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(stack.owner);
    await worker.runOnce();
    const runs = sent.filter((frame) => frame.type === "delivery:run");
    expect(runs).toHaveLength(1);
    const run = runs[0] as Extract<RunnerServerFrame, { type: "delivery:run" }>;
    expect(run.delivery.deliveryId).toBe(deliveryId);
    expect(run.delivery.runtime.model).toBe(MODEL);
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    if (!row) throw new Error("delivery row missing");
    expect(row.state).toBe("pending");
    expect(row.dispatchRequestId).toBe(run.requestId);
    // The Local registry was never consulted for an instance: no computer online state changed.
    const [computer] = await unit.database.select().from(computers).where(eq(computers.id, cloud.computerId));
    if (!computer) throw new Error("computer row missing");
    expect(computer.currentInstanceId).toBeNull();
  });

  it("keeps a Cloud delivery pending (transient) when the environment is not ready", async () => {
    const { scope } = await cloudScope({ ready: false });
    const stack = makeStack();
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(stack.owner);
    await worker.runOnce();
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    if (!row) throw new Error("delivery row missing");
    expect(row.state).toBe("pending");
    expect(row.lastErrorCode).toBe("IM_DELIVERY_CLOUD_ENVIRONMENT_NOT_READY");
    expect(row.dispatchRequestId).toBeNull();
  });

  it("keeps a Cloud delivery pending (transient) when the Cloud dispatch owner is not configured", async () => {
    const { scope } = await cloudScope();
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(undefined);
    await worker.runOnce();
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    if (!row) throw new Error("delivery row missing");
    expect(row.state).toBe("pending");
    expect(row.lastErrorCode).toBe("IM_DELIVERY_CLOUD_UNAVAILABLE");
  });

  it("claims a Cloud pending delivery inside its ingress deadline and freezes a fresh runtime-budget window", async () => {
    const { scope, cloud, agent } = await cloudScope();
    await unit.database
      .update(agentRuntimeConfigs)
      .set({ maxDurationMs: 120_000 })
      .where(eq(agentRuntimeConfigs.agentId, agent.id));
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    // Inside the bounded ingress deadline the Cloud row is claimable, and the frozen execution
    // window is the runtime budget for THIS attempt — not the ingress TTL.
    const { deliveryId } = await pendingDelivery(scope.sessionId, new Date(Date.now() + 6 * 60 * 60 * 1_000));
    const worker = makeWorker(stack.owner);
    await worker.runOnce();
    const runs = sent.filter((frame) => frame.type === "delivery:run");
    expect(runs).toHaveLength(1);
    const run = runs[0] as Extract<RunnerServerFrame, { type: "delivery:run" }>;
    expect(run.delivery.deliveryId).toBe(deliveryId);
    // The execution window is the runtime budget for THIS attempt, not the old IM TTL and not a
    // faked future date.
    const windowMs = Date.parse(run.delivery.deadlineAt as string) - Date.now();
    expect(windowMs).toBeGreaterThan(100_000);
    expect(windowMs).toBeLessThanOrEqual(120_000);
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    expect(row?.state).toBe("pending");
    expect(row?.dispatchRequestId).toBe(run.requestId);
    expect(row?.dispatchInputHash).toBe(computeDirectInputHash(run.delivery));
  });

  it("resolves a missing runtime model to the deployment default before the payload hash is frozen", async () => {
    const { scope, cloud, agent } = await cloudScope();
    await unit.database
      .update(agentRuntimeConfigs)
      .set({ model: null })
      .where(eq(agentRuntimeConfigs.agentId, agent.id));
    // No injected default: the real CloudModelGrantService.defaultModel getter supplies it.
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(stack.owner);
    await worker.runOnce();
    const run = sent.filter((frame) => frame.type === "delivery:run")[0] as Extract<
      RunnerServerFrame,
      { type: "delivery:run" }
    >;
    expect(run.delivery.deliveryId).toBe(deliveryId);
    expect(run.delivery.runtime.model).toBe(MODEL);
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    expect(row?.dispatchInputHash).toBe(computeDirectInputHash(run.delivery));
    expect(row?.dispatchPayload).toMatchObject({ runtime: { model: MODEL } });
  });

  it("requests allocation through the injected port and never provisions anything when the model path is off", async () => {
    const { scope, cloud, accountId } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    const allocation: AllocationCallLog = { ensured: [], allocated: [], outcome: "ready" };
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(stack.owner, allocation);
    await worker.runOnce();
    expect(allocation.ensured).toHaveLength(0);
    expect(allocation.allocated).toEqual([{ accountId, sandboxId: scope.sandboxId }]);
    expect(sent.some((frame) => frame.type === "delivery:run")).toBe(true);

    // A model-disabled owner provisions nothing: no allocation call, no dispatch frame.
    const disabledScope = await cloudScope();
    const disabledStack = makeStack({ withModel: false });
    const disabledSent: RunnerServerFrame[] = [];
    const disabledSocket = fakeSocket(disabledSent);
    disabledStack.hub.attach(disabledScope.scope, disabledSocket);
    disabledStack.hub.markReady(disabledScope.scope, READINESS, disabledSocket);
    disabledStack.fence.attach({
      computerId: disabledScope.cloud.computerId,
      installationId: randomUUID(),
      scope: disabledScope.scope,
      socket: disabledSocket,
    });
    const disabledAllocation: AllocationCallLog = { ensured: [], allocated: [], outcome: "ready" };
    const disabledDelivery = await pendingDelivery(disabledScope.scope.sessionId);
    const disabledWorker = makeWorker(disabledStack.owner, disabledAllocation);
    await disabledWorker.runOnce();
    expect(disabledAllocation.ensured).toHaveLength(0);
    expect(disabledAllocation.allocated).toHaveLength(0);
    expect(disabledSent.some((frame) => frame.type === "delivery:run")).toBe(false);
    const [disabledRow] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, disabledDelivery.deliveryId));
    expect(disabledRow?.lastErrorCode).toBe("IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE");
    expect(disabledRow?.state).toBe("pending");
    expect(disabledRow?.dispatchRequestId).toBeNull();
    expect(deliveryId).toBeTypeOf("string");
  });

  it("does not claim an undispatched Cloud delivery past its ingress deadline", async () => {
    const { scope, cloud } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    // The bounded ingress deadline passed before this input ever reached a Runner: the janitor
    // owns it (expired/ttl) and the worker must not dispatch it.
    const { deliveryId } = await pendingDelivery(scope.sessionId, new Date(Date.now() - 60_000));
    const worker = makeWorker(stack.owner);
    await worker.runOnce();
    expect(sent.some((frame) => frame.type === "delivery:run")).toBe(false);
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    expect(row).toMatchObject({ state: "pending", dispatchRequestId: null });
  });

  it("blocks destructive re-allocation before E5 and reports the restore requirement", async () => {
    const { scope, cloud } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    const allocation: AllocationCallLog = { ensured: [], allocated: [], outcome: "restore_required" };
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(stack.owner, allocation);
    await worker.runOnce();
    expect(allocation.allocated).toHaveLength(1);
    expect(sent.some((frame) => frame.type === "delivery:run")).toBe(false);
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    // A permanent E5 guard is an explicit terminal failure, not a 2 s retry loop.
    expect(row).toMatchObject({ state: "terminal_rejected", reason: "restore_required", dispatchRequestId: null });
    // A later claim cannot re-provision the same message.
    await worker.runOnce();
    expect(allocation.allocated).toHaveLength(1);
    expect(sent.some((frame) => frame.type === "delivery:run")).toBe(false);
  });

  it("terminally rejects a Cloud delivery when its environment was stopped", async () => {
    const { scope, cloud } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    const allocation: AllocationCallLog = { ensured: [], allocated: [], outcome: "stopped" };
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(stack.owner, allocation);
    await worker.runOnce();
    expect(allocation.allocated).toHaveLength(1);
    expect(sent.some((frame) => frame.type === "delivery:run")).toBe(false);
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    expect(row).toMatchObject({ state: "terminal_rejected", reason: "environment_stopped", dispatchRequestId: null });
    await worker.runOnce();
    expect(allocation.allocated).toHaveLength(1);
  });

  it("releases a persisted dispatch whose frozen execution window passed instead of faking it forward", async () => {
    const { scope, cloud } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(stack.owner);
    await worker.runOnce();
    const firstRun = sent.filter((frame) => frame.type === "delivery:run")[0] as Extract<
      RunnerServerFrame,
      { type: "delivery:run" }
    >;
    expect(firstRun).toBeDefined();
    // Rewind the frozen window: a pending row never held execution permission, so the next claim
    // releases the stale dispatch instead of re-sending an unusable window.
    const expiredPayload = { ...firstRun.delivery, deadlineAt: new Date(Date.now() - 60_000).toISOString() };
    await unit.database
      .update(imMessageDeliveries)
      .set({
        dispatchPayload: expiredPayload,
        dispatchInputHash: computeDirectInputHash(expiredPayload),
        nextAttemptAt: new Date(Date.now() - 1_000),
      })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await worker.runOnce();
    const [released] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect(released?.dispatchRequestId).toBeNull();
    expect(released?.dispatchPayload).toBeNull();
    expect(released?.lastErrorCode).toBe("IM_DELIVERY_CLOUD_DISPATCH_EXPIRED");
    // The next claim freezes a fresh window rather than replaying the expired one.
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await worker.runOnce();
    const runs = sent.filter((frame) => frame.type === "delivery:run");
    expect(runs).toHaveLength(2);
    expect((runs[1] as Extract<RunnerServerFrame, { type: "delivery:run" }>).requestId).not.toBe(firstRun.requestId);
  });

  it("rejects pending stopped inputs and preserves accepted work for reconciliation after a Session end", async () => {
    const { scope, cloud, agent } = await cloudScope();
    const stack = makeStack();
    const worker = makeWorker(stack.owner);
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, scope.sessionId));

    // An input that can never execute under the ended-Session claim guard is terminally rejected
    // with an explicit reason instead of staying invisibly pending forever.
    const stopped = await pendingDelivery(scope.sessionId);
    // An accepted-unreported turn keeps its genuine outcome opportunity: recovery waits for the
    // allocation's replayed report instead of writing terminal unknown.
    const acceptedMessageId = randomUUID();
    const acceptedDeliveryId = randomUUID();
    const [binding] = await unit.database.select().from(imBindings).limit(1);
    await unit.database.insert(imMessages).values({
      id: acceptedMessageId,
      imBindingId: binding?.id as string,
      channelId: "unit-channel",
      externalMessageId: `ext-${acceptedMessageId.slice(0, 8)}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "unit-user",
      content: { version: 1, fallbackText: "accepted", blocks: [], truncated: false },
      providerContext: { provider: "feishu" },
      occurredAt: new Date(),
    });
    await unit.database.insert(imMessageDeliveries).values({
      id: acceptedDeliveryId,
      messageId: acceptedMessageId,
      sessionId: scope.sessionId,
      attention: "direct",
      state: "accepted",
      inputHash: "accepted-input-hash",
      turnId: "accepted-turn",
      reportOwnerInstanceId: cloudInstanceIdFor(scope),
      placementGeneration: 1,
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() - 60_000),
      nextAttemptAt: new Date(Date.now() - 1_000),
    });

    await worker.runJanitorOnce();

    const [rejectedRow] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, stopped.deliveryId));
    expect(rejectedRow).toMatchObject({ state: "terminal_rejected", reason: "session_ended" });
    const [preservedRow] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, acceptedDeliveryId));
    expect(preservedRow?.state).toBe("accepted");
    expect(preservedRow?.reportedAt).toBeNull();
    expect(preservedRow?.turnReport).toBeNull();
    // The reconciliation cadence is bounded rather than a hot loop.
    expect(preservedRow?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(agent.id).toBeTypeOf("string");
    expect(cloud.computerId).toBeTypeOf("string");
  });

  it("reconciles a started accepted turn whose binding stopped even without an ended Session", async () => {
    const { scope, cloud, bindingId } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    const worker = makeWorker(stack.owner);
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    await worker.runOnce();
    const run = sent.filter((frame) => frame.type === "delivery:run")[0] as Extract<
      RunnerServerFrame,
      { type: "delivery:run" }
    >;
    const connection = stack.fence.connectionForSandbox(scope.sandboxId);
    if (!connection) throw new Error("no live Cloud connection");
    const turnId = randomUUID();
    await stack.owner.handleDeliveryReceived(connection, { deliveryId, requestId: run.requestId, turnId });

    // The binding is permanently disabled while the turn runs: the normal claim path excludes this
    // row, so the bounded stopped-authority pass must still reach it and resend the missed cancel.
    await disableBinding(bindingId);
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => stack.owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "started" }));
      }
    };
    // The claim lease left nextAttemptAt in the future; this pass must be due now.
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await worker.runJanitorOnce();

    expect(sent.some((frame) => frame.type === "delivery:cancel")).toBe(true);
    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    expect(row).toMatchObject({ state: "accepted", reportedAt: null, turnReport: null });
  });

  it("backs off a persisted Cloud dispatch after the model path is disabled, keeping the frozen window", async () => {
    const { scope, cloud } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    let clockMs = Date.now();
    const worker = makeWorker(stack.owner, undefined, { now: () => new Date(clockMs) });
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(clockMs - 1) })
      .where(eq(imMessageDeliveries.id, deliveryId));

    // First claim dispatches and freezes the execution window on the row.
    await worker.runOnce();
    expect(sent.some((frame) => frame.type === "delivery:run")).toBe(true);
    const [dispatched] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    if (!dispatched?.dispatchRequestId || !dispatched.dispatchPayload) {
      throw new Error("dispatch window was not persisted");
    }

    // The model path is disabled after dispatch: the persisted attempt must back off instead of
    // retrying every 2 s, while retaining the frozen dispatch identity and payload.
    vi.spyOn(stack.owner, "isModelPathConfigured").mockReturnValue(false);
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(clockMs - 1) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await worker.runOnce();
    const [firstRetry] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect(firstRetry).toMatchObject({
      state: "pending",
      lastErrorCode: "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE",
      dispatchRequestId: dispatched.dispatchRequestId,
    });
    expect(firstRetry?.dispatchPayload).toEqual(dispatched.dispatchPayload);
    const firstDelay = (firstRetry?.nextAttemptAt.getTime() ?? 0) - clockMs;
    expect(firstDelay).toBeGreaterThan(2_000);

    clockMs = firstRetry?.nextAttemptAt.getTime() ?? clockMs;
    await worker.runOnce();
    const [secondRetry] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect((secondRetry?.nextAttemptAt.getTime() ?? 0) - clockMs).toBe(firstDelay * 2);
    expect(secondRetry).toMatchObject({ dispatchRequestId: dispatched.dispatchRequestId });
  });

  it("backs off the model-unavailable dispatch path with the same attempt counter", async () => {
    const { scope } = await cloudScope();
    const stack = makeStack({ withModel: false });
    const clockMs = Date.now();
    const worker = makeWorker(stack.owner, undefined, { now: () => new Date(clockMs) });
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(clockMs - 1) })
      .where(eq(imMessageDeliveries.id, deliveryId));

    await worker.runOnce();

    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    expect(row).toMatchObject({
      state: "pending",
      lastErrorCode: "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE",
    });
    expect((row?.nextAttemptAt.getTime() ?? 0) - clockMs).toBe(2_000);
  });

  it("backs off transient Cloud dispatch failures with the attempt count and caps the delay", async () => {
    const { scope } = await cloudScope();
    const stack = makeStack();
    // No ready Runner is attached: every claim fails with runner_not_ready.
    let clockMs = Date.now();
    const worker = makeWorker(stack.owner, undefined, { now: () => new Date(clockMs) });
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(clockMs - 1) })
      .where(eq(imMessageDeliveries.id, deliveryId));

    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await worker.runOnce();
      const [row] = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId));
      expect(row?.lastErrorCode).toBe("IM_DELIVERY_CLOUD_ENVIRONMENT_NOT_READY");
      if (!row) throw new Error("delivery row missing");
      // Deterministic clock: the next retry is exactly the capped backoff for this attempt.
      delays.push(row.nextAttemptAt.getTime() - clockMs);
      clockMs = row.nextAttemptAt.getTime();
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("pauses a pending Cloud input under reauthorization and delivers it after restoration", async () => {
    const { scope, cloud, bindingId } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope });
    const worker = makeWorker(stack.owner);
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, bindingId));

    await worker.runJanitorOnce();

    // Transient reauthorization preserves the queued input: no terminal rejection, no dispatch.
    const [paused] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect(paused).toMatchObject({ state: "pending", reason: null, dispatchRequestId: null });
    expect(sent.filter((frame) => frame.type === "delivery:run")).toHaveLength(0);

    // The user restores authorization: the queued input becomes deliverable again.
    await unit.database.update(imBindings).set({ status: "active" }).where(eq(imBindings.id, bindingId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await worker.runOnce();

    const runs = sent.filter((frame) => frame.type === "delivery:run");
    expect(runs).toHaveLength(1);
    expect((runs[0] as Extract<RunnerServerFrame, { type: "delivery:run" }>).delivery.deliveryId).toBe(deliveryId);
  });

  it("keeps an accepted Cloud turn paused under reauthorization and cancels it only on a definitive stop", async () => {
    const { scope, cloud, bindingId } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    const worker = makeWorker(stack.owner);
    const { deliveryId } = await pendingDelivery(scope.sessionId);
    await worker.runOnce();
    const run = sent.filter((frame) => frame.type === "delivery:run")[0] as Extract<
      RunnerServerFrame,
      { type: "delivery:run" }
    >;
    const connection = stack.fence.connectionForSandbox(scope.sandboxId);
    if (!connection) throw new Error("no live Cloud connection");
    const turnId = randomUUID();
    await stack.owner.handleDeliveryReceived(connection, { deliveryId, requestId: run.requestId, turnId });

    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, bindingId));
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() =>
          stack.owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "received" }),
        );
      }
    };
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));

    await worker.runJanitorOnce();

    // Transient reauthorization preserves the accepted received evidence: no cancel, no fake loss.
    expect(sent.some((frame) => frame.type === "delivery:cancel")).toBe(false);
    const [pausedRow] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    expect(pausedRow).toMatchObject({ state: "accepted", reportedAt: null, turnReport: null });

    // Restoration to active re-verifies the still-received turn with a fresh grant: the normal
    // claim/recovery path owns active chains, not the stopped-authority reconcile pass.
    await unit.database.update(imBindings).set({ status: "active" }).where(eq(imBindings.id, bindingId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    const verifiedBefore = sent.filter(
      (frame) => frame.type === "delivery:verified" && frame.status === "verified",
    ).length;
    await worker.runOnce();
    expect(sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified").length).toBe(
      verifiedBefore + 1,
    );

    // A definitive stop then cancels the still-unreported turn truthfully.
    await disableBinding(bindingId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await worker.runJanitorOnce();
    expect(sent.some((frame) => frame.type === "delivery:cancel")).toBe(true);
  });

  it("terminally rejects a pending Cloud input whose authority stopped", async () => {
    const { scope, agent, bindingId } = await cloudScope();
    await disableBinding(bindingId);
    const stack = makeStack();
    const worker = makeWorker(stack.owner);
    const { deliveryId } = await pendingDelivery(scope.sessionId);

    await worker.runJanitorOnce();

    const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
    expect(row).toMatchObject({
      state: "terminal_rejected",
      reason: "authority_stopped",
      dispatchRequestId: null,
    });
    expect(agent.id).toBeDefined();
  });

  it("does not dispatch a second Cloud delivery while the first is accepted-unreported (Session serial)", async () => {
    const { scope, cloud } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope });
    const first = await pendingDelivery(scope.sessionId);
    const worker = makeWorker(stack.owner);
    await worker.runOnce();
    const run = sent.filter((frame) => frame.type === "delivery:run")[0] as Extract<
      RunnerServerFrame,
      { type: "delivery:run" }
    >;
    const connection = stack.fence.connectionForSandbox(scope.sandboxId);
    if (!connection) throw new Error("no live Cloud connection");
    await stack.owner.handleDeliveryReceived(connection, {
      deliveryId: first.deliveryId,
      requestId: run.requestId,
      turnId: randomUUID(),
    });
    // A second message arrives while the first is executing: it must not dispatch.
    const second = await pendingDelivery(scope.sessionId);
    await worker.runOnce();
    const runs = sent.filter((frame) => frame.type === "delivery:run");
    expect(runs).toHaveLength(1);
    const [secondRow] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, second.deliveryId));
    if (!secondRow) throw new Error("delivery row missing");
    expect(secondRow.state).toBe("pending");
    expect(secondRow.dispatchRequestId).toBeNull();
  });
});

/**
 * E6 Session occupancy. Different Cloud Sessions of one Agent execute concurrently, the same Cloud
 * Session keeps exactly one custody owner and its input order, and Local keeps its Agent-wide
 * exclusion. The PostgreSQL race behavior is exercised by the integration suite; these cases are
 * deterministic and coordinate with gates instead of sleeps.
 */
describe("ImDeliveryWorker Cloud Session occupancy", () => {
  it("executes different Cloud Sessions of one Agent concurrently", async () => {
    const first = await cloudScope();
    const second = await addCloudSession(first);
    const stack = makeStack();
    const firstSent: RunnerServerFrame[] = [];
    const secondSent: RunnerServerFrame[] = [];
    const firstSocket = fakeSocket(firstSent);
    const secondSocket = fakeSocket(secondSent);
    stack.hub.attach(first.scope, firstSocket);
    stack.hub.markReady(first.scope, READINESS, firstSocket);
    stack.fence.attach({
      computerId: first.cloud.computerId,
      installationId: randomUUID(),
      scope: first.scope,
      socket: firstSocket,
    });
    stack.hub.attach(second.scope, secondSocket);
    stack.hub.markReady(second.scope, READINESS, secondSocket);
    stack.fence.attach({
      computerId: first.cloud.computerId,
      installationId: randomUUID(),
      scope: second.scope,
      socket: secondSocket,
    });
    const firstDelivery = await pendingDelivery(first.scope.sessionId);
    const secondDelivery = await pendingDelivery(second.scope.sessionId);

    // The first delivery parks inside its admission boundary; the second may only reach its own
    // boundary while the first is still there. That is exactly the E6 concurrency proof: with an
    // Agent-keyed lane the second run could not start until the first finished.
    let firstAdmissionReached: () => void = () => undefined;
    const firstAdmission = new Promise<void>((resolve) => {
      firstAdmissionReached = resolve;
    });
    let secondAdmissionReached: () => void = () => undefined;
    const secondAdmission = new Promise<void>((resolve) => {
      secondAdmissionReached = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: () => void = () => undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let releaseFallback: () => void = () => undefined;
    const fallback = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    const fallbackTimer = setTimeout(releaseFallback, 3_000);
    fallbackTimer.unref?.();
    let admissions = 0;
    let firstExited = false;
    const worker = makeWorker(stack.owner, undefined, {
      beforeDeliveryAdmission: async () => {
        admissions += 1;
        if (admissions === 1) {
          firstAdmissionReached();
          await Promise.race([firstGate, fallback]);
          firstExited = true;
          return;
        }
        secondAdmissionReached();
        await Promise.race([secondGate, fallback]);
      },
    });

    const firstRun = worker.runOnce();
    await firstAdmission;
    const secondRun = worker.runOnce();
    await secondAdmission;
    // Both lanes are live at the same time: the first has not left its boundary yet.
    expect(firstExited).toBe(false);
    expect(admissions).toBe(2);

    // Release sequentially so the assertions do not depend on driver-level query interleaving.
    releaseFirst();
    await firstRun;
    releaseSecond();
    await secondRun;
    clearTimeout(fallbackTimer);

    const firstRuns = firstSent.filter((frame) => frame.type === "delivery:run");
    const secondRuns = secondSent.filter((frame) => frame.type === "delivery:run");
    expect(firstRuns.map((frame) => frame.delivery.deliveryId)).toEqual([firstDelivery.deliveryId]);
    expect(secondRuns.map((frame) => frame.delivery.deliveryId)).toEqual([secondDelivery.deliveryId]);
    for (const [deliveryId, run] of [
      [firstDelivery.deliveryId, firstRuns[0]],
      [secondDelivery.deliveryId, secondRuns[0]],
    ] as const) {
      const [row] = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId));
      expect(row?.dispatchRequestId).toBe(run?.requestId);
    }
  });

  it("fences a Cloud Session input behind another Worker's in-flight claim of a newer input", async () => {
    const { scope, cloud } = await cloudScope();
    const stack = makeStack();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(scope, socket);
    stack.hub.markReady(scope, READINESS, socket);
    stack.fence.attach({ computerId: cloud.computerId, installationId: randomUUID(), scope, socket });
    // The candidate is the OLDER message, so only the custody claim (not ingress order) can fence
    // it: another Worker claimed the newer input first and its lease is the durable trace.
    const candidate = await pendingDelivery(scope.sessionId, undefined, new Date(Date.now() - 10_000));
    const inFlight = await pendingDelivery(scope.sessionId, undefined, new Date());
    await unit.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: dispatchClaimToken(), nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(imMessageDeliveries.id, inFlight.deliveryId));

    const worker = makeWorker(stack.owner);
    await worker.runOnce();

    expect(sent.filter((frame) => frame.type === "delivery:run")).toHaveLength(0);
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, candidate.deliveryId));
    expect(row).toMatchObject({ state: "pending", dispatchRequestId: null, lastErrorCode: null });
  });

  it("does not let a same-Session follow-up overtake an earlier input in retry backoff", async () => {
    const session = await cloudScope();
    const otherSession = await addCloudSession(session);
    const stack = makeStack();
    // Only the unrelated Session has a Runner: the earlier input of the first Session fails its
    // dispatch transiently and backs off, then the follow-up becomes due before the retry.
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    stack.hub.attach(otherSession.scope, socket);
    stack.hub.markReady(otherSession.scope, READINESS, socket);
    stack.fence.attach({
      computerId: session.cloud.computerId,
      installationId: randomUUID(),
      scope: otherSession.scope,
      socket,
    });
    const earlier = await pendingDelivery(session.scope.sessionId, undefined, new Date(Date.now() - 20_000));
    const followUp = await pendingDelivery(session.scope.sessionId, undefined, new Date(Date.now() - 10_000));
    const otherDelivery = await pendingDelivery(otherSession.scope.sessionId);
    const now = Date.now();
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(now - 3_000) })
      .where(eq(imMessageDeliveries.id, earlier.deliveryId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(now - 2_000) })
      .where(eq(imMessageDeliveries.id, followUp.deliveryId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(now - 1_000) })
      .where(eq(imMessageDeliveries.id, otherDelivery.deliveryId));

    const worker = makeWorker(stack.owner);
    // First tick claims the earlier input, which fails transiently and backs off.
    await worker.runOnce();

    // The earlier input is now in transient backoff...
    const [backingOff] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, earlier.deliveryId));
    expect(backingOff).toMatchObject({
      state: "pending",
      dispatchRequestId: null,
      lastErrorCode: "IM_DELIVERY_CLOUD_ENVIRONMENT_NOT_READY",
    });
    expect(backingOff?.nextAttemptAt.getTime()).toBeGreaterThan(now);

    // Second tick: the follow-up is due, but it must wait behind the backed-off earlier input,
    // while the other Session is free to proceed.
    await worker.runOnce();

    const [deferred] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, followUp.deliveryId));
    expect(deferred).toMatchObject({ state: "pending", dispatchRequestId: null, lastErrorCode: null });
    const runs = sent.filter((frame) => frame.type === "delivery:run");
    expect(runs.map((frame) => frame.delivery.deliveryId)).toEqual([otherDelivery.deliveryId]);
    const [otherRow] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, otherDelivery.deliveryId));
    expect(otherRow?.dispatchRequestId).toBe(
      (runs[0] as Extract<RunnerServerFrame, { type: "delivery:run" }>).requestId,
    );
  });

  it("keeps the Agent-wide custody fence for Local deliveries across Sessions", async () => {
    const scope = await localScope();
    const occupant = await pendingDelivery(scope.firstSessionId);
    const candidate = await pendingDelivery(scope.secondSessionId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: dispatchClaimToken(), nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(imMessageDeliveries.id, occupant.deliveryId));

    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: {} as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue({} as never) },
      registry: scope.registry,
    });
    await worker.runOnce();

    // A Local Turn owns the whole Agent: the other Local Session may not start.
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, candidate.deliveryId));
    expect(row).toMatchObject({ state: "pending", dispatchRequestId: null, lastErrorCode: null });
  });

  it("claims a later Local delivery while an earlier Local input backs off (Local order unchanged)", async () => {
    const scope = await localScope();
    const earlier = await pendingDelivery(scope.firstSessionId, undefined, new Date(Date.now() - 20_000));
    const later = await pendingDelivery(scope.secondSessionId);
    await unit.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: "IM_DELIVERY_RUNTIME_UNAVAILABLE", nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(imMessageDeliveries.id, earlier.deliveryId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, later.deliveryId));

    const requestDelivery = vi.fn(async (_computerId, _instanceId, request, onDispatched) => {
      onDispatched?.();
      return {
        type: "im:deliver:result" as const,
        requestId: request.requestId,
        deliveryId: request.deliveryId,
        sessionId: request.sessionId,
        placementGeneration: request.placementGeneration,
        status: "accepted" as const,
        turnId: `turn-${request.deliveryId}`,
      };
    });
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: {
        requestReconcile: vi.fn(async (_computerId, _instanceId, request, onDispatched) => {
          onDispatched?.();
          return {
            type: "session:reconcile:result" as const,
            requestId: request.requestId,
            sessionId: request.sessionId,
            placementGeneration: request.placementGeneration,
            status: "ready" as const,
          };
        }),
        requestDelivery,
      } as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue({} as never) },
      registry: scope.registry,
    });
    await worker.runOnce();

    // Local has no same-Agent ordering predicate: a backed-off earlier input never blocks this
    // Agent's other Session, exactly as before E6.
    expect(requestDelivery).toHaveBeenCalledTimes(1);
    const deliveredRequest = requestDelivery.mock.calls[0]?.[2] as { deliveryId: string } | undefined;
    expect(deliveredRequest?.deliveryId).toBe(later.deliveryId);
    const [earlierRow] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, earlier.deliveryId));
    expect(earlierRow).toMatchObject({ state: "pending", attemptCount: 0 });
  });
});
