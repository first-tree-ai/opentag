import { randomUUID } from "node:crypto";
import type { RunnerCloudSessionMessageReceivedFrame, RunnerServerFrame } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  imBindings,
  runtimeDurableWork,
  sandboxes,
  sessionMessages,
  users,
} from "../../db/schema/index.js";
import type { RuntimeDispatchAdmission } from "../../runtime/runtime-domain-owner.js";
import { PostgresRuntimeDurableWorkStore } from "../../runtime/runtime-durable-work-store.js";
import { RuntimeExecutionRegistry } from "../../runtime-credentials/execution-registry.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../../services/runtime-config/index.js";
import { CloudModelGrantService } from "../../services/sandboxes/cloud-model-grants.js";
import { type CloudConnectionRecord, CloudRuntimeFence } from "../../services/sandboxes/cloud-runtime-fence.js";
import {
  CloudSessionCollaborationOwner,
  CloudSessionWorkTracker,
  createCloudSourceConnectionVerifier,
  createSessionCliCloudProofAuthority,
} from "../../services/sandboxes/cloud-session-collaboration-owner.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { SandboxService } from "../../services/sandboxes/sandbox-service.js";
import { SessionCliProofService, SessionService } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * E8 Cloud Session collaboration on REAL PostgreSQL: registry-backed proof lifetime (queued
 * sibling, old-proof revocation, source self-revocation), acknowledged terminal settlement,
 * and authoritative accepted-work recovery after Instance loss.
 */

const MODEL = "fixture-cloud-model";
const RUNNER_VERSION = "0.0.5";
const JWT_SECRET = "unit-test-jwt-secret-at-least-32-characters";
const cloudIdentities = { enabled: true as const, runnerVersion: RUNNER_VERSION, storageBase: "gs://unit-cloud/x" };
const READINESS = {
  sandboxName: "ots-s-unit-1",
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: RUNNER_VERSION,
  reportedAt: new Date().toISOString(),
};
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);

afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

beforeEach(async () => {
  await testDatabase.reset();
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
  await client.database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "E8" });
  const cloud = await new ComputerService(client.database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(client.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e8-pi-${randomUUID().slice(0, 8)}`,
    displayName: "E8 Pi",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  await client.database
    .update(agentRuntimeConfigs)
    .set({ instructions: "Agent instructions.", model: MODEL })
    .where(eq(agentRuntimeConfigs.agentId, agent.id));
  const bindingId = randomUUID();
  await client.database.insert(imBindings).values({
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
  const sandbox = await new SandboxService(client.database, new SessionService(client.database), {
    cloudIdentities,
  }).ensureForAccount(accountId, {
    imBindingId: bindingId,
    channelId: "unit-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  const resourceName = `projects/unit/locations/us-west1/instances/ots-s-${sandbox.sandboxId.slice(0, 8)}-1`;
  await client.database
    .update(sandboxes)
    .set({
      lifecycle: "ready",
      environmentGeneration: 1,
      currentResourceName: resourceName,
      currentResourceUid: `unit-uid-${sandbox.sandboxId.slice(0, 8)}`,
    })
    .where(eq(sandboxes.id, sandbox.sandboxId));
  return {
    accountId,
    agentId: agent.id,
    bindingId,
    computerId: cloud.computerId,
    sandboxId: sandbox.sandboxId,
    sessionId: sandbox.sessionId,
    scope: { environmentGeneration: 1, resourceName, sandboxId: sandbox.sandboxId, sessionId: sandbox.sessionId },
  };
}

interface Stack {
  fence: CloudRuntimeFence;
  hub: RunnerHub;
  owner: CloudSessionCollaborationOwner;
  proofs: SessionCliProofService;
  registry: RuntimeExecutionRegistry;
  sessions: SessionService;
}

function makeStack(): Stack {
  const hub = new RunnerHub();
  const fence = new CloudRuntimeFence();
  const registry = new RuntimeExecutionRegistry();
  const grants = new CloudModelGrantService(JWT_SECRET, {
    allowedModels: [MODEL],
    maxStreamsPerToken: 2,
    ttlSeconds: 600,
  });
  const proofs = new SessionCliProofService(
    client.database,
    { currentInstanceId: () => undefined, supportsCapability: () => false },
    new Uint8Array(32).fill(7),
    { cloud: createSessionCliCloudProofAuthority({ fence, registry }) },
  );
  const sessions = new SessionService(client.database, {
    cloudSourceConnection: createCloudSourceConnectionVerifier(fence),
  });
  const owner = new CloudSessionCollaborationOwner({
    assembler: new EffectiveRuntimeSnapshotAssembler(client.database),
    database: client.database,
    durableWork: new PostgresRuntimeDurableWorkStore(client.database),
    fence,
    hub,
    modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
    modelGrants: grants,
    proofs,
    sessions,
    work: new CloudSessionWorkTracker(),
  });
  return { fence, hub, owner, proofs, registry, sessions };
}

function attachRunner(
  stack: Stack,
  fixture: CloudFixture,
  options: { executionEligible?: boolean; onFrame?: (frame: RunnerServerFrame) => void } = {},
): { connection: CloudConnectionRecord; sent: RunnerServerFrame[] } {
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
    sessionCollaborationEligible: true,
  });
  return { connection, sent };
}

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

function answeringOnFrame(stack: Stack, fixture: CloudFixture) {
  return (frame: RunnerServerFrame) => {
    if (frame.type !== "session:message:run") return;
    const connection = stack.fence.connectionForSandbox(fixture.sandboxId);
    if (!connection) return;
    void stack.owner.handleReceived(connection, {
      messageId: frame.message.messageId,
      phase: "received",
      requestId: frame.requestId,
      status: "accepted",
      turnId: `turn-${frame.message.messageId}`,
      type: "session:message:received",
    });
  };
}

const allowAdmission: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame> = async (operation) => ({
  admitted: true,
  result: Promise.resolve(await operation(() => undefined)),
});

async function dispatchAccepted(stack: Stack, fixture: CloudFixture, messageId: string) {
  await client.database.insert(sessionMessages).values({
    id: messageId,
    sourceSessionId: fixture.sessionId,
    targetSessionId: fixture.sessionId,
    content: "continue the task",
    contentHash: "a".repeat(64),
    attemptCount: 1,
    lastAttemptAt: new Date(),
  });
  const attach = attachRunner(stack, fixture, { onFrame: answeringOnFrame(stack, fixture) });
  const runtime = await new EffectiveRuntimeSnapshotAssembler(client.database).assembleForSession(fixture.sessionId);
  const outcome = await stack.owner.deliver(
    {
      attemptCount: 1,
      message: { content: "continue the task", id: messageId },
      route: {
        agentId: fixture.agentId,
        imBindingId: fixture.bindingId,
        sourceComputerId: fixture.computerId,
        sourceConnectionInstanceId: attach.connection.connectionId,
        sourcePlacementGeneration: 1,
        sourceSessionId: fixture.sessionId,
        targetComputerId: fixture.computerId,
        targetComputerKind: "cloud",
        targetInstallationId: randomUUID(),
        targetPlacementGeneration: 1,
        targetSessionId: fixture.sessionId,
        targetSessionKind: "channel",
        targetCreatorSessionId: null,
      },
      runtime,
    },
    allowAdmission,
  );
  expect(outcome).toEqual({ status: "accepted" });
  return attach;
}

describe("E8 Cloud Session collaboration on real PostgreSQL", () => {
  it("derives proof lifetime from the actual executions and revokes source authority on close", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack();
    const attach = attachRunner(stack, fixture);
    const executionA = openExecution(stack, fixture, attach.connection);
    const proofA = await stack.proofs.mintCloud({
      computerId: fixture.computerId,
      connectionId: attach.connection.connectionId,
      executionId: executionA.executionId,
      placementGeneration: 1,
      sandboxId: fixture.sandboxId,
      sessionId: fixture.sessionId,
    });
    const source = await stack.proofs.authenticate(proofA.token);
    expect(source).toMatchObject({ computerId: fixture.computerId, sessionId: fixture.sessionId });

    // The proof authorizes the same-Agent Session API while its execution is open.
    const authorized = await stack.sessions.authorizeAndRecordMessage({
      content: "follow-up",
      messageId: randomUUID(),
      sourceComputerId: source.computerId,
      sourceConnectionInstanceId: source.connectionInstanceId,
      sourceInstallationId: source.installationId,
      sourcePlacementGeneration: source.placementGeneration,
      sourceSessionId: source.sessionId,
      targetSessionId: fixture.sessionId,
    });
    expect(authorized.route.targetComputerKind).toBe("cloud");

    // A queued sibling execution reuses the same proof: the active Turn is never rotated.
    const executionB = openExecution(stack, fixture, attach.connection);
    const proofB = await stack.proofs.mintCloud({
      computerId: fixture.computerId,
      connectionId: attach.connection.connectionId,
      executionId: executionB.executionId,
      placementGeneration: 1,
      sandboxId: fixture.sandboxId,
      sessionId: fixture.sessionId,
    });
    expect(proofB.proofId).toBe(proofA.proofId);
    await expect(stack.proofs.authenticate(proofA.token)).resolves.toMatchObject({ sessionId: fixture.sessionId });

    // The first execution closes: the queued execution keeps the proof and the source authority.
    stack.registry.close(executionA.executionId, "execution_closed");
    await expect(stack.proofs.authenticate(proofA.token)).resolves.toMatchObject({ sessionId: fixture.sessionId });
    await expect(
      stack.sessions.authorizeAndRecordMessage({
        content: "after sibling close",
        messageId: randomUUID(),
        sourceComputerId: source.computerId,
        sourceConnectionInstanceId: source.connectionInstanceId,
        sourceInstallationId: source.installationId,
        sourcePlacementGeneration: source.placementGeneration,
        sourceSessionId: source.sessionId,
        targetSessionId: fixture.sessionId,
      }),
    ).resolves.toMatchObject({ route: { targetSessionId: fixture.sessionId } });

    // The last execution closes: self-revocation is immediate, with no timer involved, so no
    // fresh source context can be authenticated (the HTTP route authenticates the proof per
    // request; an already-issued source context is never a separate credential).
    stack.registry.close(executionB.executionId, "execution_closed");
    await expect(stack.proofs.authenticate(proofA.token)).rejects.toMatchObject({ code: "invalid_proof" });

    // A later Turn gets a fresh proof; the old token can never be resurrected.
    const executionC = openExecution(stack, fixture, attach.connection);
    const proofC = await stack.proofs.mintCloud({
      computerId: fixture.computerId,
      connectionId: attach.connection.connectionId,
      executionId: executionC.executionId,
      placementGeneration: 1,
      sandboxId: fixture.sandboxId,
      sessionId: fixture.sessionId,
    });
    expect(proofC.proofId).not.toBe(proofA.proofId);
    await expect(stack.proofs.authenticate(proofA.token)).rejects.toMatchObject({ code: "invalid_proof" });
    await expect(stack.proofs.authenticate(proofC.token)).resolves.toMatchObject({ sessionId: fixture.sessionId });

    // Explicit stop revokes the Session proof. There is no accepted work in this test, so nothing
    // is retained; accepted work is covered by the cancellation regression below.
    await stack.owner.cancelSessionMessages(fixture.sessionId);
    await expect(stack.proofs.authenticate(proofC.token)).rejects.toMatchObject({ code: "invalid_proof" });
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
  });

  it("retains accepted work across a cancellation request and acks the Runner's cancelled result", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack();
    const messageId = randomUUID();
    const attach = await dispatchAccepted(stack, fixture, messageId);
    attach.sent.length = 0;

    const outcomes = await stack.owner.cancelSessionMessages(fixture.sessionId);
    expect(outcomes).toEqual([{ messageId, status: "requested" }]);
    expect(attach.sent).toContainEqual(expect.objectContaining({ messageId, type: "session:message:cancel" }));
    // Requested is not drained: the durable barrier stays and the record is still accepted.
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
    const [pending] = await client.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(pending).toMatchObject({ status: "accepted" });

    // The Runner's cancelled terminal result is committed exactly once and acked.
    await stack.owner.handleSettled(attach.connection, {
      messageId,
      outcome: "cancelled",
      requestId: messageId,
      turnId: `turn-${messageId}`,
      type: "session:message:settled",
    });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({ messageId, status: "recorded", type: "session:message:settled:ack" }),
    );
    const [terminal] = await client.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    expect(terminal).toMatchObject({ status: "failed" });
    expect((terminal?.lastError as { code?: string } | null)?.code).toBe("turn_cancelled");
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(false);
  });

  it("retires accepted work only on authoritative Instance loss and never replays a late report", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack();
    const messageId = randomUUID();
    const attach = await dispatchAccepted(stack, fixture, messageId);
    const [record] = await client.database
      .select()
      .from(runtimeDurableWork)
      .where(
        and(
          eq(runtimeDurableWork.computerId, fixture.computerId),
          eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`),
        ),
      );
    if (!record) throw new Error("durable record missing");
    expect(record).toMatchObject({ kind: "session-message", status: "accepted" });
    expect((record.payload as { type?: string }).type).toBe("cloud-session-message-work");
    await expect(
      stack.owner.hasUnsettledSessionWork({
        allocation: {
          environmentGeneration: 1,
          resourceName: fixture.scope.resourceName,
          sandboxId: fixture.sandboxId,
        },
        sessionId: fixture.sessionId,
      }),
    ).resolves.toBe(true);

    // The Instance is replaced (instance-loss): the old allocation can never execute again.
    const nextResourceName = `${fixture.scope.resourceName}-next`;
    await client.database
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

    // A late receipt replay from the old Turn is retired, never re-executed, and gets no ack.
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
    await stack.owner.handleSettled(attach.connection, {
      messageId,
      outcome: "completed",
      requestId: messageId,
      turnId: `turn-${messageId}`,
      type: "session:message:settled",
    });
    expect(attach.sent.some((frame) => frame.type === "session:message:settled:ack")).toBe(false);
  });

  it("commits one terminal result exactly once and acks only that commit", async () => {
    const fixture = await seedCloudSession();
    const stack = makeStack();
    const messageId = randomUUID();
    const attach = await dispatchAccepted(stack, fixture, messageId);

    await stack.owner.handleSettled(attach.connection, {
      messageId,
      outcome: "unknown",
      requestId: messageId,
      turnId: `turn-${messageId}`,
      type: "session:message:settled",
    });
    expect(attach.sent).toContainEqual(
      expect.objectContaining({
        messageId,
        status: "recorded",
        turnId: `turn-${messageId}`,
        type: "session:message:settled:ack",
      }),
    );
    const [terminal] = await client.database
      .select()
      .from(runtimeDurableWork)
      .where(eq(runtimeDurableWork.recordKey, `${fixture.sessionId}:${messageId}`));
    // The conservative unknown outcome is preserved distinctly and never claimed as success.
    expect(terminal).toMatchObject({ status: "failed" });
    expect((terminal?.lastError as { code?: string } | null)?.code).toBe("turn_state_unknown");

    // A replay of the same immutable terminal result is idempotent.
    await stack.owner.handleSettled(attach.connection, {
      messageId,
      outcome: "unknown",
      requestId: messageId,
      turnId: `turn-${messageId}`,
      type: "session:message:settled",
    });
    expect(attach.sent.filter((frame) => frame.type === "session:message:settled:ack")).toHaveLength(2);
    expect(attach.sent.at(-1)).toMatchObject({ status: "already_recorded" });

    // A conflicting outcome is never overwritten and never acked.
    await stack.owner.handleSettled(attach.connection, {
      messageId,
      outcome: "completed",
      requestId: messageId,
      turnId: `turn-${messageId}`,
      type: "session:message:settled",
    });
    expect(attach.sent.filter((frame) => frame.type === "session:message:settled:ack")).toHaveLength(2);

    // A retransmitted receipt after the terminal commit is retired, not re-executed.
    attach.sent.length = 0;
    await stack.owner.handleReceived(attach.connection, {
      messageId,
      phase: "started",
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
    expect(attach.sent.some((frame) => frame.type === "session:message:run")).toBe(false);
  });
});
