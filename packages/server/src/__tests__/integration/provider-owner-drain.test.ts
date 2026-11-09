import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createDatabaseClient } from "../../db/client.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ProviderCliReconcileOwner } from "../../runtime/provider-cli-reconcile-owner.js";
import { ComputerService } from "../../services/computers/computer-service.js";
import { deferred } from "../support/deferred.js";
import { createSkillHarness } from "../support/skill-service-harness.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
  client = createDatabaseClient(pg.databaseUrl, { max: 1 });
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => {
  await client?.sql.end({ timeout: 1 });
  await pg?.stop();
});

it.each(["registration", "preparation"] as const)(
  "joins %s after real eligibility SQL and prevents later requirement reads",
  async (path) => {
    const harness = createSkillHarness(client);
    const accountId = await harness.createUser();
    const computerId = await harness.createComputer(accountId);
    const agentId = await harness.createAgent(accountId, computerId);
    const registry = new ConnectionRegistry();
    const instanceId = randomUUID(),
      installationId = randomUUID();
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
    await registry.register(
      {
        computerId,
        instanceId,
        installationId,
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
    const read = deferred(),
      resume = deferred();
    const computers = new ComputerService(client.database, {} as never);
    const source = {
      shouldPrewarmOfficialProviderClis: vi.fn(async (id: string) => {
        const eligible = await computers.hasActiveAgentWithoutMessagingSetup(id);
        read.resolve();
        await resume.promise;
        return eligible;
      }),
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, source);
    const operation =
      path === "registration"
        ? owner.onComputerRegistered({ computerId, installationId, instanceId })
        : owner.prepareComputer({ computerId, agentId, runtimeProvider: "codex" });
    const outcome = operation.then(
      () => "finished",
      (error: unknown) => String(error),
    );
    try {
      await read.promise;
      let drained = false;
      const closing = owner.close().then(() => {
        drained = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      resume.resolve();
      await closing;
      expect(drained).toBe(true);
      expect(await outcome).toMatch(path === "registration" ? "finished" : /closed/);
      expect(source.listActiveProviderCliRequirements).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
      await owner.onComputerRegistered({ computerId, installationId, instanceId });
      expect(source.shouldPrewarmOfficialProviderClis).toHaveBeenCalledTimes(1);
      expect((await client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
    } finally {
      resume.resolve();
      await outcome;
      await owner.close();
    }
  },
);
