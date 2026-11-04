import { randomUUID } from "node:crypto";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
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

async function deadBindingFixture() {
  const f = await createInboundFixture(testDatabase.databaseUrl);
  cleanup.push(f.close);
  const bindingId = await f.service.activateFeishu({ agentId: f.agent.id, ...activation });
  let failure: (() => Error) | undefined = () => tokenRefusal(10015);
  let probes = 0;
  let attempts = 0;
  const record = f.service.recordDiagnosticError.bind(f.service);
  f.service.recordDiagnosticError = async (id: string, code: string) => {
    attempts += 1;
    return record(id, code);
  };
  const manager = new FeishuConnectionManager({
    database: f.client.database,
    imBindings: f.service,
    inbox: new ImMessageInbox(f.client.database, { now: () => f.clock.now }),
    instanceId: randomUUID(),
    leaseMs: 120_000,
    maintenanceMs: 60_000,
    now: () => f.clock.now,
    // The circuit follows the same clock, so an open circuit half-opens as it would in real time.
    policy: new ExternalCallPolicy({ allowedHosts: ["open.feishu.cn"], clock: () => f.clock.now }),
    createAdapter: () =>
      ({
        channel: { on: () => () => undefined, connect: async () => undefined, disconnect: async () => undefined },
        validateBinding: async () => {
          probes += 1;
          const next = failure?.();
          if (next) throw next;
          return {
            externalAppId: activation.appId,
            externalTeamId: activation.teamId,
            externalBotId: activation.botOpenId,
          };
        },
      }) as unknown as FeishuAdapter,
  });
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
  const binding = async () => {
    const [row] = await f.client.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
    return row;
  };
  return {
    ...f,
    bindingId,
    manager,
    runFor,
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
