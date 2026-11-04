import { randomUUID } from "node:crypto";
import type { registerApp } from "@larksuiteoapi/node-sdk";
import { count } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imBindings } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { FeishuSetupService } from "../../services/im-bindings/feishu/index.js";
import { DefaultFeishuRegistrationGateway } from "../../services/im-bindings/feishu/registration.js";
import { ImBindingService } from "../../services/im-bindings/im-binding-service.js";
import { deferred } from "../support/deferred.js";
import { pausedTableRead } from "../support/paused-binding-read.js";
import { createSkillHarness } from "../support/skill-service-harness.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => pg?.stop());

it.each(["qr", "slot", "registered"] as const)(
  "joins actual Feishu %s registration work and keeps restart fences",
  async (phase) => {
    const client = createDatabaseClient(pg.databaseUrl, { max: 2 });
    const harness = createSkillHarness(client),
      accountId = await harness.createUser(),
      computerId = await harness.createComputer(accountId);
    const agent = await new AgentService(client.database).createForAccount(accountId, {
      computerId,
      name: "setup-drain",
      displayName: "Setup drain",
      runtimeProvider: "codex",
    });
    const cipher = new ApplicationCipher(Buffer.alloc(32, 17));
    const entered = deferred(),
      resume = deferred();
    const paused = pausedTableRead(client.database, imBindings);
    const register = vi.fn(async (raw: unknown) => {
      const options = raw as { onQRCodeReady(input: { url: string; expireIn: number }): void };
      if (phase === "slot") paused.arm();
      if (phase !== "qr") options.onQRCodeReady({ url: "https://open.feishu.cn/qr/drain", expireIn: 60 });
      entered.resolve();
      await resume.promise;
      if (phase === "qr") options.onQRCodeReady({ url: "https://open.feishu.cn/qr/late", expireIn: 60 });
      return { client_id: "late-app", client_secret: "late-secret" };
    });
    const setup = new FeishuSetupService({
      database: paused.database,
      cipher,
      instanceId: randomUUID(),
      imBindings: new ImBindingService(client.database, cipher),
      registrations: new DefaultFeishuRegistrationGateway(register as typeof registerApp),
      activation: { activateAtomicAttempt: vi.fn() },
    });
    let drained = false;
    const creation = setup.createOrReuse(accountId, agent.id, "create").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await entered.promise;
      if (phase === "slot") await paused.captured;
      if (phase === "registered") expect(await creation).toHaveProperty("value");
      const stopping = setup.stop().then(() => {
        drained = true;
      });
      setup.start();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      paused.release();
      resume.resolve();
      const result = await creation;
      await stopping;
      if (phase === "registered") {
        if (!("value" in result)) throw result.error;
        expect(await setup.get(accountId, result.value.id)).toMatchObject({
          state: "failed",
          errorCode: "FEISHU_SETUP_OWNER_RESTARTED",
        });
      } else {
        expect(result).toHaveProperty("error");
        expect((await client.database.select({ n: count() }).from(imBindings))[0]?.n).toBe(0);
      }
      expect((await client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
      setup.start();
      await setup.stop();
    } finally {
      paused.release();
      resume.resolve();
      await creation;
      await setup.stop();
      await client.sql.end({ timeout: 1 });
    }
  },
);

it.each([false, true])(
  "settles a slot committed after the first shutdown pass or reports cleanup failure (%s)",
  async (failLateCleanup) => {
    const client = createDatabaseClient(pg.databaseUrl, { max: 2 });
    const harness = createSkillHarness(client),
      accountId = await harness.createUser(),
      computerId = await harness.createComputer(accountId);
    const agent = await new AgentService(client.database).createForAccount(accountId, {
      computerId,
      name: "late-slot",
      displayName: "Late slot",
      runtimeProvider: "codex",
    });
    const cipher = new ApplicationCipher(Buffer.alloc(32, 21));
    const inserted = deferred(),
      commit = deferred(),
      firstQrPass = deferred(),
      sdkResume = deferred();
    const failure = new Error("Late QR settlement unavailable");
    const original = client.database.transaction.bind(client.database);
    let calls = 0;
    const transaction = vi.spyOn(client.database, "transaction").mockImplementation(async (...args) => {
      const call = ++calls;
      if (call === 3 && failLateCleanup) throw failure;
      return original(async (executor) => {
        const value = await args[0](executor);
        if (call === 1) {
          inserted.resolve();
          await commit.promise;
        }
        if (call === 2) firstQrPass.resolve();
        return value;
      }, args[1]);
    });
    const register = vi.fn(async (raw: unknown) => {
      (raw as { onQRCodeReady(input: { url: string; expireIn: number }): void }).onQRCodeReady({
        url: "https://open.feishu.cn/qr/late-slot",
        expireIn: 60,
      });
      await sdkResume.promise;
      return { client_id: "late-slot-app", client_secret: "late-slot-secret" };
    });
    const setup = new FeishuSetupService({
      database: client.database,
      cipher,
      instanceId: randomUUID(),
      imBindings: new ImBindingService(client.database, cipher),
      registrations: new DefaultFeishuRegistrationGateway(register as typeof registerApp),
      activation: { activateAtomicAttempt: vi.fn() },
    });
    const creation = setup.createOrReuse(accountId, agent.id, "create").catch((error: unknown) => error);
    try {
      await inserted.promise;
      const stopping = setup.stop().then(
        () => undefined,
        (error: unknown) => error,
      );
      await firstQrPass.promise;
      expect((await client.database.select({ n: count() }).from(imBindings))[0]?.n).toBe(0);
      commit.resolve();
      sdkResume.resolve();
      expect(await creation).toBeInstanceOf(Error);
      const outcome = await stopping;
      if (failLateCleanup) {
        expect(outcome).toMatchObject({ errors: [expect.objectContaining({ cause: failure })] });
        await setup.stop();
      } else expect(outcome).toBeUndefined();
      const [row] = await client.database.select().from(imBindings);
      expect(row?.setupState).toBe("failed");
      expect(row?.lastErrorCode).toBe("FEISHU_SETUP_OWNER_RESTARTED");
      expect(row?.setupOwnerInstanceId).toBeNull();
      expect((await client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
    } finally {
      commit.resolve();
      sdkResume.resolve();
      await creation;
      await setup.stop();
      transaction.mockRestore();
      await client.sql.end({ timeout: 1 });
    }
  },
);
