/**
 * Real-PostgreSQL E3 lifecycle semantics: cross-request races (deferred create vs stop,
 * concurrent starts vs early readiness), uncertain-create reference preservation, and the
 * current-authority guards. The cloud side is the deterministic fake admin; the database is a
 * migrated PostgreSQL container, so the CAS/SQL behavior proven here is the production one.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { agents, imBindings, sandboxes, sessions, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { SandboxService } from "../../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../../services/sandboxes/runner-bootstrap-token.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { SandboxRunnerService } from "../../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { FakeCloudRunAdmin } from "../support/fake-cloud-run-admin.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const RUNNER_VERSION = "0.0.5";
const cloudIdentities = {
  enabled: true,
  runnerVersion: RUNNER_VERSION,
  storageBase: "gs://integration-cloud/sandboxes",
};
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

let testDatabase: MigratedTestDatabase;
let sql: ReturnType<typeof createDatabaseClient>["sql"];
let database: DatabaseClient;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  const client = createDatabaseClient(testDatabase.databaseUrl);
  sql = client.sql;
  database = client.database;
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await testDatabase?.stop();
});

beforeEach(async () => testDatabase.reset());

async function fixture() {
  const accountId = randomUUID();
  await database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "E3 IT" });
  const cloud = await new ComputerService(database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e3-it-${randomUUID().slice(0, 8)}`,
    displayName: "E3 IT",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  const bindingId = randomUUID();
  await database.insert(imBindings).values({
    id: bindingId,
    agentId: agent.id,
    provider: "feishu",
    status: "active",
    externalAppId: `it-app-${randomUUID().slice(0, 8)}`,
    externalBotId: "it-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "integration-only-unused",
    activatedAt: new Date(),
  });
  const sandbox = await new SandboxService(database, new SessionService(database), {
    cloudIdentities,
  }).ensureForAccount(accountId, {
    imBindingId: bindingId,
    channelId: "it-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  return { accountId, sandbox, agent };
}

function makeService(
  fake: FakeCloudRunAdmin,
  options: {
    createConvergeTimeoutMs?: number;
    deleteVerifyTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const tokens = new RunnerBootstrapTokenService("integration-test-jwt-secret-32-characters", { ttlSeconds: 600 });
  const hub = new RunnerHub();
  const service = new SandboxRunnerService(database, {
    cloudAdmin: fake as never,
    tokens,
    hub,
    environment: "staging",
    backendUrl: "wss://api.example.com/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: RUNNER_VERSION,
    acceptanceTimeoutMs: 30_000,
    createConvergeTimeoutMs: options.createConvergeTimeoutMs ?? 30_000,
    deleteVerifyTimeoutMs: options.deleteVerifyTimeoutMs ?? 2_000,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  return { service, tokens, hub };
}

function fakeSocket(): RunnerControlSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    send(frame) {
      sent.push(frame);
    },
    close() {},
  };
}

async function sandboxRow(sandboxId: string) {
  const [row] = await database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
  return row as typeof sandboxes.$inferSelect;
}

describe("SandboxRunnerService real-PostgreSQL lifecycle", () => {
  it("persists the deterministic name before I/O and never clears it while the create is unknown", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 300 });
    const start = service.startForAccount(accountId, sandbox.sandboxId);
    await vi.waitFor(async () => {
      const row = await sandboxRow(sandbox.sandboxId);
      expect(row?.lifecycle).toBe("preparing");
      expect(row?.currentResourceName).not.toBeNull();
      expect(row?.lastErrorCode).toBe("cloud_create_pending");
    });
    const awaiting = await sandboxRow(sandbox.sandboxId);
    // A concurrent stop observes `preparing` with a persisted name. The create result is unknown
    // (the request is in flight), so release must NOT clear the reference or the pending marker.
    await expect(service.stopForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const releasing = await sandboxRow(sandbox.sandboxId);
    expect(releasing?.lifecycle).toBe("releasing");
    expect(releasing?.currentResourceName).toBe(awaiting?.currentResourceName);
    expect(releasing?.currentResourceUid).toBeNull();
    expect(releasing?.lastErrorCode).toBe("cloud_create_pending");
    // The late create lands while releasing and the pending release completes in the SAME start
    // request: no leaked Instance and no second user stop required.
    open();
    await expect(start).resolves.toMatchObject({ lifecycle: "unallocated" });
    const cleared = await sandboxRow(sandbox.sandboxId);
    expect(cleared?.currentResourceName).toBeNull();
    expect(cleared?.currentResourceUid).toBeNull();
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("concurrent starts submit one create and an early Runner report is promoted after tracking", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const { service, hub } = makeService(fake);
    const first = service.startForAccount(accountId, sandbox.sandboxId);
    const second = service.startForAccount(accountId, sandbox.sandboxId);
    await vi.waitFor(async () => {
      expect((await sandboxRow(sandbox.sandboxId))?.lifecycle).toBe("preparing");
      expect(fake.createCalls).toHaveLength(1);
    });
    const pending = await sandboxRow(sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: pending?.currentResourceName as string,
    };
    const socket = fakeSocket();
    const readiness = {
      sandboxName: "ots-s-x-1",
      rootfs: "/opt/sandbox-root",
      nodeVersion: "v24.19.0",
      piVersion: "0.84.2",
      runnerVersion: RUNNER_VERSION,
      reportedAt: new Date().toISOString(),
    };
    hub.attach(scope, socket);
    hub.markReady(scope, readiness, socket);
    // The create caller has not recorded the verified UID yet: readiness is deferred, not fatal.
    expect(await service.markRunnerReady(scope, readiness)).toBe("deferred");
    open();
    await Promise.all([first, second]);
    await vi.waitFor(async () => {
      expect((await sandboxRow(sandbox.sandboxId))?.lifecycle).toBe("ready");
    });
    const status = await service.statusForAccount(accountId, sandbox.sandboxId);
    expect(status.runnerReady).toBe(true);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("keeps an unknown create's reference through a 404 and only adopts the resource that materializes", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    fake.createUnknownWithoutResourceOnce = true;
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 300 });
    const first = await service.startForAccount(accountId, sandbox.sandboxId);
    expect(first.lastErrorCode).toBe("cloud_create_uncertain");
    expect(first.currentResourceName).not.toBeNull();
    expect(first.currentResourceUid).toBeNull();
    // A later start reconciles GET only; the 404 is not proof no late create exists.
    const second = await service.startForAccount(accountId, sandbox.sandboxId);
    expect(second.environmentGeneration).toBe(1);
    expect(fake.createCalls).toHaveLength(1);
    // Stop cannot clear an uncertain reference.
    await expect(service.stopForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect((await sandboxRow(sandbox.sandboxId))?.lifecycle).toBe("releasing");
    expect((await sandboxRow(sandbox.sandboxId))?.currentResourceName).toBe(first.currentResourceName);
    // The late create materializes; a retried stop finds, verifies and deletes it.
    fake.materialize(fake.createCalls[0] as never);
    const stopped = await service.stopForAccount(accountId, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(stopped.currentResourceUid).toBeNull();
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("keeps status/stop ownership access but denies start and Runner connect for a disabled chain", async () => {
    const { accountId, sandbox, agent } = await fixture();
    const fake = new FakeCloudRunAdmin();
    const { service } = makeService(fake);
    const started = await service.startForAccount(accountId, sandbox.sandboxId);
    await database.update(agents).set({ status: "suspended" }).where(eq(agents.id, agent.id));

    const status = await service.statusForAccount(accountId, sandbox.sandboxId);
    expect(status.lifecycle).toBe("preparing");
    await expect(service.startForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.validateRunnerScope({
        sandboxId: sandbox.sandboxId,
        sessionId: sandbox.sessionId,
        environmentGeneration: 1,
        resourceName: started.currentResourceName as string,
      }),
    ).resolves.toBeUndefined();
    // Stop still cleans up the owned environment.
    const stopped = await service.stopForAccount(accountId, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");

    await database.update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));
    await database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sandbox.sessionId));
    await expect(service.startForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 404 });
    await database.update(sessions).set({ endedAt: null }).where(eq(sessions.id, sandbox.sessionId));
    await database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, accountId));
    await expect(service.startForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 404 });
    expect(fake.createCalls).toHaveLength(1);
  });
});
