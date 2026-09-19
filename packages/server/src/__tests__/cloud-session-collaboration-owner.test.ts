import { randomUUID } from "node:crypto";
import type { RunnerCloudSessionMessageReceivedFrame, RunnerServerFrame } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  sandboxes,
  sessionMessages,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import type { RuntimeDispatchAdmission } from "../runtime/runtime-domain-owner.js";
import { PostgresRuntimeDurableWorkStore } from "../runtime/runtime-durable-work-store.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import { EffectiveRuntimeSnapshotAssembler } from "../services/runtime-config/index.js";
import { CloudModelGrantService } from "../services/sandboxes/cloud-model-grants.js";
import { type CloudConnectionRecord, CloudRuntimeFence } from "../services/sandboxes/cloud-runtime-fence.js";
import {
  CloudSessionCollaborationOwner,
  type CloudSessionDeliveryInput,
  CloudSessionWorkTracker,
  createSessionCliCloudProofAuthority,
} from "../services/sandboxes/cloud-session-collaboration-owner.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../services/sandboxes/runner-hub.js";
import { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";
import type { AuthorizedSessionMessageRoute } from "../services/sessions/session-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * E8 Cloud Session collaboration owner against the unit PostgreSQL: custody ordering, capability
 * gating, registry-backed proof binding, terminal ack, durable reclaim barrier, FIFO and
 * duplicate-receipt behavior.
 */

const MODEL = "fixture-cloud-model";
const JWT_SECRET = "unit-test-jwt-secret-at-least-32-characters";
const READINESS = {
  sandboxName: "ots-s-unit-1",
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: "0.0.5",
  reportedAt: new Date().toISOString(),
};

let db: UnitDatabase;

beforeAll(async () => {
  db = await createUnitDatabase();
}, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.reset();
});

interface CloudFixture {
  accountId: string;
  agentId: string;
  bindingId: string;
  computerId: string;
  sessionId: string;
  sandboxId: string;
  scope: RunnerScope;
}

async function seedCloudSession(): Promise<CloudFixture> {
  const accountId = randomUUID();
  const computerId = randomUUID();
  await db.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "E8" });
  await db.database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: "cloud",
    currentInstallationId: randomUUID(),
    currentInstanceId: randomUUID(),
    displayName: "Cloud",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.5",
  });
  const [agent] = await db.database
    .insert(agents)
    .values({
      createdByUserId: accountId,
      computerId,
      name: `e8-${randomUUID().slice(0, 8)}`,
      displayName: "E8 Agent",
      runtimeProvider: "pi",
    })
    .returning();
  if (!agent) throw new Error("agent fixture missing");
  await db.database
    .insert(agentRuntimeConfigs)
    .values({ agentId: agent.id, instructions: "Agent instructions.", model: MODEL });
  const [binding] = await db.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: `unit-app-${randomUUID().slice(0, 8)}`,
      externalBotId: "unit-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "unit-only-unused",
      activatedAt: new Date(),
    })
    .returning();
  if (!binding) throw new Error("binding fixture missing");
  const sessionId = randomUUID();
  await db.database.insert(sessions).values({
    id: sessionId,
    imBindingId: binding.id,
    channelId: "unit-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  await db.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  const sandboxId = randomUUID();
  const resourceName = `projects/unit/locations/us-west1/instances/ots-s-${sandboxId.slice(0, 8)}-1`;
  await db.database.insert(sandboxes).values({
    id: sandboxId,
    sessionId,
    storageUri: `gs://unit-cloud/${sandboxId}`,
    lifecycle: "ready",
    environmentGeneration: 1,
    currentResourceName: resourceName,
    currentResourceUid: `unit-uid-${sandboxId.slice(0, 8)}`,
  });
  return {
    accountId,
    agentId: agent.id,
    bindingId: binding.id,
    computerId,
    sandboxId,
    sessionId,
    scope: { environmentGeneration: 1, resourceName, sandboxId, sessionId },
  };
}

interface Stack {
  fence: CloudRuntimeFence;
  grants: CloudModelGrantService;
  hub: RunnerHub;
  owner: CloudSessionCollaborationOwner;
  proofs: SessionCliProofService;
  recordMessageOutcome: (input: { messageId: string }) => Promise<boolean>;
  registry: RuntimeExecutionRegistry;
  sessions: { recordMessageOutcome: (input: { messageId: string }) => Promise<boolean> };
  work: CloudSessionWorkTracker;
}

function makeStack(
  fixture: CloudFixture,
  overrides: {
    durableWork?: ConstructorParameters<typeof CloudSessionCollaborationOwner>[0]["durableWork"];
    modelGrants?: ConstructorParameters<typeof CloudSessionCollaborationOwner>[0]["modelGrants"];
    recordMessageOutcome?: (input: { messageId: string }) => Promise<boolean>;
  } = {},
): Stack {
  const hub = new RunnerHub();
  const fence = new CloudRuntimeFence();
  const registry = new RuntimeExecutionRegistry();
  const work = new CloudSessionWorkTracker();
  const grants = new CloudModelGrantService(JWT_SECRET, {
    allowedModels: [MODEL],
    maxStreamsPerToken: 2,
    ttlSeconds: 600,
  });
  const proofs = new SessionCliProofService(
    db.database,
    { currentInstanceId: () => undefined, supportsCapability: () => false },
    new Uint8Array(32).fill(9),
    { cloud: createSessionCliCloudProofAuthority({ fence, registry }) },
  );
  const recordMessageOutcome =
    overrides.recordMessageOutcome ??
    (async (input: { messageId: string }) => {
      await db.database
        .update(sessionMessages)
        .set({ lastOutcome: "accepted" })
        .where(eq(sessionMessages.id, input.messageId));
      return true;
    });
  const owner = new CloudSessionCollaborationOwner({
    assembler: new EffectiveRuntimeSnapshotAssembler(db.database),
    database: db.database,
    ...(overrides.durableWork !== undefined
      ? { durableWork: overrides.durableWork }
      : { durableWork: new PostgresRuntimeDurableWorkStore(db.database) }),
    fence,
    hub,
    modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
    modelGrants: overrides.modelGrants ?? grants,
    proofs,
    sessions: { recordMessageOutcome },
    work,
  });
  void fixture;
  return {
    fence,
    grants,
    hub,
    owner,
    proofs,
    recordMessageOutcome,
    registry,
    sessions: { recordMessageOutcome },
    work,
  };
}

async function attachRunner(
  stack: Stack,
  fixture: CloudFixture,
  options: {
    executionEligible?: boolean;
    onFrame?: (frame: RunnerServerFrame) => void;
    sessionCollaborationEligible?: boolean;
  } = {},
): Promise<{ connection: CloudConnectionRecord; sent: RunnerServerFrame[]; socket: RunnerControlSocket }> {
  const sent: RunnerServerFrame[] = [];
  const socket: RunnerControlSocket = {
    send(frame) {
      sent.push(frame);
      options.onFrame?.(frame);
    },
    close() {
      // no-op
    },
  };
  stack.hub.attach(fixture.scope, socket);
  stack.hub.markReady(fixture.scope, READINESS, socket);
  const connection = stack.fence.attach({
    computerId: fixture.computerId,
    installationId: randomUUID(),
    scope: fixture.scope,
    socket,
    executionEligible: options.executionEligible !== false,
    sessionCollaborationEligible: options.sessionCollaborationEligible !== false,
  });
  return { connection, sent, socket };
}

/** Open the actual credential execution the proof will be correlated with. */
function openExecution(
  stack: Stack,
  fixture: CloudFixture,
  connection: CloudConnectionRecord,
  messageId = randomUUID(),
) {
  return stack.registry.open({
    accountId: fixture.accountId,
    agentId: fixture.agentId,
    agentRevision: 1,
    computerId: fixture.computerId,
    computerKind: "cloud",
    connectionId: connection.connectionId,
    instanceId: connection.instanceId,
    placementGeneration: 1,
    providers: new Map(),
    purpose: "execution",
    runId: randomUUID(),
    sandbox: {
      environmentGeneration: fixture.scope.environmentGeneration,
      resourceUid: "unit-resource-uid",
      sandboxId: fixture.sandboxId,
    },
    sessionId: fixture.sessionId,
    source: { kind: "session-message", messageId },
  });
}

/** Answer the next `session:message:run` on the current fence connection with a journaled receipt. */
function answeringOnFrame(stack: Stack, fixture: CloudFixture, phase: "received" | "started" = "received") {
  return (frame: RunnerServerFrame) => {
    if (frame.type !== "session:message:run") return;
    const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
    if (!connection) return;
    void stack.owner.handleReceived(connection, {
      messageId: frame.message.messageId,
      phase,
      requestId: frame.requestId,
      status: "accepted",
      turnId: `turn-${frame.message.messageId}`,
      type: "session:message:received",
    });
  };
}

function routeFor(fixture: CloudFixture): AuthorizedSessionMessageRoute {
  return {
    agentId: fixture.agentId,
    imBindingId: fixture.bindingId,
    sourceComputerId: fixture.computerId,
    sourceConnectionInstanceId: randomUUID(),
    sourcePlacementGeneration: 1,
    sourceSessionId: fixture.sessionId,
    targetComputerId: fixture.computerId,
    targetComputerKind: "cloud",
    targetInstallationId: randomUUID(),
    targetPlacementGeneration: 1,
    targetSessionId: fixture.sessionId,
    targetSessionKind: "channel",
    targetCreatorSessionId: null,
  };
}

const allowAdmission: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame> = async (operation) => ({
  admitted: true,
  result: Promise.resolve(await operation(() => undefined)),
});

async function deliveryInput(fixture: CloudFixture, messageId: string): Promise<CloudSessionDeliveryInput> {
  const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
  return {
    attemptCount: 1,
    message: { content: "continue the task", id: messageId },
    route: routeFor(fixture),
    runtime,
  };
}

async function insertMessage(messageId: string, fixture: CloudFixture): Promise<void> {
  await db.database.insert(sessionMessages).values({
    id: messageId,
    sourceSessionId: fixture.sessionId,
    targetSessionId: fixture.sessionId,
    content: "continue the task",
    contentHash: "a".repeat(64),
    attemptCount: 1,
    lastAttemptAt: new Date(),
  });
}

function settleFrame(messageId: string, outcome: "completed" | "failed" | "cancelled" | "unknown" = "completed") {
  return {
    messageId,
    outcome,
    requestId: messageId,
    turnId: `turn-${messageId}`,
    type: "session:message:settled" as const,
  };
}

describe("CloudSessionCollaborationOwner", () => {
  it("records durable custody and the accepted outcome before publishing execution permission", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    let releaseOutcome: () => void = () => undefined;
    const outcomeGate = new Promise<void>((resolve) => {
      releaseOutcome = resolve;
    });
    const order: string[] = [];
    const stack = makeStack(fixture, {
      recordMessageOutcome: async (input) => {
        await outcomeGate;
        order.push("accepted-outcome");
        await db.database
          .update(sessionMessages)
          .set({ lastOutcome: "accepted" })
          .where(eq(sessionMessages.id, input.messageId));
        return true;
      },
    });
    let connection: CloudConnectionRecord;
    await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type === "session:message:run") {
          order.push("custody-write");
          void stack.owner.handleReceived(connection, {
            messageId,
            phase: "received",
            requestId: frame.requestId,
            status: "accepted",
            turnId: "turn-1",
            type: "session:message:received",
          });
        }
        if (frame.type === "session:message:verified") order.push("verified");
      },
    });
    connection = stack.fence.connectionForSandbox(fixture.sandboxId) as CloudConnectionRecord;
    const delivering = stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);

    await vi.waitFor(() => expect(order).toContain("custody-write"), { timeout: 2_000 });
    // The outcome commit is still gated: permission must NOT be published yet.
    expect(order).not.toContain("accepted-outcome");
    expect(order).not.toContain("verified");
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);

    releaseOutcome();
    await expect(delivering).resolves.toEqual({ status: "accepted" });
    expect(order.indexOf("accepted-outcome")).toBeLessThan(order.indexOf("verified"));
  });

  it("never sends a session frame to a legacy E7 connection and leaves IM behavior untouched", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const { sent } = await attachRunner(stack, fixture, { sessionCollaborationEligible: false });
    const outcome = await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
    expect(outcome).toEqual({ status: "unreachable", code: "runtime_not_ready" });
    expect(sent.filter((frame) => frame.type.startsWith("session:message"))).toEqual([]);
    expect(sent.some((frame) => frame.type === "delivery:verified")).toBe(false);
  });

  it("re-reads the configuration at the permission boundary and refuses a stale frozen snapshot", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type !== "session:message:run") return;
        // A long cold-start wait spanned a configuration change before the receipt arrived.
        void db.database
          .update(agentRuntimeConfigs)
          .set({ instructions: "Replaced instructions.", revision: 999 })
          .where(eq(agentRuntimeConfigs.agentId, fixture.agentId))
          .then(() => answeringOnFrame(stack, fixture)(frame));
      },
    });
    const outcome = await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
    expect(outcome).toEqual({ status: "unreachable", code: "stale_configuration" });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ code: "stale_configuration", status: "rejected", type: "session:message:verified" }),
    );
    // No custody was published for the refused attempt.
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
  });

  it("binds the proof to the actual execution: a queued execution never rotates an active one", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const { connection } = await attachRunner(stack, fixture);
    const executionA = openExecution(stack, fixture, connection);
    const proofA = await stack.proofs.mintCloud({
      computerId: fixture.computerId,
      connectionId: connection.connectionId,
      executionId: executionA.executionId,
      placementGeneration: 1,
      sandboxId: fixture.sandboxId,
      sessionId: fixture.sessionId,
    });
    await expect(stack.proofs.authenticate(proofA.token)).resolves.toMatchObject({ sessionId: fixture.sessionId });

    // A queued Turn opens its own execution while A is still live: the same proof is reused.
    const executionB = openExecution(stack, fixture, connection);
    const proofB = await stack.proofs.mintCloud({
      computerId: fixture.computerId,
      connectionId: connection.connectionId,
      executionId: executionB.executionId,
      placementGeneration: 1,
      sandboxId: fixture.sandboxId,
      sessionId: fixture.sessionId,
    });
    expect(proofB.proofId).toBe(proofA.proofId);
    await expect(stack.proofs.authenticate(proofA.token)).resolves.toMatchObject({ sessionId: fixture.sessionId });

    // A closes first: B's execution keeps the shared proof live.
    stack.registry.close(executionA.executionId, "execution_closed");
    await expect(stack.proofs.authenticate(proofA.token)).resolves.toMatchObject({ sessionId: fixture.sessionId });

    // Last execution closes: the proof dies on the actual registry close, never on a timer.
    stack.registry.close(executionB.executionId, "execution_closed");
    await expect(stack.proofs.authenticate(proofA.token)).rejects.toMatchObject({ code: "invalid_proof" });

    // A later Turn mints a fresh proof; the old token can never revive.
    const executionC = openExecution(stack, fixture, connection);
    const proofC = await stack.proofs.mintCloud({
      computerId: fixture.computerId,
      connectionId: connection.connectionId,
      executionId: executionC.executionId,
      placementGeneration: 1,
      sandboxId: fixture.sandboxId,
      sessionId: fixture.sessionId,
    });
    expect(proofC.proofId).not.toBe(proofA.proofId);
    await expect(stack.proofs.authenticate(proofA.token)).rejects.toMatchObject({ code: "invalid_proof" });
    await expect(stack.proofs.authenticate(proofC.token)).resolves.toMatchObject({ sessionId: fixture.sessionId });
  });

  it("rejects report-only and replaced connections for proof and dispatch authority", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const first = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    const execution = openExecution(stack, fixture, first.connection);
    const proof = await stack.proofs.mintCloud({
      computerId: fixture.computerId,
      connectionId: first.connection.connectionId,
      executionId: execution.executionId,
      placementGeneration: 1,
      sandboxId: fixture.sandboxId,
      sessionId: fixture.sessionId,
    });
    await expect(stack.proofs.authenticate(proof.token)).resolves.toMatchObject({ sessionId: fixture.sessionId });

    // Replacing the attach (report-only) invalidates the exact connection binding.
    await attachRunner(stack, fixture, { executionEligible: false });
    await expect(stack.proofs.authenticate(proof.token)).rejects.toMatchObject({ code: "invalid_proof" });
    const nextMessage = randomUUID();
    await insertMessage(nextMessage, fixture);
    await expect(stack.owner.deliver(await deliveryInput(fixture, nextMessage), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
  });

  it("keeps sibling Sessions independent for proof and execution authority", async () => {
    const first = await seedCloudSession();
    const second = await seedCloudSession();
    const stack = makeStack(first);
    const firstAttach = await attachRunner(stack, first);
    const secondAttach = await attachRunner(stack, second);
    const firstExecution = openExecution(stack, first, firstAttach.connection);
    const secondExecution = openExecution(stack, second, secondAttach.connection);
    const firstProof = await stack.proofs.mintCloud({
      computerId: first.computerId,
      connectionId: firstAttach.connection.connectionId,
      executionId: firstExecution.executionId,
      placementGeneration: 1,
      sandboxId: first.sandboxId,
      sessionId: first.sessionId,
    });
    const secondProof = await stack.proofs.mintCloud({
      computerId: second.computerId,
      connectionId: secondAttach.connection.connectionId,
      executionId: secondExecution.executionId,
      placementGeneration: 1,
      sandboxId: second.sandboxId,
      sessionId: second.sessionId,
    });
    await expect(stack.proofs.authenticate(firstProof.token)).resolves.toMatchObject({ sessionId: first.sessionId });
    await expect(stack.proofs.authenticate(secondProof.token)).resolves.toMatchObject({ sessionId: second.sessionId });

    // Revoking the first Session's proof never touches the sibling.
    await stack.proofs.revokeForSession(first.sessionId);
    await expect(stack.proofs.authenticate(firstProof.token)).rejects.toMatchObject({ code: "invalid_proof" });
    await expect(stack.proofs.authenticate(secondProof.token)).resolves.toMatchObject({ sessionId: second.sessionId });
  });

  it("acks only an exact durable terminal commit and replays it idempotently", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });

    // A settle for a message with no durable record is never falsely acked.
    await stack.owner.handleSettled(attach.connection, settleFrame(randomUUID()));
    expect(attach.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);

    // A mismatched turn id is not this record's terminal evidence.
    await stack.owner.handleSettled(attach.connection, { ...settleFrame(messageId), turnId: "turn-other" });
    expect(attach.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);

    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    expect(attach.sent).toContainEqual(
      expect.objectContaining({
        messageId,
        status: "recorded",
        turnId: `turn-${messageId}`,
        type: "session:message:settled:ack",
      }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);

    // The Runner replays its immutable terminal result until acked: the second answer is
    // `already_recorded` for the identical outcome, and never a second execution.
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    const acks = attach.sent.filter((frame) => frame.type === "session:message:settled:ack");
    expect(acks).toHaveLength(2);
    expect(acks[1]).toMatchObject({ status: "already_recorded" });

    // A conflicting outcome for an already-terminal record is never overwritten or acked.
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId, "failed"));
    expect(attach.sent.filter((frame) => frame.type === "session:message:settled:ack")).toHaveLength(2);
  });

  it("retires accepted work only when its allocation is authoritatively gone", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    const allocation = {
      environmentGeneration: fixture.scope.environmentGeneration,
      resourceName: fixture.scope.resourceName,
      sandboxId: fixture.sandboxId,
    };
    await expect(stack.owner.hasUnsettledSessionWork({ allocation, sessionId: fixture.sessionId })).resolves.toBe(true);
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(0);

    // The Instance was replaced: the recorded allocation can never execute again.
    const nextResourceName = `${fixture.scope.resourceName}-next`;
    await db.database
      .update(sandboxes)
      .set({ environmentGeneration: 2, currentResourceName: nextResourceName })
      .where(eq(sandboxes.id, fixture.sandboxId));
    await expect(
      stack.owner.hasUnsettledSessionWork({
        allocation: { environmentGeneration: 2, resourceName: nextResourceName, sandboxId: fixture.sandboxId },
        sessionId: fixture.sessionId,
      }),
    ).resolves.toBe(false);
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(1);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);

    // A late replay from the old Turn is never re-executed and gets no false ack.
    attach.sent.length = 0;
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: messageId,
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    await vi.waitFor(() =>
      expect(attach.sent).toContainEqual(
        expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
      ),
    );
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    expect(attach.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);
  });

  it("requests cancellation without clearing accepted work and acks the exact cancelled result", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
    attach.sent.length = 0;

    const outcomes = await stack.owner.cancelSessionMessages(fixture.sessionId);
    expect(outcomes).toEqual([{ messageId, status: "requested" }]);
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    // A sent request is not drain evidence: the durable barrier and busy picture stay in place.
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
    expect(stack.owner.isSandboxBusy(fixture.sandboxId)).toBe(true);

    // The Runner's exact terminal result is committed once and acked, which is what clears it.
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId, "cancelled"));
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.sandboxId)).toBe(false);
  });

  it("retains the barrier when cancellation cannot be sent", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);

    // No exact connection remains: a request that cannot be handed over is not termination.
    stack.fence.detachSandbox(fixture.sandboxId);
    const disconnected = await stack.owner.cancelSessionMessages(fixture.sessionId);
    expect(disconnected).toEqual([{ messageId, status: "no_connection" }]);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);

    // A connection whose socket fails the send reports `send_failed`, still without clearing.
    const failingSocket: RunnerControlSocket = {
      send(frame) {
        if (frame.type === "session:message:cancel") throw new Error("control channel closed");
      },
      close() {
        // no-op
      },
    };
    stack.hub.attach(fixture.scope, failingSocket);
    stack.hub.markReady(fixture.scope, READINESS, failingSocket);
    stack.fence.attach({
      computerId: fixture.computerId,
      installationId: randomUUID(),
      scope: fixture.scope,
      sessionCollaborationEligible: true,
      socket: failingSocket,
    });
    const failed = await stack.owner.cancelSessionMessages(fixture.sessionId);
    expect(failed).toEqual([{ messageId, status: "send_failed" }]);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("requests cancellation for durable-only work after a Server restart", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
    attach.sent.length = 0;

    // A restarted Server has no in-memory picture; the durable envelope is the only source of
    // the message id and Turn, so the stop must still request cancellation for it.
    stack.work.clearSandbox(fixture.sandboxId);
    const outcomes = await stack.owner.cancelSessionMessages(fixture.sessionId);
    expect(outcomes).toEqual([{ messageId, status: "requested" }]);
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("converges a cancelled request once the allocation is authoritatively retired", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
    await expect(stack.owner.cancelSessionMessages(fixture.sessionId)).resolves.toEqual([
      { messageId, status: "requested" },
    ]);

    // The Instance is retired before any Runner terminal result arrives.
    const nextResourceName = `${fixture.scope.resourceName}-next`;
    await db.database
      .update(sandboxes)
      .set({ environmentGeneration: 2, currentResourceName: nextResourceName })
      .where(eq(sandboxes.id, fixture.sandboxId));
    await expect(
      stack.owner.hasUnsettledSessionWork({
        allocation: { environmentGeneration: 2, resourceName: nextResourceName, sandboxId: fixture.sandboxId },
        sessionId: fixture.sessionId,
      }),
    ).resolves.toBe(false);
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(1);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);

    // A late cancelled result can no longer be acked against the retired record.
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId, "cancelled"));
    expect(attach.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);
  });

  it("serializes same-Session dispatches in call order and cleans the dispatch tail", async () => {
    const fixture = await seedCloudSession();
    const firstMessage = randomUUID();
    const secondMessage = randomUUID();
    await insertMessage(firstMessage, fixture);
    await insertMessage(secondMessage, fixture);
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let outcomeCalls = 0;
    const stack = makeStack(fixture, {
      recordMessageOutcome: async (input) => {
        outcomeCalls += 1;
        if (outcomeCalls === 1) await firstGate;
        await db.database
          .update(sessionMessages)
          .set({ lastOutcome: "accepted" })
          .where(eq(sessionMessages.id, input.messageId));
        return true;
      },
    });
    const runOrder: string[] = [];
    await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type !== "session:message:run") return;
        runOrder.push(frame.message.messageId);
        answeringOnFrame(stack, fixture)(frame);
      },
    });
    const deliveries = [
      stack.owner.deliver(await deliveryInput(fixture, firstMessage), allowAdmission),
      stack.owner.deliver(await deliveryInput(fixture, secondMessage), allowAdmission),
    ];
    await vi.waitFor(() => expect(runOrder).toEqual([firstMessage]), { timeout: 2_000 });
    releaseFirst();
    await expect(Promise.all(deliveries)).resolves.toEqual([{ status: "accepted" }, { status: "accepted" }]);
    expect(runOrder).toEqual([firstMessage, secondMessage]);
    await vi.waitFor(() => expect(stack.owner.activeDispatchTargets).toBe(0));
  });

  it("keeps accepted work as the reclaim barrier after the in-memory picture expires", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
    // The approximate in-memory picture is gone (restart): the durable record still blocks.
    stack.work.clearSandbox(fixture.sandboxId);
    expect(stack.owner.isSandboxBusy(fixture.sandboxId)).toBe(false);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("cleans the serialized tail after an unexpected dispatch failure", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture, {
      durableWork: {
        read: async () => undefined,
        write: async () => undefined,
      },
      modelGrants: {
        defaultModel: MODEL,
        isModelAllowed: () => true,
        issue: async () => {
          throw new Error("mint exploded");
        },
        revokeExecution: () => 0,
      },
    });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).rejects.toThrow(
      "mint exploded",
    );
    await vi.waitFor(() => expect(stack.owner.activeDispatchTargets).toBe(0));
  });
});
