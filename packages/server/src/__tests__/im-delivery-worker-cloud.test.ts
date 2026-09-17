import { randomUUID } from "node:crypto";
import { computeDirectInputHash, type RunnerServerFrame } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentRuntimeConfigs,
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

async function pendingDelivery(sessionId: string, expiresAt?: Date) {
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
    occurredAt: new Date(),
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

function makeWorker(owner?: CloudDeliveryOwner, allocation?: AllocationCallLog) {
  return new ImDeliveryWorker({
    assembler: new EffectiveRuntimeSnapshotAssembler(unit.database),
    database: unit.database,
    domain: {} as never,
    registry: new ConnectionRegistry(),
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

    // The binding is deactivated while the turn runs: the normal claim path excludes this row, so
    // the bounded stopped-authority pass must still reach it and resend the missed cancel.
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, bindingId));
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

  it("terminally rejects a pending Cloud input whose authority stopped", async () => {
    const { scope, agent, bindingId } = await cloudScope();
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, bindingId));
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
