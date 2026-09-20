import { randomUUID } from "node:crypto";
import type { RunnerCloudSessionMessageReceivedFrame, RunnerServerFrame } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  runtimeDurableWork,
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

async function deliveryInput(
  fixture: CloudFixture,
  messageId: string,
  attemptCount = 1,
): Promise<CloudSessionDeliveryInput> {
  const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
  return {
    attemptCount,
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
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);

    // The Runner's exact terminal result is committed once and acked, which is what clears it.
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId, "cancelled"));
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
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
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
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

  it("cancels a re-announced started Turn on a stopped Session and acks its real settlement", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // The Session stops while the Turn is running; the Runner reconnects mid-Turn and re-announces.
    await db.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, fixture.sessionId));
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "started",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });

    // Cancellation is requested and nothing else: no rejection (the Runner ignores it for a
    // started entry) and, above all, no conflicting terminal state that could strand the real
    // settlement. Custody stays accepted-unfinished until the Turn's truthful outcome arrives.
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    expect(attach.sent.some((frame) => frame.type === "session:message:verified")).toBe(false);
    const [pending] = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(pending).toMatchObject({ status: "accepted" });
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);

    // The Turn's real settle is committed once and acked; only then do barrier and busy clear.
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId, "cancelled"));
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("answers a report-only re-announcement on a releasing allocation with cancellation", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });

    // The allocation starts draining before the Runner's verified arrived; the Runner reconnects
    // report-only (no execution permission) and re-announces its received entry. Silence here
    // would strand the entry and time out the release drain.
    await db.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, fixture.sandboxId));
    const reportOnly = await attachRunner(stack, fixture, { executionEligible: false });
    await stack.owner.handleReceived(reportOnly.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(reportOnly.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    expect(reportOnly.sent.some((frame) => frame.type === "session:message:verified")).toBe(false);

    // The entry settles truthfully as cancelled and is acked, which retires custody and the busy
    // picture so the release drain can finish.
    await stack.owner.handleSettled(reportOnly.connection, settleFrame(messageId, "cancelled"));
    expect(reportOnly.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
    void attach;
  });

  it("never replays a retired record after allocation loss, even when the Turn provably never started", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    const oldVerified = attach.sent.find(
      (frame): frame is Extract<RunnerServerFrame, { type: "session:message:verified" }> =>
        frame.type === "session:message:verified",
    );
    if (!oldVerified?.model) throw new Error("missing minted grant");

    // The Instance is lost before the Turn settled: the old allocation is authoritatively retired.
    // `failed/allocation_retired` proves only that the allocation was lost while unsettled — even
    // for this received-never-verified entry the record cannot prove non-execution, so it is
    // immutable evidence and never a replay permit.
    const nextResourceName = `${fixture.scope.resourceName}-next`;
    await db.database
      .update(sandboxes)
      .set({ environmentGeneration: 2, currentResourceName: nextResourceName })
      .where(eq(sandboxes.id, fixture.sandboxId));
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(1);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
    const grantsBefore = stack.grants.trackedGrantCount;

    // The duplicate logical message reaches the replacement Runner, which journals a new Turn:
    // custody is refused, the Runner's fresh entry is retired with a rejection, no fresh grant is
    // minted, and the terminal record is untouched — the same accepted message can never run twice.
    const retryScope = { ...fixture.scope, environmentGeneration: 2, resourceName: nextResourceName };
    const retry = await attachRunner(
      stack,
      { ...fixture, scope: retryScope },
      {
        onFrame: (frame) => {
          if (frame.type !== "session:message:run") return;
          const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
          if (!connection) return;
          void stack.owner.handleReceived(connection, {
            messageId,
            phase: "received",
            requestId: frame.requestId,
            status: "accepted",
            turnId: "turn-retry",
            type: "session:message:received",
          });
        },
      },
    );
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId, 2), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(retry.sent).toContainEqual(
      expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
    );
    expect(stack.grants.trackedGrantCount).toBe(grantsBefore);
    expect(stack.owner.isSandboxBusy(retryScope)).toBe(false);
    const records = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "failed" });
    if (!records[0]) throw new Error("durable record missing");
    expect((records[0].lastError as { code?: string } | null)?.code).toBe("allocation_retired");
    expect((records[0].payload as { turnId?: string }).turnId).toBe(`turn-${messageId}`);
    // The replaced allocation is not pinned by the retired attempt, and the old grant is dead.
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
    await expect(stack.grants.verify(oldVerified.model.token)).resolves.toBeUndefined();
  });

  it("never authorizes a duplicate of a started Turn whose allocation was lost before settlement", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    // The Turn started on the Runner and may have performed external effects before the Instance
    // disappeared. The durable state after reconcile is the same `failed/allocation_retired` as
    // for a never-started entry — which is exactly why replay is forbidden.
    const nextResourceName = `${fixture.scope.resourceName}-next`;
    await db.database
      .update(sandboxes)
      .set({ environmentGeneration: 2, currentResourceName: nextResourceName })
      .where(eq(sandboxes.id, fixture.sandboxId));
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(1);
    const grantsBefore = stack.grants.trackedGrantCount;

    const retryScope = { ...fixture.scope, environmentGeneration: 2, resourceName: nextResourceName };
    const retry = await attachRunner(
      stack,
      { ...fixture, scope: retryScope },
      {
        onFrame: (frame) => {
          if (frame.type !== "session:message:run") return;
          const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
          if (!connection) return;
          void stack.owner.handleReceived(connection, {
            messageId,
            phase: "received",
            requestId: frame.requestId,
            status: "accepted",
            turnId: "turn-retry",
            type: "session:message:received",
          });
        },
      },
    );
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId, 2), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    // No new grant and no second execution; the fresh journal entry is retired.
    expect(stack.grants.trackedGrantCount).toBe(grantsBefore);
    expect(stack.owner.isSandboxBusy(retryScope)).toBe(false);
    expect(retry.sent).toContainEqual(
      expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
    );
    expect(retry.sent.some((frame) => frame.type === "session:message:verified" && frame.status === "verified")).toBe(
      false,
    );
    const [record] = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(record).toMatchObject({ status: "failed" });
    if (!record) throw new Error("durable record missing");
    expect((record.lastError as { code?: string } | null)?.code).toBe("allocation_retired");
  });

  it("replaces a superseded never-started record when a retry re-journals with changed input", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const revokeSpy = vi.spyOn(stack.grants, "revokeExecution");
    // The verified frame is lost in transit: custody is committed but the Turn never starts, and
    // the Runner's entry waits at `received`.
    const droppingSocket: RunnerControlSocket = {
      send(frame) {
        if (frame.type === "session:message:verified" && frame.status === "verified") return;
        const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
        if (frame.type === "session:message:run" && connection) {
          void stack.owner.handleReceived(connection, {
            messageId,
            phase: "received",
            requestId: frame.requestId,
            status: "accepted",
            turnId: `turn-${messageId}`,
            type: "session:message:received",
          });
        }
      },
      close() {
        // no-op
      },
    };
    stack.hub.attach(fixture.scope, droppingSocket);
    stack.hub.markReady(fixture.scope, READINESS, droppingSocket);
    stack.fence.attach({
      computerId: fixture.computerId,
      installationId: randomUUID(),
      scope: fixture.scope,
      socket: droppingSocket,
      sessionCollaborationEligible: true,
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    const [accepted] = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(accepted).toMatchObject({ status: "accepted" });

    // The retry re-journals the message as a new Turn (the Runner retired the stale received
    // entry whose input had changed): the same-allocation, never-started record is replaced — not
    // borrowed — so the new Turn can settle and be acked.
    const retry = await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type !== "session:message:run") return;
        const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
        if (!connection) return;
        void stack.owner.handleReceived(connection, {
          messageId,
          phase: "received",
          requestId: frame.requestId,
          status: "accepted",
          turnId: "turn-second",
          type: "session:message:received",
        });
      },
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId, 2), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    const records = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(records).toHaveLength(1);
    if (!records[0]) throw new Error("durable record missing");
    expect((records[0].payload as { turnId?: string }).turnId).toBe("turn-second");
    // The superseded Turn's grant died with its custody.
    expect(revokeSpy).toHaveBeenCalledWith(`turn-${messageId}`);

    await stack.owner.handleSettled(retry.connection, {
      messageId,
      outcome: "completed",
      requestId: randomUUID(),
      turnId: "turn-second",
      type: "session:message:settled",
    });
    expect(retry.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("never lets a late old receipt overwrite the current attempt or clear its occupancy", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    // Attempt 1's verified frame is lost in transit: custody T1 is committed but never started.
    const droppingSocket: RunnerControlSocket = {
      send(frame) {
        if (frame.type === "session:message:verified" && frame.status === "verified") return;
        const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
        if (frame.type === "session:message:run" && connection) {
          void stack.owner.handleReceived(connection, {
            messageId,
            phase: "received",
            requestId: frame.requestId,
            status: "accepted",
            turnId: `turn-${messageId}`,
            type: "session:message:received",
          });
        }
      },
      close() {
        // no-op
      },
    };
    stack.hub.attach(fixture.scope, droppingSocket);
    stack.hub.markReady(fixture.scope, READINESS, droppingSocket);
    stack.fence.attach({
      computerId: fixture.computerId,
      installationId: randomUUID(),
      scope: fixture.scope,
      socket: droppingSocket,
      sessionCollaborationEligible: true,
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });

    // Attempt 2 on the SAME allocation re-journals the message as a new Turn: the superseded
    // never-started record is replaced (compare-and-set) and T2 becomes the live attempt.
    const retry = await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type !== "session:message:run") return;
        const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
        if (!connection) return;
        void stack.owner.handleReceived(connection, {
          messageId,
          phase: "received",
          requestId: frame.requestId,
          status: "accepted",
          turnId: "turn-second",
          type: "session:message:received",
        });
      },
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId, 2), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    retry.sent.length = 0;

    // A stale receipt for the SUPERSEDED Turn arrives late on the current connection: it is
    // retired with a rejection, never re-verified into a second execution, and the live attempt's
    // busy registration and custody record stay exactly as they were.
    await stack.owner.handleReceived(retry.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    await vi.waitFor(() =>
      expect(retry.sent).toContainEqual(
        expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
      ),
    );
    expect(
      retry.sent.filter((frame) => frame.type === "session:message:verified" && frame.status === "verified"),
    ).toHaveLength(0);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
    const [record] = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(record).toMatchObject({ status: "accepted" });
    if (!record) throw new Error("durable record missing");
    expect((record.payload as { turnId?: string }).turnId).toBe("turn-second");

    // A late settlement for the superseded Turn is never committed or acked; the live attempt's
    // record and occupancy are untouched.
    await stack.owner.handleSettled(retry.connection, {
      messageId,
      outcome: "completed",
      requestId: randomUUID(),
      turnId: `turn-${messageId}`,
      type: "session:message:settled",
    });
    expect(retry.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);

    // The live attempt settles and clears normally.
    await stack.owner.handleSettled(retry.connection, {
      messageId,
      outcome: "completed",
      requestId: randomUUID(),
      turnId: "turn-second",
      type: "session:message:settled",
    });
    expect(retry.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("preserves custody a concurrent re-announcement registered when the redispatch fails", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);

    // A redispatch attempt registers its own unassigned busy entry, then the connection drops
    // before any receipt: the failed attempt must release NOTHING — the accepted Turn's merged
    // registration (turnId) is live custody, not the failed dispatch's property.
    let captured = false;
    const gated = await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type === "session:message:run") captured = true;
      },
    });
    const redelivering = stack.owner.deliver(await deliveryInput(fixture, messageId, 2), allowAdmission);
    await vi.waitFor(() => expect(captured).toBe(true), { timeout: 2_000 });
    stack.owner.detachConnection(gated.connection.connectionId);
    await expect(redelivering).resolves.toEqual({ status: "unreachable", code: "runtime_not_ready" });

    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
    expect(stack.work.trackedMessages(fixture.sandboxId)).toEqual([{ messageId, turnId: `turn-${messageId}` }]);
    // The durable barrier and the accepted outcome are likewise untouched by the failed attempt.
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
    const [message] = await db.database.select().from(sessionMessages).where(eq(sessionMessages.id, messageId));
    expect(message?.lastOutcome).toBe("accepted");

    // The accepted Turn still settles and clears normally.
    const restored = await attachRunner(stack, fixture);
    await stack.owner.handleSettled(restored.connection, settleFrame(messageId));
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
    void attach;
  });

  it("refuses to borrow a terminal duplicate record instead of reviving it", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    const grantsBefore = stack.grants.trackedGrantCount;
    attach.sent.length = 0;

    // A redispatch under a brand-new Turn (a Runner that re-journaled the message) meets the
    // terminal record: custody is refused, the Runner's entry is retired, and no new permission
    // is minted — the already-executed message can never run a second time.
    const second = await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type !== "session:message:run") return;
        const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
        if (!connection) return;
        void stack.owner.handleReceived(connection, {
          messageId,
          phase: "received",
          requestId: frame.requestId,
          status: "accepted",
          turnId: "turn-second",
          type: "session:message:received",
        });
      },
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId, 2), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(second.sent).toContainEqual(
      expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
    );
    expect(stack.grants.trackedGrantCount).toBe(grantsBefore);
    const [record] = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(record).toMatchObject({ status: "succeeded" });
  });

  it("clears the busy tracker only for the exact retired Turn", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
    // A newer attempt's registration for another message must survive the retirement sweep.
    const otherMessage = randomUUID();
    stack.work.register(fixture.scope, otherMessage, "turn-other");

    await db.database
      .update(sandboxes)
      .set({ environmentGeneration: 2, currentResourceName: `${fixture.scope.resourceName}-next` })
      .where(eq(sandboxes.id, fixture.sandboxId));
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(1);
    expect(stack.work.trackedMessages(fixture.sandboxId)).toEqual([{ messageId: otherMessage, turnId: "turn-other" }]);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
    stack.work.settle(fixture.scope, otherMessage);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("refuses custody when an idle claim committed before the receipt boundary", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    let answer: (() => void) | undefined;
    const attach = await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type !== "session:message:run") return;
        answer = () => answeringOnFrame(stack, fixture)(frame);
      },
    });
    const delivering = stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
    await vi.waitFor(() => expect(answer).toBeDefined(), { timeout: 2_000 });

    // An idle claim wins the Sandbox row lock before the receipt arrives: the claim's busy and
    // barrier checks legitimately saw nothing. Custody must now fail closed so the reclaim drain
    // converges and the source retries, instead of accepting work onto a sealed environment.
    await db.database.update(sandboxes).set({ idleReclaimAt: new Date() }).where(eq(sandboxes.id, fixture.sandboxId));
    answer?.();
    await expect(delivering).resolves.toEqual({ status: "unreachable", code: "runtime_not_ready" });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({
        code: "environment_reclaimed",
        status: "rejected",
        type: "session:message:verified",
      }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
    const [message] = await db.database.select().from(sessionMessages).where(eq(sessionMessages.id, messageId));
    expect(message?.lastOutcome).toBe("unknown");
  });

  it("correlates a same-input retry by its new request identity and settles against it", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const requestIds: string[] = [];
    const attach = await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type !== "session:message:run") return;
        requestIds.push(frame.requestId);
        // The Runner re-correlates its journaled entry to the newest attempt, so the receipt
        // carries this dispatch's request id while the Turn identity stays stable.
        answeringOnFrame(stack, fixture)(frame);
      },
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId, 2), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    const verified = attach.sent.filter(
      (frame): frame is Extract<RunnerServerFrame, { type: "session:message:verified" }> =>
        frame.type === "session:message:verified" && frame.status === "verified",
    );
    expect(verified.at(-1)?.requestId).toBe(requestIds[1]);
    // One custody record, one Turn: the retry was an idempotent re-acceptance, not new work.
    const records = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(records).toHaveLength(1);

    // The settlement carries the re-correlated request id (never the bare message id); it is
    // committed and acked against the exact Turn and allocation.
    const retryRequestId = requestIds[1] as string;
    await stack.owner.handleSettled(attach.connection, {
      messageId,
      outcome: "completed",
      requestId: retryRequestId,
      turnId: `turn-${messageId}`,
      type: "session:message:settled",
    });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({
        messageId,
        requestId: retryRequestId,
        status: "recorded",
        type: "session:message:settled:ack",
      }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("never retires accepted custody on a transient durable read failure", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const store = new PostgresRuntimeDurableWorkStore(db.database);
    // Exactly the next durable read fails; everything else uses the real store.
    let failReads = 0;
    const stack = makeStack(fixture, {
      durableWork: {
        read: async (computerId, kind, key) => {
          if (failReads > 0) {
            failReads -= 1;
            throw new Error("transient read failure");
          }
          return store.read(computerId, kind, key);
        },
        write: (computerId, record) => store.write(computerId, record),
        replaceSessionMessageRecord: (computerId, expected, record) =>
          store.replaceSessionMessageRecord(computerId, expected, record),
      },
    });
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });

    // The Runner re-announces its received entry (a reconnect) while exactly one durable read
    // fails: the error must surface to the connection handler instead of becoming a false
    // proven-absence rejection that deletes the Runner's journal and strands the barrier.
    failReads = 1;
    attach.sent.length = 0;
    await expect(
      stack.owner.handleReceived(attach.connection, {
        messageId,
        phase: "received",
        requestId: randomUUID(),
        status: "accepted",
        turnId: `turn-${messageId}`,
        type: "session:message:received",
      }),
    ).rejects.toThrow("transient read failure");
    expect(attach.sent).toEqual([]);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
    const [record] = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(record).toMatchObject({ status: "accepted" });

    // The retained entry re-announces after the failure (the reconnected Runner): verification,
    // settlement and ack converge normally.
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    await vi.waitFor(() =>
      expect(attach.sent).toContainEqual(
        expect.objectContaining({ status: "verified", type: "session:message:verified" }),
      ),
    );
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("clears the allocation convergence race timer once convergence wins", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    // A cold Sandbox: the dispatch must converge the allocation before it can send.
    await db.database
      .update(sandboxes)
      .set({ lifecycle: "preparing", currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, fixture.sandboxId));
    const hub = new RunnerHub();
    const fence = new CloudRuntimeFence();
    const work = new CloudSessionWorkTracker();
    const grants = new CloudModelGrantService(JWT_SECRET, {
      allowedModels: [MODEL],
      maxStreamsPerToken: 2,
      ttlSeconds: 600,
    });
    const owner = new CloudSessionCollaborationOwner({
      allocation: {
        ensureEnvironmentAllocated: async () => {
          await db.database
            .update(sandboxes)
            .set({ lifecycle: "ready", currentResourceName: fixture.scope.resourceName })
            .where(eq(sandboxes.id, fixture.sandboxId));
          return "ready";
        },
        ensureSandbox: async () => ({ accountId: fixture.accountId, sandboxId: fixture.sandboxId }),
      },
      assembler: new EffectiveRuntimeSnapshotAssembler(db.database),
      database: db.database,
      durableWork: new PostgresRuntimeDurableWorkStore(db.database),
      ensureTimeoutMs: 60_000,
      fence,
      hub,
      modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
      modelGrants: grants,
      work,
    });
    const sent: RunnerServerFrame[] = [];
    const socket: RunnerControlSocket = {
      send(frame) {
        sent.push(frame);
        if (frame.type === "session:message:run") {
          const connection = fence.connectionForSandbox(fixture.sandboxId);
          if (!connection) return;
          void owner.handleReceived(connection, {
            messageId,
            phase: "received",
            requestId: frame.requestId,
            status: "accepted",
            turnId: `turn-${messageId}`,
            type: "session:message:received",
          });
        }
      },
      close() {
        // no-op
      },
    };
    hub.attach(fixture.scope, socket);
    hub.markReady(fixture.scope, READINESS, socket);
    fence.attach({
      computerId: fixture.computerId,
      installationId: randomUUID(),
      scope: fixture.scope,
      sessionCollaborationEligible: true,
      socket,
    });

    vi.useFakeTimers();
    try {
      const baseline = vi.getTimerCount();
      await expect(owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
        status: "accepted",
      });
      // Close the grant service's own sweep interval so only a leaked dispatch/convergence timer
      // could keep the count above baseline after the dispatch fully resolved.
      grants.close();
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
    void sent;
  });
});
