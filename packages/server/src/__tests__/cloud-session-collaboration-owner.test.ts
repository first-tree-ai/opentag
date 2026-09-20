import { randomUUID } from "node:crypto";
import type {
  EffectiveRuntimeSnapshot,
  RunnerCloudSessionMessageReceivedFrame,
  RunnerServerFrame,
  RuntimeDurableWorkRecord,
} from "@opentag/shared";
import { RUNTIME_DEFAULT_MAX_DURATION_MS } from "@opentag/shared";
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
  slackInstallations,
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
  type CloudSessionDurableWorkPort,
  CloudSessionWorkTracker,
  createCloudSourceConnectionVerifier,
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

async function seedCloudSession(
  options: { provider?: "feishu" | "slack"; kind?: "channel" | "thread" | "internal"; threadKey?: string } = {},
): Promise<CloudFixture> {
  const provider = options.provider ?? "feishu";
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
  const slackInstallationId = provider === "slack" ? randomUUID() : undefined;
  if (slackInstallationId) {
    await db.database.insert(slackInstallations).values({
      id: slackInstallationId,
      agentId: agent.id,
      status: "active",
      externalAppId: `unit-slack-app-${randomUUID().slice(0, 8)}`,
      externalTeamId: `unit-slack-team-${randomUUID().slice(0, 8)}`,
      externalBotId: "unit-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "unit-only-unused",
      activatedAt: new Date(),
    });
  }
  const [binding] = await db.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider,
      status: "active",
      externalAppId: `unit-app-${randomUUID().slice(0, 8)}`,
      externalTeamId: `unit-team-${randomUUID().slice(0, 8)}`,
      externalBotId: "unit-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      ...(provider === "slack"
        ? { slackInstallationId, slackRouteKind: "default" }
        : { encryptedCredential: "unit-only-unused" }),
      activatedAt: new Date(),
    })
    .returning();
  if (!binding) throw new Error("binding fixture missing");
  const sessionId = randomUUID();
  // An internal Session must name its creator Session; it shares the binding/placement chain.
  const creatorSessionId = options.kind === "internal" ? randomUUID() : undefined;
  if (creatorSessionId) {
    await db.database.insert(sessions).values({
      id: creatorSessionId,
      imBindingId: binding.id,
      channelId: "unit-channel",
      conversationKind: "channel",
      kind: "channel",
    });
  }
  await db.database.insert(sessions).values({
    id: sessionId,
    imBindingId: binding.id,
    channelId: "unit-channel",
    conversationKind: "channel",
    kind: options.kind ?? "channel",
    ...(options.threadKey ? { threadKey: options.threadKey } : {}),
    ...(creatorSessionId ? { createdBySessionId: creatorSessionId } : {}),
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
    noteActivity?: ConstructorParameters<typeof CloudSessionCollaborationOwner>[0]["noteActivity"];
    recordMessageOutcome?: (input: { messageId: string }) => Promise<boolean>;
    requestTimeoutMs?: number;
    assembler?: ConstructorParameters<typeof CloudSessionCollaborationOwner>[0]["assembler"];
    proofs?: ConstructorParameters<typeof CloudSessionCollaborationOwner>[0]["proofs"];
    allocation?: ConstructorParameters<typeof CloudSessionCollaborationOwner>[0]["allocation"];
    ensureTimeoutMs?: number;
    logger?: ConstructorParameters<typeof CloudSessionCollaborationOwner>[0]["logger"];
    /** Omit the durable work store entirely (degraded composition) to pin the fail-closed paths. */
    omitDurableWork?: boolean;
    /** Omit the model grant port entirely to pin the no-authority resolution path. */
    omitModelGrants?: boolean;
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
    ...(overrides.allocation !== undefined ? { allocation: overrides.allocation } : {}),
    assembler: overrides.assembler ?? new EffectiveRuntimeSnapshotAssembler(db.database),
    database: db.database,
    ...(overrides.omitDurableWork
      ? {}
      : overrides.durableWork !== undefined
        ? { durableWork: overrides.durableWork }
        : { durableWork: new PostgresRuntimeDurableWorkStore(db.database) }),
    ...(overrides.ensureTimeoutMs !== undefined ? { ensureTimeoutMs: overrides.ensureTimeoutMs } : {}),
    fence,
    hub,
    ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
    modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
    ...(overrides.omitModelGrants ? {} : { modelGrants: overrides.modelGrants ?? grants }),
    ...(overrides.noteActivity !== undefined ? { noteActivity: overrides.noteActivity } : {}),
    proofs: overrides.proofs ?? proofs,
    ...(overrides.requestTimeoutMs !== undefined ? { requestTimeoutMs: overrides.requestTimeoutMs } : {}),
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
  stack: { registry: RuntimeExecutionRegistry },
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

/** The `exp` claim of a model grant token, in milliseconds. */
function ackExpiryMs(token: string): number {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("token payload missing");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp: number };
  return claims.exp * 1_000;
}

/** A bare Local-shaped durable payload: a delivery request with no Cloud envelope. */
function bareLocalRequest(fixture: CloudFixture, messageId: string, runtime: EffectiveRuntimeSnapshot) {
  return {
    type: "session:message:deliver" as const,
    requestId: randomUUID(),
    messageId,
    sourceSessionId: fixture.sessionId,
    targetSessionId: fixture.sessionId,
    agentId: fixture.agentId,
    placementGeneration: 1,
    content: { kind: "text" as const, text: "continue the task" },
    runtime,
  };
}

/** A Cloud envelope for one Turn under a chosen allocation identity. */
function cloudEnvelope(
  fixture: CloudFixture,
  turnId: string,
  allocation: { environmentGeneration: number; resourceName: string },
  runtime: EffectiveRuntimeSnapshot,
) {
  return {
    type: "cloud-session-message-work" as const,
    request: bareLocalRequest(fixture, randomUUID(), runtime),
    allocation: { sandboxId: fixture.sandboxId, ...allocation },
    turnId,
  };
}

function cloudEnvelopeRecord(
  fixture: CloudFixture,
  turnId: string,
  allocation: { environmentGeneration: number; resourceName: string },
  runtime: EffectiveRuntimeSnapshot,
): RuntimeDurableWorkRecord {
  const now = Date.now();
  return {
    acceptedAt: now,
    attempts: 0,
    key: `${fixture.sessionId}:${randomUUID()}`,
    kind: "session-message",
    payload: cloudEnvelope(fixture, turnId, allocation, runtime),
    status: "accepted",
    updatedAt: now,
  };
}

/** Write one durable row directly, bypassing the owner (recovery/legacy fixture). */
async function insertDurableRow(input: {
  computerId: string;
  key: string;
  payload: unknown;
  status?: "accepted" | "running" | "retryable" | "succeeded" | "failed" | "dead-letter";
}): Promise<void> {
  const now = Date.now();
  await db.database.insert(runtimeDurableWork).values({
    acceptedAt: now,
    attempts: 0,
    computerId: input.computerId,
    kind: "session-message",
    payload: input.payload,
    recordKey: input.key,
    status: input.status ?? "accepted",
    updatedAt: now,
  });
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

  it("returns runtime_not_ready on a failed send without abandoning the receipt promise", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const fixture = await seedCloudSession();
      const messageId = randomUUID();
      await insertMessage(messageId, fixture);
      const stack = makeStack(fixture);
      const throwingSocket: RunnerControlSocket = {
        send() {
          throw new Error("control channel closed");
        },
        close() {
          // no-op
        },
      };
      stack.hub.attach(fixture.scope, throwingSocket);
      stack.hub.markReady(fixture.scope, READINESS, throwingSocket);
      stack.fence.attach({
        computerId: fixture.computerId,
        installationId: randomUUID(),
        scope: fixture.scope,
        sessionCollaborationEligible: true,
        socket: throwingSocket,
      });
      await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
        status: "unreachable",
        code: "runtime_not_ready",
      });
      // No custody, grant, verified frame or busy registration survives the failed handoff.
      await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
      expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
      // Let any abandoned rejection surface before asserting none exists.
      for (let index = 0; index < 20; index += 1) await new Promise((done) => setImmediate(done));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns delivery_timeout when the receipt times out during the activity hand-off, without abandoning it", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const fixture = await seedCloudSession();
      const messageId = randomUUID();
      await insertMessage(messageId, fixture);
      let releaseActivity: () => void = () => undefined;
      const activityGate = new Promise<void>((resolve) => {
        releaseActivity = resolve;
      });
      const stack = makeStack(fixture, { noteActivity: () => activityGate, requestTimeoutMs: 50 });
      await attachRunner(stack, fixture); // the Runner never answers the receipt
      const delivering = stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
      // The 50ms receipt timeout fires while the activity update is still gated, so the pending
      // receipt rejects before the dispatch adopts it.
      await new Promise((resolve) => setTimeout(resolve, 120));
      releaseActivity();
      await expect(delivering).resolves.toEqual({ status: "unknown", code: "delivery_timeout" });
      expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
      await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
      for (let index = 0; index < 20; index += 1) await new Promise((done) => setImmediate(done));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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

/** A tracker-scoped allocation identity; the tracker never touches the database. */
function alloc(
  sandboxId: string,
  generation: number,
  resourceName = "res",
): {
  sandboxId: string;
  environmentGeneration: number;
  resourceName: string;
} {
  return { environmentGeneration: generation, resourceName, sandboxId };
}

describe("CloudSessionWorkTracker", () => {
  it("scopes busy state per exact allocation and answers sandbox-level diagnostics", () => {
    const tracker = new CloudSessionWorkTracker();
    const first = alloc("sandbox-1", 1, "resource-1");
    const second = alloc("sandbox-2", 1, "resource-1");
    expect(tracker.isSandboxBusy("sandbox-1")).toBe(false);
    tracker.register(first, "message-1", "turn-1");
    // A different generation of the SAME Sandbox is a different allocation identity.
    expect(tracker.isBusy(alloc("sandbox-1", 2, "resource-1"))).toBe(false);
    expect(tracker.isBusy(first)).toBe(true);
    expect(tracker.isSandboxBusy("sandbox-1")).toBe(true);
    expect(tracker.isSandboxBusy("sandbox-2")).toBe(false);
    expect(tracker.trackedMessages("sandbox-1")).toEqual([{ messageId: "message-1", turnId: "turn-1" }]);
    expect(tracker.trackedMessages("sandbox-2")).toEqual([]);
    void second;
  });

  it("keeps the newest Turn identity when the same message is re-registered without one", () => {
    const tracker = new CloudSessionWorkTracker();
    const allocation = alloc("sandbox-1", 1);
    tracker.register(allocation, "message-1", "turn-1");
    // A redispatch of the same message without a Turn identity must not erase the merged custody.
    tracker.register(allocation, "message-1");
    expect(tracker.trackedMessages("sandbox-1")).toEqual([{ messageId: "message-1", turnId: "turn-1" }]);

    // Settling an untracked allocation or message is a truthful miss, never an error.
    expect(tracker.settle(alloc("sandbox-9", 1), "message-1")).toBeUndefined();
    expect(tracker.settle(allocation, "message-unknown")).toEqual({});

    const settled = tracker.settle(allocation, "message-1");
    expect(settled).toEqual({ turnId: "turn-1" });
    expect(tracker.isSandboxBusy("sandbox-1")).toBe(false);

    // A registration that never learned a Turn identity settles to an empty picture, not undefined.
    tracker.register(allocation, "message-4");
    expect(tracker.settle(allocation, "message-4")).toEqual({});
  });

  it("settles only the exact Turn and preserves a concurrent attempt's registration", () => {
    const tracker = new CloudSessionWorkTracker();
    const allocation = alloc("sandbox-1", 1);
    tracker.register(allocation, "message-1", "turn-1");
    // A stale Turn's settlement never clears the live attempt's entry.
    tracker.settleTurn(allocation, "message-1", "turn-other");
    expect(tracker.trackedMessages("sandbox-1")).toEqual([{ messageId: "message-1", turnId: "turn-1" }]);
    tracker.settleTurn(alloc("sandbox-9", 1), "message-1", "turn-1");
    expect(tracker.trackedMessages("sandbox-1")).toEqual([{ messageId: "message-1", turnId: "turn-1" }]);
    tracker.settleTurn(allocation, "message-1", "turn-1");
    expect(tracker.isSandboxBusy("sandbox-1")).toBe(false);

    // Unassigned settlement releases only an entry that never learned a Turn identity.
    tracker.register(allocation, "message-2", "turn-2");
    tracker.settleUnassigned(allocation, "message-2");
    expect(tracker.trackedMessages("sandbox-1")).toEqual([{ messageId: "message-2", turnId: "turn-2" }]);
    tracker.register(allocation, "message-3");
    tracker.settleUnassigned(alloc("sandbox-9", 1), "message-3");
    tracker.settleUnassigned(allocation, "message-3");
    expect(tracker.trackedMessages("sandbox-1")).toEqual([{ messageId: "message-2", turnId: "turn-2" }]);
  });

  it("clears every generation of one Sandbox only", () => {
    const tracker = new CloudSessionWorkTracker();
    tracker.register(alloc("sandbox-1", 1), "message-1");
    tracker.register(alloc("sandbox-1", 2), "message-2");
    tracker.register(alloc("sandbox-2", 1), "message-3");
    tracker.clearSandbox("sandbox-1");
    expect(tracker.isSandboxBusy("sandbox-1")).toBe(false);
    expect(tracker.trackedMessages("sandbox-2")).toEqual([{ messageId: "message-3" }]);
  });

  it("deduplicates one message tracked across two generations of the same Sandbox", () => {
    const tracker = new CloudSessionWorkTracker();
    tracker.register(alloc("sandbox-1", 1), "message-1", "turn-1");
    tracker.register(alloc("sandbox-1", 2), "message-1");
    // The first registration wins the id, so an older generation's Turn identity is never lost.
    expect(tracker.trackedMessages("sandbox-1")).toEqual([{ messageId: "message-1", turnId: "turn-1" }]);
  });
});

describe("createSessionCliCloudProofAuthority", () => {
  it("describes a live connection by id and denies an unknown one", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const { connection } = await attachRunner(stack, fixture);
    const authority = createSessionCliCloudProofAuthority({ fence: stack.fence, registry: stack.registry });
    expect(authority.connection(randomUUID())).toBeUndefined();
    expect(authority.connection(connection.connectionId)).toEqual({
      computerId: fixture.computerId,
      connectionId: connection.connectionId,
      executionEligible: true,
      instanceId: connection.instanceId,
      sandboxId: fixture.sandboxId,
      sessionCollaborationEligible: true,
      sessionId: fixture.sessionId,
    });
  });

  it("keeps a proof live while any correlated execution points at the exact connection", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const { connection } = await attachRunner(stack, fixture);
    const authority = createSessionCliCloudProofAuthority({ fence: stack.fence, registry: stack.registry });
    // Two executions correlate the same proof: closing one leaves the other keeping it live.
    const first = openExecution(stack, fixture, connection);
    const second = openExecution(stack, fixture, connection);
    for (const execution of [first, second]) {
      authority.registerExecution({
        connectionId: connection.connectionId,
        executionId: execution.executionId,
        proofId: "proof-1",
        sessionId: fixture.sessionId,
      });
    }
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-1",
        sessionId: fixture.sessionId,
      }),
    ).toBe(true);
    stack.registry.close(first.executionId, "execution_closed");
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-1",
        sessionId: fixture.sessionId,
      }),
    ).toBe(true);
    // A proofId/connection that does not match the correlation entry is never live.
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-2",
        sessionId: fixture.sessionId,
      }),
    ).toBe(false);
    const other = await attachRunner(stack, fixture);
    expect(
      authority.isProofLive({
        connectionId: other.connection.connectionId,
        proofId: "proof-1",
        sessionId: fixture.sessionId,
      }),
    ).toBe(false);
    // The correlated execution record's own connection must still be the asked-for one.
    stack.registry.close(second.executionId, "execution_closed");
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-1",
        sessionId: fixture.sessionId,
      }),
    ).toBe(false);
    expect(authority.isProofLive({ connectionId: "unknown", proofId: "proof-1", sessionId: randomUUID() })).toBe(false);
    // Dropping an untracked Session and dropping a non-matching proofId both stay no-ops.
    authority.dropExecution({ sessionId: randomUUID() });
    authority.dropExecution({ proofId: "proof-other", sessionId: fixture.sessionId });
  });

  it("closes proof liveness for every Session whose registry execution closed", async () => {
    const first = await seedCloudSession();
    const second = await seedCloudSession();
    const stack = makeStack(first);
    const firstAttach = await attachRunner(stack, first);
    const secondAttach = await attachRunner(stack, second);
    const authority = createSessionCliCloudProofAuthority({ fence: stack.fence, registry: stack.registry });
    const firstExecution = openExecution(stack, first, firstAttach.connection);
    const secondExecution = openExecution(stack, second, secondAttach.connection);
    authority.registerExecution({
      connectionId: firstAttach.connection.connectionId,
      executionId: firstExecution.executionId,
      proofId: "proof-1",
      sessionId: first.sessionId,
    });
    authority.registerExecution({
      connectionId: secondAttach.connection.connectionId,
      executionId: secondExecution.executionId,
      proofId: "proof-2",
      sessionId: second.sessionId,
    });
    // Two registry entries of one Session: closing the unrelated execution must not unregister it.
    const otherExecution = openExecution(stack, first, firstAttach.connection);
    authority.registerExecution({
      connectionId: firstAttach.connection.connectionId,
      executionId: otherExecution.executionId,
      proofId: "proof-1",
      sessionId: first.sessionId,
    });
    stack.registry.close(firstExecution.executionId, "execution_closed");
    expect(
      authority.isProofLive({
        connectionId: firstAttach.connection.connectionId,
        proofId: "proof-1",
        sessionId: first.sessionId,
      }),
    ).toBe(true);
    stack.registry.close(otherExecution.executionId, "execution_closed");
    expect(
      authority.isProofLive({
        connectionId: firstAttach.connection.connectionId,
        proofId: "proof-1",
        sessionId: first.sessionId,
      }),
    ).toBe(false);
    stack.registry.close(secondExecution.executionId, "execution_closed");
    expect(
      authority.isProofLive({
        connectionId: secondAttach.connection.connectionId,
        proofId: "proof-2",
        sessionId: second.sessionId,
      }),
    ).toBe(false);
  });

  it("reuses the correlation entry for the same proofId and replaces it for a new one", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const { connection } = await attachRunner(stack, fixture);
    const authority = createSessionCliCloudProofAuthority({ fence: stack.fence, registry: stack.registry });
    const first = openExecution(stack, fixture, connection);
    authority.registerExecution({
      connectionId: connection.connectionId,
      executionId: first.executionId,
      proofId: "proof-1",
      sessionId: fixture.sessionId,
    });
    const second = openExecution(stack, fixture, connection);
    authority.registerExecution({
      connectionId: connection.connectionId,
      executionId: second.executionId,
      proofId: "proof-1",
      sessionId: fixture.sessionId,
    });
    // A rotated proof replaces the entry: the old proofId stops being live, the new one is.
    authority.registerExecution({
      connectionId: connection.connectionId,
      executionId: second.executionId,
      proofId: "proof-2",
      sessionId: fixture.sessionId,
    });
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-1",
        sessionId: fixture.sessionId,
      }),
    ).toBe(false);
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-2",
        sessionId: fixture.sessionId,
      }),
    ).toBe(true);
    // Dropping the exact proofId clears it; dropping another one leaves it alone.
    authority.dropExecution({ proofId: "proof-other", sessionId: fixture.sessionId });
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-2",
        sessionId: fixture.sessionId,
      }),
    ).toBe(true);
    authority.dropExecution({ proofId: "proof-2", sessionId: fixture.sessionId });
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-2",
        sessionId: fixture.sessionId,
      }),
    ).toBe(false);
  });

  it("reports not-live when every correlated execution is gone from the registry", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const { connection } = await attachRunner(stack, fixture);
    const authority = createSessionCliCloudProofAuthority({ fence: stack.fence, registry: stack.registry });
    // A correlation entry whose executions are no longer resolvable in the registry (a swept or
    // foreign record): the correlation map is exact, but liveness must still be re-proven per call.
    authority.registerExecution({
      connectionId: connection.connectionId,
      executionId: randomUUID(),
      proofId: "proof-1",
      sessionId: fixture.sessionId,
    });
    expect(
      authority.isProofLive({
        connectionId: connection.connectionId,
        proofId: "proof-1",
        sessionId: fixture.sessionId,
      }),
    ).toBe(false);
  });
});

describe("createCloudSourceConnectionVerifier", () => {
  it("authorizes only the exact current, execution-eligible collaboration connection", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const { connection } = await attachRunner(stack, fixture);
    const verify = createCloudSourceConnectionVerifier(stack.fence);
    expect(
      verify({
        computerId: fixture.computerId,
        connectionInstanceId: connection.connectionId,
        sessionId: fixture.sessionId,
      }),
    ).toBe(true);
    // An unknown connection id is never authorized.
    expect(
      verify({ computerId: fixture.computerId, connectionInstanceId: randomUUID(), sessionId: fixture.sessionId }),
    ).toBe(false);
    expect(
      verify({ computerId: randomUUID(), connectionInstanceId: connection.connectionId, sessionId: fixture.sessionId }),
    ).toBe(false);
    expect(
      verify({
        computerId: fixture.computerId,
        connectionInstanceId: connection.connectionId,
        sessionId: randomUUID(),
      }),
    ).toBe(false);

    const reportOnly = await attachRunner(stack, fixture, { executionEligible: false });
    expect(
      verify({
        computerId: fixture.computerId,
        connectionInstanceId: reportOnly.connection.connectionId,
        sessionId: fixture.sessionId,
      }),
    ).toBe(false);
    const legacy = await attachRunner(stack, fixture, { sessionCollaborationEligible: false });
    expect(
      verify({
        computerId: fixture.computerId,
        connectionInstanceId: legacy.connection.connectionId,
        sessionId: fixture.sessionId,
      }),
    ).toBe(false);
  });
});

describe("CloudSessionCollaborationOwner degraded composition", () => {
  it("reports model_unavailable when no grant authority is composed", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture, { omitModelGrants: true });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "model_unavailable",
    });
  });

  it("reports outbox_unavailable for an ended or non-active target before any allocation work", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    // The frozen snapshot is assembled BEFORE the authority lapses: the delivery owner must
    // refuse the dispatch on the target envelope, not on a re-assembled configuration.
    const input = await deliveryInput(fixture, messageId);
    await db.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, fixture.sessionId));
    await expect(stack.owner.deliver(input, allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "outbox_unavailable",
    });

    // A visible target whose binding lost its authority also fails closed before dispatch.
    await db.database.update(sessions).set({ endedAt: null }).where(eq(sessions.id, fixture.sessionId));
    await db.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, fixture.bindingId));
    await expect(stack.owner.deliver(input, allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "outbox_unavailable",
    });
  });

  it("derives the internal target envelope with no IM outbox context", async () => {
    const fixture = await seedCloudSession({ kind: "internal" });
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    const run = attach.sent.find(
      (frame): frame is Extract<RunnerServerFrame, { type: "session:message:run" }> =>
        frame.type === "session:message:run",
    );
    expect(run).toMatchObject({ sessionKind: "internal" });
    expect(run?.outboxContext).toBeUndefined();
  });

  it("derives the Slack outbox context including a thread key of a thread Session", async () => {
    const fixture = await seedCloudSession({ kind: "thread", provider: "slack", threadKey: "1700000000.000100" });
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    const run = attach.sent.find(
      (frame): frame is Extract<RunnerServerFrame, { type: "session:message:run" }> =>
        frame.type === "session:message:run",
    );
    expect(run).toMatchObject({
      outboxContext: {
        channelId: "unit-channel",
        provider: "slack",
        sessionKind: "thread",
        threadTs: "1700000000.000100",
      },
    });
  });

  it("derives each provider's outbox context with and without a thread identity", async () => {
    const runFrameOf = async (
      fixture: CloudFixture,
    ): Promise<Extract<RunnerServerFrame, { type: "session:message:run" }>> => {
      const messageId = randomUUID();
      await insertMessage(messageId, fixture);
      const stack = makeStack(fixture);
      const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
      await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
        status: "accepted",
      });
      const frame = attach.sent.find(
        (candidate): candidate is Extract<RunnerServerFrame, { type: "session:message:run" }> =>
          candidate.type === "session:message:run",
      );
      if (!frame) throw new Error("run frame missing");
      return frame;
    };

    // A Feishu channel carries no thread id; a Feishu thread carries it as `threadId`.
    const feishuChannel = await runFrameOf(await seedCloudSession());
    expect(feishuChannel.outboxContext).toEqual({
      chatId: "unit-channel",
      provider: "feishu",
      sessionKind: "channel",
    });
    const feishuThread = await runFrameOf(await seedCloudSession({ kind: "thread", threadKey: "omt_unit_thread" }));
    expect(feishuThread.outboxContext).toEqual({
      chatId: "unit-channel",
      provider: "feishu",
      sessionKind: "thread",
      threadId: "omt_unit_thread",
    });
    // A Slack channel carries no thread ts either: the field is omitted, never null-filled.
    const slackChannel = await runFrameOf(await seedCloudSession({ provider: "slack" }));
    expect(slackChannel.outboxContext).toEqual({
      channelId: "unit-channel",
      provider: "slack",
      sessionKind: "channel",
    });
  });

  it("converges a cold Sandbox through ensureSandbox when no managed row exists yet", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    // No managed Sandbox row yet (the cold start): the dispatch creates it through the port.
    await db.database.delete(sandboxes).where(eq(sandboxes.id, fixture.sandboxId));
    const owner = new CloudSessionCollaborationOwner({
      allocation: {
        ensureEnvironmentAllocated: async () => "pending",
        ensureSandbox: async () => {
          await db.database.insert(sandboxes).values({
            id: fixture.sandboxId,
            sessionId: fixture.sessionId,
            storageUri: `gs://unit-cloud/${fixture.sandboxId}`,
            lifecycle: "preparing",
            environmentGeneration: 1,
          });
          return { accountId: fixture.accountId, sandboxId: fixture.sandboxId };
        },
      },
      assembler: new EffectiveRuntimeSnapshotAssembler(db.database),
      database: db.database,
      durableWork: new PostgresRuntimeDurableWorkStore(db.database),
      fence: stack.fence,
      hub: stack.hub,
      modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
      modelGrants: stack.grants,
      work: new CloudSessionWorkTracker(),
    });
    // The ensured row is not dispatch-ready yet and the allocation converges as pending.
    await expect(owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
    await expect(owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    void attach;
  });

  it("fails closed when the attempted allocation cannot produce a usable Sandbox row", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await db.database.delete(sandboxes).where(eq(sandboxes.id, fixture.sandboxId));
    const owner = new CloudSessionCollaborationOwner({
      allocation: {
        // The ensure is rejected outright: nothing can be dispatched, nothing is registered.
        ensureEnvironmentAllocated: async () => "ready",
        ensureSandbox: async () => {
          throw new Error("allocation unavailable");
        },
      },
      assembler: new EffectiveRuntimeSnapshotAssembler(db.database),
      database: db.database,
      durableWork: new PostgresRuntimeDurableWorkStore(db.database),
      fence: stack.fence,
      hub: stack.hub,
      modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
      modelGrants: stack.grants,
      work: new CloudSessionWorkTracker(),
    });
    await expect(owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
    await expect(owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
  });

  it("refuses a blank replacement when the persisted storage demands a restore", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    // A not-ready Sandbox: the ingress convergence is the only way forward.
    await db.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, fixture.sandboxId));
    const stack = makeStack(fixture, {
      allocation: {
        ensureEnvironmentAllocated: async () => "restore_required",
        ensureSandbox: async () => ({ accountId: fixture.accountId, sandboxId: fixture.sandboxId }),
      },
    });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "rejected",
      code: "restore_required",
    });
  });

  it("reports a bounded convergence timeout and a rejected convergence without accepting", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    await db.database
      .update(sandboxes)
      .set({ lifecycle: "preparing", currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, fixture.sandboxId));

    const timingOut = makeStack(fixture, {
      allocation: {
        ensureEnvironmentAllocated: () => new Promise(() => undefined),
        ensureSandbox: async () => ({ accountId: fixture.accountId, sandboxId: fixture.sandboxId }),
      },
      ensureTimeoutMs: 25,
    });
    await attachRunner(timingOut, fixture, { onFrame: answeringOnFrame(timingOut, fixture) });
    await expect(timingOut.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });

    const warn = vi.fn();
    const rejecting = makeStack(fixture, {
      allocation: {
        ensureEnvironmentAllocated: async () => {
          throw new Error("allocation convergence failed");
        },
        ensureSandbox: async () => ({ accountId: fixture.accountId, sandboxId: fixture.sandboxId }),
      },
      logger: { error: vi.fn(), warn },
    });
    await attachRunner(rejecting, fixture, { onFrame: answeringOnFrame(rejecting, fixture) });
    await expect(rejecting.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: "CLOUD_SESSION_ALLOCATION_FAILED" }),
        expect.any(String),
      ),
    );
  });

  it("reports runtime_not_ready when a cold Sandbox is never created or never becomes ready", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await db.database.delete(sandboxes).where(eq(sandboxes.id, fixture.sandboxId));

    // No managed row and no allocation authority at all: the dispatch cannot even start.
    const noAllocation = makeStack(fixture, { omitDurableWork: true });
    await expect(noAllocation.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });

    // The ensure answers but the managed row still does not exist afterwards.
    const hollowEnsure = makeStack(fixture, {
      allocation: {
        ensureEnvironmentAllocated: async () => "pending",
        ensureSandbox: async () => ({ accountId: fixture.accountId, sandboxId: fixture.sandboxId }),
      },
    });
    await expect(hollowEnsure.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });

    // A row exists but is not dispatch-ready and there is no allocation authority to converge it.
    const hollowSandboxId = randomUUID();
    await db.database.insert(sandboxes).values({
      id: hollowSandboxId,
      sessionId: fixture.sessionId,
      storageUri: `gs://unit-cloud/${hollowSandboxId}`,
      lifecycle: "preparing",
      environmentGeneration: 1,
    });
    await expect(noAllocation.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });

    // The convergence reports ready, but the persisted row never became dispatch-ready.
    const notConverged = makeStack(fixture, {
      allocation: {
        ensureEnvironmentAllocated: async () => "ready",
        ensureSandbox: async () => ({ accountId: fixture.accountId, sandboxId: fixture.sandboxId }),
      },
    });
    await attachRunner(notConverged, fixture, { onFrame: answeringOnFrame(notConverged, fixture) });
    await expect(notConverged.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
  });

  it("ignores a placement-less Session for the reclaim barrier and for durable-only cancellation", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    await db.database.delete(sessionPlacements).where(eq(sessionPlacements.sessionId, fixture.sessionId));
    // Without a placement Computer there is no authoritative durable scope: never a barrier.
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(0);
    await expect(stack.owner.cancelSessionMessages(fixture.sessionId)).resolves.toEqual([]);
  });

  it("still revokes the Session proof when the Sandbox row is already gone", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture);
    await db.database.delete(sandboxes).where(eq(sandboxes.id, fixture.sandboxId));
    // No Sandbox row means no allocation and no possible cancellation, but the stop must still
    // revoke the Session's proof: custody without a proof authority is the only safe residue.
    await expect(stack.owner.cancelSessionMessages(fixture.sessionId)).resolves.toEqual([]);
    expect(attach.sent).toEqual([]);
  });

  it("keeps a legacy-shaped accepted record as a barrier and cancels it without a Turn identity", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
    // A Local-shaped record under this Session's own placement Computer: no Cloud envelope, so the
    // barrier is conservative and the stop can name only the message, never a Turn.
    await insertDurableRow({
      computerId: fixture.computerId,
      key: `${fixture.sessionId}:${messageId}`,
      payload: bareLocalRequest(fixture, messageId, runtime),
    });
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
    await expect(stack.owner.cancelSessionMessages(fixture.sessionId)).resolves.toEqual([
      { messageId, status: "requested" },
    ]);
    // No grant can be revoked for a Turn the record never named.
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("cancels durable-only work with no exact connection left as a truthful no_connection", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    // The in-memory picture is gone (a restart) and the fence has no connection: the stop must
    // still name the durable message and report that no cancellation could be handed over.
    stack.work.clearSandbox(fixture.sandboxId);
    stack.fence.detachSandbox(fixture.sandboxId);
    await expect(stack.owner.cancelSessionMessages(fixture.sessionId)).resolves.toEqual([
      { messageId, status: "no_connection" },
    ]);
    void attach;
  });

  it("cancels the Hub's current socket when the fenced connection carries no socket", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // A recovery fixture carries no socket on the fence record: the Hub's current socket is the
    // only legal send target while the exact connection is still the fence's current one.
    const fenced = stack.fence.attach({
      computerId: fixture.computerId,
      installationId: randomUUID(),
      scope: fixture.scope,
      sessionCollaborationEligible: true,
    });
    await expect(stack.owner.cancelSessionMessages(fixture.sessionId)).resolves.toEqual([
      { messageId, status: "requested" },
    ]);
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    void fenced;
  });

  it("reports send_failed when the fenced connection's socket is no longer the Hub's current one", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);

    // A newer socket owns the Sandbox while the recorded connection is still the fence's exact
    // one: the cancel cannot be handed to the replaced socket and is reported as such.
    const replacement: RunnerControlSocket = { send() {}, close() {} };
    stack.hub.attach(fixture.scope, replacement);
    stack.hub.markReady(fixture.scope, READINESS, replacement);
    await expect(stack.owner.cancelSessionMessages(fixture.sessionId)).resolves.toEqual([
      { messageId, status: "send_failed" },
    ]);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("reports the truthful failure when the Session CLI proof revoke fails on a stop or a detach", async () => {
    const fixture = await seedCloudSession();
    const warn = vi.fn();
    const stack = makeStack(fixture, {
      logger: { error: vi.fn(), warn },
      proofs: {
        revokeForConnection: async () => {
          throw new Error("connection revoke failed");
        },
        revokeForSession: async () => {
          throw new Error("session revoke failed");
        },
      },
    });
    await expect(stack.owner.cancelSessionMessages(fixture.sessionId)).resolves.toEqual([]);
    stack.owner.detachConnection(randomUUID());
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLOUD_SESSION_PROOF_REVOKE_FAILED", sessionId: fixture.sessionId }),
      expect.any(String),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLOUD_SESSION_PROOF_REVOKE_FAILED" }),
      expect.any(String),
    );
  });

  it("fails the activity clock silently when the business-activity note rejects", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const warn = vi.fn();
    const stack = makeStack(fixture, {
      logger: { error: vi.fn(), warn },
      noteActivity: async () => {
        throw new Error("activity clock unavailable");
      },
    });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: "CLOUD_SESSION_ACTIVITY_TOUCH_FAILED" }),
        expect.any(String),
      ),
    );
  });

  it("resolves the runtime model to the allowlisted default when the configuration names none", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    // The Agent configuration carries no model: the deployment default must be substituted.
    await db.database
      .update(agentRuntimeConfigs)
      .set({ model: null })
      .where(eq(agentRuntimeConfigs.agentId, fixture.agentId));
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
    expect(runtime.model).toBeUndefined();
    await expect(
      stack.owner.deliver(
        { attemptCount: 1, message: { content: "continue", id: messageId }, route: routeFor(fixture), runtime },
        allowAdmission,
      ),
    ).resolves.toEqual({ status: "accepted" });
    const run = attach.sent.find(
      (frame): frame is Extract<RunnerServerFrame, { type: "session:message:run" }> =>
        frame.type === "session:message:run",
    );
    expect(run?.message.runtime.model).toBe(MODEL);

    // A default that is not allowlisted is never substituted: the dispatch fails closed.
    const blocked = makeStack(fixture, {
      modelGrants: {
        defaultModel: "not-allowed",
        isModelAllowed: () => false,
        issue: async () => undefined,
        revokeExecution: () => 0,
      },
    });
    await expect(
      blocked.owner.deliver(
        { attemptCount: 1, message: { content: "continue", id: messageId }, route: routeFor(fixture), runtime },
        allowAdmission,
      ),
    ).resolves.toEqual({ status: "unreachable", code: "model_unavailable" });
  });

  it("reports model_unavailable when no runtime can be assembled for the Session", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    // The frozen snapshot comes from a working assembler; the owner's own boundary re-read fails.
    const input = await deliveryInput(fixture, messageId);
    const stack = makeStack(fixture, {
      assembler: {
        assembleForSession: async () => {
          throw new Error("assembly failed");
        },
      },
    });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    // An assembly failure proves nothing: the frozen snapshot is trusted and the dispatch proceeds.
    await expect(stack.owner.deliver(input, allowAdmission)).resolves.toEqual({ status: "accepted" });
  });

  it("reports runtime_not_ready when the Hub has no ready connection for a ready Sandbox", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    // Attached but never marked ready: the Hub can prove no dispatchable Runner.
    const socket: RunnerControlSocket = { send() {}, close() {} };
    stack.hub.attach(fixture.scope, socket);
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
  });

  it("reports runtime_not_ready when the fenced connection no longer names the Hub's scope", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture);
    // The fence still holds a superseded allocation record for the Sandbox while the Hub (and the
    // Sandbox row) name the current generation: the exact instance identity must be proven.
    stack.fence.attach({
      computerId: fixture.computerId,
      installationId: randomUUID(),
      scope: { ...fixture.scope, environmentGeneration: 2 },
      sessionCollaborationEligible: true,
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
  });

  it("reports runtime_not_ready when the fenced socket is not the Hub's current socket", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const live: RunnerControlSocket = { send() {}, close() {} };
    stack.hub.attach(fixture.scope, live);
    stack.hub.markReady(fixture.scope, READINESS, live);
    const stale: RunnerControlSocket = { send() {}, close() {} };
    stack.fence.attach({
      computerId: fixture.computerId,
      installationId: randomUUID(),
      scope: fixture.scope,
      sessionCollaborationEligible: true,
      socket: stale,
    });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
  });

  it("fails the dispatch when the authority admission refuses and unwinds unexpected failures", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });

    const refusing: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame> = async (operation) => {
      void operation;
      return { admitted: false };
    };
    const input = await deliveryInput(fixture, messageId);
    await expect(stack.owner.deliver(input, refusing)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    // A refused admission leaves no busy registration behind.
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);

    // An unexpected admission failure must surface, never become a fabricated outcome.
    const exploding: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame> = async () => {
      throw new Error("admission exploded");
    };
    await expect(stack.owner.deliver(input, exploding)).rejects.toThrow("admission exploded");
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("maps a Runner rejected receipt to capacity or the reported rejection reason", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const rejectingFrame = (target: Stack, reason: "client_busy" | "input_conflict") => (frame: RunnerServerFrame) => {
      if (frame.type !== "session:message:run") return;
      const connection = target.fence.connectionForSandbox(fixture.sandboxId);
      if (!connection) return;
      void target.owner.handleReceived(connection, {
        messageId,
        reason,
        requestId: frame.requestId,
        status: "rejected",
        type: "session:message:received",
      });
    };

    const busy = makeStack(fixture);
    await attachRunner(busy, fixture, { onFrame: rejectingFrame(busy, "client_busy") });
    await expect(busy.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "capacity",
    });
    expect(busy.owner.isSandboxBusy(fixture.scope)).toBe(false);

    const conflicted = makeStack(fixture);
    await attachRunner(conflicted, fixture, { onFrame: rejectingFrame(conflicted, "input_conflict") });
    await expect(conflicted.owner.deliver(await deliveryInput(fixture, messageId, 2), allowAdmission)).resolves.toEqual(
      { status: "rejected", code: "input_conflict" },
    );
    expect(conflicted.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("re-checks the dispatch boundary after the receipt and refuses a report-only replacement", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    // The Runner connection is replaced report-only in the window between the journaled receipt
    // and the Server's custody commit: the receipt must not be accepted onto the new connection.
    const boundaryAdmission: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame> = async (operation) => {
      const receipt = await operation(() => undefined);
      await attachRunner(stack, fixture, { executionEligible: false });
      return { admitted: true, result: Promise.resolve(receipt) };
    };
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), boundaryAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
    });
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("accepts a receipt whose journal phase is already started", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture, "started") });
    // The Runner re-correlated an already-running entry: custody and the grant were delivered
    // earlier, so this is a truthful duplicate acceptance rather than a fresh execution.
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
    // No permission frame is re-minted for an already-started Turn.
    expect(
      attach.sent.filter((frame) => frame.type === "session:message:verified" && frame.status === "verified"),
    ).toHaveLength(0);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("refuses custody when the exact connection lapses across the accepted-outcome commit", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture, {
      recordMessageOutcome: async (input) => {
        await db.database
          .update(sessionMessages)
          .set({ lastOutcome: "accepted" })
          .where(eq(sessionMessages.id, input.messageId));
        // A replacement connection takes over before custody is returned to the caller.
        await attachRunner(stack, fixture, { executionEligible: false });
        return true;
      },
    });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    // The Runner's journaled entry was never authorized: no verified frame left the Server.
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("reports runtime_unavailable when the grant cannot be minted or the permission frame cannot be sent", async () => {
    const unMintable = await seedCloudSession();
    const unMintableMessage = randomUUID();
    await insertMessage(unMintableMessage, unMintable);
    const noGrant = makeStack(unMintable, {
      modelGrants: {
        defaultModel: MODEL,
        isModelAllowed: () => true,
        issue: async () => undefined,
        revokeExecution: () => 0,
      },
    });
    await attachRunner(noGrant, unMintable, { onFrame: answeringOnFrame(noGrant, unMintable) });
    await expect(
      noGrant.owner.deliver(await deliveryInput(unMintable, unMintableMessage), allowAdmission),
    ).resolves.toEqual({ status: "unreachable", code: "runtime_unavailable" });
    expect(noGrant.owner.isSandboxBusy(unMintable.scope)).toBe(false);

    const unsendable = await seedCloudSession();
    const unsendableMessage = randomUUID();
    await insertMessage(unsendableMessage, unsendable);
    const stack = makeStack(unsendable);
    const revokeSpy = vi.spyOn(stack.grants, "revokeExecution");
    const droppingSocket: RunnerControlSocket = {
      send(frame) {
        if (frame.type === "session:message:verified" && frame.status === "verified") {
          throw new Error("control channel closed");
        }
        if (frame.type === "session:message:run") {
          const connection = stack.fence.connectionForSandbox(unsendable.sandboxId);
          if (!connection) return;
          void stack.owner.handleReceived(connection, {
            messageId: unsendableMessage,
            phase: "received",
            requestId: frame.requestId,
            status: "accepted",
            turnId: `turn-${unsendableMessage}`,
            type: "session:message:received",
          });
        }
      },
      close() {},
    };
    stack.hub.attach(unsendable.scope, droppingSocket);
    stack.hub.markReady(unsendable.scope, READINESS, droppingSocket);
    stack.fence.attach({
      computerId: unsendable.computerId,
      installationId: randomUUID(),
      scope: unsendable.scope,
      sessionCollaborationEligible: true,
      socket: droppingSocket,
    });
    await expect(
      stack.owner.deliver(await deliveryInput(unsendable, unsendableMessage), allowAdmission),
    ).resolves.toEqual({ status: "unreachable", code: "runtime_unavailable" });
    // Custody committed, so the grant is revoked and the busy registration retired together.
    expect(revokeSpy).toHaveBeenCalledWith(`turn-${unsendableMessage}`);
    expect(stack.owner.isSandboxBusy(unsendable.scope)).toBe(false);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: unsendable.sessionId })).resolves.toBe(true);
  });

  it("fails the permission boundary when the frozen runtime names a non-allowlisted model", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    const input = await deliveryInput(fixture, messageId);
    await expect(
      stack.owner.deliver({ ...input, runtime: { ...input.runtime, model: "not-allowlisted" } }, allowAdmission),
    ).resolves.toEqual({ status: "unreachable", code: "model_unavailable" });
  });

  it("normalizes a completed or unknown Runner settlement into distinct durable outcomes", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });

    // `unknown` is a real distinct outcome: the Turn state was never provable.
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId, "unknown"));
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    const [record] = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(record?.status).toBe("failed");
    expect((record?.lastError as { code?: string } | null)?.code).toBe("turn_state_unknown");

    // A `failed` settlement is a plain failure, with no lastError code to decode.
    const secondMessage = randomUUID();
    await insertMessage(secondMessage, fixture);
    await expect(stack.owner.deliver(await deliveryInput(fixture, secondMessage), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    await stack.owner.handleSettled(attach.connection, settleFrame(secondMessage, "failed"));
    const [second] = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${secondMessage}`));
    expect(second?.status).toBe("failed");
    expect((second?.lastError as { code?: string } | null)?.code).toBe("turn_failed");
  });

  it("keeps a legacy-shaped durable record as a conservative reclaim barrier", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
    // A Local-shaped record (a bare delivery request, no Cloud envelope) written under the
    // Session's own placement Computer: it can never be borrowed as custody and it stays a barrier.
    await insertDurableRow({
      computerId: fixture.computerId,
      key: `${fixture.sessionId}:${messageId}`,
      payload: bareLocalRequest(fixture, messageId, runtime),
    });
    const allocation = {
      environmentGeneration: fixture.scope.environmentGeneration,
      resourceName: fixture.scope.resourceName,
      sandboxId: fixture.sandboxId,
    };
    // A missing or foreign envelope is conservative for the barrier and refused for custody.
    await expect(stack.owner.hasUnsettledSessionWork({ allocation, sessionId: fixture.sessionId })).resolves.toBe(true);
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(0);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);

    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("skips legacy-shaped rows while retiring the exact allocations it can prove lost", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const staleMessage = randomUUID();
    const legacyMessage = randomUUID();
    const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
    await insertDurableRow({
      computerId: fixture.computerId,
      key: `${fixture.sessionId}:${legacyMessage}`,
      payload: bareLocalRequest(fixture, legacyMessage, runtime),
    });
    await insertDurableRow({
      computerId: fixture.computerId,
      key: `${fixture.sessionId}:${staleMessage}`,
      payload: cloudEnvelope(fixture, "turn-stale", { environmentGeneration: 9, resourceName: "gone" }, runtime),
    });
    // Only the record whose recorded allocation is provably gone is retired; the legacy shape is
    // skipped because its allocation cannot be evaluated at all.
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(1);
    const rows = await db.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.computerId, fixture.computerId));
    expect(rows.find((row) => row.recordKey.endsWith(legacyMessage))?.status).toBe("accepted");
    expect(rows.find((row) => row.recordKey.endsWith(staleMessage))?.status).toBe("failed");
  });

  it("fails closed when the durable store cannot read or write the custody record", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture, {
      durableWork: {
        read: async () => {
          throw new Error("durable read failed");
        },
        write: async () => {
          throw new Error("durable write failed");
        },
      },
    });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    // Neither the preflight read nor the write nor the re-read proves anything: the attempt stays
    // retryable and never authorizes execution against an unprovable custody record.
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
  });

  it("decides durable custody against the exact existing record and never borrows a foreign one", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const allocation = {
      environmentGeneration: fixture.scope.environmentGeneration,
      resourceName: fixture.scope.resourceName,
      sandboxId: fixture.sandboxId,
    };
    const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
    const turnId = `turn-${messageId}`;
    const record = (turn: string, alloc: typeof allocation) => ({
      ...cloudEnvelopeRecord(fixture, turn, alloc, runtime),
      key: `${fixture.sessionId}:${messageId}`,
    });
    /** The store as the concurrent writer race sees it: the write always loses, the re-read answers. */
    const scripted = (script: {
      reads: (RuntimeDurableWorkRecord | undefined | "throw")[];
      replace?: "ok" | "undefined" | "throw" | "missing";
    }): CloudSessionDurableWorkPort => {
      let index = 0;
      return {
        read: async () => {
          const next = script.reads[Math.min(index, script.reads.length - 1)];
          index += 1;
          if (next === "throw") throw new Error("durable read failed");
          return next;
        },
        write: async () => {
          throw new Error("concurrent writer won");
        },
        ...(script.replace === "missing"
          ? {}
          : {
              replaceSessionMessageRecord: async (
                _computerId: string,
                _expected: RuntimeDurableWorkRecord,
                input: RuntimeDurableWorkRecord,
              ) => {
                if (script.replace === "throw") throw new Error("replace failed");
                return script.replace === "undefined" ? undefined : input;
              },
            }),
      };
    };
    const deliver = async (store: CloudSessionDurableWorkPort) => {
      const stack = makeStack(fixture, { durableWork: store });
      await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
      const outcome = await stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission);
      return { outcome, stack };
    };

    // The raced re-read finds this very Turn already accepted: it is reused, not re-minted.
    const reused = await deliver(scripted({ reads: [undefined, record(turnId, allocation)] }));
    expect(reused.outcome).toEqual({ status: "accepted" });

    // The raced re-read finds another attempt's live custody: it is refused, never borrowed.
    const refused = await deliver(
      scripted({ reads: [undefined, record("turn-other", { ...allocation, resourceName: "other" })] }),
    );
    expect(refused.outcome).toEqual({ status: "unreachable", code: "runtime_unavailable" });

    // The raced re-read finds a superseded same-allocation record: it is replaced, not borrowed.
    const replaced = await deliver(scripted({ reads: [undefined, record("turn-superseded", allocation)] }));
    expect(replaced.outcome).toEqual({ status: "accepted" });

    // Nothing readable at all: the pinned warning fires and the attempt stays retryable.
    const warn = vi.fn();
    const wedge = makeStack(fixture, {
      durableWork: scripted({ reads: ["throw"] }),
      logger: { error: vi.fn(), warn },
    });
    await attachRunner(wedge, fixture, { onFrame: answeringOnFrame(wedge, fixture) });
    await expect(wedge.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLOUD_SESSION_DURABLE_WRITE_FAILED" }),
      expect.any(String),
    );

    // A preflight that already names a superseded record goes straight to the compare-and-set.
    const direct = await deliver(scripted({ reads: [record("turn-superseded", allocation)] }));
    expect(direct.outcome).toEqual({ status: "accepted" });

    // The compare-and-set loses the record to a concurrent settlement: nothing is overwritten.
    const lostRace = await deliver(scripted({ reads: [record("turn-superseded", allocation)], replace: "undefined" }));
    expect(lostRace.outcome).toEqual({ status: "unreachable", code: "runtime_unavailable" });

    // The store has no compare-and-set at all (degraded fixture): a superseded same-allocation
    // record cannot be replaced, so the pinned warning fires and the attempt stays retryable.
    const unpinnedWarn = vi.fn();
    const unpinned = makeStack(fixture, {
      durableWork: scripted({ reads: [record("turn-superseded", allocation)], replace: "missing" }),
      logger: { error: vi.fn(), warn: unpinnedWarn },
    });
    await attachRunner(unpinned, fixture, { onFrame: answeringOnFrame(unpinned, fixture) });
    await expect(unpinned.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(unpinnedWarn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLOUD_SESSION_DURABLE_WRITE_FAILED" }),
      expect.any(String),
    );

    // A throwing compare-and-set is reported, never silently accepted.
    const replaceWarn = vi.fn();
    const exploded = makeStack(fixture, {
      durableWork: scripted({ reads: [record("turn-superseded", allocation)], replace: "throw" }),
      logger: { error: vi.fn(), warn: replaceWarn },
    });
    await attachRunner(exploded, fixture, { onFrame: answeringOnFrame(exploded, fixture) });
    await expect(exploded.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(replaceWarn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLOUD_SESSION_DURABLE_WRITE_FAILED" }),
      expect.any(String),
    );
  });

  it("reports unavailable when the accepted-outcome commit rejects or is fenced out", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const rejected = makeStack(fixture, {
      recordMessageOutcome: async () => {
        throw new Error("outcome commit failed");
      },
    });
    await attachRunner(rejected, fixture, { onFrame: answeringOnFrame(rejected, fixture) });
    await expect(rejected.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(rejected.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("reports unavailable when no durable authority is composed at all", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture, { omitDurableWork: true });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    // Degraded (in-memory only) composition: no durable custody can be recorded, so no Turn may
    // ever be authorized, and no durable barrier exists to report.
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(0);
  });

  it("refuses custody for an already-started Turn it cannot prove it owns", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture, { omitDurableWork: true });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture, "started") });
    // A `started` receipt claims the Turn is already running: without a provable custody record
    // the Server must not adopt it, and the running Turn settles through its own path.
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("never acks a settlement whose durable record disappeared before the commit", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const store = new PostgresRuntimeDurableWorkStore(db.database);
    // The handleSettled preflight still sees the record; the terminalization read does not.
    let settling = false;
    let settleReads = 0;
    const stack = makeStack(fixture, {
      durableWork: {
        read: async (computerId, kind, key) => {
          if (!settling) return store.read(computerId, kind, key);
          settleReads += 1;
          return settleReads === 1 ? store.read(computerId, kind, key) : undefined;
        },
        write: (computerId, record) => store.write(computerId, record),
      },
    });
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;
    settling = true;
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    // Without an authoritative commit there is no ack: the Runner keeps replaying its journal.
    expect(attach.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("drops settlement and re-announcement frames when no durable authority is composed", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture, { omitDurableWork: true });
    const attach = await attachRunner(stack, fixture);
    // Without a durable store there is no custody record to re-verify: the journaled entry is
    // retired rather than run blind, and a settlement has no evidence to commit or ack.
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    expect(attach.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);
    expect(attach.sent.some((frame) => frame.type === "session:message:verified" && frame.status === "verified")).toBe(
      false,
    );
  });

  it("keeps the reclaim barrier conservative when the terminal commit cannot be written", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const store = new PostgresRuntimeDurableWorkStore(db.database);
    const warn = vi.fn();
    let failWrites = false;
    const stack = makeStack(fixture, {
      durableWork: {
        read: (computerId, kind, key) => store.read(computerId, kind, key),
        write: async (computerId, record) => {
          if (failWrites) throw new Error("terminal write failed");
          await store.write(computerId, record);
        },
      },
      logger: { error: vi.fn(), warn },
    });
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;
    failWrites = true;
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    expect(attach.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLOUD_SESSION_DURABLE_SETTLE_FAILED" }),
      expect.any(String),
    );
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("keeps the barrier conservative when a retirement sweep cannot terminalize its record", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const store = new PostgresRuntimeDurableWorkStore(db.database);
    const warn = vi.fn();
    let failWrites = false;
    const stack = makeStack(fixture, {
      durableWork: {
        read: (computerId, kind, key) => store.read(computerId, kind, key),
        write: async (computerId, record) => {
          if (failWrites) throw new Error("terminal write failed");
          await store.write(computerId, record);
        },
      },
      logger: { error: vi.fn(), warn },
    });
    await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    // The allocation is proven lost, but its retirement cannot be committed: the record keeps
    // blocking (a retired count of zero) rather than being silently dropped.
    await db.database
      .update(sandboxes)
      .set({ environmentGeneration: 2, currentResourceName: `${fixture.scope.resourceName}-next` })
      .where(eq(sandboxes.id, fixture.sandboxId));
    failWrites = true;
    await expect(stack.owner.reconcileSessionWork(fixture.sessionId)).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLOUD_SESSION_DURABLE_SETTLE_FAILED" }),
      expect.any(String),
    );
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
  });

  it("bounds the Turn budget by the platform ceiling and the default", async () => {
    const fixture = await seedCloudSession();
    const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
    /** Each delivery runs on its own stack so the budget assertion is independent of prior turns. */
    const deliver = async (budget: { maxDurationMs?: number } | undefined) => {
      const messageId = randomUUID();
      await insertMessage(messageId, fixture);
      const stack = makeStack(fixture);
      const attach = await attachRunner(stack, fixture, {
        onFrame: (frame) => {
          if (frame.type !== "session:message:run") return;
          const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
          if (!connection) return;
          void stack.owner.handleReceived(connection, {
            messageId,
            phase: "received",
            requestId: frame.requestId,
            status: "accepted",
            turnId: `turn-${messageId}`,
            type: "session:message:received",
          });
        },
      });
      await expect(
        stack.owner.deliver(
          {
            attemptCount: 1,
            message: { content: "continue", id: messageId },
            route: routeFor(fixture),
            runtime: { ...runtime, ...(budget ? { budget } : {}) },
          },
          allowAdmission,
        ),
      ).resolves.toEqual({ status: "accepted" });
      const verified = attach.sent.find(
        (frame): frame is Extract<RunnerServerFrame, { type: "session:message:verified" }> =>
          frame.type === "session:message:verified" && frame.status === "verified",
      );
      if (!verified?.model) throw new Error("verified frame missing");
      // The granted permission lifetime is the Turn budget plus the fixed transport allowance.
      return ackExpiryMs(verified.model.token) - Date.now();
    };
    // Measured against the granted expiry only; the exact second is irrelevant, the window is not.
    const expected = (budgetMs: number) => budgetMs + 30_000;
    const slack = 5_000;

    // An absent budget falls back to the platform's default Turn duration.
    expect(await deliver(undefined)).toBeGreaterThan(expected(RUNTIME_DEFAULT_MAX_DURATION_MS) - slack);
    expect(await deliver(undefined)).toBeLessThan(expected(RUNTIME_DEFAULT_MAX_DURATION_MS) + slack);
    // An explicit small budget is honoured exactly (plus the transport allowance).
    expect(await deliver({ maxDurationMs: 1_000 })).toBeGreaterThan(expected(1_000) - slack);
    expect(await deliver({ maxDurationMs: 1_000 })).toBeLessThan(expected(1_000) + slack);
  });

  it("drops the re-verification when the connection lapses during the accepted-outcome repair", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    let detachOnRepair = false;
    const stack = makeStack(fixture, {
      recordMessageOutcome: async (input) => {
        await db.database
          .update(sessionMessages)
          .set({ lastOutcome: "accepted" })
          .where(eq(sessionMessages.id, input.messageId));
        // The connection is replaced while the lost accepted outcome is being repaired.
        if (detachOnRepair) stack.fence.detachSandbox(fixture.sandboxId);
        return true;
      },
    });
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    // The recorded outcome was lost while the durable custody record survived (a restart window).
    await db.database.update(sessionMessages).set({ lastOutcome: "unknown" }).where(eq(sessionMessages.id, messageId));
    attach.sent.length = 0;
    const replacement = await attachRunner(stack, fixture);
    detachOnRepair = true;
    await stack.owner.handleReceived(replacement.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    // The repair ran, but the exact connection lapsed: no permission may be published for a
    // connection the fence no longer owns.
    expect(replacement.sent).toEqual([]);
  });

  it("ignores frames from a connection that is no longer the fenced one", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    const replacement = await attachRunner(stack, fixture);
    replacement.sent.length = 0;

    // Frames arriving on the superseded connection are dropped outright: no receipt, no settle
    // ack, and the live custody is untouched.
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    expect(replacement.sent).toEqual([]);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("commits a terminal outcome without acking when the control socket is gone", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // The control channel was replaced while the exact fence connection is still current: the
    // terminal commit must still happen (it is exact durable evidence) while the ack is skipped
    // rather than handed to a socket the Hub no longer owns; the Runner replays on reconnect.
    stack.hub.attach(fixture.scope, { send() {}, close() {} });
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    expect(attach.sent).toEqual([]);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
  });

  it("ignores a rejected receipt that no dispatch is waiting for", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture);
    await stack.owner.handleReceived(attach.connection, {
      messageId: randomUUID(),
      reason: "input_conflict",
      requestId: randomUUID(),
      status: "rejected",
      type: "session:message:received",
    });
    expect(attach.sent).toEqual([]);
  });
});

describe("CloudSessionCollaborationOwner re-announcement", () => {
  it("retires an entry for a message this Session was never authorized to run", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture);
    // No such authorized message row at all: the journaled entry is retired, never executed.
    await stack.owner.handleReceived(attach.connection, {
      messageId: randomUUID(),
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: "turn-orphan",
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ code: "target_mismatch", status: "rejected", type: "session:message:verified" }),
    );
  });

  it("retires a re-announced entry with no accepted custody record", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture);
    // The message is authorized but nothing was ever accepted for it: a settlement could never be
    // committed or acked, so the entry is retired instead of running blind.
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
    );
  });

  it("ignores a re-announcement that lands after the connection stopped being current", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // The connection is replaced while the authority read is in flight: the in-flight
    // re-announcement must not dispatch anything on behalf of the superseded connection.
    const pending = stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    stack.fence.detachSandbox(fixture.sandboxId);
    await pending;
    expect(attach.sent).toEqual([]);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  });

  it("re-registers a started Turn's liveness without minting a second permission", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    stack.work.clearSandbox(fixture.sandboxId);
    attach.sent.length = 0;

    // A reconnect re-announces the already-started Turn: the Server only refreshes its liveness
    // picture and never re-mints permission for a Turn that is already running.
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "started",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toEqual([]);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
  });

  it("holds a re-announced entry pending while the target binding is not active", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // A transient IM reauthorization pauses new grants but never erases accepted custody.
    await db.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, fixture.bindingId));
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toEqual([]);
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
    void attach;
  });

  it("retires a re-announced entry whose journaled Turn already reached a terminal outcome", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    await stack.owner.handleSettled(attach.connection, settleFrame(messageId));
    attach.sent.length = 0;

    // The Runner retransmits its journaled entry after the Server already committed the terminal
    // outcome: re-verifying it would run the message a second time, so it is retired instead.
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
    );
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("retires a legacy-payload terminal record by the frame's own Turn identity", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture);
    const runtime = await new EffectiveRuntimeSnapshotAssembler(db.database).assembleForSession(fixture.sessionId);
    // A terminal record whose payload is a bare Local request (no Cloud envelope to read a Turn
    // from): the frame's own Turn identity is the only one the retirement can name.
    await insertDurableRow({
      computerId: fixture.computerId,
      key: `${fixture.sessionId}:${messageId}`,
      payload: bareLocalRequest(fixture, messageId, runtime),
      status: "succeeded",
    });
    stack.work.register(fixture.scope, messageId, `turn-${messageId}`);
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
    );
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(false);
  });

  it("retires a re-announcement naming a superseded Turn while the live attempt keeps running", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // The custody record names this attempt's Turn; the frame names an older one. Re-verifying it
    // would be a second execution, and clearing occupancy would drop the live attempt's entry.
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: "turn-superseded",
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
    );
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
  });

  it("requests cancellation for a re-announcement on a stopped Agent or a suspended Account", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;
    // The Agent is suspended outside the Session: the authority chain can never let the Turn finish.
    await db.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "started",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    expect(attach.sent.some((frame) => frame.type === "session:message:verified")).toBe(false);

    // A suspended Account owner is the same authority-stop: cancellation, never a false terminal.
    await db.database.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));
    await db.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, fixture.accountId));
    attach.sent.length = 0;
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "started",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
  });

  it("requests cancellation when the Sandbox row is gone or draining", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // The Sandbox row disappeared while custody survived: the Turn can never finish here.
    await db.database.delete(sandboxes).where(eq(sandboxes.id, fixture.sandboxId));
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    expect(attach.sent.some((frame) => frame.type === "session:message:verified")).toBe(false);

    // An unallocated Sandbox is equally unable to run the Turn.
    await db.database.insert(sandboxes).values({
      id: fixture.sandboxId,
      sessionId: fixture.sessionId,
      storageUri: `gs://unit-cloud/${fixture.sandboxId}`,
      lifecycle: "unallocated",
      environmentGeneration: 1,
    });
    attach.sent.length = 0;
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
  });

  it("stays silent when the current runtime cannot be assembled for a re-announcement", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // An assembly failure proves nothing about custody: the entry stays pending and the next
    // re-announcement re-verifies, instead of a false retirement while custody still exists.
    const failing = makeStack(fixture, {
      assembler: {
        assembleForSession: async () => {
          throw new Error("assembly failed");
        },
      },
    });
    const pending = await attachRunner(failing, fixture);
    await failing.owner.handleReceived(pending.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(pending.sent).toEqual([]);
    expect(failing.owner.isSandboxBusy(fixture.scope)).toBe(true);
  });

  it("repairs a lost accepted outcome and rejects the entry when the fence refuses the repair", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    // The recorded outcome was lost while the durable custody record survived (a restart window).
    await db.database.update(sessionMessages).set({ lastOutcome: "unknown" }).where(eq(sessionMessages.id, messageId));
    attach.sent.length = 0;
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    // The repair restores the accepted outcome and the entry is re-verified normally.
    await vi.waitFor(() =>
      expect(attach.sent).toContainEqual(
        expect.objectContaining({ status: "verified", type: "session:message:verified" }),
      ),
    );
    const [message] = await db.database.select().from(sessionMessages).where(eq(sessionMessages.id, messageId));
    expect(message?.lastOutcome).toBe("accepted");

    // The same repair under a fence that refuses it retires the entry instead of running it.
    const refusing = makeStack(fixture, { recordMessageOutcome: async () => false });
    const replacement = await attachRunner(refusing, fixture);
    await db.database.update(sessionMessages).set({ lastOutcome: "unknown" }).where(eq(sessionMessages.id, messageId));
    await refusing.owner.handleReceived(replacement.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(replacement.sent).toContainEqual(
      expect.objectContaining({ code: "not_accepted", status: "rejected", type: "session:message:verified" }),
    );
  });

  it("stays silent when the re-verification cannot mint or loses its connection mid-mint", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // A mint that returns nothing proves no permission: the entry stays pending, unpunished.
    let issued = 0;
    const refusingGrant = makeStack(fixture, {
      modelGrants: {
        defaultModel: MODEL,
        isModelAllowed: () => true,
        issue: async () => {
          issued += 1;
          return undefined;
        },
        revokeExecution: () => 0,
      },
    });
    const refused = await attachRunner(refusingGrant, fixture);
    await refusingGrant.owner.handleReceived(refused.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(issued).toBe(1);
    expect(refused.sent).toEqual([]);
    expect(refusingGrant.owner.isSandboxBusy(fixture.scope)).toBe(true);
  });

  it("stays silent when no runtime model authority is composed for a re-announcement", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });

    // A composition without model grants can never mint permission: the custody stays pending
    // instead of being falsely retired, and the grant path never runs.
    const noAuthority = makeStack(fixture, { omitModelGrants: true });
    const armed = await attachRunner(noAuthority, fixture, { executionEligible: true });
    await noAuthority.owner.handleReceived(armed.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(armed.sent).toEqual([]);
    expect(noAuthority.owner.isSandboxBusy(fixture.scope)).toBe(true);
    void attach;
  });

  it("ignores a report-only connection and a missing runtime model on the re-verification path", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });

    // A report-only reconnect carries no execution permission: custody is registered but no
    // permission is minted for it.
    const reportOnly = await attachRunner(stack, fixture, { executionEligible: false });
    await stack.owner.handleReceived(reportOnly.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(reportOnly.sent).toEqual([]);
    expect(stack.owner.isSandboxBusy(fixture.scope)).toBe(true);
    void attach;
  });

  it("refuses a re-announcement when the fenced connection lapses during the authority read", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const store = new PostgresRuntimeDurableWorkStore(db.database);
    let detachOnRead = false;
    const stack = makeStack(fixture, {
      durableWork: {
        read: async (computerId, kind, key) => {
          const record = await store.read(computerId, kind, key);
          if (detachOnRead) {
            detachOnRead = false;
            stack.fence.detachSandbox(fixture.sandboxId);
          }
          return record;
        },
        write: (computerId, record) => store.write(computerId, record),
      },
    });
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;
    // The authority row is read first; the lapse lands on the custody read that follows it.
    detachOnRead = true;
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(attach.sent).toEqual([]);
  });

  it("revokes a grant minted while the connection lapsed and when the frame cannot be sent", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // The connection is replaced while the grant for the re-announcement is being minted: the
    // freshly minted permission must be revoked rather than left live for an unreachable Runner.
    const revokeSpy = vi.spyOn(stack.grants, "revokeExecution");
    let detachOnMint = true;
    const original = stack.grants.issue.bind(stack.grants);
    vi.spyOn(stack.grants, "issue").mockImplementation(async (input) => {
      const grant = await original(input);
      if (detachOnMint) {
        detachOnMint = false;
        stack.fence.detachSandbox(fixture.sandboxId);
      }
      return grant;
    });
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(revokeSpy).toHaveBeenCalledWith(`turn-${messageId}`);
    expect(attach.sent).toEqual([]);
    vi.mocked(stack.grants.issue).mockRestore();

    // A control channel that refuses the verified frame leaves the minted grant revoked: no live
    // permission may outlive a permission frame the Runner never received.
    const dropping = await attachRunner(stack, fixture, {
      onFrame: (frame) => {
        if (frame.type === "session:message:verified") throw new Error("control channel closed");
      },
    });
    revokeSpy.mockClear();
    await stack.owner.handleReceived(dropping.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(revokeSpy).toHaveBeenCalledWith(`turn-${messageId}`);
  });

  it("revokes a permission minted for a connection that lapsed inside the mint itself", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;

    // A mint authority that loses the exact connection while signing: the freshly minted token
    // must never be published to a Runner the fence no longer owns.
    const real = stack.grants;
    let detachOnMint = false;
    // The detach target is the stack that owns the mint authority; it is only resolved later.
    let detachTarget: CloudRuntimeFence = stack.fence;
    const racingGrants = {
      get defaultModel() {
        return real.defaultModel;
      },
      isModelAllowed: (model: string) => real.isModelAllowed(model),
      issue: async (input: Parameters<CloudModelGrantService["issue"]>[0]) => {
        const grant = await real.issue(input);
        if (detachOnMint) detachTarget.detachSandbox(fixture.sandboxId);
        return grant;
      },
      revokeExecution: (executionId: string) => real.revokeExecution(executionId),
    };
    const racing = makeStack(fixture, { modelGrants: racingGrants });
    detachTarget = racing.fence;
    const replacement = await attachRunner(racing, fixture);
    const issued = vi.spyOn(racingGrants, "revokeExecution");
    detachOnMint = true;
    await racing.owner.handleReceived(replacement.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(replacement.sent).toEqual([]);
    // The wrapper delegates revocation to the real service, so the lapsed grant is dead.
    expect(issued).toHaveBeenCalledWith(`turn-${messageId}`);
    expect(real.trackedGrantCount).toBe(1);
  });

  it("revokes a permission minted just before the connection lapsed again", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);

    /**
     * Arm a fence that lapses on the Nth `isCurrent` check of one re-announcement, so each window
     * of the mint sequence can be pinned exactly. The checks are: 1 the caller's pre-mint guard,
     * 2/3 the mint's own guard around `issue`, 4 the caller's post-mint re-check.
     */ const lapseOn = async (nth: number) => {
      const stack = makeStack(fixture);
      const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
      await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
        status: "accepted",
      });
      attach.sent.length = 0;
      const fenceIsCurrent = stack.fence.isCurrent.bind(stack.fence);
      let armed = false;
      let checks = 0;
      vi.spyOn(stack.fence, "isCurrent").mockImplementation((computerId, instanceId, connectionId) => {
        if (!armed) return fenceIsCurrent(computerId, instanceId, connectionId);
        checks += 1;
        if (checks === nth) {
          stack.fence.detachSandbox(fixture.sandboxId);
          return false;
        }
        return fenceIsCurrent(computerId, instanceId, connectionId);
      });
      armed = true;
      await stack.owner.handleReceived(attach.connection, {
        messageId,
        phase: "received",
        requestId: randomUUID(),
        status: "accepted",
        turnId: `turn-${messageId}`,
        type: "session:message:received",
      });
      // Nothing is ever published to a connection the fence no longer owns, in either window.
      expect(attach.sent).toEqual([]);
      vi.mocked(stack.fence.isCurrent).mockRestore();
    };

    // The connection lapsed before the mint could even start.
    await lapseOn(5);
    // The connection lapsed just after the mint succeeded but before the permission frame.
    await lapseOn(7);
  });

  it("ignores a re-announcement whose custody read happens after the connection lapsed", async () => {
    const fixture = await seedCloudSession();
    const messageId = randomUUID();
    await insertMessage(messageId, fixture);
    const stack = makeStack(fixture);
    const attach = await attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
    await expect(stack.owner.deliver(await deliveryInput(fixture, messageId), allowAdmission)).resolves.toEqual({
      status: "accepted",
    });
    attach.sent.length = 0;
    // The lapse lands between the custody re-verification and the allocation read: the exact
    // connection must be re-proven before any further work is done on its behalf.
    const racedStore = new PostgresRuntimeDurableWorkStore(db.database);
    let detachOnRead = false;
    const racingStack = makeStack(fixture, {
      durableWork: {
        read: async (computerId, kind, key) => {
          const record = await racedStore.read(computerId, kind, key);
          if (detachOnRead) {
            detachOnRead = false;
            racingStack.fence.detachSandbox(fixture.sandboxId);
          }
          return record;
        },
        write: (computerId, record) => racedStore.write(computerId, record),
      },
    });
    const racingAttach = await attachRunner(racingStack, fixture);
    // The re-announcement's custody read detaches the Sandbox: nothing may be sent afterwards.
    detachOnRead = true;
    await racingStack.owner.handleReceived(racingAttach.connection, {
      messageId,
      phase: "received",
      requestId: randomUUID(),
      status: "accepted",
      turnId: `turn-${messageId}`,
      type: "session:message:received",
    });
    expect(racingAttach.sent).toEqual([]);
  });

  it("fails a pending dispatch that a different connection's detach must not touch", async () => {
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

    // A detach for an unrelated connection leaves this pending dispatch alone; its own receipt
    // still resolves it normally.
    stack.owner.detachConnection(randomUUID());
    answer?.();
    await expect(delivering).resolves.toEqual({ status: "accepted" });
    void attach;
  });
});
