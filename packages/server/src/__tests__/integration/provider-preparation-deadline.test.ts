import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createDatabaseClient } from "../../db/client.js";
import { imBindings } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ProviderCliReconcileOwner } from "../../runtime/provider-cli-reconcile-owner.js";
import { deferred } from "../support/deferred.js";
import { createSkillHarness } from "../support/skill-service-harness.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let observer: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
  client = createDatabaseClient(pg.databaseUrl, { max: 1, statementTimeoutMs: 2000 });
  observer = createDatabaseClient(pg.databaseUrl, { max: 2 });
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => {
  await Promise.all([client?.sql.end(), observer?.sql.end()]);
  await pg?.stop();
});

it.each(["prewarm", "active"] as const)(
  "bounds %s source SQL wait without starting late dispatch, then recovers",
  async (path) => {
    const h = createSkillHarness(client),
      accountId = await h.createUser(),
      computerId = await h.createComputer(accountId),
      agentId = await h.createAgent(accountId, computerId);
    await client.database.insert(imBindings).values({ agentId, provider: "slack" });
    const locked = deferred(),
      unlock = deferred(),
      queryDone = deferred();
    let queryPending = false;
    const holding = observer.sql.begin(async (tx) => {
      await tx`lock table im_bindings in access exclusive mode`;
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    const registry = new ConnectionRegistry(),
      instanceId = randomUUID();
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn((_body: string, callback: (error?: Error) => void) => callback()),
      close: vi.fn(),
    } as unknown as WebSocket;
    await registry.register(
      {
        computerId,
        instanceId,
        installationId: randomUUID(),
        active: true,
        lastHeartbeatAt: Date.now(),
        socket,
        negotiatedCapabilities: {
          [RUNTIME_CAPABILITY.providerCliPrewarm]: 1,
          [RUNTIME_CAPABILITY.providerCliReconcile]: 1,
        },
      },
      async () => undefined,
    );
    const read = async () => {
      queryPending = true;
      try {
        return await client.database.select().from(imBindings).where(eq(imBindings.agentId, agentId));
      } finally {
        queryPending = false;
        queryDone.resolve();
      }
    };
    const owner = new ProviderCliReconcileOwner(
      registry,
      {
        shouldPrewarmOfficialProviderClis: async () => {
          if (path === "active") return false;
          await read();
          return true;
        },
        listActiveProviderCliRequirements: async () => {
          const rows = await read();
          return rows.map((row) => ({
            agentId,
            integrationId: row.id,
            provider: "slack" as const,
            credentialGeneration: 1,
            expectedIdentity: { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" },
          }));
        },
        issueIntegrationCliValidationGrant: vi.fn(),
      },
      { preparationTimeoutMs: 300 },
    );
    const input = { computerId, agentId, runtimeProvider: "codex" as const };
    const preparing = owner.prepareComputer(input).then(
      () => "started",
      (error) => String(error),
    );
    try {
      await expect
        .poll(
          async () =>
            (
              await observer.sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
            )[0]?.n,
        )
        .toBeGreaterThan(0);
      expect(await preparing).toContain("timed out");
      expect(queryPending).toBe(true);
      expect(socket.send).not.toHaveBeenCalled();
      expect((await observer.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
      unlock.resolve();
      await holding;
      await queryDone.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(socket.send).not.toHaveBeenCalled();
      await expect(owner.prepareComputer(input)).resolves.toBeUndefined();
      expect(socket.send).toHaveBeenCalledTimes(path === "prewarm" ? 2 : 1);
    } finally {
      unlock.resolve();
      await holding;
      owner.close();
      await preparing;
    }
  },
);
