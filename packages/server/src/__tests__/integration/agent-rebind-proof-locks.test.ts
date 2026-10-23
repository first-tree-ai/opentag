import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  computers,
  imBindings,
  sessionCliProofs,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { SessionCliProofService } from "../../services/sessions/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

function pauseAfterLock(
  database: DatabaseClient,
  table: "computers" | "session_placements",
  pause: () => Promise<void>,
) {
  let armed = true;
  const wrapQuery = (query: object): object =>
    new Proxy(query, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then" && typeof value === "function") {
          return (fulfilled: (rows: unknown) => unknown, rejected: (error: unknown) => unknown) => {
            const toSQL = Reflect.get(target, "toSQL");
            const statement =
              typeof toSQL === "function" ? (Reflect.apply(toSQL, target, []) as { sql: string }) : undefined;
            return Promise.resolve(Reflect.apply(value, target, []))
              .then(async (rows) => {
                if (armed && statement?.sql.includes(`from "${table}"`) && statement.sql.includes(" for ")) {
                  armed = false;
                  await pause();
                }
                return rows;
              })
              .then(fulfilled, rejected);
          };
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          return result && typeof result === "object" ? wrapQuery(result) : result;
        };
      },
    });
  const wrapExecutor = (executor: object): object =>
    new Proxy(executor, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "select") return (...args: unknown[]) => wrapQuery(Reflect.apply(value, target, args));
        if (key === "transaction")
          return (run: (transaction: unknown) => Promise<unknown>) =>
            Reflect.apply(value, target, [(transaction: object) => run(wrapExecutor(transaction))]);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrapExecutor(database) as DatabaseClient;
}

async function createComputer(database: DatabaseClient, accountId: string) {
  const computerId = randomUUID(),
    instanceId = randomUUID();
  await database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    currentInstanceId: instanceId,
    currentInstallationId: randomUUID(),
    displayName: "Proof fixture",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.1.2",
  });
  return { computerId, instanceId };
}

async function fixture() {
  const observer = createDatabaseClient(testDatabase.databaseUrl);
  const rebinder = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const minter = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const accountId = randomUUID();
  await observer.database
    .insert(users)
    .values({ id: accountId, email: `${accountId}@example.test`, displayName: "Proof owner" });
  const { computerId, instanceId } = await createComputer(observer.database, accountId);
  const connections = new Map<string, string>([[computerId, instanceId]]);
  const agents = new AgentService(observer.database);
  const agent = await agents.createForAccount(accountId, {
    name: "proof-rebind",
    displayName: "Proof",
    runtimeProvider: "codex",
    computerId,
  });
  const [binding] = await observer.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: randomUUID(),
      externalBotId: "fixture-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "fixture",
      activatedAt: new Date(),
    })
    .returning();
  if (!binding) throw new Error("Missing IM binding fixture");
  const [session] = await observer.database
    .insert(sessions)
    .values({ imBindingId: binding.id, channelId: "fixture-channel", conversationKind: "channel", kind: "channel" })
    .returning();
  if (!session) throw new Error("Missing Session fixture");
  await observer.database.insert(sessionPlacements).values({ sessionId: session.id, computerId, generation: 1 });
  const registry = { currentInstanceId: (id: string) => connections.get(id), supportsCapability: () => true };
  const key = randomBytes(32);
  const proofs = (database = minter.database) => new SessionCliProofService(database, registry, key);
  return {
    observer,
    rebinder,
    minter,
    agents,
    accountId,
    computerId,
    agent,
    connections,
    proofs,
    input: { sessionId: session.id, computerId, placementGeneration: 1, connectionInstanceId: instanceId },
    close: () => Promise.all([observer.sql.end(), rebinder.sql.end(), minter.sql.end()]),
  };
}

function outcome(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return "committed";
  let error = result.reason;
  while (error?.cause) error = error.cause;
  return error?.code ?? String(error);
}

it.each(["first mint", "existing proof"] as const)(
  "commits same-Computer rebind racing with %s after both locks are held",
  async (mode) => {
    const f = await fixture();
    const computerHeld = vi.fn(),
      placementHeld = vi.fn();
    const resumeComputer = deferred(),
      resumePlacement = deferred();
    const running: Promise<unknown>[] = [];
    try {
      const existing = mode === "existing proof" ? await f.proofs().mint(f.input) : undefined;
      const agents = new AgentService(
        pauseAfterLock(f.rebinder.database, "computers", async () => {
          computerHeld();
          await resumeComputer.promise;
        }),
      );
      const proofs = f.proofs(
        pauseAfterLock(f.minter.database, "session_placements", async () => {
          placementHeld();
          await resumePlacement.promise;
        }),
      );
      const rebind = Promise.allSettled([agents.rebindById(f.accountId, f.agent.id, f.computerId)]);
      running.push(rebind);
      await vi.waitFor(() => expect(computerHeld).toHaveBeenCalledOnce());
      const mint = Promise.allSettled([proofs.mint(f.input)]);
      running.push(mint);
      await vi.waitFor(() => expect(placementHeld).toHaveBeenCalledOnce());
      resumePlacement.resolve();
      resumeComputer.resolve();
      const [rebound] = await rebind,
        [minted] = await mint;
      if (!rebound || !minted) throw new Error("Missing Service outcomes");
      expect([rebound, minted].map(outcome)).toEqual(["committed", "committed"]);
      if (rebound.status !== "fulfilled" || minted.status !== "fulfilled") throw new Error("Services did not commit");
      expect(rebound.value).toMatchObject({ id: f.agent.id, computerId: f.computerId, revision: f.agent.revision });
      expect(await f.observer.database.select().from(sessionPlacements)).toMatchObject([
        { computerId: f.computerId, generation: 1 },
      ]);
      expect(await f.observer.database.select().from(sessionCliProofs)).toHaveLength(1);
      if (existing) expect(minted.value).toEqual(existing);
      expect(await f.proofs().authenticate(minted.value.token)).toMatchObject({
        sessionId: f.input.sessionId,
        agentId: f.agent.id,
      });
    } finally {
      resumeComputer.resolve();
      resumePlacement.resolve();
      await Promise.allSettled(running);
      await f.close();
    }
  },
);

it("permits first mint's FK check while rebind holds Computer, but excludes a concurrent Computer mutation", async () => {
  const f = await fixture();
  const held = vi.fn(),
    resume = deferred();
  const agents = new AgentService(
    pauseAfterLock(f.rebinder.database, "computers", async () => {
      held();
      await resume.promise;
    }),
  );
  const rebind = Promise.allSettled([agents.rebindById(f.accountId, f.agent.id, f.computerId)]);
  try {
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce());
    await expect(
      f.observer.sql`select id from computers where id = ${f.computerId} for no key update nowait`,
    ).rejects.toMatchObject({ code: "55P03" });
    await f.minter.sql`set statement_timeout = '2s'`;
    const minted = await f.proofs().mint(f.input);
    expect(await f.proofs().authenticate(minted.token)).toMatchObject({ sessionId: f.input.sessionId });
  } finally {
    resume.resolve();
    expect((await rebind).map(outcome)).toEqual(["committed"]);
    await f.close();
  }
});

it.each(["mint first", "rebind first"] as const)("preserves the serial control: %s", async (order) => {
  const f = await fixture();
  try {
    if (order === "mint first") {
      await f.proofs().mint(f.input);
      await f.agents.rebindById(f.accountId, f.agent.id, f.computerId);
    } else {
      await f.agents.rebindById(f.accountId, f.agent.id, f.computerId);
      await f.proofs().mint(f.input);
    }
    expect(await f.observer.database.select().from(sessionCliProofs)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("retains real cross-Computer movement and rejects the old proof and placement input", async () => {
  const f = await fixture();
  try {
    const old = await f.proofs().mint(f.input);
    expect(await f.proofs().authenticate(old.token)).toMatchObject({ sessionId: f.input.sessionId });
    const { computerId, instanceId } = await createComputer(f.observer.database, f.accountId);
    f.connections.set(computerId, instanceId);
    expect(await f.agents.rebindById(f.accountId, f.agent.id, computerId)).toMatchObject({
      computerId,
      revision: f.agent.revision + 1,
    });
    expect(await f.observer.database.select().from(sessionPlacements)).toMatchObject([{ computerId, generation: 2 }]);
    await expect(f.proofs().authenticate(old.token)).rejects.toMatchObject({ code: "invalid_proof" });
    await expect(f.proofs().mint(f.input)).rejects.toMatchObject({ code: "runtime_unavailable" });
    const current = await f
      .proofs()
      .mint({ ...f.input, computerId, placementGeneration: 2, connectionInstanceId: instanceId });
    expect(current.proofId).not.toBe(old.proofId);
    expect(await f.proofs().authenticate(current.token)).toMatchObject({
      sessionId: f.input.sessionId,
      agentId: f.agent.id,
    });
  } finally {
    await f.close();
  }
});

it.each([
  { name: "rejects a destination without Context Tree support", selected: true, supported: false },
  { name: "moves selected trees to a capable destination", selected: true, supported: true },
  { name: "keeps no-tree moves independent of Context Tree support", selected: false, supported: false },
])("$name", async ({ selected, supported }) => {
  const f = await fixture();
  try {
    const target = await createComputer(f.observer.database, f.accountId);
    const trees = selected ? [{ kind: "git" as const, repository: "acme/memory", path: ".", ref: "main" }] : [];
    await f.observer.database
      .update(agentRuntimeConfigs)
      .set({ contextTrees: trees })
      .where(eq(agentRuntimeConfigs.agentId, f.agent.id));
    const supportsContextTrees = vi.fn(() => supported);
    const service = new AgentService(f.observer.database, { supportsContextTrees });
    const before = await service.getConfigById(f.accountId, f.agent.id);
    const placements = await f.observer.database.select().from(sessionPlacements);
    const move = service.rebindById(f.accountId, f.agent.id, target.computerId);
    if (selected && !supported) {
      await expect(move).rejects.toMatchObject({
        code: "AGENT_LIFECYCLE_CONFLICT",
        statusCode: 409,
        message:
          "Update OpenTag on the destination Computer and bring it online before moving an Agent with Context Trees.",
      });
      expect(await service.getConfigById(f.accountId, f.agent.id)).toEqual(before);
      expect(await f.observer.database.select().from(sessionPlacements)).toEqual(placements);
    } else {
      await expect(move).resolves.toMatchObject({
        computerId: target.computerId,
        runtimeConfig: { contextTrees: trees },
      });
      expect(await f.observer.database.select().from(sessionPlacements)).toMatchObject([
        { sessionId: f.input.sessionId, computerId: target.computerId, generation: 2 },
      ]);
    }
    if (selected) expect(supportsContextTrees).toHaveBeenCalledWith(target.computerId);
    else expect(supportsContextTrees).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
