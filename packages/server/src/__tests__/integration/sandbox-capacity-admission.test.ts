/**
 * E9 resource admission on real PostgreSQL: several independent reservation transactions race
 * for the last Account/platform slot, failure-phase allocations (unknown create, delete
 * unconfirmed, save failed) keep their slot until verified absence, same-account physical reuse
 * is never charged as a new reservation, and a retried generation is never charged twice.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { imBindings, sandboxes, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { CloudRunAdminError } from "../../services/cloud-run/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { CloudCapacityExceededError } from "../../services/sandboxes/errors.js";
import { SandboxService } from "../../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../../services/sandboxes/runner-bootstrap-token.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { countCloudCapacityOccupancy } from "../../services/sandboxes/sandbox-capacity.js";
import { SandboxRunnerService } from "../../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { FakeCloudRunAdmin } from "../support/fake-cloud-run-admin.js";
import { FakeWorkspaceObjectStore } from "../support/fake-workspace-store.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const RUNNER_VERSION = "0.0.5";
const JWT_SECRET = "integration-test-jwt-secret-at-least-32-characters";
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

async function account() {
  const id = randomUUID();
  await database.insert(users).values({ id, email: `${id}@example.test`, displayName: "E9 capacity" });
  return id;
}

async function ownedSandbox(accountId: string, channel: string) {
  const cloud = await new ComputerService(database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e9-cap-${randomUUID().slice(0, 8)}`,
    displayName: "E9 capacity",
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
  return new SandboxService(database, new SessionService(database), { cloudIdentities }).ensureForAccount(accountId, {
    imBindingId: bindingId,
    channelId: channel,
    conversationKind: "channel",
    kind: "channel",
  });
}

interface RaceStack {
  fake: FakeCloudRunAdmin;
  store: FakeWorkspaceObjectStore;
  hub: RunnerHub;
  service: SandboxRunnerService;
}

function makeStack(capacity: { accountLimit: number; platformLimit: number }, options: { workspace?: boolean } = {}) {
  const fake = new FakeCloudRunAdmin();
  const store = new FakeWorkspaceObjectStore();
  const hub = new RunnerHub();
  const tokens = new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: 600 });
  const service = new SandboxRunnerService(database, {
    cloudAdmin: fake as never,
    tokens,
    hub,
    environment: "staging",
    backendUrl: "wss://unit.example/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: RUNNER_VERSION,
    acceptanceTimeoutMs: 10_000,
    createConvergeTimeoutMs: 30_000,
    idleTimeoutMs: 120_000,
    sleep: () => Promise.resolve(),
    capacity,
    ...(options.workspace === false ? {} : { workspace: { store } }),
  });
  return { fake, store, hub, service };
}

async function rowFor(sandboxId: string) {
  const [row] = await database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
  if (!row) throw new Error("Missing Sandbox row");
  return row;
}

function expectCapacity(error: unknown, scope: "account" | "platform") {
  expect(error).toBeInstanceOf(CloudCapacityExceededError);
  expect(error).toMatchObject({
    code: "CLOUD_CAPACITY_EXCEEDED",
    category: "transient",
    statusCode: 429,
    scope,
  });
}

/** One ready Sandbox whose E7 reuse-capable Runner answers the E5 seal exactly as a Runner would. */
async function readySandbox(stack: RaceStack, accountId: string, channel: string) {
  const sandbox = await ownedSandbox(accountId, channel);
  await stack.service.startForAccount(accountId, sandbox.sandboxId);
  const row = await rowFor(sandbox.sandboxId);
  const scope: RunnerScope = {
    sandboxId: row.id,
    sessionId: row.sessionId,
    environmentGeneration: row.environmentGeneration,
    resourceName: row.currentResourceName as string,
  };
  const socket: RunnerControlSocket = {
    async send(frame) {
      if (frame.type !== "workspace:seal") return;
      stack.store.plant(
        {
          storageUri: row.storageUri,
          sandboxId: row.id,
          sessionId: row.sessionId,
          environmentGeneration: row.environmentGeneration,
        },
        { saved: true, sealed: true, ownerGeneration: row.environmentGeneration },
      );
      stack.hub.settleWorkspaceSeal(
        row.id,
        { type: "workspace:seal:result", requestId: frame.requestId, ok: true },
        socket,
      );
    },
    close() {},
  };
  stack.hub.attach(scope, socket, { reuseCapable: true });
  stack.hub.markReady(
    scope,
    {
      sandboxName: scope.resourceName.split("/").at(-1) as string,
      rootfs: "/opt/sandbox-root",
      nodeVersion: "v24.19.0",
      piVersion: "0.84.2",
      runnerVersion: RUNNER_VERSION,
      reportedAt: new Date().toISOString(),
    },
    socket,
  );
  await stack.service.promoteDeferredReadiness(row.id);
  const ready = await rowFor(row.id);
  expect(ready.lifecycle).toBe("ready");
  return { sandbox, row: ready, scope };
}

describe("E9 capacity admission races on PostgreSQL", () => {
  it("lets exactly three of five independent concurrent reservations win the Account slots", async () => {
    const accountId = await account();
    const stack = makeStack({ accountLimit: 3, platformLimit: 20 });
    const starters = await Promise.all([
      ownedSandbox(accountId, "slot-1"),
      ownedSandbox(accountId, "slot-2"),
      ownedSandbox(accountId, "slot-3"),
      ownedSandbox(accountId, "slot-4"),
      ownedSandbox(accountId, "slot-5"),
    ]);

    // Five independent reservation transactions race for three slots; the advisory admission
    // lock serializes the count+reserve so the last slot can never be over-admitted.
    const results = await Promise.allSettled(
      starters.map((sandbox) => stack.service.startForAccount(accountId, sandbox.sandboxId)),
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(3);
    expect(losers).toHaveLength(2);
    for (const loser of losers) {
      expectCapacity(loser.status === "rejected" ? loser.reason : undefined, "account");
    }
    // Only admitted reservations ever reached the cloud, and every winner committed its own generation.
    expect(stack.fake.createCalls).toHaveLength(3);
    expect(stack.fake.liveInstanceCount()).toBe(3);
    expect(await countCloudCapacityOccupancy(database, accountId)).toEqual({ accountUsed: 3, platformUsed: 3 });
    for (const [index, result] of results.entries()) {
      const row = await rowFor(starters[index]?.sandboxId as string);
      if (result.status === "fulfilled") {
        expect(row).toMatchObject({ lifecycle: "preparing", environmentGeneration: 1 });
        expect(row.currentResourceName).not.toBeNull();
      } else {
        expect(row).toMatchObject({ lifecycle: "unallocated", environmentGeneration: 0, currentResourceName: null });
      }
    }
  });

  it("lets exactly two of four cross-Account reservations win the last platform slots", async () => {
    const leftAccount = await account();
    const rightAccount = await account();
    const stack = makeStack({ accountLimit: 5, platformLimit: 2 });
    const starters = [
      { accountId: leftAccount, sandbox: await ownedSandbox(leftAccount, "platform-l1") },
      { accountId: leftAccount, sandbox: await ownedSandbox(leftAccount, "platform-l2") },
      { accountId: rightAccount, sandbox: await ownedSandbox(rightAccount, "platform-r1") },
      { accountId: rightAccount, sandbox: await ownedSandbox(rightAccount, "platform-r2") },
    ];

    const results = await Promise.allSettled(
      starters.map(({ accountId, sandbox }) => stack.service.startForAccount(accountId, sandbox.sandboxId)),
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(2);
    expect(losers).toHaveLength(2);
    // Neither Account is near its own ceiling: the platform scope is the actionable rejection.
    for (const loser of losers) {
      expectCapacity(loser.status === "rejected" ? loser.reason : undefined, "platform");
    }
    expect(stack.fake.createCalls).toHaveLength(2);
    expect(stack.fake.liveInstanceCount()).toBe(2);
    expect((await countCloudCapacityOccupancy(database, leftAccount)).platformUsed).toBe(2);
  });

  it("counts a delete-unconfirmed release and frees the slot only after verified removal", async () => {
    const accountId = await account();
    const stack = makeStack({ accountLimit: 1, platformLimit: 20 });
    const first = await ownedSandbox(accountId, "delete-slot-a");
    const second = await ownedSandbox(accountId, "delete-slot-b");
    await stack.service.startForAccount(accountId, first.sandboxId);

    // The delete fails: the row keeps its binding in releasing and keeps occupying the slot.
    stack.fake.deleteFailures = 1;
    await expect(stack.service.stopForAccount(accountId, first.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(await rowFor(first.sandboxId)).toMatchObject({
      lifecycle: "releasing",
      lastErrorCode: "cloud_delete_incomplete",
    });
    expect(await countCloudCapacityOccupancy(database, accountId)).toEqual({ accountUsed: 1, platformUsed: 1 });
    await expect(stack.service.startForAccount(accountId, second.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
    });
    expect(stack.fake.createCalls).toHaveLength(1);

    // Release is never blocked by the ceiling: the retried stop verifies the 404 and frees the slot.
    await stack.service.stopForAccount(accountId, first.sandboxId);
    expect(await rowFor(first.sandboxId)).toMatchObject({ lifecycle: "unallocated", currentResourceName: null });
    expect(await countCloudCapacityOccupancy(database, accountId)).toEqual({ accountUsed: 0, platformUsed: 0 });
    await stack.service.startForAccount(accountId, second.sandboxId);
    expect(stack.fake.createCalls).toHaveLength(2);
    expect(stack.fake.liveInstanceCount()).toBe(1);
  });

  it("counts an unknown create outcome and never frees the slot on uncertainty", async () => {
    const accountId = await account();
    const stack = makeStack({ accountLimit: 1, platformLimit: 20 });
    const first = await ownedSandbox(accountId, "unknown-slot-a");
    const second = await ownedSandbox(accountId, "unknown-slot-b");
    // The create request may or may not have landed: no resource is visible and no LRO exists.
    stack.fake.createUnknownWithoutResourceOnce = true;
    await stack.service.startForAccount(accountId, first.sandboxId);
    expect(await rowFor(first.sandboxId)).toMatchObject({
      lifecycle: "preparing",
      lastErrorCode: "cloud_create_uncertain",
    });

    // The unknown outcome still occupies: a concurrent reservation cannot take the slot early.
    await expect(stack.service.startForAccount(accountId, second.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
    });
    expect(stack.fake.createCalls).toHaveLength(1);
    expect(await countCloudCapacityOccupancy(database, accountId)).toEqual({ accountUsed: 1, platformUsed: 1 });
    // A repeated reconcile of the unknown row keeps the conservative reference and the slot.
    await stack.service.startForAccount(accountId, first.sandboxId);
    expect(await rowFor(first.sandboxId)).toMatchObject({
      lifecycle: "preparing",
      lastErrorCode: "cloud_create_uncertain",
    });
    await expect(stack.service.startForAccount(accountId, second.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
    });
  });

  it("counts a save-failed release until the archive is proven and removal verified", async () => {
    const accountId = await account();
    const stack = makeStack({ accountLimit: 1, platformLimit: 20 });
    const a = await readySandbox(stack, accountId, "save-slot-a");
    const second = await ownedSandbox(accountId, "save-slot-b");

    // The Runner is gone, so the save owed by a used environment cannot be proven: the row keeps
    // its binding in releasing and keeps occupying the slot.
    stack.hub.closeScope(a.scope);
    await expect(stack.service.stopForAccount(accountId, a.sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(await rowFor(a.sandbox.sandboxId)).toMatchObject({
      lifecycle: "releasing",
      lastErrorCode: "workspace_save_failed",
    });
    await expect(stack.service.startForAccount(accountId, second.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
    });
    expect(stack.fake.deleteCalls).toHaveLength(0);

    // A reconnected Runner proves the sealed archive; the retried stop deletes and frees the slot.
    const socket: RunnerControlSocket = {
      async send(frame) {
        if (frame.type !== "workspace:seal") return;
        stack.store.plant(
          {
            storageUri: a.row.storageUri,
            sandboxId: a.row.id,
            sessionId: a.row.sessionId,
            environmentGeneration: a.row.environmentGeneration,
          },
          { saved: true, sealed: true, ownerGeneration: a.row.environmentGeneration },
        );
        stack.hub.settleWorkspaceSeal(
          a.row.id,
          { type: "workspace:seal:result", requestId: frame.requestId, ok: true },
          socket,
        );
      },
      close() {},
    };
    stack.hub.attach(a.scope, socket, { reuseCapable: true });
    await stack.service.stopForAccount(accountId, a.sandbox.sandboxId);
    expect(await rowFor(a.sandbox.sandboxId)).toMatchObject({ lifecycle: "unallocated", currentResourceName: null });
    await stack.service.startForAccount(accountId, second.sandboxId);
    expect(stack.fake.liveInstanceCount()).toBe(1);
  });

  it("retains occupancy for a reference without an occupied lifecycle and a lifecycle without a reference", async () => {
    const accountId = await account();
    const referenced = await ownedSandbox(accountId, "predicate-ref");
    const preparing = await ownedSandbox(accountId, "predicate-preparing");
    // The ordinary freed case: unallocated with no reference, never counted.
    await ownedSandbox(accountId, "predicate-freed");
    // The schema has no constraint equating lifecycle and resource identity: force both skews.
    await database
      .update(sandboxes)
      .set({
        lifecycle: "unallocated",
        currentResourceName: `projects/unit-project/locations/us-west1/instances/ots-retained-${randomUUID().slice(0, 8)}`,
        currentResourceUid: "uid-retained",
      })
      .where(eq(sandboxes.id, referenced.sandboxId));
    await database
      .update(sandboxes)
      .set({ lifecycle: "preparing", currentResourceName: null, currentResourceUid: null })
      .where(eq(sandboxes.id, preparing.sandboxId));

    // Either fact alone retains the slot through the shared `occupiedSandbox` predicate.
    expect(await countCloudCapacityOccupancy(database, accountId)).toEqual({ accountUsed: 2, platformUsed: 2 });

    // Admission counts through the same predicate: a new reservation at the ceiling is rejected.
    const stack = makeStack({ accountLimit: 2, platformLimit: 20 });
    const cold = await ownedSandbox(accountId, "predicate-cold");
    await expect(stack.service.startForAccount(accountId, cold.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
    });
    expect(stack.fake.createCalls).toHaveLength(0);
  });

  it("never charges the same generation twice: a definitively rejected retry converges at the ceiling", async () => {
    const accountId = await account();
    const stack = makeStack({ accountLimit: 1, platformLimit: 20 });
    const first = await ownedSandbox(accountId, "retry-slot-a");
    const second = await ownedSandbox(accountId, "retry-slot-b");
    // The first submission is definitively rejected: the generation was charged at reservation.
    stack.fake.failNextCreateWith = new CloudRunAdminError("invalid", "create rejected", {
      status: 400,
      createRejected: true,
    });
    await expect(stack.service.startForAccount(accountId, first.sandboxId)).rejects.toMatchObject({ statusCode: 503 });
    expect(await rowFor(first.sandboxId)).toMatchObject({
      lifecycle: "preparing",
      environmentGeneration: 1,
      lastErrorCode: "cloud_create_rejected",
    });

    // The charged (though physically empty) row still occupies; only its own retry may proceed.
    await expect(stack.service.startForAccount(accountId, second.sandboxId)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_EXCEEDED",
      scope: "account",
    });
    const retried = await stack.service.startForAccount(accountId, first.sandboxId);
    expect(retried).toMatchObject({ lifecycle: "preparing", environmentGeneration: 1 });
    expect(stack.fake.createCalls).toHaveLength(2);
    expect(stack.fake.liveInstanceCount()).toBe(1);
    expect(await countCloudCapacityOccupancy(database, accountId)).toEqual({ accountUsed: 1, platformUsed: 1 });
  });

  it("transfers the idle same-account Instance at the ceiling while the concurrent cold start is rejected", async () => {
    const accountId = await account();
    const stack = makeStack({ accountLimit: 1, platformLimit: 20 });
    const a = await readySandbox(stack, accountId, "reuse-slot-a");
    const borrower = await ownedSandbox(accountId, "reuse-borrower");
    const cold = await ownedSandbox(accountId, "reuse-cold");
    const createsBefore = stack.fake.createCalls.length;

    // Two independent reservations race at a full Account ceiling: the borrow moves A's physical
    // Instance (never a new reservation, never charged), the cold start must be rejected.
    const results = await Promise.allSettled([
      stack.service.startForAccount(accountId, borrower.sandboxId),
      stack.service.startForAccount(accountId, cold.sandboxId),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectCapacity(rejected[0]?.status === "rejected" ? rejected[0].reason : undefined, "account");

    const borrowerRow = await rowFor(borrower.sandboxId);
    const coldRow = await rowFor(cold.sandboxId);
    const [reuseRow, rejectedRow] =
      borrowerRow.currentResourceName === a.row.currentResourceName ? [borrowerRow, coldRow] : [coldRow, borrowerRow];
    expect(reuseRow).toMatchObject({
      lifecycle: "preparing",
      currentResourceName: a.row.currentResourceName,
      currentResourceUid: a.row.currentResourceUid,
    });
    expect(rejectedRow).toMatchObject({
      lifecycle: "unallocated",
      environmentGeneration: 0,
      currentResourceName: null,
    });
    // Exactly one physical Instance exists the whole time; no create was submitted for either starter.
    expect(stack.fake.createCalls).toHaveLength(createsBefore);
    expect(stack.fake.liveInstanceCount()).toBe(1);
    expect(await rowFor(a.sandbox.sandboxId)).toMatchObject({ lifecycle: "unallocated", currentResourceName: null });
    expect(await countCloudCapacityOccupancy(database, accountId)).toEqual({ accountUsed: 1, platformUsed: 1 });
  });
});
