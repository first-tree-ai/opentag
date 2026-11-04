import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient, type DatabaseTransaction } from "../../db/client.js";
import {
  agentSkills,
  agents,
  computers,
  imBindings,
  sandboxes,
  sessionCliProofs,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { DatabaseAgentOwnerResolver } from "../../services/agents/agent-self-service.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { ComputerService } from "../../services/computers/computer-service.js";
import { cloudInstanceIdFor } from "../../services/sandboxes/cloud-runtime-fence.js";
import { ScheduleService } from "../../services/schedules/service.js";
import { SessionCliProofService } from "../../services/sessions/session-cli-proof-service.js";
import { SkillService } from "../../services/skills/skill-service.js";
import { deferred } from "../support/deferred.js";
import { FakeSkillObjectStore } from "../support/fake-skill-object-store.js";
import { moveLegacyAgentFixture, transferLegacyAgentFixture } from "../support/legacy-agent-fixture.js";
import { createSkillHarness } from "../support/skill-service-harness.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 180_000);
beforeEach(async () => pg.reset());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.sql.end({ timeout: 1 })));
});
afterAll(async () => pg?.stop());
function client(max = 2) {
  const c = createDatabaseClient(pg.databaseUrl, { max });
  clients.push(c);
  return c;
}

async function fixture() {
  const c = client();
  const h = createSkillHarness(c);
  const accountId = await h.createUser();
  const targetAccountId = await h.createUser();
  const computerId = await h.createComputer(accountId);
  const agentService = new AgentService(c.database);
  const agent = await agentService.createForAccount(accountId, {
    name: "source",
    displayName: "Source",
    runtimeProvider: "codex",
    computerId,
  });
  const { source, token } = await h.runtimeProof(agent.id);
  const store = new FakeSkillObjectStore();
  const skills = h.serviceWith(store);
  const skill = await h.upload(skills, accountId, agent.id, "test-skill");
  const scheduleService = new ScheduleService({
    database: c.database,
    owners: new DatabaseAgentOwnerResolver(c.database),
    proofs: h.proofs,
    publicUrl: "https://authority.example.test",
  });
  const scope = await scheduleService.authenticate(token);
  const schedule = await scheduleService.createForAgent(scope, {
    name: "Task",
    prompt: "run",
    timezone: "UTC",
    schedule: { kind: "every", intervalSeconds: 600 },
  });
  return {
    c,
    h,
    accountId,
    targetAccountId,
    computerId,
    agentService,
    agent,
    source,
    token,
    store,
    skills,
    skill,
    scheduleService,
    scope,
    schedule,
  };
}

function pauseAgentUpdate(database: DatabaseClient, pause: () => Promise<void>): DatabaseClient {
  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then")
          return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(target)
              .then(async (rows) => {
                await pause();
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
  return new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "transaction")
        return (run: (tx: DatabaseTransaction) => Promise<unknown>) =>
          target.transaction((tx) =>
            run(
              new Proxy(tx, {
                get(t, k) {
                  const v = Reflect.get(t, k);
                  if (k === "update")
                    return (table: Parameters<DatabaseTransaction["update"]>[0]) =>
                      table === agents ? wrap(t.update(table)) : t.update(table);
                  return typeof v === "function" ? v.bind(t) : v;
                },
              }),
            ),
          );
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it.each(["enable", "remove", "schedule"] as const)(
  "serializes final %s authority with an historical Account ownership change",
  async (operation) => {
    const f = await fixture();
    await f.agentService.suspendById(f.accountId, f.agent.id);
    const entered = deferred();
    const release = deferred();
    const writer = client();
    const reader = client(1);
    const [backend] = await reader.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    assert(backend);
    const transferring = transferLegacyAgentFixture(
      pauseAgentUpdate(writer.database, async () => {
        entered.resolve();
        await release.promise;
      }),
      { agentId: f.agent.id, targetAccountId: f.targetAccountId, slack: "disable" },
    );
    let pending: Promise<unknown> | undefined;
    try {
      await entered.promise;
      const skills = new SkillService({
        database: reader.database,
        keyPrefix: "skills",
        store: f.store,
        proofs: f.h.proofs,
      });
      const schedules = new ScheduleService({
        database: reader.database,
        proofs: f.h.proofs,
        owners: new DatabaseAgentOwnerResolver(reader.database),
        publicUrl: "https://authority.example.test",
      });
      const task =
        operation === "enable"
          ? skills.setEnabled(f.accountId, f.agent.id, f.skill.id, false)
          : operation === "remove"
            ? skills.remove(f.accountId, f.agent.id, f.skill.id)
            : schedules.deleteForAccount(f.accountId, f.agent.id, f.schedule.id, f.schedule.revision + 1);
      pending = task.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.waitFor(async () => {
        const [state] = await f.c.sql<
          { waiting: boolean }[]
        >`select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${backend.pid}`;
        expect(state?.waiting).toBe(true);
      });
    } finally {
      release.resolve();
    }
    await transferring;
    assert(pending);
    expect(await pending).toMatchObject({
      error: { code: operation === "schedule" ? "RESOURCE_NOT_FOUND" : "SKILL_NOT_FOUND" },
    });
    expect(await f.skills.get(f.targetAccountId, f.agent.id, f.skill.id)).toMatchObject({
      enabled: true,
      revision: f.skill.revision,
    });
    expect(await f.scheduleService.getForAccount(f.targetAccountId, f.agent.id, f.schedule.id)).toMatchObject({
      enabled: false,
    });
  },
);

it("refuses a Skill replace prepared before transfer and removes only its unreferenced object", async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const put = f.store.put.bind(f.store);
  const initialKeys = f.store.keys();
  vi.spyOn(f.store, "put").mockImplementation(async (...args) => {
    await put(...args);
    entered.resolve();
    await release.promise;
  });
  const replacing = f.h
    .upload(f.skills, f.accountId, f.agent.id, "test-skill", { replace: true, files: { "new.md": "late" } })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    await entered.promise;
    await f.agentService.suspendById(f.accountId, f.agent.id);
    await transferLegacyAgentFixture(f.c.database, {
      agentId: f.agent.id,
      targetAccountId: f.targetAccountId,
      slack: "disable",
    });
  } finally {
    release.resolve();
  }
  expect(await replacing).toMatchObject({ error: { code: "SKILL_NOT_FOUND" } });
  expect(await f.skills.get(f.targetAccountId, f.agent.id, f.skill.id)).toMatchObject({
    revision: f.skill.revision,
    archiveSha256: f.skill.archiveSha256,
  });
  expect(f.store.keys()).toEqual(initialKeys);
});

it.each(["revoke", "replace-proof", "placement", "session-end", "connection", "rebind"] as const)(
  "rejects stale Runtime Skill/Schedule source after %s",
  async (change) => {
    const f = await fixture();
    if (change === "revoke" || change === "replace-proof") {
      await f.h.proofs.revoke({
        sessionId: f.source.sessionId,
        computerId: f.source.computerId,
        placementGeneration: f.source.placementGeneration,
        connectionInstanceId: f.source.connectionInstanceId,
      });
      if (change === "replace-proof") await f.h.proofs.mint(f.source);
    } else if (change === "placement") {
      await f.c.database
        .update(sessionPlacements)
        .set({ generation: f.source.placementGeneration + 1 })
        .where(eq(sessionPlacements.sessionId, f.source.sessionId));
    } else if (change === "session-end") {
      await f.c.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, f.source.sessionId));
    } else if (change === "connection") {
      await f.c.database
        .update(computers)
        .set({ currentInstanceId: randomUUID() })
        .where(eq(computers.id, f.source.computerId));
    } else {
      await moveLegacyAgentFixture(f.c.database, f.agent.id, await f.h.createComputer(f.accountId));
    }
    const bytes = await f.h.archive("new-skill");
    const beforePuts = f.store.puts;
    await expect(f.skills.listForAgent(f.source)).rejects.toBeDefined();
    await expect(
      f.skills.uploadForAgent(f.source, { bytes, format: "tar.gz", declaredSha256: f.h.sha256(bytes), replace: false }),
    ).rejects.toBeDefined();
    await expect(f.scheduleService.pauseForAgent(f.scope, f.schedule.id, f.schedule.revision)).rejects.toBeDefined();
    expect(f.store.puts).toBe(beforePuts);
    expect(await f.scheduleService.getForAccount(f.accountId, f.agent.id, f.schedule.id)).toMatchObject({
      enabled: true,
      revision: f.schedule.revision,
    });
    expect((await f.skills.list(f.accountId, f.agent.id)).skills).toHaveLength(1);
  },
);

it("revalidates the proof after object preparation without keeping a transaction across object I/O", async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const put = f.store.put.bind(f.store);
  vi.spyOn(f.store, "put").mockImplementation(async (...args) => {
    await put(...args);
    entered.resolve();
    await release.promise;
  });
  const bytes = await f.h.archive("prepared-skill");
  const uploading = f.skills
    .uploadForAgent(f.source, { bytes, format: "tar.gz", declaredSha256: f.h.sha256(bytes), replace: false })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    await entered.promise;
    const observer = client(1);
    await observer.database.transaction(async (tx) => {
      const rows = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, f.agent.id))
        .for("update", { noWait: true });
      expect(rows).toHaveLength(1);
    });
    await f.h.proofs.revoke({
      sessionId: f.source.sessionId,
      computerId: f.source.computerId,
      placementGeneration: f.source.placementGeneration,
      connectionInstanceId: f.source.connectionInstanceId,
    });
  } finally {
    release.resolve();
  }
  expect(await uploading).toMatchObject({ error: { code: "invalid_proof" } });
  expect(f.store.keys()).toHaveLength(1);
  expect(await f.c.database.select().from(agentSkills)).toHaveLength(1);
});

it.each(["enable", "remove", "replace"] as const)(
  "retains revision CAS and the referenced object against a legacy %s writer",
  async (operation) => {
    const f = await fixture();
    const legacy = client(1);
    const database = f.h.databasePausingFirstReturning(async () => {
      // A rolling older writer does not take the new Agent guard; this is a separate PostgreSQL connection.
      await legacy.database
        .update(agentSkills)
        .set({ revision: f.skill.revision + 1 })
        .where(eq(agentSkills.id, f.skill.id));
    });
    const service = new SkillService({ database, store: f.store, keyPrefix: "skills", proofs: f.h.proofs });
    const call =
      operation === "enable"
        ? service.setEnabled(f.accountId, f.agent.id, f.skill.id, false)
        : operation === "remove"
          ? service.remove(f.accountId, f.agent.id, f.skill.id)
          : f.h.upload(service, f.accountId, f.agent.id, "test-skill", {
              replace: true,
              files: { "new.md": "changed" },
            });
    await expect(call).rejects.toMatchObject({ code: "SKILL_REVISION_CONFLICT" });
    expect(await f.skills.get(f.accountId, f.agent.id, f.skill.id)).toMatchObject({
      enabled: true,
      revision: f.skill.revision + 1,
      archiveSha256: f.skill.archiveSha256,
    });
    expect(f.store.keys()).toHaveLength(1);
    expect(await f.skills.openBundle(f.accountId, f.agent.id, f.skill.id)).toMatchObject({
      sha256: f.skill.archiveSha256,
    });
  },
);

it("does not apply Agent self-config opt-out to Skill or Schedule authority", async () => {
  const f = await fixture();
  await f.agentService.updateById(f.accountId, f.agent.id, {
    expectedRevision: f.agent.revision,
    selfConfigurationEnabled: false,
  });
  expect((await f.skills.listForAgent(f.source)).skills).toHaveLength(1);
  expect(await f.scheduleService.pauseForAgent(f.scope, f.schedule.id, f.schedule.revision)).toMatchObject({
    enabled: false,
  });
});

it("holds the proof row through final admission while a real disconnect revokes it", async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const service = new SkillService({
    database: f.h.databasePausingFirstReturning(async () => {
      entered.resolve();
      await release.promise;
    }),
    proofs: f.h.proofs,
    store: f.store,
    keyPrefix: "skills",
  });
  const bytes = await f.h.archive("admitted");
  const uploading = service.uploadForAgent(f.source, {
    bytes,
    format: "tar.gz",
    declaredSha256: f.h.sha256(bytes),
    replace: false,
  });
  const revoker = client(1);
  const [backend] = await revoker.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  assert(backend);
  const proofs = new SessionCliProofService(
    revoker.database,
    { currentInstanceId: () => undefined, supportsCapability: () => false },
    randomBytes(32),
  );
  let revoking: Promise<void> | undefined;
  try {
    await entered.promise;
    revoking = proofs.revokeForConnection(f.source.connectionInstanceId);
    await vi.waitFor(async () => {
      const [state] = await f.c.sql<
        { waiting: boolean }[]
      >`select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${backend.pid}`;
      expect(state?.waiting).toBe(true);
    });
  } finally {
    release.resolve();
  }
  await expect(uploading).resolves.toMatchObject({ name: "admitted" });
  await revoking;
  await expect(f.skills.listForAgent(f.source)).rejects.toMatchObject({ code: "invalid_proof" });
  expect((await f.skills.list(f.accountId, f.agent.id)).skills).toHaveLength(2);
});

it("rejects a closed Cloud execution without treating its logical Computer as liveness", async () => {
  const c = client();
  const h = createSkillHarness(c);
  const accountId = await h.createUser();
  const computer = await new ComputerService(
    c.database,
    {
      getActiveUserById: async () => {
        throw new Error("unused Account projection");
      },
    },
    { cloudIdentities: { enabled: true, runnerVersion: "0.0.5" } },
  ).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(c.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: "cloud-source",
    displayName: "Cloud source",
    runtimeProvider: "pi",
    computerId: computer.computerId,
  });
  const [binding] = await c.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: randomUUID(),
      externalBotId: "cloud-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "fixture",
      activatedAt: new Date(),
    })
    .returning();
  assert(binding);
  const [session] = await c.database
    .insert(sessions)
    .values({ imBindingId: binding.id, kind: "channel", channelId: "cloud-channel", conversationKind: "channel" })
    .returning();
  assert(session);
  await c.database
    .insert(sessionPlacements)
    .values({ sessionId: session.id, computerId: computer.computerId, generation: 1 });
  const resourceName = "projects/authority/locations/test/workerPools/source/instances/source";
  const [sandbox] = await c.database
    .insert(sandboxes)
    .values({
      sessionId: session.id,
      storageUri: "gs://authority/workspace",
      lifecycle: "ready",
      environmentGeneration: 1,
      currentResourceName: resourceName,
      currentResourceUid: "source-uid",
    })
    .returning();
  assert(sandbox);
  const connectionId = randomUUID();
  let liveProof: string | undefined;
  const connection = {
    computerId: computer.computerId,
    connectionId,
    sessionId: session.id,
    sandboxId: sandbox.id,
    executionEligible: true,
    sessionCollaborationEligible: true,
    instanceId: cloudInstanceIdFor({
      sandboxId: sandbox.id,
      sessionId: session.id,
      environmentGeneration: 1,
      resourceName,
    }),
  };
  const proofs = new SessionCliProofService(
    c.database,
    { currentInstanceId: () => undefined, supportsCapability: () => false },
    randomBytes(32),
    {
      cloud: {
        connection: (id) => (id === connectionId ? connection : undefined),
        isProofLive: (input) => input.proofId === liveProof,
        registerExecution: (input) => {
          liveProof = input.proofId;
        },
        dropExecution: () => {
          liveProof = undefined;
        },
      },
    },
  );
  const { token } = await proofs.mintCloud({
    sessionId: session.id,
    computerId: computer.computerId,
    placementGeneration: 1,
    connectionId,
    sandboxId: sandbox.id,
    executionId: randomUUID(),
  });
  const source = await proofs.authenticate(token);
  const store = new FakeSkillObjectStore();
  const skills = new SkillService({ database: c.database, store, keyPrefix: "skills", proofs });
  const bytes = await h.archive("cloud-skill");
  await skills.uploadForAgent(source, { bytes, format: "tar.gz", declaredSha256: h.sha256(bytes), replace: false });
  const schedules = new ScheduleService({
    database: c.database,
    proofs,
    owners: new DatabaseAgentOwnerResolver(c.database),
    publicUrl: "https://authority.example.test",
  });
  const scope = await schedules.authenticate(token);
  const schedule = await schedules.createForAgent(scope, {
    name: "Cloud task",
    prompt: "run",
    timezone: "UTC",
    schedule: { kind: "every", intervalSeconds: 600 },
  });
  liveProof = undefined;
  expect(await c.database.select().from(sessionCliProofs)).toHaveLength(1);
  await expect(skills.listForAgent(source)).rejects.toMatchObject({ code: "invalid_proof" });
  await expect(schedules.pauseForAgent(scope, schedule.id, schedule.revision)).rejects.toMatchObject({
    code: "invalid_proof",
  });
  expect(await schedules.getForAccount(accountId, agent.id, schedule.id)).toMatchObject({
    enabled: true,
    revision: schedule.revision,
  });
});

it("keeps an Account Skill list on its authorization snapshot during transfer and replacement", async () => {
  const f = await fixture();
  const reader = client(1);
  const entered = deferred();
  const release = deferred();
  let first = true;
  const afterRead = async (rows: unknown) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return rows;
  };
  const query = (builder: object): object =>
    new Proxy(builder, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then")
          return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(target).then(afterRead).then(resolve, reject);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              const result = Reflect.apply(value, target, args);
              return result && typeof result === "object" ? query(result) : result;
            }
          : value;
      },
    });
  const database = new Proxy(reader.database, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "transaction")
        return (run: (tx: DatabaseTransaction) => Promise<unknown>, options: unknown) =>
          Reflect.apply(value, target, [
            (transaction: DatabaseTransaction) =>
              run(
                new Proxy(transaction, {
                  get(t, k) {
                    const v = Reflect.get(t, k);
                    if (k === "select") return (...args: unknown[]) => query(Reflect.apply(v, t, args));
                    return typeof v === "function" ? v.bind(t) : v;
                  },
                }),
              ),
            options,
          ]);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new SkillService({ database, store: f.store, keyPrefix: "skills", proofs: f.h.proofs });
  const reading = service.list(f.accountId, f.agent.id);
  try {
    await entered.promise;
    await f.agentService.suspendById(f.accountId, f.agent.id);
    await transferLegacyAgentFixture(f.c.database, {
      agentId: f.agent.id,
      targetAccountId: f.targetAccountId,
      slack: "disable",
    });
    await f.h.upload(f.skills, f.targetAccountId, f.agent.id, "test-skill", {
      replace: true,
      files: { "new.md": "new owner" },
    });
  } finally {
    release.resolve();
  }
  expect((await reading).skills).toEqual([
    expect.objectContaining({ id: f.skill.id, revision: f.skill.revision, archiveSha256: f.skill.archiveSha256 }),
  ]);
  await expect(f.skills.list(f.accountId, f.agent.id)).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  expect((await f.skills.list(f.targetAccountId, f.agent.id)).skills).toEqual([
    expect.objectContaining({ id: f.skill.id, revision: f.skill.revision + 1 }),
  ]);
});
