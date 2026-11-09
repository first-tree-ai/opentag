import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
  TurnActivityRequestSchema,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { type RuntimeBusinessOptions, RuntimeSession } from "../../runtime/runtime-session.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const phases = [
  "auth",
  "registration",
  "heartbeat",
  "disconnect",
  "registered",
  "business",
  "registration_timeout",
] as const;
type Phase = (typeof phases)[number];
let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => pg?.stop());

class SessionSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  frames: Record<string, unknown>[] = [];
  send(body: string) {
    this.frames.push(JSON.parse(body));
  }
  receive(frame: unknown) {
    this.emit("message", JSON.stringify(frame), false);
  }
  close(code = 1000) {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code);
  }
  async frame(type: string) {
    await expect.poll(() => this.frames.find((frame) => frame.type === type)).toBeDefined();
    const frame = this.frames.find((frame) => frame.type === type);
    if (!frame) throw new Error(`Missing ${type}`);
    return frame;
  }
}

function holdAfter<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
  hold: () => Promise<void>,
) {
  return async (...args: Args) => {
    const result = await operation(...args);
    await hold();
    return result;
  };
}

async function fixture(phase: Phase) {
  let queryTimeouts = 0;
  const client = createDatabaseClient(pg.databaseUrl, {
    max: 1,
    statementTimeoutMs: 1500,
    queryTimeoutMs: 5000,
    onQueryTimeout: () => {
      queryTimeouts++;
    },
  });
  const observer = createDatabaseClient(pg.databaseUrl, { max: 2 });
  const account = await bootstrapInitialAdmin(client.database, {
    displayName: "Session drain",
    email: "drain@example.test",
  });
  const auth = new MachineAuthService(client.database);
  const issued = await auth.issueForAccount(account.userId, {});
  const installationId = randomUUID(),
    instanceId = randomUUID();
  const exchange = await auth.exchangeConnectCode({
    code: issued.code,
    installationId,
    displayName: "drain",
    platform: "linux",
    arch: "arm64",
    clientVersion: "0.1.1",
  });
  const service = new ComputerService(client.database, {} as never);
  const entered = deferred(),
    resume = deferred();
  const hold = async () => {
    entered.resolve();
    await resume.promise;
  };
  if (phase === "auth") {
    const original = auth.verifyMachineToken.bind(auth);
    vi.spyOn(auth, "verifyMachineToken").mockImplementation(holdAfter(original, hold));
  }
  if (phase === "registration") {
    const original = service.register.bind(service);
    vi.spyOn(service, "register").mockImplementation(holdAfter(original, hold));
  }
  if (phase === "heartbeat") {
    const original = service.heartbeat.bind(service);
    vi.spyOn(service, "heartbeat").mockImplementation(holdAfter(original, hold));
  }
  if (phase === "disconnect") {
    const original = service.disconnect.bind(service);
    vi.spyOn(service, "disconnect").mockImplementation(holdAfter(original, hold));
  }
  const socket = new SessionSocket(),
    registry = new ConnectionRegistry();
  const business: RuntimeBusinessOptions = {
    parse: (input) => {
      const parsed = TurnActivityRequestSchema.safeParse(input);
      return parsed.success ? parsed.data : undefined;
    },
    laneKey: () => "drain",
    handle: async () => {
      await client.sql`select 1`;
      await hold();
      await client.sql`select 2`;
      return undefined;
    },
    failureResult: () => undefined,
    overloadResult: () => undefined,
  };
  const session = new RuntimeSession(socket as never, auth, service, registry, {
    business,
    onRegistered: async () => {
      if (phase !== "registered") return;
      await client.sql`select 1`;
      await hold();
      await client.sql`select 2`;
    },
  });
  const unlock = deferred();
  let lockWork: Promise<unknown> = Promise.resolve();
  const acquireRegistrationLock = async () => {
    const locked = deferred();
    lockWork = observer.sql.begin(async (tx) => {
      await tx`select id from computers where id = ${exchange.computerId} for update`;
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
  };
  return {
    client,
    observer,
    auth,
    service,
    socket,
    registry,
    session,
    exchange,
    installationId,
    instanceId,
    entered,
    resume,
    unlock,
    acquireRegistrationLock,
    lockWork: () => lockWork,
    queryTimeouts: () => queryTimeouts,
  };
}

async function startPhase(f: Awaited<ReturnType<typeof fixture>>, phase: Phase) {
  f.session.start();
  f.socket.receive({
    type: "auth",
    requestId: randomUUID(),
    protocolVersion: 2,
    supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
    machineToken: f.exchange.machineToken,
  });
  if (phase === "auth") return;
  await f.socket.frame("server:welcome");
  if (phase === "registration_timeout") await f.acquireRegistrationLock();
  f.socket.receive({
    type: "computer:register",
    requestId: randomUUID(),
    installationId: f.installationId,
    instanceId: f.instanceId,
    displayName: "drain",
    platform: "linux",
    arch: "arm64",
    clientVersion: "0.1.1",
    capabilities: { imCredentialGrant: 1 },
    protocolVersion: 2,
    supportedCapabilities: RUNTIME_CLIENT_CAPABILITY_OFFERS,
    requiredServerCapabilities: [],
  });
  if (phase === "registration" || phase === "registration_timeout") return;
  const registered = await f.socket.frame("computer:register:result");
  if (phase === "heartbeat")
    f.socket.receive({
      type: "heartbeat",
      requestId: randomUUID(),
      protocolVersion: 2,
      connectionId: registered.connectionId,
      installationId: f.installationId,
      instanceId: f.instanceId,
    });
  if (phase === "business")
    f.socket.receive({
      type: "turn:activity",
      requestId: randomUUID(),
      connectionId: registered.connectionId,
      deliveryId: randomUUID(),
      sessionId: randomUUID(),
      agentId: randomUUID(),
      turnId: randomUUID(),
      placementGeneration: 1,
      sequence: 1,
      phase: "running",
    });
}

it.each(phases)("joins actual %s SQL before shared pool disposal", async (phase) => {
  const f = await fixture(phase);
  const [backend] = await f.client.sql`select pg_backend_pid() as pid`;
  try {
    await startPhase(f, phase);
    if (phase === "registration_timeout") {
      await expect
        .poll(
          async () =>
            (
              await f.observer
                .sql`select count(*)::int as n from pg_stat_activity where pid = ${backend?.pid} and wait_event_type = 'Lock'`
            )[0]?.n,
        )
        .toBe(1);
      f.entered.resolve();
    }
    let drained = false;
    let closing: Promise<void> | undefined;
    if (phase === "disconnect")
      closing = f.session.close().then(() => {
        drained = true;
      });
    await f.entered.promise;
    closing ??= f.session.close().then(() => {
      drained = true;
    });
    const frameCount = f.socket.frames.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    f.resume.resolve();
    await closing;
    f.unlock.resolve();
    await f.lockWork();
    expect(f.socket.frames).toHaveLength(frameCount);
    expect(f.registry.currentInstanceId(f.exchange.computerId)).toBeUndefined();
    const [computer] = await f.observer.database
      .select()
      .from(computers)
      .where(eq(computers.id, f.exchange.computerId));
    expect(computer?.currentInstanceId).toBeNull();
    expect(f.queryTimeouts()).toBe(0);
    expect((await f.client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
    await f.client.sql.end({ timeout: 1 });
    await expect
      .poll(
        async () =>
          (await f.observer.sql`select count(*)::int as n from pg_stat_activity where pid = ${backend?.pid}`)[0]?.n,
      )
      .toBe(0);
  } finally {
    f.resume.resolve();
    f.unlock.resolve();
    await Promise.allSettled([f.session.close(), f.lockWork()]);
    await Promise.all([f.client.sql.end({ timeout: 1 }), f.observer.sql.end({ timeout: 1 })]);
  }
});
