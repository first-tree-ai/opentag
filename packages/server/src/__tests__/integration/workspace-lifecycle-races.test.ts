/**
 * Real-PostgreSQL E5 lifecycle regressions: cross-request races (deferred create vs stop,
 * concurrent starts vs early readiness), uncertain-create reference preservation, and the
 * current-authority guards. The cloud side is the deterministic fake admin; the database is a
 * migrated PostgreSQL container, so the CAS/SQL behavior proven here is the production one.
 */
import { randomUUID } from "node:crypto";
import type { RunnerWorkspaceObject } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { imBindings, sandboxes, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { CloudRunAdminError } from "../../services/cloud-run/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { SandboxService } from "../../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../../services/sandboxes/runner-bootstrap-token.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { SandboxRunnerService } from "../../services/sandboxes/sandbox-runner-service.js";
import type { WorkspaceObjectScope, WorkspaceObjectStore } from "../../services/sandboxes/workspace-object-store.js";
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
}, 60_000);

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
    store: WorkspaceObjectStore;
    createConvergeTimeoutMs?: number;
    deleteVerifyTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
) {
  const tokens = new RunnerBootstrapTokenService("integration-test-jwt-secret-32-characters", { ttlSeconds: 600 });
  const hub = new RunnerHub();
  const service = new SandboxRunnerService(database, {
    cloudAdmin: fake as never,
    workspace: { store: options.store, sealTimeoutMs: 10_000 },
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

function persistence() {
  let object: RunnerWorkspaceObject | undefined;
  const claim = vi.fn(async (scope: WorkspaceObjectScope) => {
    if (!object && scope.environmentGeneration !== 1) throw new Error("Missing previously allocated workspace");
    object = {
      generation: "1",
      metageneration: "1",
      saved: false,
      sealed: false,
      bytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      md5: "1B2M2Y8AsgTpgAmY7PhCfg==",
      ...object,
      ownerGeneration: scope.environmentGeneration,
    };
    return object;
  });
  const store: WorkspaceObjectStore = {
    claim,
    head: async () => object,
    read: async () => {
      throw new Error("unused archive read");
    },
    write: async () => {
      throw new Error("unused archive write");
    },
  };
  return {
    store,
    claim,
    clear: () => {
      object = undefined;
    },
    seal: () => {
      if (!object) throw new Error("No seed");
      object = { ...object, saved: true, sealed: true, bytes: 1 };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("workspace lifecycle recovery on PostgreSQL", () => {
  it("initializes storage before reserving the first environment and leaves a failed seed retryable", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    const persisted = persistence();
    persisted.claim.mockRejectedValueOnce(new Error("storage unavailable"));
    const { service } = makeService(fake, persisted);
    await expect(service.startForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(await sandboxRow(sandbox.sandboxId)).toMatchObject({ lifecycle: "unallocated", environmentGeneration: 0 });
    expect(fake.createCalls).toHaveLength(0);
    await service.startForAccount(accountId, sandbox.sandboxId);
    expect(persisted.claim).toHaveBeenCalledTimes(2);
    expect(fake.createCalls).toHaveLength(1);
  });

  it("can claim the initial empty workspace after the first create fails and the allocation is replaced", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    fake.failNextCreateWith = new CloudRunAdminError("invalid", "rejected", { status: 400, createRejected: true });
    const persisted = persistence();
    const { service } = makeService(fake, persisted);
    await expect(service.startForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    await service.stopForAccount(accountId, sandbox.sandboxId);
    await service.startForAccount(accountId, sandbox.sandboxId);
    const row = await sandboxRow(sandbox.sandboxId);
    expect(row.environmentGeneration).toBe(2);
    await expect(
      persisted.store.claim({
        storageUri: row.storageUri,
        sandboxId: row.id,
        sessionId: row.sessionId,
        environmentGeneration: 2,
      }),
    ).resolves.toMatchObject({ saved: false, ownerGeneration: 2 });
  });

  it("does not recreate missing storage after any environment was allocated", async () => {
    const { accountId, sandbox } = await fixture();
    const fake = new FakeCloudRunAdmin();
    const persisted = persistence();
    const { service } = makeService(fake, persisted);
    await service.startForAccount(accountId, sandbox.sandboxId);
    await service.stopForAccount(accountId, sandbox.sandboxId);
    persisted.clear();
    await expect(service.startForAccount(accountId, sandbox.sandboxId)).rejects.toMatchObject({ statusCode: 409 });
    expect(await service.ensureIngressAllocation(accountId, sandbox.sandboxId)).toBe("restore_required");
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.liveInstanceCount()).toBe(0);
    expect(await sandboxRow(sandbox.sandboxId)).toMatchObject({ lifecycle: "unallocated", environmentGeneration: 1 });
  });

  it("a late create callback cannot clear the save requirement while a ready environment is stopping", async () => {
    const { accountId, sandbox } = await fixture();
    const created = deferred();
    const releaseCreate = deferred();
    class DelayedCreate extends FakeCloudRunAdmin {
      override async createInstance(...args: Parameters<FakeCloudRunAdmin["createInstance"]>) {
        const result = await super.createInstance(...args);
        created.resolve();
        await releaseCreate.promise;
        return { ...result, operationName: "late-operation" };
      }
    }
    const fake = new DelayedCreate();
    const persisted = persistence();
    const { service, hub } = makeService(fake, persisted);
    const starting = service.startForAccount(accountId, sandbox.sandboxId);
    await created.promise;
    const row = await sandboxRow(sandbox.sandboxId);
    const scope: RunnerScope = {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName as string,
    };
    await persisted.store.claim({ ...scope, storageUri: row.storageUri });
    const socket = fakeSocket();
    const readiness = {
      sandboxName: "test",
      rootfs: "/rootfs",
      nodeVersion: "v24.20.0",
      piVersion: "0.84.2",
      runnerVersion: RUNNER_VERSION,
      reportedAt: new Date().toISOString(),
    };
    hub.attach(scope, socket);
    hub.markReady(scope, readiness, socket);
    await service.startForAccount(accountId, sandbox.sandboxId);
    expect((await sandboxRow(row.id)).lifecycle).toBe("ready");
    const stopping = service.stopForAccount(accountId, sandbox.sandboxId);
    // Attach rejection observers immediately; assertion cleanup still awaits both operations.
    const settled = Promise.allSettled([starting, stopping]);
    try {
      await vi.waitFor(async () => expect((await sandboxRow(row.id)).lastErrorCode).toBe("workspace_save_required"));
      releaseCreate.resolve();
      await vi.waitFor(async () => {
        const latest = await sandboxRow(row.id);
        expect(latest.currentOperationName === "late-operation" || latest.lifecycle === "unallocated").toBe(true);
      });
      expect((await sandboxRow(row.id)).lastErrorCode).toBe("workspace_save_required");
      expect(fake.deleteCalls).toHaveLength(0);
    } finally {
      releaseCreate.resolve();
      // Complete every waiting seal request so no test leaves a pending lifecycle operation.
      persisted.seal();
      const seal = socket.sent.find((frame) => (frame as { type: string }).type === "workspace:seal") as
        | { requestId: string }
        | undefined;
      if (seal)
        hub.settleWorkspaceSeal(
          scope.sandboxId,
          { type: "workspace:seal:result", requestId: seal.requestId, ok: true },
          socket,
        );
      await settled;
    }
    expect((await sandboxRow(row.id)).lifecycle).toBe("unallocated");
  });
});
