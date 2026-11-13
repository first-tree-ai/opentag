import { randomUUID } from "node:crypto";
import type { RunnerCloudSessionMessageReceivedFrame, RunnerServerFrame } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agentRuntimeConfigs, imBindings, sandboxes, sessionMessages, users } from "../../db/schema/index.js";
import { stopCloudThenLocalAgentSessions } from "../../runtime/agent-session-stopper.js";
import type { RuntimeDispatchAdmission } from "../../runtime/runtime-domain-owner.js";
import { PostgresRuntimeDurableWorkStore } from "../../runtime/runtime-durable-work-store.js";
import { RuntimeExecutionRegistry } from "../../runtime-credentials/execution-registry.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../../services/runtime-config/index.js";
import { createStaticCloudModelCatalog } from "../../services/sandboxes/cloud-model-catalog.js";
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
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

// Native lifecycle authority with controlled Runner replies and actual Cloud proof/SQL owners.

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
  client = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
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
    catalog: createStaticCloudModelCatalog([MODEL]),
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
    agentAccessGeneration: 1,
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

it("keeps new accepted Cloud work and its proof after a stale suspend callback", async () => {
  const fixture = await seedCloudSession(),
    stack = makeStack();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  const service = new AgentService(client.database, {
    cloudIdentitiesEnabled: true,
    onProviderCliPlacementChanged: async (input) => {
      if (!input.computerId) {
        entered();
        await blocked;
      }
    },
    stopSessions: (targets) =>
      stopCloudThenLocalAgentSessions(
        client.database,
        targets,
        undefined,
        {
          currentInstanceId: () => undefined,
          requestReconcile: async () => {
            throw new Error("Local stop must skip active Agent");
          },
        },
        undefined,
        stack.owner,
      ),
  });
  const suspending = service.suspendById(fixture.accountId, fixture.agentId);
  try {
    await started;
    await service.reactivateById(fixture.accountId, fixture.agentId);
    const messageId = randomUUID(),
      attach = await dispatchAccepted(stack, fixture, messageId);
    const execution = openExecution(stack, fixture, attach.connection, messageId);
    const proof = await stack.proofs.mintCloud({
      sessionId: fixture.sessionId,
      computerId: fixture.computerId,
      placementGeneration: 1,
      connectionId: attach.connection.connectionId,
      sandboxId: fixture.sandboxId,
      executionId: execution.executionId,
    });
    await expect(stack.proofs.authenticate(proof.token)).resolves.toMatchObject({ agentId: fixture.agentId });
    attach.sent.length = 0;
    release();
    await suspending;
    expect((await service.getConfigById(fixture.accountId, fixture.agentId)).status).toBe("active");
    expect(attach.sent).not.toContainEqual(expect.objectContaining({ type: "session:message:cancel", messageId }));
    await expect(stack.proofs.authenticate(proof.token)).resolves.toMatchObject({ agentId: fixture.agentId });
    await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  } finally {
    release();
    await suspending;
  }
});

it("cancels current Cloud work and revokes only its proof on a one-connection pool", async () => {
  const fixture = await seedCloudSession(),
    stack = makeStack(),
    messageId = randomUUID();
  const attach = await dispatchAccepted(stack, fixture, messageId);
  const execution = openExecution(stack, fixture, attach.connection, messageId);
  const proof = await stack.proofs.mintCloud({
    sessionId: fixture.sessionId,
    computerId: fixture.computerId,
    placementGeneration: 1,
    connectionId: attach.connection.connectionId,
    sandboxId: fixture.sandboxId,
    executionId: execution.executionId,
  });
  const service = new AgentService(client.database, {
    cloudIdentitiesEnabled: true,
    stopSessions: (targets) =>
      stopCloudThenLocalAgentSessions(
        client.database,
        targets,
        undefined,
        {
          currentInstanceId: () => undefined,
          requestReconcile: async () => {
            throw new Error("Unexpected Local stop");
          },
        },
        undefined,
        stack.owner,
      ),
  });
  expect((await service.suspendById(fixture.accountId, fixture.agentId)).status).toBe("suspended");
  expect(attach.sent).toContainEqual(expect.objectContaining({ type: "session:message:cancel", messageId }));
  await expect(stack.proofs.authenticate(proof.token)).rejects.toMatchObject({ code: "invalid_proof" });
  await expect(stack.owner.hasUnsettledSessionWork({ sessionId: fixture.sessionId })).resolves.toBe(true);
  await expect(client.sql`select 1 as healthy`).resolves.toHaveLength(1);
});

it("preserves a reused Cloud proof and correlation when an older revoke loses its CAS", async () => {
  const fixture = await seedCloudSession(),
    stack = makeStack(),
    messageId = randomUUID();
  const attach = await dispatchAccepted(stack, fixture, messageId);
  const execution = openExecution(stack, fixture, attach.connection, messageId);
  const mint = (executionId: string) =>
    stack.proofs.mintCloud({
      sessionId: fixture.sessionId,
      computerId: fixture.computerId,
      placementGeneration: 1,
      connectionId: attach.connection.connectionId,
      sandboxId: fixture.sandboxId,
      executionId,
    });
  const old = await mint(execution.executionId),
    entered = deferred(),
    release = deferred();
  let armed = true;
  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then")
          return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(target)
              .then(async (rows) => {
                if (armed) {
                  armed = false;
                  entered.resolve();
                  await release.promise;
                }
                return rows;
              })
              .then(resolve, reject);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              const result = Reflect.apply(value, target, args);
              return result && typeof result === "object" ? wrap(result) : result;
            }
          : value;
      },
    });
  const paused = new Proxy(client.database, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "select") return (...args: unknown[]) => wrap(Reflect.apply(value, target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const revoking = stack.proofs.revokeForSession(fixture.sessionId, paused);
  try {
    await entered.promise;
    const newerExecution = openExecution(stack, fixture, attach.connection, randomUUID());
    const newer = await mint(newerExecution.executionId);
    expect(newer.proofId).toBe(old.proofId);
    release.resolve();
    await revoking;
    await expect(stack.proofs.authenticate(newer.token)).resolves.toMatchObject({ agentId: fixture.agentId });
  } finally {
    release.resolve();
    await revoking;
  }
});
