/**
 * Runner control channel + Account runner HTTP endpoints against a real Fastify app, real
 * loopback WebSockets, and the embedded PostgreSQL engine. The cloud side is the deterministic
 * fake admin; no GCP, no credential material, no Pi.
 */
import { randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import {
  accountSandboxRunnerAcceptancePath,
  accountSandboxRunnerPath,
  accountSandboxRunnerStartPath,
  accountSandboxRunnerStopPath,
  HTTP_PATHS,
  RUNNER_WS_CLOSE,
  RUNNER_WS_MAX_FRAME_BYTES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { registerRunnerWebSocketRoute } from "../api/runner-ws.js";
import { createApp } from "../app.js";
import { imBindings, sandboxes, users } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ComputerService } from "../services/computers/index.js";
import { SandboxService } from "../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../services/sandboxes/runner-bootstrap-token.js";
import { RunnerHub } from "../services/sandboxes/runner-hub.js";
import { SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../services/sessions/index.js";
import { FAKE_REGION, FakeCloudRunAdmin } from "./support/fake-cloud-run-admin.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
const apps: ReturnType<typeof createApp>[] = [];
const bareApps: Fastify.FastifyInstance[] = [];

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(bareApps.splice(0).map((app) => app.close()));
});

const RUNNER_VERSION = "0.0.5";
const cloudIdentities = { enabled: true, runnerVersion: RUNNER_VERSION, storageBase: "gs://unit-cloud/sandboxes" };
const JWT_SECRET = "unit-test-jwt-secret-at-least-32-characters";
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

async function account(email = "owner@example.test") {
  const id = randomUUID();
  await unit.database.insert(users).values({ id, email: `${id}-${email}`, displayName: "WS fixture" });
  return id;
}

async function ownedSandbox(accountId: string) {
  const cloud = await new ComputerService(unit.database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(unit.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e3-ws-${randomUUID().slice(0, 8)}`,
    displayName: "E3 WS",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  const bindingId = randomUUID();
  await unit.database.insert(imBindings).values({
    id: bindingId,
    agentId: agent.id,
    provider: "feishu",
    status: "active",
    externalAppId: `unit-app-${randomUUID().slice(0, 8)}`,
    externalBotId: "unit-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: new Date(),
  });
  return new SandboxService(unit.database, new SessionService(unit.database), { cloudIdentities }).ensureForAccount(
    accountId,
    { imBindingId: bindingId, channelId: "unit-channel", conversationKind: "channel", kind: "channel" },
  );
}

function authService(accountId: string): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: { user: { id: accountId, email: "owner@example.test", displayName: "Owner" }, setupCompletedAt: null },
    }),
  };
}

interface RunnerContext {
  fake: FakeCloudRunAdmin;
  tokens: RunnerBootstrapTokenService;
  hub: RunnerHub;
  service: SandboxRunnerService;
}

function makeRunnerContext(options: { tokenTtlSeconds?: number } = {}): RunnerContext {
  const fake = new FakeCloudRunAdmin();
  const tokens = new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: options.tokenTtlSeconds ?? 600 });
  const hub = new RunnerHub();
  const service = new SandboxRunnerService(unit.database, {
    cloudAdmin: fake as never,
    tokens,
    hub,
    environment: "staging",
    backendUrl: "wss://unit.example/api/v1/sandbox-runners/ws",
    expectedRunnerVersion: RUNNER_VERSION,
    acceptanceTimeoutMs: 10_000,
    createConvergeTimeoutMs: 30_000,
    sleep: () => Promise.resolve(),
  });
  return { fake, tokens, hub, service };
}

async function createRunnerApp(accountId: string, options: { tokenTtlSeconds?: number } = {}) {
  const context = makeRunnerContext(options);
  const app = createApp({
    authService: authService(accountId),
    sandboxRunnerService: context.service,
    runnerChannel: { tokens: context.tokens, hub: context.hub },
  });
  apps.push(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, address, ...context };
}

async function createBareRunnerApp(
  _accountId: string,
  options: {
    tokenTtlSeconds?: number;
    authTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    credentialRenewalIntervalMs?: number;
  } = {},
) {
  const context = makeRunnerContext(options);
  const app = Fastify();
  await app.register(websocket, { options: { maxPayload: RUNNER_WS_MAX_FRAME_BYTES } });
  registerRunnerWebSocketRoute(app, {
    tokens: context.tokens,
    hub: context.hub,
    service: context.service,
    ...(options.authTimeoutMs !== undefined ? { authTimeoutMs: options.authTimeoutMs } : {}),
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 45_000,
    ...(options.credentialRenewalIntervalMs !== undefined
      ? { credentialRenewalIntervalMs: options.credentialRenewalIntervalMs }
      : {}),
  });
  bareApps.push(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, address, ...context };
}

const authorization = { authorization: "Bearer access" };

interface RunnerClient {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForNth(type: string, count: number, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function connectRunner(address: string, query = ""): Promise<RunnerClient> {
  const url = `${address.replace("http", "ws")}${HTTP_PATHS.sandboxRunnerWebSocket}${query}`;
  const socket = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  const waiters: { type: string; count: number; resolve: (frame: Record<string, unknown>) => void }[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const notify = () => {
    for (const waiter of [...waiters]) {
      const matches = frames.filter((frame) => frame.type === waiter.type);
      if (matches.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(matches[waiter.count - 1] as Record<string, unknown>);
      }
    }
  };
  socket.on("message", (raw) => {
    frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
    notify();
  });
  return new Promise((resolve, reject) => {
    socket.on("open", () =>
      resolve({
        socket,
        frames,
        closed,
        send: (frame) => socket.send(JSON.stringify(frame)),
        waitFor: (type, timeoutMs = 5_000) =>
          new Promise<Record<string, unknown>>((settle, fail) => {
            const existing = frames.find((frame) => frame.type === type);
            if (existing) return settle(existing);
            const timer = setTimeout(() => fail(new Error(`timed out waiting for ${type}`)), timeoutMs);
            waiters.push({
              type,
              count: 1,
              resolve: (frame) => {
                clearTimeout(timer);
                settle(frame);
              },
            });
          }),
        waitForNth: (type, count, timeoutMs = 5_000) =>
          new Promise<Record<string, unknown>>((settle, fail) => {
            const existing = frames.filter((frame) => frame.type === type);
            if (existing.length >= count) return settle(existing[count - 1] as Record<string, unknown>);
            const timer = setTimeout(() => fail(new Error(`timed out waiting for ${type} #${count}`)), timeoutMs);
            waiters.push({
              type,
              count,
              resolve: (frame) => {
                clearTimeout(timer);
                settle(frame);
              },
            });
          }),
      }),
    );
    socket.on("error", reject);
  });
}

async function startedSandbox(accountId: string) {
  const sandbox = await ownedSandbox(accountId);
  const ctx = await createRunnerApp(accountId);
  await ctx.service.startForAccount(accountId, sandbox.sandboxId);
  const [row] = await unit.database.query.sandboxes.findMany({
    where: (table, { eq }) => eq(table.id, sandbox.sandboxId),
    limit: 1,
  });
  const claims = {
    sandboxId: sandbox.sandboxId,
    sessionId: sandbox.sessionId,
    environmentGeneration: 1,
    resourceName: row?.currentResourceName as string,
  };
  const token = await ctx.tokens.issue(claims);
  return { ...ctx, sandbox, claims, token };
}

async function authenticatedRunner(address: string, token: string) {
  const client = await connectRunner(address);
  client.send({ type: "auth", requestId: randomUUID(), token });
  const authResult = await client.waitFor("auth:result");
  return { client, authResult };
}

const READY_READINESS = {
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: RUNNER_VERSION,
} as const;

/** A runner:ready frame whose native sandbox name matches the allocated Instance resource. */
function readyFrame(resourceName: string, readinessOverrides: Record<string, unknown> = {}) {
  return {
    type: "runner:ready",
    readiness: {
      sandboxName: resourceName.split("/").at(-1) as string,
      ...READY_READINESS,
      ...readinessOverrides,
    },
  };
}

async function waitForLifecycle(
  service: SandboxRunnerService,
  accountId: string,
  sandboxId: string,
  lifecycle: string,
): Promise<void> {
  await vi.waitFor(async () => {
    expect((await service.statusForAccount(accountId, sandboxId)).lifecycle).toBe(lifecycle);
  });
}

describe("runner control channel authentication", () => {
  it("authenticates first-frame, welcomes with scope, and flips ready only after native readiness", async () => {
    const accountId = await account();
    const { address, token, sandbox, service, claims } = await startedSandbox(accountId);
    const { client, authResult } = await authenticatedRunner(address, token);
    expect(authResult.ok).toBe(true);
    const welcome = await client.waitFor("server:welcome");
    expect(welcome).toMatchObject({
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
    });
    expect(String(welcome.resourceName)).toContain(`/locations/${FAKE_REGION}/instances/`);
    // Not ready before the native readiness report.
    expect((await service.statusForAccount(accountId, sandbox.sandboxId)).lifecycle).toBe("preparing");
    client.send(readyFrame(claims.resourceName));
    await waitForLifecycle(service, accountId, sandbox.sandboxId, "ready");
    const ready = await service.statusForAccount(accountId, sandbox.sandboxId);
    expect(ready.runnerReady).toBe(true);
    expect(ready.runnerReadiness?.rootfs).toBe("/opt/sandbox-root");
    expect(ready.runnerReadiness?.runnerVersion).toBe(RUNNER_VERSION);
    client.socket.close();
    await client.closed;
  });

  it("acknowledges a client heartbeat with a server heartbeat frame", async () => {
    const accountId = await account();
    const { address, token } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    client.send({ type: "heartbeat", requestId: randomUUID() });
    const ack = await client.waitFor("server:heartbeat");
    expect(ack.type).toBe("server:heartbeat");
    client.socket.close();
    await client.closed;
  });

  it("sends a fresh scoped credential on welcome", async () => {
    const accountId = await account();
    const { address, token, tokens, claims } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    const credential = await client.waitFor("server:credential");
    const verified = await tokens.verify(String(credential.token));
    expect(verified).toEqual(claims);
    client.socket.close();
    await client.closed;
  });

  it("rejects a token supplied in a query URL", async () => {
    const accountId = await account();
    const { address, token } = await startedSandbox(accountId);
    const client = await connectRunner(address, `?token=${encodeURIComponent(token)}`);
    const closed = await client.closed;
    expect(closed.code).toBe(RUNNER_WS_CLOSE.authFailed);
    expect(client.frames.filter((frame) => frame.type === "auth:result")).toHaveLength(0);
  });

  it("serializes parallel auth frames: the second is a duplicate and closes the socket", async () => {
    const accountId = await account();
    const { address, token } = await startedSandbox(accountId);
    const client = await connectRunner(address);
    client.send({ type: "auth", requestId: "one", token });
    client.send({ type: "auth", requestId: "two", token });
    await client.waitFor("server:welcome");
    const closed = await client.closed;
    expect(closed.code).toBe(RUNNER_WS_CLOSE.protocolError);
    expect(client.frames.filter((frame) => frame.type === "auth:result")).toHaveLength(1);
  });

  it("rejects an expired bootstrap token", async () => {
    const accountId = await account();
    const { address, claims } = await startedSandbox(accountId);
    const expired = new RunnerBootstrapTokenService(JWT_SECRET, {
      ttlSeconds: 600,
      now: () => new Date(Date.now() - 3_600_000),
    });
    const staleToken = await expired.issue(claims);
    const { client, authResult } = await authenticatedRunner(address, staleToken);
    expect(authResult.ok).toBe(false);
    const { code } = await client.closed;
    expect(code).toBe(RUNNER_WS_CLOSE.authFailed);
  });

  it("rejects a token whose generation no longer matches the current allocation", async () => {
    const accountId = await account();
    const { address, token, sandbox, service } = await startedSandbox(accountId);
    // Stop + start moves to generation 2; the generation-1 token is now useless.
    await service.stopForAccount(accountId, sandbox.sandboxId);
    await service.startForAccount(accountId, sandbox.sandboxId);
    const { client, authResult } = await authenticatedRunner(address, token);
    expect(authResult.ok).toBe(false);
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.authFailed);
  });

  it("rejects a token minted for a different sandbox (cross-session isolation)", async () => {
    const accountId = await account();
    const other = await ownedSandbox(accountId);
    const { address, tokens, service } = await startedSandbox(accountId);
    await service.startForAccount(accountId, other.sandboxId);
    const foreign = await tokens.issue({
      sandboxId: other.sandboxId,
      sessionId: other.sessionId,
      environmentGeneration: 1,
      resourceName: `projects/unit-project/locations/${FAKE_REGION}/instances/foreign`,
    });
    const { client, authResult } = await authenticatedRunner(address, foreign);
    expect(authResult.ok).toBe(false);
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.authFailed);
  });

  it("closes a connection whose first frame is not auth", async () => {
    const accountId = await account();
    const { address } = await startedSandbox(accountId);
    const client = await connectRunner(address);
    client.send({ type: "heartbeat" });
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.authFailed);
  });

  it("rejects a readiness frame whose Runner version is not the configured one", async () => {
    const accountId = await account();
    const { address, token, sandbox, service, claims } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    client.send(readyFrame(claims.resourceName, { runnerVersion: "9.9.9" }));
    const error = await client.waitFor("error");
    expect(error.code).toBe("RUNNER_VERSION_MISMATCH");
    const status = await service.statusForAccount(accountId, sandbox.sandboxId);
    expect(status.lifecycle).toBe("preparing");
    expect(status.runnerReady).toBe(false);
    client.socket.close();
    await client.closed;
  });

  it("fails closed when the allocation is released while the Runner is connected", async () => {
    const accountId = await account();
    const { address, token, sandbox, service } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    await service.stopForAccount(accountId, sandbox.sandboxId);
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.staleScope);
  });

  it("rejects a live duplicate same-scope connection and reconnects after cleanup, without disturbing another session", async () => {
    const accountId = await account();
    const first = await startedSandbox(accountId);
    const secondSandbox = await ownedSandbox(accountId);
    await first.service.startForAccount(accountId, secondSandbox.sandboxId);
    const secondClaims = {
      sandboxId: secondSandbox.sandboxId,
      sessionId: secondSandbox.sessionId,
      environmentGeneration: 1,
      resourceName: (await first.service.statusForAccount(accountId, secondSandbox.sandboxId))
        .currentResourceName as string,
    };
    const secondToken = await first.tokens.issue(secondClaims);

    const one = await authenticatedRunner(first.address, first.token);
    const other = await authenticatedRunner(first.address, secondToken);
    expect(one.authResult.ok).toBe(true);
    expect(other.authResult.ok).toBe(true);

    // A second connection for the same scope while the live one is current is rejected as a
    // duplicate: no last-wins takeover, the heartbeating Runner keeps its channel, and the
    // other Session's Runner is untouched.
    const duplicate = await connectRunner(first.address);
    duplicate.send({ type: "auth", requestId: randomUUID(), token: first.token });
    expect((await duplicate.closed).code).toBe(RUNNER_WS_CLOSE.duplicate);
    expect(
      duplicate.frames.some((frame) => frame.type === "error" && frame.code === "RUNNER_DUPLICATE_CONNECTION"),
    ).toBe(true);
    expect(one.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(other.client.socket.readyState).toBe(WebSocket.OPEN);
    one.client.send({ type: "heartbeat", requestId: randomUUID() });
    await one.client.waitFor("server:heartbeat");
    expect(first.hub.describe(first.sandbox.sandboxId).connected).toBe(true);

    // Once the dead connection is cleaned up, a legitimate reconnect of the same scope lands.
    one.client.socket.close();
    await one.client.closed;
    await vi.waitFor(() => {
      expect(first.hub.describe(first.sandbox.sandboxId).connected).toBe(false);
    });
    const reconnected = await authenticatedRunner(first.address, first.token);
    expect(reconnected.authResult.ok).toBe(true);
    expect(other.client.socket.readyState).toBe(WebSocket.OPEN);
    // The replacement can report readiness; the other Session's Runner stays untouched.
    reconnected.client.send(readyFrame(first.claims.resourceName));
    await waitForLifecycle(first.service, accountId, first.sandbox.sandboxId, "ready");
    reconnected.client.socket.close();
    other.client.socket.close();
  });

  it("never evicts the live Runner when a same-scope socket closes before its attach completes", async () => {
    const accountId = await account();
    const ctx = await startedSandbox(accountId);
    const live = await authenticatedRunner(ctx.address, ctx.token);
    expect(live.authResult.ok).toBe(true);
    // The ghost authenticates with a valid token but its socket is gone before the asynchronous
    // verification settles; the attach path must leave the healthy connection alone.
    const ghost = await connectRunner(ctx.address);
    ghost.send({ type: "auth", requestId: "ghost", token: ctx.token });
    ghost.socket.close();
    await ghost.closed;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(live.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(ctx.hub.describe(ctx.sandbox.sandboxId).connected).toBe(true);
    live.client.send({ type: "heartbeat", requestId: randomUUID() });
    await live.client.waitFor("server:heartbeat");
    live.client.socket.close();
    await live.client.closed;
  });
});

describe("runner readiness gating", () => {
  it("rejects readiness whose native sandbox does not match the allocated Instance", async () => {
    const accountId = await account();
    const { address, token, sandbox, service, claims } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    client.send(readyFrame(claims.resourceName, { sandboxName: "ots-not-the-allocated-instance" }));
    const error = await client.waitFor("error");
    expect(error.code).toBe("RUNNER_READINESS_MISMATCH");
    const mismatched = await service.statusForAccount(accountId, sandbox.sandboxId);
    expect(mismatched.lifecycle).toBe("preparing");
    expect(mismatched.runnerReady).toBe(false);
    // The connection stays authenticated and unpoisoned: the corrected report becomes ready.
    client.send(readyFrame(claims.resourceName));
    await waitForLifecycle(service, accountId, sandbox.sandboxId, "ready");
    client.socket.close();
    await client.closed;
  });

  it("never marks the hub ready from a wrong-version report, even on an already-ready row", async () => {
    const accountId = await account();
    const ctx = await startedSandbox(accountId);
    const first = await authenticatedRunner(ctx.address, ctx.token);
    first.client.send(readyFrame(ctx.claims.resourceName));
    await waitForLifecycle(ctx.service, accountId, ctx.sandbox.sandboxId, "ready");
    // A bad report on the good connection is rejected without touching the stored readiness.
    first.client.send(readyFrame(ctx.claims.resourceName, { runnerVersion: "9.9.9" }));
    expect((await first.client.waitFor("error")).code).toBe("RUNNER_VERSION_MISMATCH");
    let status = await ctx.service.statusForAccount(accountId, ctx.sandbox.sandboxId);
    expect(status.runnerReady).toBe(true);
    expect(status.runnerReadiness?.runnerVersion).toBe(RUNNER_VERSION);
    // The review scenario: a fresh connection on the ready row reports the wrong version. The
    // hub must not flip ready before the version verdict, so acceptance stays 409.
    first.client.socket.close();
    await first.client.closed;
    await vi.waitFor(() => {
      expect(ctx.hub.describe(ctx.sandbox.sandboxId).connected).toBe(false);
    });
    const second = await authenticatedRunner(ctx.address, ctx.token);
    second.client.send(readyFrame(ctx.claims.resourceName, { runnerVersion: "9.9.9" }));
    expect((await second.client.waitFor("error")).code).toBe("RUNNER_VERSION_MISMATCH");
    status = await ctx.service.statusForAccount(accountId, ctx.sandbox.sandboxId);
    expect(status.runnerReady).toBe(false);
    const acceptance = await ctx.app.inject({
      method: "POST",
      url: accountSandboxRunnerAcceptancePath(ctx.sandbox.sandboxId),
      headers: { ...authorization, "content-type": "application/json" },
      payload: { mode: "offline" },
    });
    expect(acceptance.statusCode).toBe(409);
    second.client.socket.close();
    await second.client.closed;
  });
});

describe("runner control channel liveness and credential renewal", () => {
  it("keeps a healthy idle connection open across more than two heartbeat periods and stays responsive", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const ctx = await createBareRunnerApp(accountId, {
      heartbeatIntervalMs: 80,
      heartbeatTimeoutMs: 30_000,
      credentialRenewalIntervalMs: 60_000,
    });
    await ctx.service.startForAccount(accountId, sandbox.sandboxId);
    const status = await ctx.service.statusForAccount(accountId, sandbox.sandboxId);
    const token = await ctx.tokens.issue({
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    });
    const { client } = await authenticatedRunner(ctx.address, token);
    // The client stays quiet; the Server must keep acknowledging so the Runner's silence timer
    // (which the client side resets on any server frame) never expires.
    await client.waitForNth("server:heartbeat", 3, 3_000);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    // The connection is still live and still answers a client heartbeat after several windows.
    client.send({ type: "heartbeat", requestId: randomUUID() });
    await client.waitForNth("server:heartbeat", 4, 3_000);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.close();
    await client.closed;
  });

  it("closes a connection whose authentication deadline expires and leaves no hub entry", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const ctx = await createBareRunnerApp(accountId, { authTimeoutMs: 120 });
    const client = await connectRunner(ctx.address);
    const closed = await client.closed;
    expect(closed.code).toBe(RUNNER_WS_CLOSE.authFailed);
    expect(client.frames.some((frame) => frame.type === "error" && frame.code === "RUNNER_AUTH_TIMEOUT")).toBe(true);
    expect(ctx.hub.describe(sandbox.sandboxId).connected).toBe(false);
  });

  it("does not leave a ghost hub entry when the socket closes during authentication", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const ctx = await createBareRunnerApp(accountId);
    await ctx.service.startForAccount(accountId, sandbox.sandboxId);
    const status = await ctx.service.statusForAccount(accountId, sandbox.sandboxId);
    const token = await ctx.tokens.issue({
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    });
    const client = await connectRunner(ctx.address);
    client.send({ type: "auth", requestId: "one", token });
    client.socket.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ctx.hub.describe(sandbox.sandboxId).connected).toBe(false);
  });

  it("closes the connection with staleScope when credential renewal finds the scope revoked", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const ctx = await createBareRunnerApp(accountId, {
      heartbeatIntervalMs: 15_000,
      credentialRenewalIntervalMs: 120,
    });
    await ctx.service.startForAccount(accountId, sandbox.sandboxId);
    const status = await ctx.service.statusForAccount(accountId, sandbox.sandboxId);
    const token = await ctx.tokens.issue({
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    });
    const { client } = await authenticatedRunner(ctx.address, token);
    await client.waitFor("server:credential");
    // A definitive revocation (the row no longer validates for this scope) must take effect on
    // the live socket at the next renewal instead of silently staying active.
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.staleScope);
    expect(ctx.hub.describe(sandbox.sandboxId).connected).toBe(false);
  });

  it("renews scoped credentials on a cadence while the connection stays current", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const ctx = await createBareRunnerApp(accountId, {
      heartbeatIntervalMs: 15_000,
      credentialRenewalIntervalMs: 150,
    });
    await ctx.service.startForAccount(accountId, sandbox.sandboxId);
    const status = await ctx.service.statusForAccount(accountId, sandbox.sandboxId);
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: status.currentResourceName as string,
    };
    const token = await ctx.tokens.issue(claims);
    const { client } = await authenticatedRunner(ctx.address, token);
    const renewed = await client.waitForNth("server:credential", 2, 3_000);
    expect(await ctx.tokens.verify(String(renewed.token))).toEqual(claims);
    client.socket.close();
    await client.closed;
  });
});

describe("account runner HTTP endpoints", () => {
  it("start/status/stop flow with strict schemas and current ownership", async () => {
    const accountId = await account();
    const { app, sandbox, fake } = await startedSandbox(accountId);
    const status = await app.inject({
      method: "GET",
      url: accountSandboxRunnerPath(sandbox.sandboxId),
      headers: authorization,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.lifecycle).toBe("preparing");
    expect(body.runnerConnected).toBe(false);
    expect(body.runnerReady).toBe(false);

    const stop = await app.inject({
      method: "POST",
      url: accountSandboxRunnerStopPath(sandbox.sandboxId),
      headers: { ...authorization, "content-type": "application/json" },
      payload: {},
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().lifecycle).toBe("unallocated");
    expect(fake.liveInstanceCount()).toBe(0);

    const restart = await app.inject({
      method: "POST",
      url: accountSandboxRunnerStartPath(sandbox.sandboxId),
      headers: { ...authorization, "content-type": "application/json" },
      payload: {},
    });
    expect(restart.statusCode).toBe(200);
    expect(restart.json().environmentGeneration).toBe(2);
    expect(fake.liveInstanceCount()).toBe(1);
  });

  it("answers 404 for a foreign sandbox id", async () => {
    const accountId = await account();
    const { app } = await startedSandbox(accountId);
    const foreign = randomUUID();
    for (const [method, url] of [
      ["GET", accountSandboxRunnerPath(foreign)],
      ["POST", accountSandboxRunnerStartPath(foreign)],
      ["POST", accountSandboxRunnerStopPath(foreign)],
      ["POST", accountSandboxRunnerAcceptancePath(foreign)],
    ] as const) {
      const payload = method !== "POST" ? undefined : url.endsWith("/acceptance") ? { mode: "offline" } : {};
      const response = await app.inject({
        method,
        url,
        headers: { ...authorization, "content-type": "application/json" },
        payload,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("acceptance over HTTP correlates to the runner frame and never echoes piConfig", async () => {
    const accountId = await account();
    const { app, address, token, sandbox, service, claims } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    client.send(readyFrame(claims.resourceName));
    await waitForLifecycle(service, accountId, sandbox.sandboxId, "ready");

    const acceptancePromise = app.inject({
      method: "POST",
      url: accountSandboxRunnerAcceptancePath(sandbox.sandboxId),
      headers: { ...authorization, "content-type": "application/json" },
      payload: { mode: "real", piConfig: { authJson: '{"deepseek":{"token":"unit-secret-value"}}' } },
    });
    const runFrame = (await client.waitFor("acceptance:run")) as {
      requestId: string;
      mode: string;
      deadlineAtMs: number;
      piConfig?: { authJson: string };
    };
    expect(runFrame.mode).toBe("real");
    expect(runFrame.piConfig?.authJson).toContain("unit-secret-value");
    expect(runFrame.deadlineAtMs).toBeGreaterThan(Date.now());
    client.send({
      type: "acceptance:result",
      requestId: runFrame.requestId,
      outcome: "passed",
      report: { events: [{ name: "probe:node", status: "passed" }], failed: false, model: "passed", offline: "passed" },
    });
    const response = await acceptancePromise;
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requestId).toBe(runFrame.requestId);
    expect(body.outcome).toBe("passed");
    expect(body.report.offline).toBe("passed");
    expect(JSON.stringify(body)).not.toContain("unit-secret-value");
    client.socket.close();
    await client.closed;
  });

  it("rejects an acceptance payload that exceeds document or aggregate byte budgets with HTTP 400", async () => {
    const accountId = await account();
    const { app, address, token, sandbox, service, claims } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    client.send(readyFrame(claims.resourceName));
    await waitForLifecycle(service, accountId, sandbox.sandboxId, "ready");

    // Valid JSON: 11,012 characters but 33,012 UTF-8 bytes for the first; the second passes each
    // document bound but doubles under JSON escaping beyond the serialized worker-stdin budget.
    const nonAscii = JSON.stringify({ token: "密钥".repeat(5_500) });
    const escapeHeavy = JSON.stringify("\\".repeat(16_000));
    for (const piConfig of [
      { authJson: nonAscii },
      { authJson: escapeHeavy, modelsJson: escapeHeavy, settingsJson: escapeHeavy },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: accountSandboxRunnerAcceptancePath(sandbox.sandboxId),
        headers: { ...authorization, "content-type": "application/json" },
        payload: { mode: "real", piConfig },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(client.frames.some((frame) => frame.type === "acceptance:run")).toBe(false);
    client.socket.close();
    await client.closed;
  });

  it("acceptance conflicts when no ready runner is attached", async () => {
    const accountId = await account();
    const { app, sandbox } = await startedSandbox(accountId);
    const response = await app.inject({
      method: "POST",
      url: accountSandboxRunnerAcceptancePath(sandbox.sandboxId),
      headers: { ...authorization, "content-type": "application/json" },
      payload: { mode: "offline" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SANDBOX_RUNNER_CONFLICT");
  });

  it("a normal HTTP POST does not self-cancel the acceptance run", async () => {
    const accountId = await account();
    const { address, token, sandbox, service, claims } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    client.send(readyFrame(claims.resourceName));
    await waitForLifecycle(service, accountId, sandbox.sandboxId, "ready");
    const responsePromise = fetch(`${address}${accountSandboxRunnerAcceptancePath(sandbox.sandboxId)}`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ mode: "offline" }),
    });
    const runFrame = (await client.waitFor("acceptance:run")) as { requestId: string };
    client.send({ type: "acceptance:result", requestId: runFrame.requestId, outcome: "passed" });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { outcome: string }).outcome).toBe("passed");
    expect(client.frames.some((frame) => frame.type === "acceptance:cancel")).toBe(false);
    client.socket.close();
    await client.closed;
  });

  it("a real client disconnect cancels the run on the Runner", async () => {
    const accountId = await account();
    const { address, token, sandbox, service, claims } = await startedSandbox(accountId);
    const { client } = await authenticatedRunner(address, token);
    client.send(readyFrame(claims.resourceName));
    await waitForLifecycle(service, accountId, sandbox.sandboxId, "ready");
    const controller = new AbortController();
    const responsePromise = fetch(`${address}${accountSandboxRunnerAcceptancePath(sandbox.sandboxId)}`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ mode: "offline" }),
      signal: controller.signal,
    });
    const runFrame = (await client.waitFor("acceptance:run")) as { requestId: string };
    controller.abort();
    await expect(responsePromise).rejects.toMatchObject({ name: "AbortError" });
    const cancel = (await client.waitFor("acceptance:cancel")) as { requestId: string };
    expect(cancel.requestId).toBe(runFrame.requestId);
    client.socket.close();
    await client.closed;
  });
});
