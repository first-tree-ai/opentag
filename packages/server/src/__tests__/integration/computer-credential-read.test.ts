import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { computerCredentials, computers, users } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { RuntimeSession } from "../../runtime/runtime-session.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase?.stop());
beforeEach(async () => testDatabase.reset());

async function fixture(kind: "local" | "cloud" = "local") {
  const observer = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const reader = createDatabaseClient(testDatabase.databaseUrl, { max: 8, statementTimeoutMs: 1_000 });
  const writer = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const writes = createDatabaseClient(testDatabase.databaseUrl, { max: 2 });
  const accountId = randomUUID();
  await observer.database
    .insert(users)
    .values({ id: accountId, email: "credential@example.com", displayName: "Owner" });
  const machineAuth = new MachineAuthService(observer.database);
  const issued = await machineAuth.issueForAccount(accountId, {});
  const context = await machineAuth.exchangeConnectCode(exchangeInput(issued.code));
  if (kind === "cloud") {
    await observer.database.delete(computerCredentials).where(eq(computerCredentials.id, context.credentialId));
    await observer.database.update(computers).set({ kind }).where(eq(computers.id, context.computerId));
  }
  const hook = vi.fn();
  const service = new ComputerService(reader.database, {} as never, { assertCloudControlCredential: hook });
  const [connection] = await writer.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  assert(connection);
  return {
    observer,
    reader,
    writer,
    writes,
    writerPid: connection.pid,
    accountId,
    context: { ...context, kind },
    hook,
    service,
    close: () => Promise.all([observer.sql.end(), reader.sql.end(), writer.sql.end(), writes.sql.end()]),
  };
}

function exchangeInput(code: string) {
  return {
    code,
    installationId: randomUUID(),
    displayName: "Local",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.0",
  };
}

function registerFrame(installationId: string, instanceId: string) {
  return {
    type: "computer:register" as const,
    requestId: randomUUID(),
    installationId,
    instanceId,
    displayName: "Computer",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.0",
    capabilities: { imCredentialGrant: 0 as const },
    protocolVersion: RUNTIME_PROTOCOL_V2,
    supportedCapabilities: RUNTIME_CLIENT_CAPABILITY_OFFERS,
    requiredServerCapabilities: [],
  };
}

class SessionSocket extends EventEmitter {
  readyState = 1;
  frames: Record<string, unknown>[] = [];
  send(body: string) {
    this.frames.push(JSON.parse(body));
  }
  receive(frame: unknown) {
    this.emit("message", JSON.stringify(frame), false);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", code);
  }
}

async function runtime(value: Awaited<ReturnType<typeof fixture>>) {
  const socket = new SessionSocket();
  const handle = vi.fn((frame) => ({ type: "work:result", key: frame.key }));
  const session = new RuntimeSession(
    socket as never,
    new MachineAuthService(value.observer.database),
    value.service,
    new ConnectionRegistry(),
    {
      business: {
        parse: (frame) => frame as { type: string },
        laneKey: (frame) => String(frame.key),
        handle,
        failureResult: () => undefined,
        overloadResult: () => undefined,
      },
    },
  );
  session.start();
  socket.receive({
    type: "auth",
    requestId: randomUUID(),
    protocolVersion: 2,
    supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
    machineToken: value.context.machineToken,
  });
  await expect.poll(() => socket.frames.find((frame) => frame.type === "auth:result")?.ok).toBe(true);
  socket.receive(registerFrame(value.context.installationId, randomUUID()));
  await expect.poll(() => socket.frames.find((frame) => frame.type === "computer:register:result")?.ok).toBe(true);
  const registration = socket.frames.find((frame) => frame.type === "computer:register:result");
  return { session, socket, handle, connectionId: registration?.connectionId };
}

describe("Non-locking Computer credential snapshots", () => {
  it.each(["local", "cloud"] as const)("admits concurrent %s reads while the Computer row is locked", async (kind) => {
    const value = await fixture(kind);
    const locked = deferred();
    const release = deferred();
    const holding = value.writer.database.transaction(async (transaction) => {
      await transaction.select().from(computers).where(eq(computers.id, value.context.computerId)).for("update");
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      await Promise.all(Array.from({ length: 8 }, () => value.reader.sql`select 1`));
      const query = vi.fn();
      value.reader.sql.options.debug = (_connection, sql) => query(sql);
      await Promise.all(Array.from({ length: 8 }, () => value.service.assertActiveCredential(value.context)));
      await expect(
        value.service.assertActiveCredential({ ...value.context, installationId: randomUUID() }),
      ).rejects.toMatchObject({ code: "COMPUTER_NOT_REGISTERED" });
      expect(query).toHaveBeenCalledTimes(9);
      for (const [sql] of query.mock.calls) {
        expect(sql).toMatch(/^select /);
        expect(sql).not.toMatch(/for update/i);
      }
      expect(value.hook).toHaveBeenCalledTimes(kind === "cloud" ? 8 : 0);
      const [waiters] = await value.observer.sql<
        { count: number }[]
      >`select count(*)::int as count from pg_stat_activity where ${value.writerPid} = any(pg_blocking_pids(pid))`;
      expect(waiters?.count).toBe(0);
    } finally {
      release.resolve();
      await holding;
      await value.close();
    }
  });

  it.each(["disconnect", "repair", "delete"] as const)(
    "uses the committed snapshot during %s and rechecks writes after commit",
    async (change) => {
      const value = await fixture();
      const changed = deferred();
      const release = deferred();
      const instanceId = randomUUID();
      const frame = registerFrame(value.context.installationId, instanceId);
      await value.service.register(value.context, frame);
      const machineAuth = new MachineAuthService(value.writer.database);
      const code = await machineAuth.issueForAccount(value.accountId, {
        mode: "repair",
        targetComputerId: value.context.computerId,
      });
      const transaction = value.writer.database.transaction.bind(value.writer.database);
      const spy = vi.spyOn(value.writer.database, "transaction").mockImplementation((callback, config) =>
        transaction(async (executor) => {
          const result = await callback(executor);
          changed.resolve();
          await release.promise;
          return result;
        }, config),
      );
      const lifecycle = new ComputerService(value.writer.database, {} as never);
      const actions = {
        repair: () => machineAuth.exchangeConnectCode(exchangeInput(code.code)),
        delete: () => lifecycle.deleteComputer(value.accountId, value.context.computerId),
        disconnect: () => lifecycle.disconnectComputer(value.accountId, value.context.computerId),
      };
      const mutation = actions[change]();
      const mutationResult = Promise.allSettled([mutation]);
      let writeResults: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await changed.promise;
        await value.service.assertActiveCredential(value.context);
        const writes = new ComputerService(value.writes.database, {} as never);
        writeResults = Promise.allSettled([
          writes.register(value.context, frame),
          writes.heartbeat(value.context, instanceId),
        ]);
        await expect
          .poll(
            async () => {
              const [row] = await value.observer.sql<
                { count: number }[]
              >`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`;
              return row?.count;
            },
            { timeout: 5_000, interval: 10 },
          )
          .toBe(2);
        release.resolve();
        expect((await mutationResult)[0]?.status).toBe("fulfilled");
        const results = await writeResults;
        for (const result of results) {
          expect(result).toMatchObject({ status: "rejected", reason: { code: "COMPUTER_NOT_REGISTERED" } });
        }
        await expect(value.service.assertActiveCredential(value.context)).rejects.toMatchObject({
          code: "COMPUTER_NOT_REGISTERED",
        });
        const [computer] = await value.observer.database
          .select()
          .from(computers)
          .where(eq(computers.id, value.context.computerId));
        expect(computer?.currentInstanceId).toBeNull();
        if (change === "repair") {
          const result = (await mutationResult)[0];
          assert(result?.status === "fulfilled" && result.value && "credentialId" in result.value);
          await value.service.assertActiveCredential(result.value);
          expect(computer?.currentInstallationId).not.toBe(value.context.installationId);
        }
        if (change === "delete") expect(computer?.deletedAt).toBeInstanceOf(Date);
        if (change === "disconnect") expect(computer?.disconnectedAt).toBeInstanceOf(Date);
      } finally {
        release.resolve();
        await mutationResult;
        await writeResults;
        spy.mockRestore();
        await value.close();
      }
    },
  );

  it("processes eight lanes on one RuntimeSession without waiting for a Computer row lock", async () => {
    const value = await fixture();
    const current = await runtime(value);
    const locked = deferred();
    const release = deferred();
    const holding = value.writer.sql.begin(async (transaction) => {
      await transaction`select id from computers where id=${value.context.computerId} for update`;
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      for (let key = 0; key < 8; key++)
        current.socket.receive({ type: "work", requestId: randomUUID(), key, connectionId: current.connectionId });
      await expect
        .poll(() => current.socket.frames.filter((frame) => frame.type === "work:result").length, { timeout: 2_000 })
        .toBe(8);
      expect(current.handle).toHaveBeenCalledTimes(8);
    } finally {
      release.resolve();
      await holding;
      await current.session.close();
      await value.close();
    }
  });

  it("does not dispatch a late credential result after the RuntimeSession closes", async () => {
    const value = await fixture();
    const current = await runtime(value);
    const locked = deferred();
    const release = deferred();
    const holding = value.writer.sql.begin(async (transaction) => {
      await transaction`lock table computers in access exclusive mode`;
      locked.resolve();
      await release.promise;
    });
    let closed: Promise<void> | undefined;
    try {
      await locked.promise;
      current.socket.receive({
        type: "work",
        requestId: randomUUID(),
        key: "late",
        connectionId: current.connectionId,
      });
      await expect
        .poll(async () => {
          const [row] = await value.observer.sql<
            { count: number }[]
          >`select count(*)::int as count from pg_stat_activity where ${value.writerPid} = any(pg_blocking_pids(pid))`;
          return row?.count;
        })
        .toBe(1);
      closed = current.session.close();
    } finally {
      release.resolve();
      await holding;
      await (closed ?? current.session.close());
      await value.close();
    }
    expect(current.handle).not.toHaveBeenCalled();
    expect(current.socket.frames.some((frame) => frame.type === "work:result")).toBe(false);
  });

  it("propagates statement cancellation and releases the reader for the next check", async () => {
    const value = await fixture();
    const locked = deferred();
    const release = deferred();
    const [connection] = await value.reader.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    assert(connection);
    await value.reader.sql`set statement_timeout = 100`;
    const holding = value.writer.sql.begin(async (transaction) => {
      await transaction`lock table computers in access exclusive mode`;
      locked.resolve();
      await release.promise;
    });
    try {
      try {
        await locked.promise;
        await expect(value.service.assertActiveCredential(value.context)).rejects.toMatchObject({
          cause: { code: "57014" },
        });
      } finally {
        release.resolve();
        await holding;
      }
      await expect(value.service.assertActiveCredential(value.context)).resolves.toBeUndefined();
      const [reader] = await value.observer.sql<
        { state: string }[]
      >`select state from pg_stat_activity where pid=${connection.pid}`;
      expect(reader?.state).toBe("idle");
    } finally {
      await value.close();
    }
  });
});
