import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type RunnerServerFrame,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  imBindings,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { createRuntimeCredentialServices } from "../runtime-credentials/index.js";
import { AgentService } from "../services/agents/index.js";
import { ComputerService } from "../services/computers/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { CloudDeliveryDispatchError, CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import { CloudModelGrantService } from "../services/sandboxes/cloud-model-grants.js";
import { CloudRuntimeFence } from "../services/sandboxes/cloud-runtime-fence.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../services/sandboxes/runner-hub.js";
import { SandboxService } from "../services/sandboxes/sandbox-service.js";
import { SessionService } from "../services/sessions/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const RUNNER_VERSION = "0.0.5";
const cloudIdentities = {
  enabled: true as const,
  runnerVersion: RUNNER_VERSION,
  storageBase: "gs://unit-cloud/sandboxes",
};
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

function runtimeSnapshot(agentId: string): EffectiveRuntimeSnapshot {
  return {
    agentId,
    contextTreeRepository: null,
    instructions: { agent: "Agent instructions.", platform: "Platform instructions." },
    provider: "pi",
    model: MODEL,
    revision: {
      agent: { id: randomUUID(), sequence: 1 },
      session: { id: randomUUID(), sequence: 1 },
    },
    execution: { approvalPolicy: "never", networkAccess: true },
    workspace: { workspaceId: randomUUID(), mode: "empty_on_create", sharing: "agent" },
  };
}

async function cloudScope() {
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
  await unit.database
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

function fakeSocket(sent: RunnerServerFrame[] = []): RunnerControlSocket & { sent: RunnerServerFrame[] } {
  return {
    sent,
    send(frame: RunnerServerFrame) {
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

function attachReady(
  hub: RunnerHub,
  fence: CloudRuntimeFence,
  scope: RunnerScope,
  sent: RunnerServerFrame[],
  computerId: string,
) {
  const socket = fakeSocket(sent);
  hub.attach(scope, socket);
  hub.markReady(scope, READINESS, socket);
  const connection = fence.attach({ computerId, installationId: randomUUID(), scope, socket });
  return { socket, connection };
}

async function pendingDelivery(input: { sessionId: string; expiresAt?: Date }) {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const [binding] = await unit.database.select().from(imBindings).limit(1);
  if (!binding) throw new Error("fixture binding missing");
  const [placement] = await unit.database
    .select()
    .from(sessionPlacements)
    .where(eq(sessionPlacements.sessionId, input.sessionId))
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
    content: { version: 1, fallbackText: "hello", blocks: [], truncated: false },
    providerContext: { provider: "feishu" },
    occurredAt: new Date(),
  });
  await unit.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId: input.sessionId,
    attention: "direct",
    state: "pending",
    placementGeneration: placement.generation,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 3_600_000),
  });
  return { deliveryId, messageId, placementGeneration: placement.generation };
}

async function deliveryRow(deliveryId: string): Promise<typeof imMessageDeliveries.$inferSelect> {
  const [row] = await unit.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, deliveryId));
  if (!row) throw new Error("delivery row missing");
  return row;
}

function deliveryRequest(input: {
  deliveryId: string;
  messageId: string;
  sessionId: string;
  agentId: string;
  placementGeneration: number;
  requestId?: string;
}): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: input.requestId ?? randomUUID(),
    deliveryId: input.deliveryId,
    imMessageId: input.messageId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    placementGeneration: input.placementGeneration,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "feishu",
        teamBrand: "feishu",
        appId: "unit-app",
        botOpenId: "unit-bot",
        chatId: "unit-channel",
        messageId: "ext-1",
      },
    },
    runtime: runtimeSnapshot(input.agentId),
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function turnReport(request: DirectImMessageDeliveryRequest, turnId: string): TurnReportRequest {
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

function makeOwner(
  options: {
    withModel?: boolean;
    allocationStatus?: (
      sandboxId: string,
    ) => Promise<import("../services/sandboxes/index.js").SandboxAllocationReconciliation | undefined>;
  } = {},
) {
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
    modelBaseUrl: "https://server.example.com/api/v1/cloud-model",
    ...(options.withModel === false ? {} : { modelGrants: grants }),
    ...(options.allocationStatus ? { allocationStatus: options.allocationStatus } : {}),
  });
  return { hub, fence, custody, grants, owner };
}

/** The real #633 server stack over the unit database, for the credential tunnel test. */
function credentialServices(fence: CloudRuntimeFence) {
  const registry = new ConnectionRegistry();
  return createRuntimeCredentialServices({
    cipher: new ApplicationCipher(new Uint8Array(32).fill(7)),
    custody: new PostgresRuntimeCustodyStore(unit.database),
    database: unit.database,
    registry,
    additionalConnectionFence: fence,
    controlAuthority: {
      isCurrentConnection: (computerId, instanceId, connectionId) =>
        registry.isCurrentConnection(computerId, instanceId, connectionId) ||
        fence.isCurrent(computerId, instanceId, connectionId),
      currentInstanceId: (computerId) => registry.currentInstanceId(computerId),
      currentControlIdentity: (computerId) =>
        registry.currentControlIdentity(computerId) ?? fence.currentControlIdentity(computerId),
      sendRevoked: (computerId, instanceId, frame) => {
        void registry.send(computerId, instanceId, frame).catch(() => undefined);
      },
    },
    cloudControlActive: (identity) => fence.isControlActive(identity),
  });
}

/** Dispatch + receipt helper driving one delivery to accepted state. */
async function dispatchAndAccept(input: {
  owner: CloudDeliveryOwner;
  fence: CloudRuntimeFence;
  scope: RunnerScope;
  agentId: string;
  computerId: string;
  installationId?: string;
}) {
  const { deliveryId, messageId, placementGeneration } = await pendingDelivery({ sessionId: input.scope.sessionId });
  const request = deliveryRequest({
    deliveryId,
    messageId,
    sessionId: input.scope.sessionId,
    agentId: input.agentId,
    placementGeneration,
  });
  await input.owner.dispatchDelivery({
    computerId: input.computerId,
    inputHash: computeDirectInputHash(request),
    installationId: input.installationId ?? randomUUID(),
    request,
  });
  const connection = input.fence.connectionForSandbox(input.scope.sandboxId);
  if (!connection) throw new Error("no connection");
  const turnId = randomUUID();
  await input.owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
  return { deliveryId, request, turnId, connection };
}

describe("CloudDeliveryOwner", () => {
  it("dispatches a claimed Cloud delivery to the scoped Runner and persists dispatch custody", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    hub.attach(scope, fakeSocket(sent));
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, messageId, placementGeneration } = await pendingDelivery({ sessionId: scope.sessionId });
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration,
    });
    await owner.dispatchDelivery({
      computerId: connection.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    expect(sent.map((frame) => frame.type)).toEqual(["delivery:run"]);
    const run = sent[0] as Extract<RunnerServerFrame, { type: "delivery:run" }>;
    expect(run.delivery.deliveryId).toBe(deliveryId);
    expect(run.requestId).toBe(request.requestId);
    const after = await deliveryRow(deliveryId);
    expect(after.dispatchRequestId).toBe(request.requestId);
    expect(after.dispatchInputHash).toBe(computeDirectInputHash(request));
    expect(after.dispatchPayload).toMatchObject({ deliveryId });
  });

  it("receipt persists durable acceptance exactly once; verified carries the model grant", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, turnId, connection } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const verified = sent.filter((frame) => frame.type === "delivery:verified");
    expect(verified).toHaveLength(1);
    expect((verified[0] as { status: string }).status).toBe("verified");
    expect((verified[0] as { model?: { model: string } }).model?.model).toBe(MODEL);
    const accepted = await deliveryRow(deliveryId);
    expect(accepted.state).toBe("accepted");
    expect(accepted.turnId).toBe(turnId);
    expect(accepted.reportOwnerInstanceId).toBe(connection.instanceId);
    // Duplicate receipt (dispatch replay after a lost verified): idempotent, no double custody.
    await owner.handleDeliveryReceived(connection, {
      deliveryId,
      requestId: accepted.dispatchRequestId as string,
      turnId,
    });
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(2);
    const stillAccepted = await deliveryRow(deliveryId);
    expect(stillAccepted.state).toBe("accepted");
    expect(stillAccepted.turnId).toBe(turnId);
  });

  it("records the Turn Report exactly once and acks; a lost ack retransmits idempotently", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId, connection } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const report = turnReport(request, turnId);
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report });
    let acks = sent.filter((frame) => frame.type === "delivery:report:ack");
    expect(acks).toHaveLength(1);
    expect((acks[0] as { status: string }).status).toBe("recorded");
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report });
    acks = sent.filter((frame) => frame.type === "delivery:report:ack");
    expect(acks).toHaveLength(2);
    expect((acks[1] as { status: string }).status).toBe("already_recorded");
    const final = await deliveryRow(deliveryId);
    expect(final.reportedAt).not.toBeNull();
    expect(final.turnReport).toMatchObject({ turnId, outcome: "completed" });
  });

  it("rejects a receipt for a foreign Session and never moves its custody", async () => {
    const first = await cloudScope();
    const second = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, first.scope, sent, first.cloud.computerId);
    const connection = fence.connectionForSandbox(first.scope.sandboxId);
    if (!connection) throw new Error("no connection");
    const { deliveryId, messageId, placementGeneration } = await pendingDelivery({
      sessionId: second.sandbox.sessionId,
    });
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: second.sandbox.sessionId,
      agentId: second.agent.id,
      placementGeneration,
    });
    await owner.handleDeliveryReceived(connection, {
      deliveryId,
      requestId: request.requestId,
      turnId: randomUUID(),
    });
    const verified = sent.filter((frame) => frame.type === "delivery:verified");
    expect(verified).toHaveLength(1);
    expect((verified[0] as { status: string }).status).toBe("rejected");
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("pending");
    expect(row.turnId).toBeNull();
  });

  it("settles a started-unknown delivery exactly once when its allocation is gone", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, turnId, connection } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    // The Runner's allocation is released (stop): no connection can ever answer for it again.
    owner.detachConnection(connection.connectionId);
    hub.detach(scope.sandboxId, socket);
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, scope.sandboxId));
    const outcome = await owner.recoverAccepted(deliveryId);
    expect(outcome).toBe("resolved");
    const settled = await deliveryRow(deliveryId);
    expect(settled.reportedAt).not.toBeNull();
    expect(settled.turnReport).toMatchObject({ outcome: "unknown", errorReason: "turn_state_unknown", turnId });
  });

  it("fences the #633 credential tunnel: foreign Session, custody, and detach", async () => {
    const { scope, agent, cloud, accountId } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, turnId, connection } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const services = credentialServices(fence);
    const withCredentials = new CloudDeliveryOwner({
      custody: new PostgresRuntimeCustodyStore(unit.database),
      database: unit.database,
      fence,
      hub,
      credentials: { owner: services.owner },
      modelBaseUrl: "https://server.example.com/api/v1/cloud-model",
      modelGrants: grants,
    });
    const sandboxFacts = {
      sandboxId: scope.sandboxId,
      resourceUid: `unit-uid-${scope.sandboxId.slice(0, 8)}`,
      environmentGeneration: 1,
    };
    // A foreign Session's execution open is rejected even on a live connection.
    const foreign = await withCredentials.handleCredentialFrame(connection, {
      type: "runtime:execution:open",
      requestId: randomUUID(),
      sessionId: randomUUID(),
      agentId: agent.id,
      placementGeneration: 1,
      runId: randomUUID(),
      source: { kind: "delivery", deliveryId, turnId },
      sandbox: sandboxFacts,
    });
    expect(foreign).toMatchObject({ status: "rejected" });
    // An open whose source delivery is not the accepted one is rejected by the custody fence.
    const notReady = await withCredentials.handleCredentialFrame(connection, {
      type: "runtime:execution:open",
      requestId: randomUUID(),
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration: 1,
      runId: randomUUID(),
      source: { kind: "delivery", deliveryId, turnId: randomUUID() },
      sandbox: sandboxFacts,
    });
    expect(notReady).toMatchObject({ status: "rejected" });
    // A wrong Sandbox generation is rejected by the sandbox fence.
    const wrongGeneration = await withCredentials.handleCredentialFrame(connection, {
      type: "runtime:execution:open",
      requestId: randomUUID(),
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration: 1,
      runId: randomUUID(),
      source: { kind: "delivery", deliveryId, turnId },
      sandbox: { ...sandboxFacts, environmentGeneration: 2 },
    });
    expect(wrongGeneration).toMatchObject({ status: "rejected", code: "sandbox_mismatch" });
    // A directly-injected execution dies with its connection: acquire after detach is unknown.
    const record = services.executions.open({
      accountId,
      agentId: agent.id,
      agentRevision: 1,
      computerId: connection.computerId,
      computerKind: "cloud",
      connectionId: connection.connectionId,
      instanceId: connection.instanceId,
      placementGeneration: 1,
      providers: new Map(),
      purpose: "execution",
      runId: randomUUID(),
      sandbox: sandboxFacts,
      sessionId: scope.sessionId,
      source: { kind: "delivery", deliveryId, turnId },
    });
    withCredentials.detachConnection(connection.connectionId);
    const after = await withCredentials.handleCredentialFrame(connection, {
      type: "runtime:credential:acquire",
      requestId: randomUUID(),
      executionId: record.executionId,
      provider: "feishu",
      bindingId: randomUUID(),
    });
    expect(after).toMatchObject({ status: "rejected", code: "execution_unknown" });
  });

  it("keeps a fresh Server's pending recovery over a live persisted allocation instead of writing unknown", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const first = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(first.hub, first.fence, scope, sent, cloud.computerId);
    const { deliveryId } = await dispatchAndAccept({
      owner: first.owner,
      fence: first.fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    // A restarted Server has an empty in-memory fence but the SAME persisted allocation.
    const fresh = makeOwner();
    const outcome = await fresh.owner.recoverAccepted(deliveryId);
    expect(outcome).toBe("pending");
    const stored = await deliveryRow(deliveryId);
    expect(stored.reportedAt).toBeNull();
    expect(stored.turnReport).toBeNull();
  });

  it("never settles unknown while the current Runner still reports phase=started", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "started" }));
      }
    };
    const outcome = await owner.recoverAccepted(deliveryId);
    expect(outcome).toBe("pending");
    const stored = await deliveryRow(deliveryId);
    expect(stored.reportedAt).toBeNull();
  });

  it("re-verifies a journaled received entry with a grant scoped to the frozen window", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "received" }));
      }
    };
    const outcome = await owner.recoverAccepted(deliveryId);
    expect(outcome).toBe("pending");
    const verified = sent.filter((frame) => frame.type === "delivery:verified");
    expect(verified).toHaveLength(2);
    const regrant = verified[1] as { status: string; model?: { token: string; expiresAt: string } };
    expect(regrant.status).toBe("verified");
    // The execution window is the frozen dispatch deadline plus the transport allowance.
    const expectedExpiry = Date.parse(request.deadlineAt as string) + 30_000;
    expect(Date.parse(regrant.model?.expiresAt as string)).toBe(expectedExpiry);
    expect(await grants.verify(regrant.model?.token as string)).toBeDefined();
  });

  it("settles unknown only when the tracked allocation is physically absent, and stays pending while present", async () => {
    const absent = await cloudScope();
    const absentStatus = makeOwner({
      allocationStatus: async () => ({
        scope: absent.scope,
        lifecycle: "ready",
        resourceUid: `unit-uid-${absent.sandbox.sandboxId.slice(0, 8)}`,
        physical: "absent",
      }),
    });
    const absentSent: RunnerServerFrame[] = [];
    attachReady(absentStatus.hub, absentStatus.fence, absent.scope, absentSent, absent.cloud.computerId);
    const absentDelivery = await dispatchAndAccept({
      owner: absentStatus.owner,
      fence: absentStatus.fence,
      scope: absent.scope,
      agentId: absent.agent.id,
      computerId: absent.cloud.computerId,
    });
    absentStatus.owner.detachConnection(absentDelivery.connection.connectionId);
    expect(await absentStatus.owner.recoverAccepted(absentDelivery.deliveryId)).toBe("resolved");
    const settled = await deliveryRow(absentDelivery.deliveryId);
    expect(settled.turnReport).toMatchObject({ outcome: "unknown", errorReason: "turn_state_unknown" });

    const present = await cloudScope();
    const presentStatus = makeOwner({
      allocationStatus: async () => ({
        scope: present.scope,
        lifecycle: "ready",
        resourceUid: `unit-uid-${present.sandbox.sandboxId.slice(0, 8)}`,
        physical: "present",
      }),
    });
    const presentSent: RunnerServerFrame[] = [];
    attachReady(presentStatus.hub, presentStatus.fence, present.scope, presentSent, present.cloud.computerId);
    const presentDelivery = await dispatchAndAccept({
      owner: presentStatus.owner,
      fence: presentStatus.fence,
      scope: present.scope,
      agentId: present.agent.id,
      computerId: present.cloud.computerId,
    });
    presentStatus.owner.detachConnection(presentDelivery.connection.connectionId);
    expect(await presentStatus.owner.recoverAccepted(presentDelivery.deliveryId)).toBe("pending");
    expect((await deliveryRow(presentDelivery.deliveryId)).reportedAt).toBeNull();
  });

  it("settles unknown exactly once for a durably stopped (releasing) allocation", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, scope.sandboxId));
    expect(await owner.recoverAccepted(deliveryId)).toBe("resolved");
    const settled = await deliveryRow(deliveryId);
    expect(settled.turnReport).toMatchObject({ outcome: "unknown", errorReason: "turn_state_unknown" });
    // Settling is one-shot: a second recovery is a no-op, never a rewrite.
    expect(await owner.recoverAccepted(deliveryId)).toBe("noop");
  });

  it("revokes the turn's grant on stop, reports outcomes, and still records a matching report", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId, connection } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const verified = sent.find((frame) => frame.type === "delivery:verified") as {
      model?: { token: string };
    };
    const token = verified.model?.token as string;
    expect(await grants.verify(token)).toBeDefined();

    const outcomes = await owner.cancelSessionDeliveries(scope.sessionId);
    expect(outcomes).toEqual([{ deliveryId, status: "cancelled" }]);
    expect(sent.some((frame) => frame.type === "delivery:cancel")).toBe(true);
    // Privileges are revoked even though the cancel frame was delivered.
    expect(await grants.verify(token)).toBeUndefined();

    // An already accepted turn's final report stays recordable, even after an explicit Session end.
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, scope.sessionId));
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report: turnReport(request, turnId) });
    const recorded = await deliveryRow(deliveryId);
    expect(recorded.reportedAt).not.toBeNull();
    expect(recorded.turnReport).toMatchObject({ outcome: "completed" });
  });

  it("reports no_connection for a lost socket instead of silently dropping the stop", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const verified = sent.find((frame) => frame.type === "delivery:verified") as { model?: { token: string } };
    owner.detachConnection(connection.connectionId);
    const outcomes = await owner.cancelSessionDeliveries(scope.sessionId);
    expect(outcomes).toEqual([{ deliveryId, status: "no_connection" }]);
    const stored = await deliveryRow(deliveryId);
    expect(stored.state).toBe("accepted");
    expect(stored.reportedAt).toBeNull();
    // With no owning socket the stop outcome is still reconcilable later, and the grant is dead.
    expect(await grants.verify(verified.model?.token as string)).toBeUndefined();
    expect(await owner.recoverAccepted(deliveryId)).toBe("pending");
  });

  it("revokes the superseded connection's grant on replacement, even after the fence entry is gone", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, turnId, request } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const verified = sent.find((frame) => frame.type === "delivery:verified") as { model?: { token: string } };
    const token = verified.model?.token as string;
    expect(await grants.verify(token)).toBeDefined();

    const replacementSent: RunnerServerFrame[] = [];
    const replacementSocket = fakeSocket(replacementSent);
    hub.attach(scope, replacementSocket);
    hub.markReady(scope, READINESS, replacementSocket);
    const replacement = owner.attachConnection({
      computerId: cloud.computerId,
      installationId: randomUUID(),
      scope,
      socket: replacementSocket,
    });
    // The old connection's fence entry is already gone; revocation must still have run.
    expect(await grants.verify(token)).toBeUndefined();
    expect(fence.connectionForSandbox(scope.sandboxId)?.connectionId).toBe(replacement.connectionId);

    // Frames addressed to the superseded connection never reach the replacement's socket.
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report: turnReport(request, turnId) });
    expect(replacementSent.some((frame) => frame.type === "delivery:report:ack")).toBe(false);
    expect((await deliveryRow(deliveryId)).reportedAt).toBeNull();

    // The replacement owns the same allocation identity, so its own replayed report is recorded.
    const report = turnReport(request, turnId);
    await owner.handleDeliveryReport(replacement, { requestId: randomUUID(), report });
    expect(replacementSent.some((frame) => frame.type === "delivery:report:ack")).toBe(true);
    expect((await deliveryRow(deliveryId)).reportedAt).not.toBeNull();
  });

  it("rejects execution permission for an accepted turn replayed from a replacement allocation generation", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const nextScope = {
      ...scope,
      environmentGeneration: 2,
      resourceName: `${scope.resourceName}-new`,
    };
    await unit.database
      .update(sandboxes)
      .set({
        environmentGeneration: 2,
        currentResourceName: nextScope.resourceName,
        currentResourceUid: "replacement-fixture-uid",
      })
      .where(eq(sandboxes.id, scope.sandboxId));
    const nextSent: RunnerServerFrame[] = [];
    const nextSocket = fakeSocket(nextSent);
    hub.attach(nextScope, nextSocket);
    hub.markReady(nextScope, READINESS, nextSocket);
    const next = owner.attachConnection({
      computerId: cloud.computerId,
      installationId: randomUUID(),
      scope: nextScope,
      socket: nextSocket,
    });
    await owner.handleDeliveryReceived(next, {
      deliveryId,
      requestId: request.requestId,
      turnId,
    });
    const verified = nextSent.filter((frame) => frame.type === "delivery:verified");
    expect(verified).toHaveLength(1);
    expect((verified[0] as { status: string }).status).toBe("rejected");
    expect(await grants.verify((verified[0] as { model?: { token: string } }).model?.token as string)).toBeUndefined();
  });

  it("refuses to dispatch new work once the Session ended", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, messageId, placementGeneration } = await pendingDelivery({ sessionId: scope.sessionId });
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration,
    });
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, scope.sessionId));
    await expect(
      owner.dispatchDelivery({
        computerId: cloud.computerId,
        inputHash: computeDirectInputHash(request),
        installationId: randomUUID(),
        request,
      }),
    ).rejects.toMatchObject({ code: "environment_not_ready" });
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("pending");
    expect(row.dispatchRequestId).toBeNull();
    expect(sent.filter((frame) => frame.type === "delivery:run")).toHaveLength(0);
  });

  it("keeps two Session allocations of one Cloud Computer independent", async () => {
    const first = await cloudScope();
    const sessionService = new SessionService(unit.database);
    const sandboxService = new SandboxService(unit.database, sessionService, { cloudIdentities });
    const secondSandbox = await sandboxService.ensureForAccount(first.accountId, {
      imBindingId: first.bindingId,
      channelId: "unit-channel-2",
      conversationKind: "channel",
      kind: "channel",
    });
    const secondResourceName = `projects/unit/locations/us-west1/instances/ots-s-${secondSandbox.sandboxId.slice(0, 8)}-1`;
    await unit.database
      .update(sandboxes)
      .set({
        lifecycle: "ready",
        environmentGeneration: 1,
        currentResourceName: secondResourceName,
        currentResourceUid: `unit-uid-${secondSandbox.sandboxId.slice(0, 8)}`,
      })
      .where(eq(sandboxes.id, secondSandbox.sandboxId));
    const secondScope: RunnerScope = {
      sandboxId: secondSandbox.sandboxId,
      sessionId: secondSandbox.sessionId,
      environmentGeneration: 1,
      resourceName: secondResourceName,
    };

    const { hub, fence, owner } = makeOwner();
    const firstSent: RunnerServerFrame[] = [];
    const secondSent: RunnerServerFrame[] = [];
    const firstAttached = attachReady(hub, fence, first.scope, firstSent, first.cloud.computerId);
    const secondAttached = attachReady(hub, fence, secondScope, secondSent, first.cloud.computerId);
    // Attaching the second Session Runner never evicts the first Session's connection.
    expect(fence.connectionForSandbox(first.scope.sandboxId)?.connectionId).toBe(firstAttached.connection.connectionId);
    expect(fence.connectionForSandbox(secondScope.sandboxId)?.connectionId).toBe(
      secondAttached.connection.connectionId,
    );
    expect(
      fence.connectionForInstance(first.cloud.computerId, firstAttached.connection.instanceId)?.scope.sandboxId,
    ).toBe(first.scope.sandboxId);
    expect(
      fence.connectionForInstance(first.cloud.computerId, secondAttached.connection.instanceId)?.scope.sandboxId,
    ).toBe(secondScope.sandboxId);

    const firstDelivery = await dispatchAndAccept({
      owner,
      fence,
      scope: first.scope,
      agentId: first.agent.id,
      computerId: first.cloud.computerId,
    });
    const secondDelivery = await dispatchAndAccept({
      owner,
      fence,
      scope: secondScope,
      agentId: first.agent.id,
      computerId: first.cloud.computerId,
    });
    const firstRuns = firstSent.filter((frame) => frame.type === "delivery:run");
    const secondRuns = secondSent.filter((frame) => frame.type === "delivery:run");
    expect(firstRuns).toHaveLength(1);
    expect(secondRuns).toHaveLength(1);
    expect((firstRuns[0] as { delivery: { deliveryId: string } }).delivery.deliveryId).toBe(firstDelivery.deliveryId);
    expect((secondRuns[0] as { delivery: { deliveryId: string } }).delivery.deliveryId).toBe(secondDelivery.deliveryId);
  });

  it("revokes the superseded connection's credential executions on replacement", async () => {
    const { scope, agent, cloud, accountId } = await cloudScope();
    const { hub, fence, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const socket = fakeSocket(sent);
    hub.attach(scope, socket);
    hub.markReady(scope, READINESS, socket);
    const services = credentialServices(fence);
    const owner = new CloudDeliveryOwner({
      custody: new PostgresRuntimeCustodyStore(unit.database),
      database: unit.database,
      fence,
      hub,
      credentials: { owner: services.owner },
      modelBaseUrl: "https://server.example.com/api/v1/cloud-model",
      modelGrants: grants,
    });
    const connection = owner.attachConnection({
      computerId: cloud.computerId,
      installationId: randomUUID(),
      scope,
      socket,
    });
    const execution = services.executions.open({
      accountId,
      agentId: agent.id,
      agentRevision: 1,
      computerId: cloud.computerId,
      computerKind: "cloud",
      connectionId: connection.connectionId,
      instanceId: connection.instanceId,
      placementGeneration: 1,
      providers: new Map(),
      purpose: "execution",
      runId: randomUUID(),
      sandbox: {
        sandboxId: scope.sandboxId,
        resourceUid: `unit-uid-${scope.sandboxId.slice(0, 8)}`,
        environmentGeneration: 1,
      },
      sessionId: scope.sessionId,
      source: { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() },
    });
    const replacementSocket = fakeSocket([]);
    hub.attach(scope, replacementSocket);
    replacementSocket && hub.markReady(scope, READINESS, replacementSocket);
    const replacement = owner.attachConnection({
      computerId: cloud.computerId,
      installationId: randomUUID(),
      scope,
      socket: replacementSocket,
    });
    expect(fence.connectionForSandbox(scope.sandboxId)?.connectionId).toBe(replacement.connectionId);
    // The old fence entry was replaced inside attach; its credential execution must still be gone.
    expect(services.executions.get(execution.executionId)).toBeUndefined();
  });

  it("revokes a permission minted while an explicit stop landed instead of sending it", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    let entered!: () => void;
    const minting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = grants.issue.bind(grants);
    grants.issue = async (input) => {
      entered();
      await gate;
      return issue(input);
    };
    const accepting = dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    await minting;
    // The stop lands while the permission is being minted.
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, scope.sessionId));
    await owner.cancelSessionDeliveries(scope.sessionId);
    release();
    const accepted = await accepting;
    const verified = sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified");
    expect(verified).toHaveLength(0);
    // The durable receipt stays; reconciliation settles it, but no permission leaks.
    expect((await deliveryRow(accepted.deliveryId)).state).toBe("accepted");
  });

  it("revokes the model permission when recovery settles the turn as unknown", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const verified = sent.find((frame) => frame.type === "delivery:verified") as {
      model?: { token: string };
    };
    const token = verified.model?.token as string;
    expect(await grants.verify(token)).toBeDefined();
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "none" }));
      }
    };
    expect(await owner.recoverAccepted(deliveryId)).toBe("resolved");
    expect(await grants.verify(token)).toBeUndefined();
    const stored = await deliveryRow(deliveryId);
    expect(stored.turnReport).toMatchObject({ outcome: "unknown", errorReason: "turn_state_unknown" });
  });

  it("rejects a receipt replay after the durable report instead of authorizing again", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId, connection } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report: turnReport(request, turnId) });
    const verifiedBefore = sent.filter(
      (frame) => frame.type === "delivery:verified" && frame.status === "verified",
    ).length;
    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    const verifiedAfter = sent.filter(
      (frame) => frame.type === "delivery:verified" && frame.status === "verified",
    ).length;
    expect(verifiedAfter).toBe(verifiedBefore);
  });

  it("fails dispatch transiently when no ready Runner is attached", async () => {
    const { scope, agent } = await cloudScope();
    const { owner } = makeOwner();
    const { deliveryId, messageId, placementGeneration } = await pendingDelivery({ sessionId: scope.sessionId });
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration,
    });
    await expect(
      owner.dispatchDelivery({
        computerId: randomUUID(),
        inputHash: computeDirectInputHash(request),
        installationId: randomUUID(),
        request,
      }),
    ).rejects.toBeInstanceOf(CloudDeliveryDispatchError);
    const after = await deliveryRow(deliveryId);
    expect(after.dispatchRequestId).toBeNull();
    expect(after.state).toBe("pending");
  });
});
