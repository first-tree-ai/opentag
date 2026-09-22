import { randomUUID } from "node:crypto";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { computers, imBindings } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import type { FeishuAdapter } from "../../services/im-bindings/feishu/adapter.js";
import { FeishuConnectionManager } from "../../services/im-bindings/feishu/connection-manager.js";
import type { FeishuChannel } from "../../services/im-bindings/feishu/index.js";
import { encodeFeishuSetupCandidate } from "../../services/im-bindings/feishu/setup-context.js";
import { FeishuSetupService } from "../../services/im-bindings/feishu/setup-service.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * The durable Feishu connection lifecycle against migrated PostgreSQL. These suites exercise the
 * real `FeishuConnectionManager` (scope probe, fenced activation transaction, credential write)
 * with a fake provider adapter, and the real migrations including the pending_activation shape.
 */

let testDatabase: MigratedTestDatabase;
const clock = { now: new Date("2026-09-10T00:00:00.000Z") };
const CANDIDATE_SECRET = "integration-candidate-secret";
const openClients: Array<{ sql: { end: () => Promise<void> } }> = [];

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => {
  await testDatabase.reset();
  clock.now = new Date("2026-09-10T00:00:00.000Z");
});
afterEach(async () => {
  while (openClients.length > 0) await openClients.pop()?.sql.end();
});

interface FakeAdapterHarness {
  createAdapter: (input: {
    appId: string;
    appSecret: string;
    teamId: string | null;
    teamBrand?: "feishu" | "lark" | null;
    channel?: FeishuChannel | null;
  }) => FeishuAdapter;
  probeAdapters: string[];
  channelAdapters: string[];
  disconnectedAdapters: string[];
  grantedScopes: { value: string[] };
}

function fakeAdapterFactory(): FakeAdapterHarness {
  const probeAdapters: string[] = [];
  const channelAdapters: string[] = [];
  const disconnectedAdapters: string[] = [];
  const grantedScopes = { value: [...FEISHU_REQUIRED_TENANT_SCOPES] };
  return {
    probeAdapters,
    channelAdapters,
    disconnectedAdapters,
    grantedScopes,
    createAdapter: (input) => {
      const channel: FeishuChannel = {
        on: vi.fn(() => () => undefined),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => {
          disconnectedAdapters.push(input.appId);
        }),
        botIdentity: { openId: `ou_${input.appId}` },
      };
      const adapter = {
        channel,
        validateBinding: vi.fn(async () => ({
          externalAppId: input.appId,
          externalTeamId: `tenant_${input.appId}`,
          externalBotId: `ou_${input.appId}`,
        })),
        listGrantedWorkspaceScopes: vi.fn(async () => {
          if (input.channel === null) probeAdapters.push(input.appId);
          return [...grantedScopes.value];
        }),
        // Official bot-info mapping: 2 is the only enabled status; see the parent-owned production
        // mapping for the remaining published values.
        probeBotIdentity: vi.fn(async () => ({ openId: `ou_${input.appId}`, activateStatus: 2 })),
        normalizeInbound: vi.fn(() => []),
        resolveSenderName: vi.fn(async () => undefined),
      };
      if (input.channel !== null) channelAdapters.push(input.appId);
      return adapter as unknown as FeishuAdapter;
    },
  };
}

async function fixture() {
  const client = createDatabaseClient(testDatabase.databaseUrl, { max: 6 });
  openClients.push(client);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: `lifecycle-${randomUUID()}@example.com`,
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: randomUUID(),
      displayName: "lifecycle-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(client.database).createForAccount(bootstrap.userId, {
    name: `lifecycle-${randomUUID().slice(0, 8)}`,
    displayName: "Lifecycle Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher({
    legacyKey: new Uint8Array(32).fill(19),
    keys: { "lifecycle-2026-09": new Uint8Array(32).fill(29) },
    activeKeyId: "lifecycle-2026-09",
    writeVersion: 2,
  });
  const imBindings = new ImBindingService(client.database, cipher, { now: () => clock.now });
  return { client, bootstrap, agent, cipher, imBindings };
}

async function insertCandidate(
  database: DatabaseClient,
  cipher: ApplicationCipher,
  input: {
    agentId: string;
    appId?: string;
    appSecret?: string;
    nextCheckAt?: Date;
    expiresAt?: Date;
  },
) {
  const bindingId = randomUUID();
  const attemptId = randomUUID();
  const now = clock.now;
  const encryptedSetupContext = encodeFeishuSetupCandidate(
    cipher,
    {
      version: 1,
      kind: "feishu_candidate",
      bindingId,
      attemptId,
      appId: input.appId ?? "cli_integration",
      appSecret: input.appSecret ?? CANDIDATE_SECRET,
      teamBrand: "feishu",
      savedAt: now.toISOString(),
      nextCheckAt: (input.nextCheckAt ?? now).toISOString(),
      observation: null,
    },
    bindingId,
    attemptId,
  );
  await database.insert(imBindings).values({
    id: bindingId,
    agentId: input.agentId,
    provider: "feishu",
    status: "provisioning",
    setupAttemptId: attemptId,
    setupIntent: "create",
    setupState: "pending_activation",
    encryptedSetupContext,
    setupExpiresAt: input.expiresAt ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
    createdAt: now,
    updatedAt: now,
  });
  return { bindingId, attemptId };
}

function createManager(
  value: Awaited<ReturnType<typeof fixture>>,
  harness: FakeAdapterHarness,
  options: { instanceId?: string; runtimeReady?: boolean } = {},
) {
  return new FeishuConnectionManager({
    database: value.client.database,
    inbox: { ingest: vi.fn() } as never,
    instanceId: options.instanceId ?? randomUUID(),
    imBindings: value.imBindings,
    createAdapter: harness.createAdapter,
    runtimeReady: vi.fn(async () => options.runtimeReady ?? true),
    now: () => clock.now,
  });
}

function createSetupService(
  value: Awaited<ReturnType<typeof fixture>>,
  activation: FeishuConnectionManager,
  options: { timing?: { checkIntervalMs?: number; checkJitterMs?: number } } = {},
) {
  return new FeishuSetupService({
    database: value.client.database,
    cipher: value.cipher,
    instanceId: randomUUID(),
    imBindings: value.imBindings,
    registrations: { start: vi.fn() },
    activation,
    timing: { checkIntervalMs: 1_000, checkJitterMs: 0, ...options.timing },
    now: () => clock.now,
    random: () => 0,
  });
}

describe("Feishu durable connection lifecycle (PostgreSQL)", () => {
  it("does not install a channel when shutdown wins after commit but before handoff", async () => {
    const value = await fixture();
    const harness = fakeAdapterFactory();
    const manager = createManager(value, harness);
    const service = createSetupService(value, manager);
    const { attemptId, bindingId } = await insertCandidate(value.client.database, value.cipher, {
      agentId: value.agent.id,
    });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transact = value.client.database.transaction.bind(value.client.database);
    const transaction = vi.spyOn(value.client.database, "transaction").mockImplementationOnce(async (...args) => {
      const committed = await transact(...args);
      enter();
      await gate;
      return committed;
    });
    try {
      const checking = service.check(value.bootstrap.userId, attemptId);
      await entered;
      await manager.stop();
      release();
      await checking;
      expect(harness.disconnectedAdapters).toEqual(["cli_integration"]);
      const [row] = await value.client.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
      expect(row).toMatchObject({ setupState: "succeeded", connectionOwnerInstanceId: null });
    } finally {
      release();
      transaction.mockRestore();
      await service.stop();
      await manager.stop();
    }
  });

  it("closes a committed channel when shutdown overlaps the runtime notification", async () => {
    const value = await fixture();
    const harness = fakeAdapterFactory();
    const manager = createManager(value, harness);
    const service = createSetupService(value, manager);
    const { attemptId } = await insertCandidate(value.client.database, value.cipher, { agentId: value.agent.id });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notification = vi
      .spyOn(value.imBindings, "notifyProviderCliRequirementChanged")
      .mockImplementation(async () => {
        enter();
        await gate;
      });
    const activation = vi.spyOn(manager, "activateAtomicAttempt");
    try {
      const checking = service.check(value.bootstrap.userId, attemptId);
      await entered;
      await service.stop();
      await manager.stop();
      release();
      await checking;
      await activation.mock.results[0]?.value;
      expect(harness.disconnectedAdapters).toEqual(["cli_integration"]);
    } finally {
      release();
      notification.mockRestore();
      activation.mockRestore();
      await service.stop();
      await manager.stop();
    }
  });

  it("reports real activation when cancellation's pre-lock observation becomes stale", async () => {
    const value = await fixture();
    const harness = fakeAdapterFactory();
    const manager = createManager(value, harness);
    const service = createSetupService(value, manager);
    const { attemptId, bindingId } = await insertCandidate(value.client.database, value.cipher, {
      agentId: value.agent.id,
    });
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorize = value.imBindings.assertCanManage.bind(value.imBindings);
    const authorization = vi.spyOn(value.imBindings, "assertCanManage").mockImplementationOnce(async (...args) => {
      await authorize(...args);
      markEntered();
      await gate;
    });
    try {
      const cancellation = service.cancel(value.bootstrap.userId, attemptId);
      await entered;
      expect((await service.check(value.bootstrap.userId, attemptId)).state).toBe("succeeded");
      release();
      expect((await cancellation).state).toBe("succeeded");
      const [row] = await value.client.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
      expect(row).toMatchObject({ status: "active", setupState: "succeeded", credentialGeneration: 1 });
      expect(harness.channelAdapters).toHaveLength(1);
    } finally {
      release();
      authorization.mockRestore();
      await service.stop();
      await manager.stop();
    }
  });

  it("probes scopes without a channel, waits, then activates through the fenced transaction", async () => {
    const value = await fixture();
    const harness = fakeAdapterFactory();
    const grantedWhileWaiting = [...FEISHU_REQUIRED_TENANT_SCOPES].slice(0, 60);
    const missingWhileWaiting = [...FEISHU_REQUIRED_TENANT_SCOPES].slice(60);
    harness.grantedScopes.value = [...grantedWhileWaiting];
    const manager = createManager(value, harness);
    const service = createSetupService(value, manager);
    const { attemptId, bindingId } = await insertCandidate(value.client.database, value.cipher, {
      agentId: value.agent.id,
      appSecret: CANDIDATE_SECRET,
    });

    const waiting = await service.check(value.bootstrap.userId, attemptId);
    expect(waiting.state).toBe("pending_activation");
    expect(waiting.activation?.reason).toBe("permissions_pending");
    expect(waiting.activation?.missingScopes).toEqual(missingWhileWaiting);
    // The waiting probe never opened a channel adapter and never activated a credential.
    expect(harness.probeAdapters).toEqual(["cli_integration"]);
    expect(harness.channelAdapters).toEqual([]);
    const waitingRow = await value.imBindings.getFeishuConnectionMaterial(bindingId);
    expect(waitingRow).toBeUndefined();

    // The full grant becomes visible, and the same candidate activates.
    harness.grantedScopes.value = [...FEISHU_REQUIRED_TENANT_SCOPES];
    clock.now = new Date(clock.now.getTime() + 120_000);
    const activated = await service.check(value.bootstrap.userId, attemptId);
    expect(activated.state).toBe("succeeded");
    expect(harness.channelAdapters).toEqual(["cli_integration"]);
    const [row] = await value.client.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
    expect(row).toMatchObject({
      status: "active",
      setupState: "succeeded",
      encryptedSetupContext: null,
      setupExpiresAt: null,
      externalAppId: "cli_integration",
      credentialGeneration: 1,
    });
    const material = await value.imBindings.getFeishuConnectionMaterial(bindingId);
    expect(material).toMatchObject({ appId: "cli_integration", appSecret: CANDIDATE_SECRET });
    await service.stop();
    await manager.stop();
  });

  it.each(["overlapping", "already-completed"] as const)(
    "activates the same candidate once across two instances (%s)",
    async (timing) => {
      const value = await fixture();
      const harness = fakeAdapterFactory();
      const managerA = createManager(value, harness);
      const managerB = createManager(value, harness);
      const serviceA = createSetupService(value, managerA);
      const serviceB = createSetupService(value, managerB);
      const { attemptId } = await insertCandidate(value.client.database, value.cipher, {
        agentId: value.agent.id,
      });

      const firstCheck = serviceA.check(value.bootstrap.userId, attemptId);
      if (timing === "already-completed") await firstCheck;
      const [first, second] = await Promise.all([firstCheck, serviceB.check(value.bootstrap.userId, attemptId)]);
      const states = [first.state, second.state];
      // check() projects the latest row: both callers may observe the same completed activation.
      // Exactly-once admission is proved by the provider probe, live connection, and durable generation.
      expect(states).toContain("succeeded");
      for (const state of states) expect(["pending_activation", "validating", "succeeded"]).toContain(state);
      if (timing === "already-completed") expect(states).toEqual(["succeeded", "succeeded"]);
      // One candidate check and one activation prerequisite check; no duplicate check from the other instance.
      expect(harness.probeAdapters).toHaveLength(2);
      expect(harness.channelAdapters).toHaveLength(1);
      const [row] = await value.client.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.setupAttemptId, attemptId));
      expect(row).toMatchObject({ status: "active", setupState: "succeeded", credentialGeneration: 1 });
      await serviceA.stop();
      await serviceB.stop();
      await managerA.stop();
      await managerB.stop();
    },
  );

  it("enforces the migrated pending shape and clears it atomically on disable", async () => {
    const value = await fixture();
    const harness = fakeAdapterFactory();
    const manager = createManager(value, harness);
    const service = createSetupService(value, manager);
    const { attemptId, bindingId } = await insertCandidate(value.client.database, value.cipher, {
      agentId: value.agent.id,
    });

    // The enum value exists and the constraint rejects an ownerless candidate without a secret.
    const enumRows = await value.client.database.execute(
      sql`select unnest(enum_range(null::feishu_setup_state))::text as state`,
    );
    expect(enumRows.map((row) => (row as { state: string }).state)).toContain("pending_activation");
    await expect(
      value.client.database.update(imBindings).set({ encryptedSetupContext: null }).where(eq(imBindings.id, bindingId)),
    ).rejects.toThrow();

    await value.imBindings.disable(value.bootstrap.userId, bindingId);
    const [row] = await value.client.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
    // The parent-owned disable cancels an open authorization atomically (secret, owner, deadline
    // and lease cleared) while preserving the terminal attempt identity.
    expect(row).toMatchObject({
      status: "disabled",
      setupState: "canceled",
      setupAttemptId: attemptId,
      encryptedSetupContext: null,
      setupOwnerInstanceId: null,
      setupExpiresAt: null,
      encryptedCredential: null,
    });
    await expect(service.get(value.bootstrap.userId, attemptId)).resolves.toMatchObject({
      id: attemptId,
      state: "canceled",
      qrUrl: null,
    });
    await service.stop();
    await manager.stop();
  });
});
