import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agentSchedules,
  agents,
  computers,
  imBindings,
  sandboxes,
  sessionMessages,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { PostgresRuntimeDurableWorkStore } from "../../runtime/runtime-durable-work-store.js";
import { EffectiveRuntimeSnapshotAssembler } from "../../services/runtime-config/index.js";
import { createStaticCloudModelCatalog } from "../../services/sandboxes/cloud-model-catalog.js";
import { CloudModelGrantService } from "../../services/sandboxes/cloud-model-grants.js";
import { CloudRuntimeFence } from "../../services/sandboxes/cloud-runtime-fence.js";
import {
  CloudSessionCollaborationOwner,
  CloudSessionWorkTracker,
} from "../../services/sandboxes/cloud-session-collaboration-owner.js";
import { RunnerHub } from "../../services/sandboxes/runner-hub.js";
import { ScheduleScheduler } from "../../services/schedules/scheduler.js";
import { SessionCollaborationService } from "../../services/sessions/session-collaboration-service.js";
import { SessionService } from "../../services/sessions/session-service.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";
import { startDatabaseFaultProxy } from "./support/postgres-fault-proxy.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "caller-lifecycle-model";
let fixture: MigratedTestDatabase;
let observer: ReturnType<typeof createDatabaseClient>;

beforeAll(async () => {
  fixture = await startMigratedTestDatabase();
  observer = createDatabaseClient(fixture.databaseUrl);
  await observer.sql`create role caller_startup login password 'local-test-only'`;
  await observer.sql`grant usage on schema drizzle, public, billing to caller_startup`;
  await observer.sql`grant select on all tables in schema drizzle to caller_startup`;
}, 120_000);
beforeEach(async () => fixture.reset());
afterAll(async () => {
  await observer?.sql.end({ timeout: 1 });
  await fixture?.stop();
});

function limitedUrl() {
  const url = new URL(fixture.databaseUrl);
  url.username = "caller_startup";
  url.password = "local-test-only";
  return url.toString();
}

async function runEntry(path: string, environment: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", path], {
        cwd: root,
        env: { PATH: process.env.PATH, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 8_000,
        killSignal: "SIGKILL",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    },
  );
}

function serverEnvironment(url: string): NodeJS.ProcessEnv {
  return {
    OPENTAG_ENV: "dev",
    OPENTAG_DATABASE_URL: url,
    OPENTAG_AUTO_MIGRATE: "false",
    OPENTAG_PUBLIC_URL: "http://127.0.0.1:8000",
    OPENTAG_HOST: "127.0.0.1",
    OPENTAG_PORT: "8000",
    OPENTAG_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    OPENTAG_JWT_SECRET: "caller-jwt-secret-abcdefghijklmnopqrstuvwxyz",
    BETTER_AUTH_SECRET: "caller-auth-secret-abcdefghijklmnopqrstuvwxyz",
    OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
    OPENTAG_CLOUD_STORAGE_BASE: "gs://caller-test/sandboxes",
    OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
    OPENTAG_CLOUD_RUNNER_IMAGE: `caller/image@sha256:${"a".repeat(64)}`,
    OPENTAG_CLOUD_RUNNER_PROJECT: "caller-project",
    OPENTAG_CLOUD_RUNNER_REGION: "asia-east1",
    OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "caller-runner@caller-project.iam.gserviceaccount.com",
    OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://caller.example.test",
    OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "caller-network",
    OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "caller-subnet",
    OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "caller-tag",
    OPENTAG_CLOUD_RUNNER_PREWARM_ENABLED: "false",
    OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN: "local-unused-token",
    OPENTAG_CLOUD_MODEL_ENABLED: "true",
    OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "https://unused.example.test",
    OPENTAG_CLOUD_MODEL_MASTER_KEY: "local-unused-model-key",
  };
}

it("exits after an established SQL failure before App creation and leaves no pool sessions", async () => {
  const result = await runEntry("src/index.ts", serverEnvironment(limitedUrl()));
  expect(result, JSON.stringify(result)).toMatchObject({ code: 1, signal: null });
  expect(result.stderr).toContain("Failed to start OpenTag server");
  expect(result.stderr).toContain("permission denied for table attempts");
  const [sessions] =
    await observer.sql`select count(*)::int as count from pg_stat_activity where usename = 'caller_startup'`;
  expect(sessions?.count).toBe(0);
  const [healthy] = await observer.sql`select 1 as healthy`;
  expect(healthy?.healthy).toBe(1);
}, 15_000);

it.each([false, true])(
  "bounds rollout CLI close when the peer withholds FIN, query failure=%s",
  async (failure) => {
    const proxy = await startDatabaseFaultProxy(failure ? limitedUrl() : fixture.databaseUrl);
    const add = proxy.connections.add.bind(proxy.connections);
    proxy.connections.add = (connection) => {
      connection.blockClose = true;
      return add(connection);
    };
    try {
      const result = await runEntry("src/admin/mcp-rollout-status-cli.ts", {
        OPENTAG_DATABASE_URL: proxy.url,
        OPENTAG_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      });
      expect(result, JSON.stringify(result)).toMatchObject({ code: failure ? 1 : 0, signal: null });
      if (failure) {
        expect(result.stderr).toContain("permission denied for table mcp_server_authorizations");
      } else {
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ legacyDowngradeAllowed: true });
      }
      expect([...proxy.connections].some((connection) => connection.blockClose && connection.clientEnded)).toBe(true);
    } finally {
      await proxy.close();
    }
  },
  15_000,
);

async function seedCloudSchedules() {
  const accountId = randomUUID();
  const agentId = randomUUID();
  const computerId = randomUUID();
  const sessionId = randomUUID();
  const bindingId = randomUUID();
  const sandboxId = randomUUID();
  const database = observer.database;
  await database.insert(users).values({ id: accountId, email: `${accountId}@example.test`, displayName: "Caller" });
  await database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    kind: "cloud",
    currentInstallationId: randomUUID(),
    currentInstanceId: randomUUID(),
    displayName: "Caller Cloud",
    platform: "linux",
    arch: "arm64",
    clientVersion: "0.0.5",
  });
  await database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: `caller-${agentId}`,
    displayName: "Caller",
    runtimeProvider: "pi",
  });
  await database.insert(agentRuntimeConfigs).values({ agentId, instructions: "Caller fixture", model });
  await database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: bindingId,
    externalBotId: "caller",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unused",
    activatedAt: new Date(),
  });
  await database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "caller",
    conversationKind: "channel",
    kind: "channel",
  });
  await database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  await database.insert(sandboxes).values({
    id: sandboxId,
    sessionId,
    storageUri: `gs://caller/${sandboxId}`,
    lifecycle: "ready",
    environmentGeneration: 1,
    currentResourceName: `projects/caller/locations/unit/instances/${sandboxId}`,
    currentResourceUid: randomUUID(),
  });
  const now = new Date();
  await database.insert(agentSchedules).values(
    Array.from({ length: 6 }, (_, i) => ({
      agentId,
      targetSessionId: sessionId,
      name: `Caller ${i}`,
      prompt: "Caller fixture",
      schedule: { kind: "at" as const, at: now.toISOString() },
      timezone: "UTC",
      enabled: true,
      nextTriggerAt: now,
    })),
  );
  return { accountId, sessionId, sandboxId };
}

describe("scheduled Cloud cancellation with real PostgreSQL", () => {
  it.each(["budget", "stop"] as const)(
    "does not start abandoned preparation after %s",
    async (mode) => {
      const seeded = await seedCloudSchedules();
      const client = createDatabaseClient(fixture.databaseUrl, { max: 4 });
      const service = new SessionService(client.database);
      const assembler = new EffectiveRuntimeSnapshotAssembler(client.database);
      const grants = new CloudModelGrantService("caller-grant-secret-abcdefghijklmnopqrstuvwxyz", {
        catalog: createStaticCloudModelCatalog([model]),
        maxStreamsPerToken: 2,
        ttlSeconds: 600,
      });
      const hub = new RunnerHub();
      const send = vi.spyOn(hub, "sendToCurrent");
      let stopped = false;
      const afterStop: boolean[] = [];
      const allocation = vi.fn(async () => {
        afterStop.push(stopped);
        return "pending" as const;
      });
      const cloud = new CloudSessionCollaborationOwner({
        database: client.database,
        fence: new CloudRuntimeFence(),
        hub,
        work: new CloudSessionWorkTracker(),
        assembler,
        durableWork: new PostgresRuntimeDurableWorkStore(client.database),
        modelBaseUrl: "https://unused.example.test",
        modelGrants: grants,
        ensureTimeoutMs: 200,
        allocation: {
          ensureSandbox: async () => ({ accountId: seeded.accountId, sandboxId: seeded.sandboxId }),
          ensureEnvironmentAllocated: allocation,
        },
      });
      const collaboration = new SessionCollaborationService({
        assembler,
        sessions: service,
        domain: {
          requestReconcile: async () => {
            throw new Error("unexpected Local reconcile");
          },
          requestSessionMessageDelivery: async () => {
            throw new Error("unexpected Local delivery");
          },
        },
        registry: {
          capabilityVersion: () => undefined,
          currentInstanceId: () => undefined,
          supportsCapability: () => false,
        },
        cloud,
        scheduledBudgets: { localMs: 5_000, cloudMs: mode === "budget" ? 500 : 5_000 },
      });
      const scheduler = new ScheduleScheduler({
        database: client.database,
        dispatch: collaboration,
        sessions: service,
        publicUrl: "https://caller.example.test",
      });
      try {
        await scheduler.scanNow();
        await expect.poll(() => allocation.mock.calls.length, { timeout: 2_000, interval: 10 }).toBeGreaterThan(0);
        if (mode === "budget")
          await expect.poll(() => scheduler.inFlightCount, { timeout: 3_000, interval: 10 }).toBe(0);
        await scheduler.stop();
        stopped = true;
        await expect.poll(() => cloud.activeDispatchTargets, { timeout: 2_000, interval: 10 }).toBe(0);
        await sleep(250);
        expect(afterStop.every((value) => !value)).toBe(true);
        if (mode === "stop") expect(allocation).toHaveBeenCalledOnce();
        expect(scheduler.inFlightCount).toBe(0);
        expect(send).not.toHaveBeenCalled();
        const [healthy] = await client.sql`select 1 as healthy`;
        expect(healthy?.healthy).toBe(1);
        const rows = await client.database
          .select()
          .from(sessionMessages)
          .where(eq(sessionMessages.targetSessionId, seeded.sessionId));
        expect(rows).toHaveLength(6);
        expect(rows.every((row) => row.lastOutcome !== "accepted")).toBe(true);
      } finally {
        await scheduler.stop();
        await expect.poll(() => cloud.activeDispatchTargets, { timeout: 3_000 }).toBe(0);
        grants.close();
        await client.sql.end({ timeout: 1 });
      }
    },
    15_000,
  );
});
