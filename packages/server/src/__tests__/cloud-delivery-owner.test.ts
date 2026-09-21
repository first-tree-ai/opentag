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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createStaticCloudModelCatalog } from "../services/sandboxes/cloud-model-catalog.js";
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

/** The Client's not-started cancellation report, emitted when a received entry is cancelled. */
function cancelledBeforeStartReport(request: DirectImMessageDeliveryRequest, turnId: string): TurnReportRequest {
  const base = {
    type: "turn:report" as const,
    requestId: randomUUID(),
    deliveryId: request.deliveryId,
    turnId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
    outcome: "cancelled" as const,
    executionEffects: "not_started" as const,
    errorReason: "client_shutdown" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return { ...base, resultHash: computeTurnResultHash(base) };
}

function makeOwner(
  options: {
    withModel?: boolean;
    logger?: import("../observability/service-logger.js").ServiceLogger;
    sessionProofs?: import("../services/sandboxes/index.js").CloudDeliveryOwnerOptions["sessionProofs"];
    credentialsOwner?: unknown;
    allocationStatus?: (
      sandboxId: string,
    ) => Promise<import("../services/sandboxes/index.js").SandboxAllocationReconciliation | undefined>;
  } = {},
) {
  const hub = new RunnerHub();
  const fence = new CloudRuntimeFence();
  const custody = new PostgresRuntimeCustodyStore(unit.database);
  const grants = new CloudModelGrantService("unit-test-jwt-secret-at-least-32-characters", {
    catalog: createStaticCloudModelCatalog([MODEL]),
    maxStreamsPerToken: 2,
    ttlSeconds: 600,
  });
  const owner = new CloudDeliveryOwner({
    custody,
    database: unit.database,
    fence,
    hub,
    modelBaseUrl: "https://server.example.com/api/v1/cloud-model",
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.credentialsOwner ? { credentials: { owner: options.credentialsOwner as never } } : {}),
    ...(options.withModel === false ? {} : { modelGrants: grants }),
    ...(options.sessionProofs ? { sessionProofs: options.sessionProofs } : {}),
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
    // A connection that did not negotiate E8 (the E7 default here) never receives the field.
    expect(verified[0]).not.toHaveProperty("sessionCliProof");
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

  it("mints the Session-CLI proof only at the actual execution open on a negotiated connection", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const mintCloud = vi.fn(async () => ({ proofId: randomUUID(), token: "unit-session-proof-token" }));
    const executionResult = {
      type: "runtime:execution:result" as const,
      requestId: "unused",
      status: "succeeded" as const,
      executionId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      providers: [],
    };
    const credentialOwner = { handle: vi.fn(async () => executionResult) };
    const { hub, fence, owner } = makeOwner({ credentialsOwner: credentialOwner, sessionProofs: { mintCloud } });
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const openFrame = {
      type: "runtime:execution:open" as const,
      requestId: randomUUID(),
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration: 1,
      runId: randomUUID(),
      source: { kind: "session-message" as const, messageId: randomUUID() },
      sandbox: {
        environmentGeneration: 1,
        resourceUid: `unit-uid-${scope.sandboxId.slice(0, 8)}`,
        sandboxId: scope.sandboxId,
      },
    };

    // A legacy E7 connection opens its real execution but never receives a proof.
    const legacy = await owner.handleCredentialFrame(connection, openFrame);
    expect(legacy).toMatchObject({ status: "succeeded" });
    expect(legacy).not.toHaveProperty("sessionCliProof");
    expect(mintCloud).not.toHaveBeenCalled();

    // An E8-negotiated connection receives the proof bound to the ACTUAL execution id.
    const sent2: RunnerServerFrame[] = [];
    const socket2 = fakeSocket(sent2);
    hub.attach(scope, socket2);
    hub.markReady(scope, READINESS, socket2);
    const replacement = fence.attach({
      computerId: cloud.computerId,
      installationId: randomUUID(),
      scope,
      sessionCollaborationEligible: true,
      socket: socket2,
    });
    const negotiated = await owner.handleCredentialFrame(replacement, openFrame);
    expect(negotiated).toMatchObject({
      sessionCliProof: { token: "unit-session-proof-token" },
      status: "succeeded",
    });
    expect(mintCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: replacement.connectionId,
        executionId: executionResult.executionId,
        placementGeneration: 1,
        sandboxId: scope.sandboxId,
        sessionId: scope.sessionId,
      }),
    );

    // A validation execution is never a Session CLI authority.
    mintCloud.mockClear();
    const validation = await owner.handleCredentialFrame(replacement, {
      ...openFrame,
      source: { kind: "validation", validationRunId: randomUUID() },
    });
    expect(validation).not.toHaveProperty("sessionCliProof");
    expect(mintCloud).not.toHaveBeenCalled();
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

  it("leaves a receipt retryable when the grant mint fails instead of accepting it without permission", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
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
      computerId: cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    const turnId = randomUUID();
    const issue = grants.issue.bind(grants);
    let calls = 0;
    grants.issue = async (input) => {
      calls += 1;
      return calls === 1 ? undefined : issue(input);
    };

    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });

    const denied = sent.filter((frame) => frame.type === "delivery:verified");
    expect(denied).toHaveLength(1);
    expect((denied[0] as { status: string }).status).toBe("rejected");
    // Retryable: durable custody was never moved and the dispatch columns survive for the retry,
    // so a later settlement can never call this never-started turn unknown/may_have_occurred.
    const retryable = await deliveryRow(deliveryId);
    expect(retryable).toMatchObject({
      state: "pending",
      turnId: null,
      reportedAt: null,
      turnReport: null,
      dispatchRequestId: request.requestId,
    });

    // Once the grant service recovers, the same receipt verifies and commits custody exactly once.
    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    const verified = sent.filter((frame) => frame.type === "delivery:verified");
    expect((verified.at(-1) as { status: string }).status).toBe("verified");
    const accepted = await deliveryRow(deliveryId);
    expect(accepted).toMatchObject({ state: "accepted", turnId, reportedAt: null });
    grants.close();
  });

  it("preserves received evidence when an accepted duplicate cannot re-mint its permission", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const verifiedBefore = sent.filter((frame) => frame.type === "delivery:verified").length;

    // The Runner reconnected and replayedly announced a receipt for an already accepted turn, but
    // the grant service cannot issue right now.
    const issue = grants.issue.bind(grants);
    grants.issue = async () => undefined;
    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });

    // A rejected frame would make the Runner erase its durable `received` journal entry and lose
    // the only evidence that this turn never started; the Server must stay silent and retry.
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(verifiedBefore);
    const preserved = await deliveryRow(deliveryId);
    expect(preserved).toMatchObject({ state: "accepted", turnId, reportedAt: null, turnReport: null });

    // Bounded truthful recovery: once the service recovers, the journaled received entry resumes
    // with a fresh rotated permission.
    grants.issue = issue;
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "received" }));
      }
    };
    await owner.recoverAccepted(deliveryId);
    const verified = sent.filter((frame) => frame.type === "delivery:verified");
    expect((verified.at(-1) as { status: string }).status).toBe("verified");
    grants.close();
  });

  it("refuses a receipt whose frozen window expired before custody and leaves the dispatch redispatchable", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, custody, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, messageId, placementGeneration } = await pendingDelivery({ sessionId: scope.sessionId });
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration,
    });
    const expiredRequest = { ...request, deadlineAt: new Date(Date.now() - 60_000).toISOString() };
    const expiredHash = computeDirectInputHash(expiredRequest);
    await owner.dispatchDelivery({
      computerId: cloud.computerId,
      inputHash: expiredHash,
      installationId: connection.installationId,
      request: expiredRequest,
    });

    await owner.handleDeliveryReceived(connection, {
      deliveryId,
      requestId: expiredRequest.requestId,
      turnId: randomUUID(),
    });

    // The input was never taken over and no permission can cover the passed window: the receipt is
    // refused so the Runner retires its received evidence, and the row keeps its frozen dispatch
    // instead of being faked forward into a permanent cancellation.
    expect(sent.filter((frame) => frame.type === "delivery:cancel")).toHaveLength(0);
    expect(sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified")).toHaveLength(0);
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toEqual([
      expect.objectContaining({ code: "dispatch_expired", status: "rejected" }),
    ]);
    const untouched = await deliveryRow(deliveryId);
    expect(untouched).toMatchObject({
      state: "pending",
      dispatchRequestId: expiredRequest.requestId,
      inputHash: null,
      reportOwnerInstanceId: null,
      reportedAt: null,
      turnId: null,
    });
    expect(untouched.dispatchPayload).not.toBeNull();

    // The worker's existing stale-window release then freezes a fresh attempt, and the same
    // receipt path verifies it normally. The unified semantics never strand the message.
    expect(await custody.releaseDeliveryDispatch(expiredRequest, expiredHash, "retry")).toBe("released");
    const freshRequest = {
      ...request,
      requestId: randomUUID(),
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const freshHash = computeDirectInputHash(freshRequest);
    expect(
      await custody.beginDeliveryDispatch(freshRequest, freshHash, {
        computerId: cloud.computerId,
        instanceId: connection.instanceId,
      }),
    ).toBe("dispatched");
    await owner.handleDeliveryReceived(connection, {
      deliveryId,
      requestId: expiredRequest.requestId,
      turnId: randomUUID(),
    });
    expect(await deliveryRow(deliveryId)).toMatchObject({
      state: "pending",
      dispatchRequestId: freshRequest.requestId,
      turnId: null,
    });
    expect(sent.filter((frame) => frame.type === "delivery:verified").at(-1)).toMatchObject({
      status: "rejected",
      code: "dispatch_unknown",
    });
    const retriedTurnId = randomUUID();
    await owner.handleDeliveryReceived(connection, {
      deliveryId,
      requestId: freshRequest.requestId,
      turnId: retriedTurnId,
    });
    expect(sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified")).toHaveLength(1);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", turnId: retriedTurnId });
    grants.close();
  });

  it("settles an accepted turn whose frozen window expired through the not_started cancellation flow", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, messageId, placementGeneration } = await pendingDelivery({ sessionId: scope.sessionId });
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration,
    });
    await owner.dispatchDelivery({
      computerId: cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    const turnId = randomUUID();
    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    expect((await deliveryRow(deliveryId)).state).toBe("accepted");

    // Custody is already accepted; only the frozen window lapses (rewound deterministically here).
    const expiredRequest = { ...request, deadlineAt: new Date(Date.now() - 60_000).toISOString() };
    const expiredHash = computeDirectInputHash(expiredRequest);
    await unit.database
      .update(imMessageDeliveries)
      .set({ dispatchPayload: expiredRequest, dispatchInputHash: expiredHash, inputHash: expiredHash })
      .where(eq(imMessageDeliveries.id, deliveryId));
    sent.length = 0;
    let reportLanded!: () => void;
    const reportRecorded = new Promise<void>((resolve) => {
      reportLanded = resolve;
    });
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:cancel") {
        setImmediate(() => {
          void owner
            .handleDeliveryReport(connection, {
              requestId: randomUUID(),
              report: cancelledBeforeStartReport(request, turnId),
            })
            .finally(reportLanded);
        });
      }
    };

    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });

    // Accepted work still settles truthfully as not_started through the explicit cancellation flow.
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(0);
    expect(sent.filter((frame) => frame.type === "delivery:cancel")).toHaveLength(1);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", turnId, reportedAt: null });
    await reportRecorded;
    const settled = await deliveryRow(deliveryId);
    expect(settled.turnReport).toMatchObject({ outcome: "cancelled", executionEffects: "not_started" });
    expect(await owner.recoverAccepted(deliveryId)).toBe("noop");
    grants.close();
  });

  it("revokes a preminted permission when the custody transition throws", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const hub = new RunnerHub();
    const fence = new CloudRuntimeFence();
    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const accept = custody.acceptDelivery.bind(custody);
    let failOnce = true;
    custody.acceptDelivery = (async (...args: Parameters<typeof accept>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("custody unavailable");
      }
      return accept(...args);
    }) as typeof custody.acceptDelivery;
    const grants = new CloudModelGrantService("unit-test-jwt-secret-at-least-32-characters", {
      catalog: createStaticCloudModelCatalog([MODEL]),
      maxStreamsPerToken: 2,
      ttlSeconds: 600,
    });
    const owner = new CloudDeliveryOwner({
      custody,
      database: unit.database,
      fence,
      hub,
      modelBaseUrl: "https://server.example.com/api/v1/cloud-model",
      modelGrants: grants,
    });
    const sent: RunnerServerFrame[] = [];
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
      computerId: cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    const issue = grants.issue.bind(grants);
    let issuedToken: string | undefined;
    grants.issue = async (input) => {
      const result = await issue(input);
      issuedToken = result?.token ?? issuedToken;
      return result;
    };

    await expect(
      owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId: randomUUID() }),
    ).rejects.toThrow("custody unavailable");

    // The preminted permission must not survive a failed custody transition.
    expect(issuedToken).toBeDefined();
    expect(await grants.verify(issuedToken as string)).toBeUndefined();
    grants.close();
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

  it("keeps a releasing allocation recoverable and records the real report instead of unknown", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, scope.sandboxId));
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "reported" }));
      }
    };

    // Releasing is not proof the allocation is destroyed: recovery waits for the journaled report
    // instead of settling a turn the Runner can still describe.
    expect(await owner.recoverAccepted(deliveryId)).toBe("pending");
    expect((await deliveryRow(deliveryId)).reportedAt).toBeNull();

    // The real report is still accepted while the allocation drains and is recorded exactly.
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report: turnReport(request, turnId) });
    const recorded = await deliveryRow(deliveryId);
    expect(recorded.turnReport).toMatchObject({ outcome: "completed", executionEffects: "completed" });
    expect(recorded.reportedAt).not.toBeNull();
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

  it("settles a receipt that committed after the stop selection via the Runner's not_started cancellation", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const hub = new RunnerHub();
    const fence = new CloudRuntimeFence();
    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const grants = new CloudModelGrantService("unit-test-jwt-secret-at-least-32-characters", {
      catalog: createStaticCloudModelCatalog([MODEL]),
      maxStreamsPerToken: 2,
      ttlSeconds: 600,
    });
    // Gate the acceptance commit so the explicit stop's SELECT runs while the row is still
    // pending: the receipt commits accepted AFTER the stop was decided.
    const accept = custody.acceptDelivery.bind(custody);
    let acceptEntered!: () => void;
    const accepting = new Promise<void>((resolve) => {
      acceptEntered = resolve;
    });
    let acceptRelease!: () => void;
    const acceptGate = new Promise<void>((resolve) => {
      acceptRelease = resolve;
    });
    custody.acceptDelivery = (async (...args: Parameters<typeof accept>) => {
      acceptEntered();
      await acceptGate;
      return accept(...args);
    }) as typeof custody.acceptDelivery;
    const owner = new CloudDeliveryOwner({
      custody,
      database: unit.database,
      fence,
      hub,
      modelBaseUrl: "https://server.example.com/api/v1/cloud-model",
      modelGrants: grants,
    });
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, messageId, placementGeneration } = await pendingDelivery({ sessionId: scope.sessionId });
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration,
    });
    await owner.dispatchDelivery({
      computerId: cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    const turnId = randomUUID();

    let reportSettled!: () => void;
    const reportLanded = new Promise<void>((resolve) => {
      reportSettled = resolve;
    });
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "received" }));
      }
      if (frame.type === "delivery:cancel") {
        // The real Client's cancel path: a received entry settles durably as a not_started report.
        setImmediate(() => {
          void owner
            .handleDeliveryReport(connection, {
              requestId: randomUUID(),
              report: cancelledBeforeStartReport(request, turnId),
            })
            .finally(reportSettled);
        });
      }
    };

    const receipt = owner.handleDeliveryReceived(connection, {
      deliveryId,
      requestId: request.requestId,
      turnId,
    });
    await accepting;
    // The explicit stop runs while the receipt is still uncommitted.
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, scope.sessionId));
    expect(await owner.cancelSessionDeliveries(scope.sessionId)).toEqual([]);
    acceptRelease();
    await receipt;

    // Verified was correctly suppressed, but the durable row is accepted and unreported on a
    // still-ready allocation with its exact current Runner connection.
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(0);
    const accepted = await deliveryRow(deliveryId);
    expect(accepted.state).toBe("accepted");
    expect(accepted.reportedAt).toBeNull();

    // Stopped recovery asks the authenticated current Runner to settle the never-started entry
    // through the same cancellation path an explicit stop uses, instead of looping on a reverify
    // that can never be authorized.
    expect(await owner.recoverAccepted(deliveryId)).toBe("pending");
    expect(sent.some((frame) => frame.type === "delivery:cancel")).toBe(true);
    await reportLanded;
    const settled = await deliveryRow(deliveryId);
    expect(settled.reportedAt).not.toBeNull();
    expect(settled.turnReport).toMatchObject({ outcome: "cancelled", executionEffects: "not_started" });
    // The loop is closed: a second recovery is a no-op and no execution permission was ever sent.
    expect(await owner.recoverAccepted(deliveryId)).toBe("noop");
    expect(sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified")).toHaveLength(0);
    grants.close();
  });

  it("resends cancel for a started turn whose authorization stopped, preserving its true report", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, scope.sessionId));
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "started" }));
      }
    };

    // The explicit stop's cancel was missed while the Runner was disconnected; recovery resends it
    // to the authenticated current Runner, which aborts and reports its real outcome.
    expect(await owner.recoverAccepted(deliveryId)).toBe("pending");
    expect(sent.some((frame) => frame.type === "delivery:cancel")).toBe(true);
    const stillRunning = await deliveryRow(deliveryId);
    expect(stillRunning).toMatchObject({ state: "accepted", reportedAt: null, turnReport: null });

    const cancelled = {
      ...cancelledBeforeStartReport(request, turnId),
      executionEffects: "may_have_occurred" as const,
    };
    await owner.handleDeliveryReport(connection, {
      requestId: randomUUID(),
      report: { ...cancelled, resultHash: computeTurnResultHash(cancelled) },
    });
    const settled = await deliveryRow(deliveryId);
    expect(settled.turnReport).toMatchObject({ outcome: "cancelled", executionEffects: "may_have_occurred" });
    grants.close();
  });

  it("rotates an accepted unfinished turn's permission on reconnect and keeps the old token invalid", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const firstVerified = sent.find((frame) => frame.type === "delivery:verified") as {
      model?: { token: string };
    };
    const firstToken = firstVerified.model?.token as string;
    expect(await grants.verify(firstToken)).toBeDefined();

    // The verified frame never reached the Runner: the control connection dropped, which revokes
    // the permission, while the durable journal entry is still `received`.
    owner.detachConnection(connection.connectionId);
    hub.detach(scope.sandboxId, socket);

    const retrySent: RunnerServerFrame[] = [];
    const replacement = attachReady(hub, fence, scope, retrySent, cloud.computerId);
    await owner.handleDeliveryReceived(replacement.connection, {
      deliveryId,
      requestId: request.requestId,
      turnId,
    });
    const verified = retrySent.find((frame) => frame.type === "delivery:verified") as {
      status: string;
      model?: { token: string };
    };
    expect(verified.status).toBe("verified");
    const rotatedToken = verified.model?.token as string;
    // A NEW generation, and the old tombstones never become valid again.
    expect(rotatedToken).not.toBe(firstToken);
    expect(await grants.verify(firstToken)).toBeUndefined();
    expect(await grants.verify(rotatedToken)).toMatchObject({ executionId: turnId });

    // One durable report revokes the rotated generation too.
    await owner.handleDeliveryReport(replacement.connection, {
      requestId: randomUUID(),
      report: turnReport(request, turnId),
    });
    expect(await grants.verify(rotatedToken)).toBeUndefined();
  });

  it("a stale in-flight receipt mint cannot take over or revoke the replacement connection's permission", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const old = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, messageId, placementGeneration } = await pendingDelivery({ sessionId: scope.sessionId });
    const request = deliveryRequest({
      deliveryId,
      messageId,
      sessionId: scope.sessionId,
      agentId: agent.id,
      placementGeneration,
    });
    await owner.dispatchDelivery({
      computerId: cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: old.connection.installationId,
      request,
    });
    const turnId = randomUUID();
    // Gate the OLD connection's mint so a replacement can mint and deliver first.
    let entered!: () => void;
    const minting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = grants.issue.bind(grants);
    let calls = 0;
    grants.issue = async (input) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return issue(input);
    };

    const previous = owner.handleDeliveryReceived(old.connection, { deliveryId, requestId: request.requestId, turnId });
    await minting;
    owner.detachConnection(old.connection.connectionId);
    hub.detach(scope.sandboxId, old.socket);

    const retrySent: RunnerServerFrame[] = [];
    const replacement = attachReady(hub, fence, scope, retrySent, cloud.computerId);
    await owner.handleDeliveryReceived(replacement.connection, {
      deliveryId,
      requestId: request.requestId,
      turnId,
    });
    const verified = retrySent.find((frame) => frame.type === "delivery:verified") as {
      status: string;
      model?: { token: string };
    };
    expect(verified.status).toBe("verified");
    const replacementToken = verified.model?.token as string;
    expect(await grants.verify(replacementToken)).toBeDefined();

    // The old connection's late completion reuses the replacement's token under the hood; it must
    // neither hand it back to the dead socket nor revoke the replacement's permission.
    release();
    await previous;
    expect(await grants.verify(replacementToken)).toMatchObject({ executionId: turnId });
    expect(retrySent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified")).toHaveLength(
      1,
    );
    expect(sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified")).toHaveLength(0);
  });

  it("a stale in-flight recovery mint cannot revoke the replacement connection's permission", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const originalToken = (sent.find((frame) => frame.type === "delivery:verified") as { model?: { token: string } })
      .model?.token as string;
    expect(await grants.verify(originalToken)).toBeDefined();

    let entered!: () => void;
    const minting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = grants.issue.bind(grants);
    let calls = 0;
    grants.issue = async (input) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return issue(input);
    };
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "received" }));
      }
    };

    // Recovery asks this connection's Runner about its journal; the answer starts a gated re-mint.
    const recovering = owner.recoverAccepted(deliveryId);
    await minting;
    owner.detachConnection(connection.connectionId);
    hub.detach(scope.sandboxId, socket);

    const retrySent: RunnerServerFrame[] = [];
    const replacement = attachReady(hub, fence, scope, retrySent, cloud.computerId);
    await owner.handleDeliveryReceived(replacement.connection, {
      deliveryId,
      requestId: request.requestId,
      turnId,
    });
    const verified = retrySent.find((frame) => frame.type === "delivery:verified") as {
      status: string;
      model?: { token: string };
    };
    expect(verified.status).toBe("verified");
    const replacementToken = verified.model?.token as string;

    release();
    expect(await recovering).toBe("pending");
    expect(await grants.verify(originalToken)).toBeUndefined();
    expect(await grants.verify(replacementToken)).toMatchObject({ executionId: turnId });
  });

  it("concurrent duplicate receipts on the same connection both verify without a spurious rejection", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const firstVerified = sent.find((frame) => frame.type === "delivery:verified") as { model?: { token: string } };
    const firstToken = firstVerified.model?.token as string;

    let entered!: () => void;
    const minting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = grants.issue.bind(grants);
    let calls = 0;
    grants.issue = async (input) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return issue(input);
    };

    const previous = owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    await minting;
    const current = owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    release();
    await previous;
    await current;

    const verified = sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "verified");
    const rejected = sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "rejected");
    expect(verified).toHaveLength(3);
    expect(rejected).toHaveLength(0);
    const lastToken = (verified[2] as { model?: { token: string } }).model?.token as string;
    expect(await grants.verify(lastToken)).toBeDefined();
    expect(await grants.verify(firstToken)).toBeDefined();
  });

  it("logs a sanitized diagnostic when a received re-verification mint fails", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const { hub, fence, owner, grants } = makeOwner({ logger });
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    grants.issue = async () => undefined;
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "received" }));
      }
    };
    sent.length = 0;

    const outcome = await owner.recoverAccepted(deliveryId);

    expect(outcome).toBe("pending");
    expect(warn).toHaveBeenCalledTimes(1);
    // Sanitized signal only: no token, request body, or raw upstream error in the bindings.
    expect(warn.mock.calls[0]?.[0]).toEqual({
      code: "CLOUD_DELIVERY_REVERIFY_MINT_FAILED",
      deliveryId,
      turnId,
    });
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(0);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", reportedAt: null });
  });

  it("does not send a stale rejection when a duplicate receipt's mint fails after the first duplicate accepted", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
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
      computerId: cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    const turnId = randomUUID();

    let entered!: () => void;
    const minting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      firstAccepted = resolve;
    });
    const issue = grants.issue.bind(grants);
    let calls = 0;
    grants.issue = async (input) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
        return issue(input);
      }
      // The duplicate's mint fails only after the first duplicate has accepted the turn; its
      // earlier custody classification is stale by then.
      await accepted;
      return undefined;
    };

    const previous = owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    await minting;
    const duplicate = owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    release();
    await previous;
    firstAccepted();
    await duplicate;

    const rejected = sent.filter((frame) => frame.type === "delivery:verified" && frame.status === "rejected");
    expect(rejected).toHaveLength(0);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted" });
  });

  it("cancels accepted received work on an inactive reconnect instead of rejecting it", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    const issue = grants.issue.bind(grants);
    let issueCalls = 0;
    grants.issue = async (input) => {
      issueCalls += 1;
      return issue(input);
    };
    sent.length = 0;
    // The authority chain is stopped: only the exact persisted allocation remains on the reconnect.
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, scope.sessionId));

    await owner.handleInactiveDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });

    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(0);
    expect(sent.filter((frame) => frame.type === "delivery:cancel")).toHaveLength(1);
    expect(issueCalls).toBe(0);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", reportedAt: null });
  });

  it("cancels accepted received work while the exact allocation is still releasing", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    sent.length = 0;
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, scope.sandboxId));

    await owner.handleInactiveDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });

    expect(sent.filter((frame) => frame.type === "delivery:cancel")).toHaveLength(1);
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(0);
  });

  it("rejects a fresh receipt on an inactive reconnect without cancel or custody", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
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
      computerId: cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    sent.length = 0;

    await owner.handleInactiveDeliveryReceived(connection, {
      deliveryId,
      requestId: request.requestId,
      turnId: randomUUID(),
    });

    expect(sent).toEqual([
      expect.objectContaining({ type: "delivery:verified", status: "rejected", code: "scope_inactive" }),
    ]);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "pending", reportedAt: null });
  });

  it("cancels accepted work for a releasing allocation even while the binding is paused", async () => {
    const { scope, agent, cloud, bindingId } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, bindingId));
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, scope.sandboxId));
    sent.length = 0;
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.type === "delivery:query") {
        setImmediate(() => owner.handleQueryResult(connection, { requestId: frame.requestId, phase: "started" }));
      }
    };

    // Recovery: a retiring allocation is an independent explicit stop, so the paused binding must
    // not suppress the truthful cancellation.
    expect(await owner.recoverAccepted(deliveryId)).toBe("pending");
    expect(sent.filter((frame) => frame.type === "delivery:cancel")).toHaveLength(1);
    sent.length = 0;

    // The report-only/inactive receipt path cancels the same way.
    await owner.handleInactiveDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    expect(sent.filter((frame) => frame.type === "delivery:cancel")).toHaveLength(1);
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(0);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", reportedAt: null, turnReport: null });
  });

  it("answers a completed receipt while paused and still acks its report replay", async () => {
    const { scope, agent, cloud, bindingId } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report: turnReport(request, turnId) });
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, bindingId));
    sent.length = 0;

    // Completed custody is terminal: the stale received entry is answered, never cancelled.
    await owner.handleInactiveDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    expect(sent).toEqual([
      expect.objectContaining({ type: "delivery:verified", status: "rejected", code: "dispatch_unknown" }),
    ]);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", reportedAt: expect.any(Date) });

    // The real report replay stays ackable (and idempotent) while the binding is paused.
    sent.length = 0;
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report: turnReport(request, turnId) });
    expect(sent.filter((frame) => frame.type === "delivery:report:ack")).toHaveLength(1);
    expect((sent[0] as { status: string }).status).toBe("already_recorded");
  });

  it("pauses accepted received work instead of cancelling it under reauthorization", async () => {
    const { scope, agent, cloud, bindingId } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    sent.length = 0;
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, bindingId));

    await owner.handleInactiveDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });

    // Transient reauthorization keeps the Runner's received evidence: no cancel, no rejection.
    expect(sent).toEqual([]);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", reportedAt: null });

    // A live receipt while paused must not mint execution permission for the same turn either.
    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    expect(sent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(0);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", reportedAt: null });
  });

  it("pauses a fresh received entry under reauthorization instead of rejecting the scope", async () => {
    const { scope, agent, cloud, bindingId } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
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
      computerId: cloud.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: connection.installationId,
      request,
    });
    sent.length = 0;
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, bindingId));

    await owner.handleInactiveDeliveryReceived(connection, {
      deliveryId,
      requestId: request.requestId,
      turnId: randomUUID(),
    });

    expect(sent).toEqual([]);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "pending", reportedAt: null });
  });

  it("cannot cancel accepted received work from a superseded allocation scope", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    sent.length = 0;
    await unit.database
      .update(sandboxes)
      .set({
        environmentGeneration: 2,
        currentResourceName: `${scope.resourceName}-new`,
        currentResourceUid: "superseded-inactive-uid",
      })
      .where(eq(sandboxes.id, scope.sandboxId));

    await owner.handleInactiveDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });

    expect(sent.filter((frame) => frame.type === "delivery:cancel")).toHaveLength(0);
    expect(sent).toEqual([
      expect.objectContaining({ type: "delivery:verified", status: "rejected", code: "stale_generation" }),
    ]);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", reportedAt: null });
  });

  it("cannot cancel accepted received work from a replaced connection", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner } = makeOwner();
    const oldSent: RunnerServerFrame[] = [];
    const old = attachReady(hub, fence, scope, oldSent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
      installationId: old.connection.installationId,
    });
    oldSent.length = 0;
    owner.detachConnection(old.connection.connectionId);
    hub.detach(scope.sandboxId, old.socket);
    const replacementSent: RunnerServerFrame[] = [];
    attachReady(hub, fence, scope, replacementSent, cloud.computerId);

    await owner.handleInactiveDeliveryReceived(old.connection, { deliveryId, requestId: request.requestId, turnId });

    expect(oldSent).toEqual([]);
    expect(replacementSent).toEqual([]);
    expect(await deliveryRow(deliveryId)).toMatchObject({ state: "accepted", reportedAt: null });
  });

  it("denies permission rotation after the Session ended and never re-mints a reported turn", async () => {
    const stopped = await cloudScope();
    const stoppedStack = makeOwner();
    const stoppedSent: RunnerServerFrame[] = [];
    const stoppedAttached = attachReady(
      stoppedStack.hub,
      stoppedStack.fence,
      stopped.scope,
      stoppedSent,
      stopped.cloud.computerId,
    );
    const stoppedDelivery = await dispatchAndAccept({
      owner: stoppedStack.owner,
      fence: stoppedStack.fence,
      scope: stopped.scope,
      agentId: stopped.agent.id,
      computerId: stopped.cloud.computerId,
    });
    stoppedStack.owner.detachConnection(stoppedAttached.connection.connectionId);
    stoppedStack.hub.detach(stopped.scope.sandboxId, stoppedAttached.socket);
    const trackedBefore = stoppedStack.grants.trackedGrantCount;
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, stopped.scope.sessionId));

    const deniedSent: RunnerServerFrame[] = [];
    const denied = attachReady(
      stoppedStack.hub,
      stoppedStack.fence,
      stopped.scope,
      deniedSent,
      stopped.cloud.computerId,
    );
    await stoppedStack.owner.handleDeliveryReceived(denied.connection, {
      deliveryId: stoppedDelivery.deliveryId,
      requestId: stoppedDelivery.request.requestId,
      turnId: stoppedDelivery.turnId,
    });
    expect(deniedSent.filter((frame) => frame.type === "delivery:verified")).toHaveLength(0);
    expect(stoppedStack.grants.trackedGrantCount).toBe(trackedBefore);
    expect((await deliveryRow(stoppedDelivery.deliveryId)).state).toBe("accepted");
    stoppedStack.grants.close();

    // A completed turn rejects the receipt before any mint: dispatch columns were cleared.
    const completed = await cloudScope();
    const completedStack = makeOwner();
    const completedSent: RunnerServerFrame[] = [];
    const completedAttached = attachReady(
      completedStack.hub,
      completedStack.fence,
      completed.scope,
      completedSent,
      completed.cloud.computerId,
    );
    const completedDelivery = await dispatchAndAccept({
      owner: completedStack.owner,
      fence: completedStack.fence,
      scope: completed.scope,
      agentId: completed.agent.id,
      computerId: completed.cloud.computerId,
    });
    await completedStack.owner.handleDeliveryReport(completedAttached.connection, {
      requestId: randomUUID(),
      report: turnReport(completedDelivery.request, completedDelivery.turnId),
    });
    const replaySent: RunnerServerFrame[] = [];
    const replay = attachReady(
      completedStack.hub,
      completedStack.fence,
      completed.scope,
      replaySent,
      completed.cloud.computerId,
    );
    await completedStack.owner.handleDeliveryReceived(replay.connection, {
      deliveryId: completedDelivery.deliveryId,
      requestId: completedDelivery.request.requestId,
      turnId: completedDelivery.turnId,
    });
    const replayVerified = replaySent.filter((frame) => frame.type === "delivery:verified");
    expect(replayVerified).toHaveLength(1);
    expect((replayVerified[0] as { status: string }).status).toBe("rejected");
    completedStack.grants.close();
  });

  it("a superseded socket's late teardown cannot revoke the replacement connection's permission", async () => {
    const { scope, agent, cloud } = await cloudScope();
    const { hub, fence, owner, grants } = makeOwner();
    const sent: RunnerServerFrame[] = [];
    const { socket, connection } = attachReady(hub, fence, scope, sent, cloud.computerId);
    const { deliveryId, request, turnId } = await dispatchAndAccept({
      owner,
      fence,
      scope,
      agentId: agent.id,
      computerId: cloud.computerId,
    });
    owner.detachConnection(connection.connectionId);
    hub.detach(scope.sandboxId, socket);

    const retrySent: RunnerServerFrame[] = [];
    const replacement = attachReady(hub, fence, scope, retrySent, cloud.computerId);
    await owner.handleDeliveryReceived(replacement.connection, {
      deliveryId,
      requestId: request.requestId,
      turnId,
    });
    const verified = retrySent.find((frame) => frame.type === "delivery:verified") as {
      status: string;
      model?: { token: string };
    };
    expect(verified.status).toBe("verified");
    const rotatedToken = verified.model?.token as string;
    expect(await grants.verify(rotatedToken)).toBeDefined();

    // The old socket's close handler runs late, after the replacement re-minted for the same turn.
    owner.detachConnection(connection.connectionId);
    expect(await grants.verify(rotatedToken)).toMatchObject({ executionId: turnId });
    expect((await deliveryRow(deliveryId)).reportedAt).toBeNull();
    // The replacement connection is still the exact owner and can still report normally.
    await owner.handleDeliveryReport(replacement.connection, {
      requestId: randomUUID(),
      report: turnReport(request, turnId),
    });
    expect((await deliveryRow(deliveryId)).reportedAt).not.toBeNull();
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
    await owner.handleDeliveryReport(connection, { requestId: randomUUID(), report: turnReport(request, turnId) });
    const verifiedBefore = sent.filter(
      (frame) => frame.type === "delivery:verified" && frame.status === "verified",
    ).length;
    const issue = grants.issue.bind(grants);
    let issueCalls = 0;
    grants.issue = async (input) => {
      issueCalls += 1;
      return issue(input);
    };
    await owner.handleDeliveryReceived(connection, { deliveryId, requestId: request.requestId, turnId });
    const verifiedAfter = sent.filter(
      (frame) => frame.type === "delivery:verified" && frame.status === "verified",
    ).length;
    expect(verifiedAfter).toBe(verifiedBefore);
    // Completed custody must never rotate or mint a permission for the stale replay.
    expect(issueCalls).toBe(0);
    grants.close();
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
