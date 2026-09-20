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
import { CloudRunAdminError } from "../../services/cloud-run/index.js";
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
    expectedRunnerVersion?: string;
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
    expectedRunnerVersion: options.expectedRunnerVersion ?? RUNNER_VERSION,
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

describe("SandboxRunnerService original-image reconnect on PostgreSQL", () => {
  const OLD_VERSION = "0.0.4";
  const UPGRADED_VERSION = "0.0.6";
  const OLD_IMAGE = `unit/image@sha256:${"1".repeat(64)}`;
  const UPGRADED_IMAGE = `unit/image@sha256:${"2".repeat(64)}`;

  function readinessFor(version: string) {
    return {
      sandboxName: "ots-s-x-1",
      rootfs: "/opt/sandbox-root",
      nodeVersion: "v24.19.0",
      piVersion: "0.84.2",
      runnerVersion: version,
      reportedAt: new Date().toISOString(),
    };
  }

  /** One READY environment whose Instance was created and verified under the given target. */
  async function readyUnderTarget(target: { image: string; version: string }) {
    const it = await fixture();
    const fake = new FakeCloudRunAdmin();
    fake.targetImage = target.image;
    const made = makeService(fake, { expectedRunnerVersion: target.version });
    await made.service.startForAccount(it.accountId, it.sandbox.sandboxId);
    const row = await sandboxRow(it.sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: it.sandbox.sandboxId,
      sessionId: it.sandbox.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName as string,
    };
    const socket = fakeSocket();
    made.hub.attach(scope, socket);
    made.hub.markReady(scope, readinessFor(target.version), socket);
    expect(await made.service.markRunnerReady(scope, readinessFor(target.version))).toBe("ready");
    expect((await sandboxRow(it.sandbox.sandboxId)).lifecycle).toBe("ready");
    return { ...it, fake, ...made, scope };
  }

  /** A fresh Server process over the same database/cloud with a changed deployment target. */
  function restartedWithTarget(fake: FakeCloudRunAdmin, target: { image: string; version: string }) {
    fake.targetImage = target.image;
    return makeService(fake, { expectedRunnerVersion: target.version });
  }

  it("accepts a previously verified READY Instance reconnecting after a restart with a new target", async () => {
    const { accountId, sandbox, fake, scope } = await readyUnderTarget({ image: OLD_IMAGE, version: OLD_VERSION });
    const restart = restartedWithTarget(fake, { image: UPGRADED_IMAGE, version: UPGRADED_VERSION });
    const socket = fakeSocket();
    restart.hub.attach(scope, socket);
    expect(await restart.service.markRunnerReady(scope, readinessFor(OLD_VERSION))).toBe("ready");
    expect(restart.hub.markReady(scope, readinessFor(OLD_VERSION), socket)).toBe(true);
    const status = await restart.service.statusForAccount(accountId, sandbox.sandboxId);
    expect(status).toMatchObject({ lifecycle: "ready", runnerReady: true, environmentGeneration: 1 });
    expect(await restart.service.ensureIngressAllocation(accountId, sandbox.sandboxId)).toBe("ready");
    // No replacement and no cleanup: the same physical Instance simply continues.
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toHaveLength(0);
    expect(fake.liveInstanceCount()).toBe(1);
    // Explicit stop still releases the legacy Instance through the verified cleanup path.
    const stopped = await restart.service.stopForAccount(accountId, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("keeps a newer existing Runner permitted when the target rolls back", async () => {
    const { sandbox, fake, scope } = await readyUnderTarget({ image: UPGRADED_IMAGE, version: UPGRADED_VERSION });
    const rollback = restartedWithTarget(fake, { image: OLD_IMAGE, version: OLD_VERSION });
    const socket = fakeSocket();
    rollback.hub.attach(scope, socket);
    expect(await rollback.service.markRunnerReady(scope, readinessFor(UPGRADED_VERSION))).toBe("ready");
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("ready");
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("rejects a wrong-version report on the CURRENT target image even for a tracked READY row", async () => {
    const { accountId, sandbox, fake, scope } = await readyUnderTarget({ image: OLD_IMAGE, version: OLD_VERSION });
    // The target image did NOT change; a different version expectation alone can never be met by
    // a report whose image is still the current target.
    const restart = makeService(fake, { expectedRunnerVersion: UPGRADED_VERSION });
    const socket = fakeSocket();
    restart.hub.attach(scope, socket);
    expect(await restart.service.markRunnerReady(scope, readinessFor(OLD_VERSION))).toBe("version_mismatch");
    expect(restart.hub.describe(sandbox.sandboxId).ready).toBe(false);
    expect((await restart.service.statusForAccount(accountId, sandbox.sandboxId)).runnerReady).toBe(false);
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("ready");
  });

  it("keeps first admission fail-closed for untracked and tracked preparing allocations", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    fake.targetImage = OLD_IMAGE;
    let open!: () => void;
    fake.createGate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };
    const { service } = makeService(fake, { expectedRunnerVersion: UPGRADED_VERSION });
    const providerReads = vi.spyOn(fake, "getInstance");
    const start = service.startForAccount(accountId, sandbox.sandboxId);
    await vi.waitFor(async () => {
      expect((await sandboxRow(sandbox.sandboxId))?.lifecycle).toBe("preparing");
    });
    const pending = await sandboxRow(sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: pending.currentResourceName as string,
    };
    // Untracked (create outcome unknown, no UID): a wrong-version report is a plain mismatch and
    // must never trigger an original-image provider lookup.
    expect(await service.markRunnerReady(scope, readinessFor(OLD_VERSION))).toBe("version_mismatch");
    expect(providerReads).not.toHaveBeenCalled();
    open();
    await start;
    // Tracked but still preparing (first admission): equally fail-closed, still no lookup.
    expect((await sandboxRow(sandbox.sandboxId)).currentResourceUid).not.toBeNull();
    expect(await service.markRunnerReady(scope, readinessFor(OLD_VERSION))).toBe("version_mismatch");
    expect(providerReads).not.toHaveBeenCalled();
    expect((await sandboxRow(sandbox.sandboxId)).lifecycle).toBe("preparing");
  });

  it("fails closed when the tracked binding changes while the provider read is in flight", async () => {
    const { sandbox, fake, scope } = await readyUnderTarget({ image: OLD_IMAGE, version: OLD_VERSION });
    const restart = restartedWithTarget(fake, { image: UPGRADED_IMAGE, version: UPGRADED_VERSION });
    const realGet = fake.getInstance.bind(fake);
    let release!: () => void;
    let markStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let gated = true;
    fake.getInstance = async (name: string) => {
      if (gated) {
        gated = false;
        markStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realGet(name);
    };
    const pendingReport = restart.service.markRunnerReady(scope, readinessFor(OLD_VERSION));
    await readStarted;
    // The tracked UID was replaced mid-verification: the recheck after the read must refuse.
    await database
      .update(sandboxes)
      .set({ currentResourceUid: "uid-swapped" })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    release();
    expect(await pendingReport).toBe("stale");
    expect(await sandboxRow(sandbox.sandboxId)).toMatchObject({
      lifecycle: "ready",
      currentResourceUid: "uid-swapped",
    });
    expect(fake.liveInstanceCount()).toBe(1);
  });
});

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

  it("preserves a definitive create marker across a failed stop read so a later 404 releases the row", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    fake.failNextCreateWith = new CloudRunAdminError("invalid", "rejected", { status: 400, createRejected: true });
    const { service } = makeService(fake, { deleteVerifyTimeoutMs: 300 });
    await expect(service.startForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const rejected = await sandboxRow(sandbox.sandboxId);
    expect(rejected?.lastErrorCode).toBe("cloud_create_rejected");
    expect(rejected?.currentOperationName).toBeNull();
    // The stop-phase GET fails (the same IAM/transient problem that rejected the create): the
    // delete-phase failure must NOT overwrite the definitive create marker. Previously this
    // wrote `cloud_delete_incomplete` and stranded the row in `releasing` with no API recovery.
    fake.getInstanceFailures = 1;
    await expect(service.stopForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const afterFailure = await sandboxRow(sandbox.sandboxId);
    expect(afterFailure?.lifecycle).toBe("releasing");
    expect(afterFailure?.lastErrorCode).toBe("cloud_create_rejected");
    expect(afterFailure?.currentResourceName).toBe(rejected?.currentResourceName);
    // The read recovers and returns 404: the preserved marker is definitive evidence, so this
    // stop clears the row instead of timing out into uncertainty again.
    const recovered = await service.stopForAccount(accountId, sandbox.sandboxId);
    expect(recovered.lifecycle).toBe("unallocated");
    expect(recovered.currentResourceName).toBeNull();
    expect(recovered.lastErrorCode).toBeNull();
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("deletes an owned Instance whose policy fails verification instead of stranding it", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    // A persistent POLICY failure with intact ownership: adoption/readiness stay blocked, but
    // stop must still delete our own resource (ownership gates delete, policy never does).
    fake.failVerifyWith = new CloudRunAdminError("invalid", "egress is not ALL_TRAFFIC");
    fake.failVerifyCount = -1;
    const { service } = makeService(fake);
    await expect(service.startForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    const blocked = await sandboxRow(sandbox.sandboxId);
    expect(blocked?.lastErrorCode).toBe("cloud_instance_unverified");
    expect(blocked?.currentResourceUid).toBeNull();
    expect(fake.liveInstanceCount()).toBe(1);
    const stopped = await service.stopForAccount(accountId, sandbox.sandboxId);
    expect(stopped.lifecycle).toBe("unallocated");
    expect(fake.liveInstanceCount()).toBe(0);
    expect(fake.deleteCalls).toHaveLength(1);
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
