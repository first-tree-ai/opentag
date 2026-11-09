import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RunnerCloudSessionMessageReceivedFrame, RunnerServerFrame } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agentRuntimeConfigs, imBindings, sandboxes, sessionMessages, users } from "../../db/schema/index.js";
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
  client = createDatabaseClient(testDatabase.databaseUrl, { max: 3, statementTimeoutMs: 2000, queryTimeoutMs: 5000 });
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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
it.each(["unknown", "cancelled"] as const)(
  "preserves an acknowledged %s result against concurrent allocation retirement",
  async (outcome) => {
    const f = await seedCloudSession(),
      stack = makeStack(),
      id = randomUUID(),
      attach = await dispatchAccepted(stack, f, id);
    const store = new PostgresRuntimeDurableWorkStore(client.database);
    const expected = await store.read(f.computerId, "session-message", `${f.sessionId}:${id}`);
    assert(expected);
    const admin = createDatabaseClient(testDatabase.databaseUrl, { max: 1 }),
      held = gate(),
      release = gate();
    const holder = admin.sql.begin(async (tx) => {
      await tx`select id from computers where id=${f.computerId} for update`;
      held.release();
      await release.promise;
    });
    let settled: Promise<void> | undefined, retired: Promise<number> | undefined;
    const frame = {
      messageId: id,
      outcome,
      requestId: id,
      turnId: `turn-${id}`,
      type: "session:message:settled" as const,
    };
    try {
      await Promise.race([held.promise, holder]);
      settled = stack.owner.handleSettled(attach.connection, frame);
      const waiters = async () =>
        Number(
          (
            await client.sql`select count(*) as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%computers%'`
          )[0]?.n,
        );
      await expect.poll(waiters, { timeout: 1000, interval: 5 }).toBe(1);
      await client.database
        .update(sandboxes)
        .set({ environmentGeneration: 2, currentResourceName: `${f.scope.resourceName}-replacement` })
        .where(eq(sandboxes.id, f.sandboxId));
      retired = stack.owner.reconcileSessionWork(f.sessionId);
      await expect.poll(waiters, { timeout: 1000, interval: 5 }).toBe(2);
      release.release();
      await holder;
      await settled;
      expect(await retired).toBe(0);
      expect(attach.sent).toContainEqual(
        expect.objectContaining({ type: "session:message:settled:ack", status: "recorded", turnId: frame.turnId }),
      );
      const final = await store.read(f.computerId, "session-message", `${f.sessionId}:${id}`);
      assert(final);
      expect(final).toMatchObject({
        status: "failed",
        lastError: { code: outcome === "unknown" ? "turn_state_unknown" : "turn_cancelled" },
      });
      const ackCount = attach.sent.filter((entry) => entry.type === "session:message:settled:ack").length;
      await stack.owner.handleSettled(attach.connection, frame);
      expect(attach.sent.filter((entry) => entry.type === "session:message:settled:ack")).toHaveLength(ackCount + 1);
      expect(attach.sent).toContainEqual(
        expect.objectContaining({
          type: "session:message:settled:ack",
          status: "already_recorded",
          turnId: frame.turnId,
        }),
      );
      expect(
        await store.replaceSessionMessageRecord(f.computerId, expected, { ...final, updatedAt: final.updatedAt + 1 }),
      ).toBeUndefined();
      expect(await client.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
    } finally {
      release.release();
      await holder;
      await Promise.allSettled([settled, retired]);
      await admin.sql.end({ timeout: 1 });
    }
  },
);
