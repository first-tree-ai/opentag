import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { HTTP_PATHS, RUNTIME_CLIENT_CAPABILITY_OFFERS, RUNTIME_SUPPORTED_PROTOCOL_VERSIONS } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => pg?.stop());

it.each([false, true])(
  "joins disconnected registration through the actual execution plugin (other close fails: %s)",
  async (failClose) => {
    const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
    const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
    const account = await bootstrapInitialAdmin(client.database, {
      displayName: "Route drain",
      email: "route@example.test",
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
    const registry = new ConnectionRegistry();
    const entered = deferred(),
      resume = deferred();
    const original = service.register.bind(service);
    const spy = vi.spyOn(service, "register").mockImplementation(async (...args) => {
      const result = await original(...args);
      entered.resolve();
      await resume.promise;
      return result;
    });
    let stopStarted = false,
      poolReleased = false,
      closed = false;
    const stopFailure = new Error("Other owner stop failed");
    const app = createApp({
      authService: {} as never,
      database: client.database,
      machineAuthService: auth,
      computerService: service,
      runtime: {
        registry,
        approvalOwner: {
          businessOptions: () => ({
            parse: () => undefined,
            laneKey: () => "none",
            handle: async () => undefined,
            failureResult: () => undefined,
            overloadResult: () => undefined,
          }),
          close: () => {
            stopStarted = true;
            if (failClose) throw stopFailure;
          },
        },
      },
    });
    app.addHook("onClose", async () => {
      await client.sql.end({ timeout: 1 });
      poolReleased = true;
    });
    const [backend] = await client.sql`select pg_backend_pid() as pid`;
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (raw) => {
      frames.push(JSON.parse(String(raw)));
    });
    let closing: Promise<unknown> | undefined;
    try {
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "auth",
          requestId: randomUUID(),
          protocolVersion: 2,
          supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
          machineToken: exchange.machineToken,
        }),
      );
      await expect.poll(() => frames.some((frame) => frame.type === "server:welcome")).toBe(true);
      socket.send(
        JSON.stringify({
          type: "computer:register",
          requestId: randomUUID(),
          installationId,
          instanceId,
          displayName: "drain",
          platform: "linux",
          arch: "arm64",
          clientVersion: "0.1.1",
          capabilities: { imCredentialGrant: 1 },
          protocolVersion: 2,
          supportedCapabilities: RUNTIME_CLIENT_CAPABILITY_OFFERS,
          requiredServerCapabilities: [],
        }),
      );
      await entered.promise;
      const disconnected = once(socket, "close");
      socket.close();
      await disconnected;
      const frameCount = frames.length;
      closing = app.close().then(
        () => {
          closed = true;
        },
        (error) => {
          closed = true;
          return error;
        },
      );
      await expect.poll(() => stopStarted).toBe(true);
      expect(closed).toBe(false);
      expect(poolReleased).toBe(false);
      expect(
        (await observer.database.select().from(computers).where(eq(computers.id, exchange.computerId)))[0]
          ?.currentInstanceId,
      ).toBe(instanceId);
      resume.resolve();
      const result = await closing;
      if (failClose) expect(result).toBeInstanceOf(AggregateError);
      else expect(result).toBeUndefined();
      expect(poolReleased).toBe(true);
      expect(frames).toHaveLength(frameCount);
      expect(registry.currentInstanceId(exchange.computerId)).toBeUndefined();
      expect(
        (await observer.database.select().from(computers).where(eq(computers.id, exchange.computerId)))[0]
          ?.currentInstanceId,
      ).toBeNull();
      await expect
        .poll(
          async () =>
            (await observer.sql`select count(*)::int as n from pg_stat_activity where pid = ${backend?.pid}`)[0]?.n,
        )
        .toBe(0);
    } finally {
      resume.resolve();
      socket.close();
      await app.close().catch(() => undefined);
      await closing;
      spy.mockRestore();
      await client.sql.end({ timeout: 1 });
      await observer.sql.end({ timeout: 1 });
    }
  },
);
