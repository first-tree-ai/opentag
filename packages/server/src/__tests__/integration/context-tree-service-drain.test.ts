import { request } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { ContextTreeOperationService } from "../../services/agents/context-tree-operation-service.js";
import { AgentService } from "../../services/agents/index.js";
import { deferred } from "../support/deferred.js";
import { createSkillHarness } from "../support/skill-service-harness.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
afterAll(async () => pg?.stop());

it("joins remote preparation and final selection SQL after the HTTP client disconnects", async () => {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 }),
    observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const harness = createSkillHarness(client),
    accountId = await harness.createUser(),
    computerId = await harness.createComputer(accountId);
  const agents = new AgentService(client.database);
  const created = await agents.createForAccount(accountId, {
    name: "tree-drain",
    displayName: "Tree drain",
    runtimeProvider: "codex",
    computerId,
  });
  const agentId = created.id,
    config = await agents.getConfigById(accountId, agentId);
  const entered = deferred(),
    resume = deferred();
  const target = { kind: "git" as const, repository: "acme/memory", path: ".", ref: "main" };
  const service = new ContextTreeOperationService(
    agents,
    { currentInstanceId: () => "instance", supportsCapability: () => true },
    {
      availability: async () => ({ status: "ready", readOnly: false }),
      computerKind: async () => "local",
      run: async () => {
        await client.sql`select 1`;
        entered.resolve();
        await resume.promise;
        return { result: { status: "completed", repository: target.repository, ref: target.ref } };
      },
    },
  );
  let poolReleased = false,
    drained = false,
    ownerStopped = false;
  const app = createApp({
    beginShutdown: () => {
      ownerStopped = true;
    },
    closeResources: async () => {
      await client.sql.end({ timeout: 1 });
      poolReleased = true;
    },
  });
  app.post("/tree", async () =>
    service.run(accountId, agentId, {
      ...target,
      action: "connect",
      expectedRevision: config.revision,
      expectedRuntimeConfigRevision: config.runtimeConfig.revision,
    }),
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const peer = request(`${address}/tree`, { method: "POST", headers: { "content-type": "application/json" } });
  peer.on("error", () => undefined);
  peer.end("{}");
  try {
    await entered.promise;
    const disconnected = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    peer.destroy();
    await disconnected;
    const closing = app.close().then(() => {
      drained = true;
    });
    await expect.poll(() => ownerStopped).toBe(true);
    expect(drained).toBe(false);
    expect(poolReleased).toBe(false);
    resume.resolve();
    await closing;
    expect(poolReleased).toBe(true);
    const saved = await new AgentService(observer.database).getConfigById(accountId, agentId);
    expect(saved.runtimeConfig.contextTrees).toEqual([target]);
  } finally {
    resume.resolve();
    peer.destroy();
    await app.close();
    await client.sql.end({ timeout: 1 });
    await observer.sql.end({ timeout: 1 });
  }
});
