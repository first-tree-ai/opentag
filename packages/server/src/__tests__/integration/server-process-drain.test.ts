import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { HTTP_PATHS, RUNTIME_CLIENT_CAPABILITY_OFFERS, RUNTIME_SUPPORTED_PROTOCOL_VERSIONS } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => pg?.stop());
const entry = fileURLToPath(new URL("../../../dist/index.mjs", import.meta.url));
const directory = fileURLToPath(new URL("../../../", import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function processFixture(port: number, heldDns = false) {
  const download = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  download.listen(0, "127.0.0.1");
  await once(download, "listening");
  const address = download.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("OPENTAG_") && key !== "BETTER_AUTH_SECRET"),
  );
  const child = spawn(
    process.execPath,
    [
      ...(heldDns ? ["--import", fileURLToPath(new URL("../fixtures/held-listen-dns.mjs", import.meta.url))] : []),
      entry,
    ],
    {
      cwd: directory,
      env: {
        ...environment,
        OPENTAG_ENV: "dev",
        OPENTAG_DATABASE_URL: pg.databaseUrl,
        OPENTAG_DATABASE_STATEMENT_TIMEOUT_MS: "1000",
        OPENTAG_DATABASE_QUERY_TIMEOUT_MS: "2000",
        OPENTAG_AUTO_MIGRATE: "false",
        OPENTAG_HOST: heldDns ? "held-listen.test" : "127.0.0.1",
        OPENTAG_PORT: String(port),
        OPENTAG_PUBLIC_URL: `http://127.0.0.1:${port}`,
        OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: `http://127.0.0.1:${address.port}/releases`,
        OPENTAG_JWT_SECRET: randomBytes(48).toString("base64url"),
        BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
        OPENTAG_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  let dnsEntered = false;
  child.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "stage" in message && message.stage === "listen-dns")
      dnsEntered = true;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-32768);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-32768);
  });
  const exit = once(child, "exit").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as string | null,
  }));
  const wait = async (predicate: () => boolean, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline)
        throw new Error(`Server process did not reach the expected state: ${output}`);
      await pause(20);
    }
  };
  return {
    child,
    exit,
    output: () => output,
    ready: () => wait(() => output.includes("Server listening at")),
    dnsReady: () => wait(() => dnsEntered),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
      await new Promise<void>((resolve, reject) => download.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function waitForExit(fixture: Awaited<ReturnType<typeof processFixture>>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fixture.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Server did not exit: ${fixture.output()}`)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.each(["release", "statement-timeout"] as const)(
  "SIGTERM joins actual registration SQL until %s, then removes every backend",
  async (mode) => {
    const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
    const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
    const blocker = createDatabaseClient(pg.databaseUrl, { max: 1 });
    const bootstrap = await bootstrapInitialAdmin(client.database, {
      displayName: "Signal",
      email: "signal@example.test",
    });
    const auth = new MachineAuthService(client.database);
    const issued = await auth.issueForAccount(bootstrap.userId, {});
    const installationId = randomUUID();
    const exchange = await auth.exchangeConnectCode({
      code: issued.code,
      installationId,
      displayName: "signal",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.1.1",
    });
    const [seedPid] = await client.sql`select pg_backend_pid() as pid`;
    const [observerPid] = await observer.sql`select pg_backend_pid() as pid`;
    const [blockerPid] = await blocker.sql`select pg_backend_pid() as pid`;
    const port = await availablePort();
    const fixture = await processFixture(port);
    const release = deferred();
    const locked = deferred();
    let transaction: Promise<unknown> | undefined;
    let socket: WebSocket | undefined;
    try {
      await fixture.ready();
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
      socket = new WebSocket(`ws://127.0.0.1:${port}${HTTP_PATHS.computerRuntimeWebSocket}`);
      const frames: Record<string, unknown>[] = [];
      socket.on("message", (raw) => {
        frames.push(JSON.parse(String(raw)));
      });
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
      const welcomeDeadline = Date.now() + 3000;
      while (!frames.some((frame) => frame.type === "server:welcome")) {
        if (Date.now() >= welcomeDeadline) throw new Error("No Runtime welcome");
        await pause(10);
      }
      transaction = blocker.sql.begin(async (sql) => {
        await sql`select id from computers where id = ${exchange.computerId} for update`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      socket.send(
        JSON.stringify({
          type: "computer:register",
          requestId: randomUUID(),
          installationId,
          instanceId: randomUUID(),
          displayName: "signal",
          platform: "linux",
          arch: "arm64",
          clientVersion: "0.1.1",
          capabilities: { imCredentialGrant: 1 },
          protocolVersion: 2,
          supportedCapabilities: RUNTIME_CLIENT_CAPABILITY_OFFERS,
          requiredServerCapabilities: [],
        }),
      );
      const lockDeadline = Date.now() + 3000;
      while (true) {
        const [waiting] =
          await observer.sql`select count(*)::int as count from pg_stat_activity where pid <> ${blockerPid?.pid} and wait_event_type = 'Lock' and query ilike '%computers%'`;
        if (waiting?.count > 0) break;
        if (Date.now() >= lockDeadline)
          throw new Error(`Registration did not reach the database lock: ${fixture.output()}`);
        await pause(10);
      }
      const backends =
        await observer.sql`select pid from pg_stat_activity where datname = current_database() and backend_type = 'client backend' and pid not in (${seedPid?.pid}, ${observerPid?.pid}, ${blockerPid?.pid})`;
      expect(backends.length).toBeGreaterThan(0);
      fixture.child.kill("SIGTERM");
      await pause(60);
      expect(fixture.child.exitCode).toBeNull();
      expect(await observer.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
      if (mode === "release") release.resolve();
      expect(await waitForExit(fixture)).toEqual({ code: 0, signal: null });
      expect(fixture.output()).not.toContain("Unhandled");
      for (const backend of backends) {
        const [row] =
          await observer.sql`select count(*)::int as count from pg_stat_activity where pid = ${backend.pid}`;
        expect(row?.count).toBe(0);
      }
      const [computer] = await observer.database.select().from(computers).where(eq(computers.id, exchange.computerId));
      expect(computer?.currentInstanceId).toBeNull();
    } finally {
      release.resolve();
      await transaction;
      socket?.terminate();
      await fixture.stop();
      await Promise.all([
        client.sql.end({ timeout: 1 }),
        observer.sql.end({ timeout: 1 }),
        blocker.sql.end({ timeout: 1 }),
      ]);
    }
  },
  20000,
);

it("cleans up an actual listen failure without leaving application backends", async () => {
  const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("No occupied port");
  const fixture = await processFixture(address.port);
  try {
    expect(await waitForExit(fixture)).toEqual({ code: 1, signal: null });
    expect(fixture.output()).toContain("Failed to start OpenTag server");
    const [row] =
      await observer.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`;
    expect(row?.count).toBe(0);
  } finally {
    await fixture.stop();
    await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
    await observer.sql.end({ timeout: 1 });
  }
}, 20000);

it("SIGTERM during real listen DNS preserves the pool until bind settles and never reopens", async () => {
  const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const fixture = await processFixture(await availablePort(), true);
  try {
    await fixture.dnsReady();
    fixture.child.kill("SIGTERM");
    await pause(60);
    expect(fixture.child.exitCode).toBeNull();
    const [waiting] =
      await observer.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`;
    expect(waiting?.count).toBeGreaterThan(0);
    fixture.child.send({ release: true });
    expect(await waitForExit(fixture)).toEqual({ code: 0, signal: null });
    expect(fixture.output()).not.toContain("Unhandled");
    const [after] =
      await observer.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`;
    expect(after?.count).toBe(0);
  } finally {
    await fixture.stop();
    await observer.sql.end({ timeout: 1 });
  }
}, 20000);
