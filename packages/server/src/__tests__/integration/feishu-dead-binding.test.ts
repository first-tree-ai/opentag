import { randomUUID } from "node:crypto";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { imBindings } from "../../db/schema/index.js";
import { ExternalCallPolicy } from "../../services/im/external-call-policy.js";
import { ImMessageInbox } from "../../services/im/index.js";
import type { FeishuAdapter } from "../../services/im-bindings/feishu/adapter.js";
import { FeishuConnectionManager } from "../../services/im-bindings/feishu/connection-manager.js";
import { createInboundFixture } from "./inbound-receipt-recovery-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => testDatabase.reset());
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});
afterAll(async () => testDatabase.stop());

const HOUR_MS = 60 * 60_000;

/** The SDK's own shape for a refused tenant token, wrapped as its channel reports it. */
function tokenRefusal(code: number): Error {
  return Object.assign(new Error("could not resolve bot identity"), {
    name: "LarkChannelError",
    code: "not_connected",
    cause: new Error(`failed to get tenant_access_token, code: ${code}, msg: synthetic`),
  });
}

function networkFailure(): Error {
  return Object.assign(new Error("could not resolve bot identity"), {
    name: "LarkChannelError",
    code: "not_connected",
    cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  });
}

const activation = {
  appId: "cli_dead",
  teamId: "tenant_dead",
  botOpenId: "ou_bot",
  appSecret: "synthetic",
  teamBrand: "feishu" as const,
  grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
};

interface ManagerOptions {
  /** Called inside each probe, before it answers: a barrier for another connection's write. */
  onProbe?: () => Promise<void>;
  permanentFailureLimit?: number;
  database?: DatabaseClient;
  instanceId?: string;
}

async function deadBindingFixture(options: ManagerOptions = {}) {
  const f = await createInboundFixture(testDatabase.databaseUrl);
  cleanup.push(f.close);
  const bindingId = await f.service.activateFeishu({ agentId: f.agent.id, ...activation });
  let failure: (() => Error) | undefined = () => tokenRefusal(10015);
  let probes = 0;
  let attempts = 0;
  const createManager = (managerOptions: ManagerOptions & { answer: () => Error | undefined }) =>
    new FeishuConnectionManager({
      database: managerOptions.database ?? f.client.database,
      imBindings: f.service,
      inbox: new ImMessageInbox(managerOptions.database ?? f.client.database, { now: () => f.clock.now }),
      instanceId: managerOptions.instanceId ?? randomUUID(),
      leaseMs: 120_000,
      maintenanceMs: 60_000,
      now: () => f.clock.now,
      ...(managerOptions.permanentFailureLimit ? { permanentFailureLimit: managerOptions.permanentFailureLimit } : {}),
      // The circuit follows the same clock, so an open circuit half-opens as it would in real time.
      policy: new ExternalCallPolicy({ allowedHosts: ["open.feishu.cn"], clock: () => f.clock.now }),
      createAdapter: () => {
        attempts += 1;
        return {
          channel: { on: () => () => undefined, connect: async () => undefined, disconnect: async () => undefined },
          validateBinding: async () => {
            probes += 1;
            await managerOptions.onProbe?.();
            const next = managerOptions.answer();
            if (next) throw next;
            return {
              externalAppId: activation.appId,
              externalTeamId: activation.teamId,
              externalBotId: activation.botOpenId,
            };
          },
        } as unknown as FeishuAdapter;
      },
    });
  const manager = createManager({ ...options, answer: () => failure?.() });
  cleanup.push(() => manager.stop());
  let started = false;
  /** One maintenance pass every 10 seconds of manager time, as the production timer runs. */
  const runFor = async (ms: number) => {
    if (!started) manager.start();
    started = true;
    for (let elapsed = 0; elapsed < ms; elapsed += 10_000) {
      await manager.maintain();
      f.clock.now = new Date(f.clock.now.getTime() + 10_000);
    }
  };
  /** Runs passes until this instance has made `count` more probes. */
  const runProbes = async (count: number) => {
    const target = probes + count;
    for (let pass = 0; probes < target; pass += 1) {
      if (pass > 500) throw new Error("probe target not reached");
      await runFor(10_000);
    }
  };
  const binding = async () => {
    const [row] = await f.client.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
    return row;
  };
  return {
    ...f,
    bindingId,
    manager,
    createManager,
    runFor,
    runProbes,
    binding,
    fail: (next: (() => Error) | undefined) => {
      failure = next;
    },
    probes: () => probes,
    attempts: () => attempts,
  };
}

it("stops a binding whose credentials Feishu keeps refusing and keeps the reason", async () => {
  const f = await deadBindingFixture();
  await f.runFor(HOUR_MS);
  expect(await f.binding()).toMatchObject({
    status: "error",
    lastErrorCode: "FEISHU_CREDENTIAL_INVALID",
    connectionOwnerInstanceId: null,
    credentialGeneration: 2,
  });
  // The Web reads the binding as a connection error, with why it stopped.
  expect(await f.service.getForAgent(f.account.userId, f.agent.id)).toMatchObject({
    bindingState: "error",
    connectionFailure: "credentials_rejected",
  });
  const probesWhenStopped = f.probes();
  expect(probesWhenStopped).toBeLessThanOrEqual(10);
  // Nothing scans a stopped binding: another hour adds no probe and no write.
  const attemptsWhenStopped = f.attempts();
  await f.runFor(HOUR_MS);
  expect(f.probes()).toBe(probesWhenStopped);
  expect(f.attempts()).toBe(attemptsWhenStopped);
}, 120_000);

it("reads a disabled or uninstalled App as needing action", async () => {
  const f = await deadBindingFixture();
  f.fail(() => tokenRefusal(10014));
  await f.runFor(HOUR_MS);
  expect(await f.binding()).toMatchObject({ status: "error", lastErrorCode: "FEISHU_APP_UNAVAILABLE" });
}, 120_000);

it("retries a network failure with backoff and never stops the binding for it", async () => {
  const f = await deadBindingFixture();
  f.fail(networkFailure);
  await f.runFor(HOUR_MS);
  expect(await f.binding()).toMatchObject({ status: "active", credentialGeneration: 1 });
  // Paced up to five minutes apart: far below the 360 passes an hour, and still retrying.
  const attempts = f.attempts();
  expect(attempts).toBeGreaterThan(5);
  expect(attempts).toBeLessThan(30);
  await f.runFor(HOUR_MS);
  expect(f.attempts() - attempts).toBeGreaterThan(0);
  expect(f.attempts() - attempts).toBeLessThanOrEqual(13);
}, 120_000);

it("does not stop a binding when network failures break the run of refusals", async () => {
  const f = await deadBindingFixture();
  let call = 0;
  f.fail(() => (++call % 5 === 0 ? networkFailure() : tokenRefusal(10015)));
  await f.runFor(3 * HOUR_MS);
  expect(await f.binding()).toMatchObject({ status: "active" });
}, 120_000);

it("resumes connecting once the stopped binding is reauthorized", async () => {
  const f = await deadBindingFixture();
  await f.runFor(HOUR_MS);
  expect(await f.binding()).toMatchObject({ status: "error" });
  f.fail(undefined);
  await f.service.activateFeishu({ agentId: f.agent.id, ...activation });
  expect(await f.binding()).toMatchObject({ status: "active", lastErrorCode: null, credentialGeneration: 3 });
  expect((await f.service.getForAgent(f.account.userId, f.agent.id))?.connectionFailure).toBeUndefined();
  const probes = f.probes();
  await f.runFor(30_000);
  expect(f.probes()).toBe(probes + 1);
  expect((await f.binding())?.observedConnectedAt).not.toBeNull();
}, 120_000);

it("starts the refusal run over when another instance claimed the binding in between", async () => {
  const f = await deadBindingFixture({ permanentFailureLimit: 3 });
  await f.runProbes(2);
  // A second instance on its own connection claims the released binding and connects it.
  const other = createDatabaseClient(testDatabase.databaseUrl, { max: 2 });
  cleanup.push(() => other.sql.end());
  const second = f.createManager({ database: other.database, answer: () => undefined });
  second.start();
  await expect.poll(async () => (await f.binding())?.observedConnectedAt).not.toBeNull();
  await second.stop();
  // The first instance's next refusal is the first of a new run, not its third.
  await f.runProbes(1);
  expect(await f.binding()).toMatchObject({ status: "active", credentialGeneration: 1 });
  await f.runProbes(2);
  expect(await f.binding()).toMatchObject({ status: "error", lastErrorCode: "FEISHU_CREDENTIAL_INVALID" });
}, 120_000);

it("does not stop or overwrite a binding another instance took over before the terminal write", async () => {
  const other = createDatabaseClient(testDatabase.databaseUrl, { max: 2 });
  cleanup.push(() => other.sql.end());
  const takeover = randomUUID();
  let bindingId = "";
  const f = await deadBindingFixture({
    permanentFailureLimit: 1,
    // The refusal arrives after this instance's lease lapsed and another instance claimed it.
    onProbe: async () => {
      await other.database
        .update(imBindings)
        .set({
          connectionOwnerInstanceId: takeover,
          connectionFencingEpoch: sql`${imBindings.connectionFencingEpoch} + 1`,
          connectionLeaseExpiresAt: new Date(Date.now() + 120_000),
        })
        .where(eq(imBindings.id, bindingId));
    },
  });
  bindingId = f.bindingId;
  await f.runProbes(1);
  expect(await f.binding()).toMatchObject({
    status: "active",
    credentialGeneration: 1,
    connectionOwnerInstanceId: takeover,
    lastErrorCode: null,
  });
  expect((await f.binding())?.connectionLeaseExpiresAt).not.toBeNull();
}, 120_000);

it("does not restore a failure reason that reauthorization cleared while the attempt ran", async () => {
  let reauthorize: () => Promise<unknown> = async () => undefined;
  const f = await deadBindingFixture({ onProbe: () => reauthorize().then(() => undefined) });
  await f.runProbes(1);
  expect((await f.binding())?.lastErrorCode).toBe("FEISHU_CREDENTIAL_INVALID");
  // During the next attempt the owner reauthorizes; that attempt's late refusal must not land.
  reauthorize = async () => {
    reauthorize = async () => undefined;
    await f.service.activateFeishu({ agentId: f.agent.id, ...activation });
  };
  await f.runProbes(1);
  expect(await f.binding()).toMatchObject({ status: "active", credentialGeneration: 2, lastErrorCode: null });
}, 120_000);
