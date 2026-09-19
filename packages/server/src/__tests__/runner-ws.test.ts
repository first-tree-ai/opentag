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
  computeDirectInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  HTTP_PATHS,
  RUNNER_WS_CLOSE,
  RUNNER_WS_MAX_FRAME_BYTES,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { registerRunnerWebSocketRoute } from "../api/runner-ws.js";
import { createApp } from "../app.js";
import {
  imBindings,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ComputerService } from "../services/computers/index.js";
import { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import { CloudModelGrantService } from "../services/sandboxes/cloud-model-grants.js";
import { CloudRuntimeFence } from "../services/sandboxes/cloud-runtime-fence.js";
import { SandboxService } from "../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../services/sandboxes/runner-bootstrap-token.js";
import { RunnerHub } from "../services/sandboxes/runner-hub.js";
import { SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";
import { SessionService } from "../services/sessions/index.js";
import { FAKE_REGION, FakeCloudRunAdmin } from "./support/fake-cloud-run-admin.js";
import { FakeWorkspaceObjectStore } from "./support/fake-workspace-store.js";
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
const E4_MODEL = "deepseek-v4.1-flash-expires-on-0910";

/** Minimal valid E4 delivery request for the runner-channel flow test. */
function e4DeliveryRequest(input: {
  deliveryId: string;
  messageId: string;
  sessionId: string;
  placementGeneration: number;
  agentId: string;
}): DirectImMessageDeliveryRequest {
  const agentId = input.agentId;
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: input.deliveryId,
    imMessageId: input.messageId,
    sessionId: input.sessionId,
    agentId,
    placementGeneration: input.placementGeneration,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello e4",
      providerRef: {
        provider: "feishu",
        teamBrand: "feishu",
        appId: "app",
        botOpenId: "bot",
        chatId: "unit-channel",
        messageId: "msg-1",
      },
    },
    runtime: {
      agentId,
      contextTreeRepository: null,
      instructions: { agent: "Agent.", platform: "Platform." },
      provider: "pi",
      model: E4_MODEL,
      revision: {
        agent: { id: randomUUID(), sequence: 1 },
        session: { id: randomUUID(), sequence: 1 },
      },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: randomUUID(), mode: "empty_on_create", sharing: "agent" },
    },
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function e4TurnReport(
  request: DirectImMessageDeliveryRequest,
  turnId: string,
  outcome: "completed" | "cancelled" = "completed",
): TurnReportRequest {
  const base = {
    type: "turn:report" as const,
    requestId: randomUUID(),
    deliveryId: request.deliveryId,
    turnId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
    outcome,
    executionEffects: outcome === "completed" ? ("completed" as const) : ("not_started" as const),
    ...(outcome === "completed" ? { finalText: "done" } : { errorReason: "client_shutdown" as const }),
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
  };
  return { ...base, resultHash: computeTurnResultHash(base) };
}
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

async function ownedSandbox(accountId: string, channel = "unit-channel") {
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
    { imBindingId: bindingId, channelId: channel, conversationKind: "channel", kind: "channel" },
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
  store?: FakeWorkspaceObjectStore;
}

function makeRunnerContext(options: { tokenTtlSeconds?: number; workspace?: boolean } = {}): RunnerContext {
  const fake = new FakeCloudRunAdmin();
  const tokens = new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: options.tokenTtlSeconds ?? 600 });
  const hub = new RunnerHub();
  const store = options.workspace ? new FakeWorkspaceObjectStore() : undefined;
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
    ...(store ? { workspace: { store } } : {}),
  });
  return { fake, tokens, hub, service, ...(store ? { store } : {}) };
}

async function createRunnerApp(accountId: string, options: { tokenTtlSeconds?: number; workspace?: boolean } = {}) {
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

/** E4-negotiated auth: the connection opts into Cloud delivery frames explicitly. */
async function authenticatedCloudRunner(address: string, token: string) {
  const client = await connectRunner(address);
  client.send({ type: "auth", requestId: randomUUID(), token, cloudDeliveryVersion: 1 });
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
    // A definitive revocation (the persisted allocation is gone) must take effect on the live
    // socket at the next renewal instead of silently staying active.
    await unit.database.update(sandboxes).set({ lifecycle: "unallocated" }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.staleScope);
    expect(ctx.hub.describe(sandbox.sandboxId).connected).toBe(false);
  });

  it("closes an E3 connection with staleScope when the Session ends while the allocation is current", async () => {
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
    // The Session ends while the persisted allocation is still current. A connection that never
    // negotiated E4 has no report-capable fallback: the next renewal revokes the live socket
    // instead of keeping it credentialed on the channel-only check.
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sandbox.sessionId));
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.staleScope);
    expect(ctx.hub.describe(sandbox.sandboxId).connected).toBe(false);
  });

  it("closes an E3 connection with staleScope when the environment starts releasing", async () => {
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
    // A releasing environment keeps the exact allocation identity, but the active authority chain
    // is gone; without E4 negotiation that is a revocation on the live socket.
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, sandbox.sandboxId));
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.staleScope);
    expect(ctx.hub.describe(sandbox.sandboxId).connected).toBe(false);
  });

  it("closes an E3 connection with staleScope when an acceptance result arrives after the Session ended", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const ctx = await createBareRunnerApp(accountId, {
      heartbeatIntervalMs: 15_000,
      // Keep the renewal timer out of the way so the result frame is the trigger under test.
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
    await client.waitFor("server:credential");
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sandbox.sessionId));
    client.send({ type: "acceptance:result", requestId: randomUUID(), outcome: "passed" });
    const outcome = await Promise.race([
      client.closed.then((closed) => closed.code),
      new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 2_000)),
    ]);
    expect(outcome).toBe(RUNNER_WS_CLOSE.staleScope);
  });

  it("keeps an E3 connection open when a renewal hits a transient validation error", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const ctx = await createBareRunnerApp(accountId, {
      heartbeatIntervalMs: 15_000,
      credentialRenewalIntervalMs: 120,
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
    await client.waitFor("server:credential");
    // A transient database error is not a revocation: the socket survives and the next renewal
    // tick recovers.
    const spy = vi
      .spyOn(ctx.service, "validateRunnerScope")
      .mockRejectedValueOnce(new Error("unit transient database error"));
    const renewed = await client.waitForNth("server:credential", 2, 3_000);
    expect(spy).toHaveBeenCalled();
    expect(await ctx.tokens.verify(String(renewed.token))).toEqual(claims);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.close();
    await client.closed;
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

describe("E4 Cloud IM delivery over the runner channel", () => {
  async function cloudDeliveryStack(
    _accountId: string,
    options: { credentialRenewalIntervalMs?: number; heartbeatIntervalMs?: number } = {},
  ) {
    const context = makeRunnerContext();
    const fence = new CloudRuntimeFence();
    const grants = new CloudModelGrantService(JWT_SECRET, {
      allowedModels: [E4_MODEL],
      maxStreamsPerToken: 2,
      ttlSeconds: 600,
    });
    const owner = new CloudDeliveryOwner({
      custody: new PostgresRuntimeCustodyStore(unit.database),
      database: unit.database,
      fence,
      hub: context.hub,
      modelBaseUrl: "https://unit.example/api/v1/cloud-model",
      modelGrants: grants,
    });
    const app = Fastify();
    await app.register(websocket, { options: { maxPayload: RUNNER_WS_MAX_FRAME_BYTES } });
    registerRunnerWebSocketRoute(app, {
      tokens: context.tokens,
      hub: context.hub,
      service: context.service,
      cloudDelivery: owner,
      ...(options.credentialRenewalIntervalMs !== undefined
        ? { credentialRenewalIntervalMs: options.credentialRenewalIntervalMs }
        : {}),
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
    });
    bareApps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    return { ...context, address, owner, fence, grants };
  }

  async function pendingDelivery(sessionId: string, placementGeneration: number) {
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    const [binding] = await unit.database.select().from(imBindings).limit(1);
    if (!binding) throw new Error("fixture binding missing");
    await unit.database.insert(imMessages).values({
      id: messageId,
      imBindingId: binding.id,
      channelId: "unit-channel",
      externalMessageId: `ext-${messageId.slice(0, 8)}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "unit-user",
      content: { version: 1, fallbackText: "hello e4", blocks: [], truncated: false },
      providerContext: { provider: "feishu" },
      occurredAt: new Date(),
    });
    await unit.database.insert(imMessageDeliveries).values({
      id: deliveryId,
      messageId,
      sessionId,
      attention: "direct",
      state: "pending",
      placementGeneration,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { deliveryId, messageId };
  }

  it("keeps the exact legacy E3 welcome shape and rejects E4 frames without negotiation", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId);
    await stack.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    const token = await stack.tokens.issue(claims);
    const { client } = await authenticatedRunner(stack.address, token);
    const welcome = await client.waitFor("server:welcome");
    expect(welcome.cloudDeliveryVersion).toBeUndefined();
    expect(welcome.resourceUid).toBeUndefined();
    // An unnegotiated channel never receives E4 frames; sending one is a protocol error.
    client.send({
      type: "delivery:received",
      requestId: randomUUID(),
      deliveryId: randomUUID(),
      turnId: randomUUID(),
    });
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.protocolError);
  });

  it("never lets a server heartbeat reach an E4 Runner ahead of its auth:result", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId, { heartbeatIntervalMs: 30 });
    await stack.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    const token = await stack.tokens.issue(claims);
    // Hold the asynchronous fence-authority read while the cadenced heartbeat sweep keeps firing:
    // a socket visible to the hub before its auth:result would receive a heartbeat pre-auth.
    let enterAuthority!: () => void;
    const authorityEntered = new Promise<void>((resolve) => {
      enterAuthority = resolve;
    });
    let releaseAuthority!: () => void;
    const authorityGate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const original = stack.service.describeScopeAuthority.bind(stack.service);
    const authoritySpy = vi
      .spyOn(stack.service, "describeScopeAuthority")
      .mockImplementation(async (scope: Parameters<typeof original>[0]) => {
        enterAuthority();
        await authorityGate;
        return original(scope);
      });
    const heartbeatSpy = vi.spyOn(stack.hub, "heartbeatAll");
    const client = await connectRunner(stack.address);
    client.send({ type: "auth", requestId: randomUUID(), token, cloudDeliveryVersion: 1 });
    await authorityEntered;
    // The sweep really fires while the fence attach is gated, so the ordering barrier is the only
    // thing keeping the pre-auth socket silent.
    await vi.waitFor(() => expect(heartbeatSpy.mock.calls.length).toBeGreaterThanOrEqual(2), {
      interval: 10,
      timeout: 2_000,
    });
    expect(client.frames).toHaveLength(0);
    releaseAuthority();
    const authResult = await client.waitFor("auth:result");
    expect(authResult.ok).toBe(true);
    expect(client.frames[0]?.type).toBe("auth:result");
    expect(client.frames.some((frame) => frame.type === "server:heartbeat")).toBe(false);
    client.socket.close();
    await client.closed;
    authoritySpy.mockRestore();
    heartbeatSpy.mockRestore();
  });

  it("keeps a negotiated E4 channel open when the channel-scope check hits a transient error", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId, { credentialRenewalIntervalMs: 120 });
    await stack.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    const token = await stack.tokens.issue(claims);
    const { client } = await authenticatedCloudRunner(stack.address, token);
    await client.waitFor("server:credential");
    // The active chain ends; the channel fallback keeps the connection alive for accepted work.
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sandbox.sessionId));
    // A transient database error on the fallback check is not a definitive miss: the socket must
    // survive and the next tick must renew against the persisted allocation identity.
    const spy = vi
      .spyOn(stack.service, "validateRunnerChannelScope")
      .mockRejectedValueOnce(new Error("unit transient database error"));
    const renewed = await client.waitForNth("server:credential", 2, 3_000);
    expect(spy).toHaveBeenCalled();
    expect(await stack.tokens.verify(String(renewed.token))).toEqual(claims);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.close();
    await client.closed;
  });

  it("binds a credential execution open to the exact connection scope", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId);
    await stack.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    const token = await stack.tokens.issue(claims);
    const { client } = await authenticatedCloudRunner(stack.address, token);
    const welcome = (await client.waitFor("server:welcome")) as { resourceUid?: string };
    const [placement] = await unit.database
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, sandbox.sessionId))
      .limit(1);
    if (!placement) throw new Error("fixture placement missing");
    const [binding] = await unit.database.select().from(imBindings).limit(1);
    if (!binding) throw new Error("fixture binding missing");
    const delegation = vi.spyOn(stack.owner, "handleCredentialFrame");
    const openFrame = (
      requestId: string,
      overrides: { sessionId?: string; sandboxId?: string; environmentGeneration?: number; omitSandbox?: boolean } = {},
    ) => ({
      type: "credential:frame",
      frame: {
        type: "runtime:execution:open",
        requestId,
        sessionId: overrides.sessionId ?? sandbox.sessionId,
        agentId: binding.agentId,
        placementGeneration: placement.generation,
        runId: randomUUID(),
        source: { kind: "session-message", messageId: randomUUID() },
        ...(overrides.omitSandbox
          ? {}
          : {
              sandbox: {
                sandboxId: overrides.sandboxId ?? sandbox.sandboxId,
                resourceUid: String(welcome.resourceUid),
                environmentGeneration: overrides.environmentGeneration ?? 1,
              },
            }),
      },
    });
    // The scope-matching open is delegated (this owner has no credential stack: it fails closed).
    client.send(openFrame(randomUUID()));
    const pass = (await client.waitFor("credential:frame")) as { frame: { status: string; code?: string } };
    expect(pass.frame).toMatchObject({ status: "rejected", code: "owner_unavailable" });
    expect(delegation).toHaveBeenCalledTimes(1);
    // Every deviation from the authenticated allocation is rejected by the channel itself and
    // never reaches the credential owner.
    const deviations = [
      { sessionId: randomUUID() },
      { sandboxId: randomUUID() },
      { environmentGeneration: 2 },
      { omitSandbox: true as const },
    ];
    for (const [index, overrides] of deviations.entries()) {
      delegation.mockClear();
      client.send(openFrame(randomUUID(), overrides));
      const denied = (await client.waitForNth("credential:frame", index + 2)) as {
        frame: { status: string; code?: string };
      };
      expect(denied.frame).toMatchObject({ status: "rejected", code: "sandbox_mismatch" });
      expect(delegation).not.toHaveBeenCalled();
    }
    client.socket.close();
    await client.closed;
  });

  it("fails a Cloud-capable attach transiently until the allocation UID is tracked", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId);
    await stack.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    // The create caller has not tracked the verified UID yet: no Cloud welcome may be published.
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "preparing", currentResourceUid: null })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    const token = await stack.tokens.issue(claims);
    const client = await connectRunner(stack.address);
    client.send({ type: "auth", requestId: randomUUID(), token, cloudDeliveryVersion: 1 });
    expect((await client.closed).code).toBe(1013);
    expect(client.frames.some((frame) => frame.type === "server:welcome")).toBe(false);
    expect(client.frames.some((frame) => frame.type === "auth:result")).toBe(false);
  });

  it.each([false, true])(
    "keeps a releasing live channel open to settle received custody (accepted=%s)",
    async (accepted) => {
      const accountId = await account();
      const sandbox = await ownedSandbox(accountId);
      const stack = await cloudDeliveryStack(accountId);
      await stack.service.startForAccount(accountId, sandbox.sandboxId);
      const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
      const claims = {
        sandboxId: sandbox.sandboxId,
        sessionId: sandbox.sessionId,
        environmentGeneration: 1,
        resourceName: row?.currentResourceName as string,
      };
      const token = await stack.tokens.issue(claims);
      const { client } = await authenticatedCloudRunner(stack.address, token);
      await client.waitFor("server:welcome");
      client.send(readyFrame(claims.resourceName));
      await waitForLifecycle(stack.service, accountId, sandbox.sandboxId, "ready");

      const [placement] = await unit.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, sandbox.sessionId))
        .limit(1);
      if (!placement) throw new Error("fixture placement missing");
      const { deliveryId, messageId } = await pendingDelivery(sandbox.sessionId, placement.generation);
      const [binding] = await unit.database.select().from(imBindings).limit(1);
      if (!binding) throw new Error("fixture binding missing");
      const request = e4DeliveryRequest({
        deliveryId,
        messageId,
        sessionId: sandbox.sessionId,
        placementGeneration: placement.generation,
        agentId: binding.agentId,
      });
      await stack.owner.dispatchDelivery({
        computerId: sandbox.computerId,
        inputHash: computeDirectInputHash(request),
        installationId: randomUUID(),
        request,
      });
      const run = (await client.waitFor("delivery:run")) as { requestId: string };
      const turnId = randomUUID();
      if (accepted) {
        client.send({ type: "delivery:received", requestId: run.requestId, deliveryId, turnId });
        await client.waitFor("delivery:verified");
      }
      await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, sandbox.sandboxId));
      client.send({ type: "delivery:received", requestId: run.requestId, deliveryId, turnId });
      if (accepted) {
        await client.waitFor("delivery:cancel");
        const report = e4TurnReport(request, turnId, "cancelled");
        client.send({ type: "delivery:report", requestId: randomUUID(), report });
        expect((await client.waitFor("delivery:report:ack")).status).toBe("recorded");
      } else {
        expect(await client.waitFor("delivery:verified")).toMatchObject({ status: "rejected", code: "scope_inactive" });
        const [pending] = await unit.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, deliveryId));
        expect(pending).toMatchObject({ state: "pending", turnId: null, reportedAt: null });
      }
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      expect(stack.hub.describe(sandbox.sandboxId).connected).toBe(true);
    },
  );

  it("records an accepted report after an explicit Session end and closes when the allocation is released", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId, { credentialRenewalIntervalMs: 150 });
    await stack.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    const token = await stack.tokens.issue(claims);
    const { client } = await authenticatedCloudRunner(stack.address, token);
    await client.waitFor("server:welcome");
    client.send(readyFrame(claims.resourceName));
    await waitForLifecycle(stack.service, accountId, sandbox.sandboxId, "ready");

    const [placement] = await unit.database
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, sandbox.sessionId))
      .limit(1);
    if (!placement) throw new Error("fixture placement missing");
    const { deliveryId, messageId } = await pendingDelivery(sandbox.sessionId, placement.generation);
    const [binding] = await unit.database.select().from(imBindings).limit(1);
    if (!binding) throw new Error("fixture binding missing");
    const request = e4DeliveryRequest({
      deliveryId,
      messageId,
      sessionId: sandbox.sessionId,
      placementGeneration: placement.generation,
      agentId: binding.agentId,
    });
    await stack.owner.dispatchDelivery({
      computerId: sandbox.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: randomUUID(),
      request,
    });
    const run = (await client.waitFor("delivery:run")) as { requestId: string };
    const turnId = randomUUID();
    client.send({ type: "delivery:received", requestId: run.requestId, deliveryId, turnId });
    await client.waitFor("delivery:verified");

    // The active authority chain is gone, but the accepted turn's report must still be recordable.
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sandbox.sessionId));
    client.send({ type: "delivery:report", requestId: randomUUID(), report: e4TurnReport(request, turnId) });
    const ack = (await client.waitFor("delivery:report:ack")) as { status: string };
    expect(ack.status).toBe("recorded");

    // A released allocation is a definitive miss: the channel is revoked at the next renewal.
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", currentResourceName: null })
      .where(eq(sandboxes.id, sandbox.sandboxId));
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.staleScope);
  });

  it.each(["completed", "cancelled"] as const)(
    "reconnects an ended-Session allocation in report-only mode and records its %s report",
    async (outcome) => {
      const accountId = await account();
      const sandbox = await ownedSandbox(accountId);
      const stack = await cloudDeliveryStack(accountId);
      await stack.service.startForAccount(accountId, sandbox.sandboxId);
      const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
      const claims = {
        sandboxId: sandbox.sandboxId,
        sessionId: sandbox.sessionId,
        environmentGeneration: 1,
        resourceName: row?.currentResourceName as string,
      };
      const token = await stack.tokens.issue(claims);
      const first = await authenticatedCloudRunner(stack.address, token);
      await first.client.waitFor("server:welcome");
      first.client.send(readyFrame(claims.resourceName));
      await waitForLifecycle(stack.service, accountId, sandbox.sandboxId, "ready");

      const [placement] = await unit.database
        .select()
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, sandbox.sessionId))
        .limit(1);
      if (!placement) throw new Error("fixture placement missing");
      const { deliveryId, messageId } = await pendingDelivery(sandbox.sessionId, placement.generation);
      const [binding] = await unit.database.select().from(imBindings).limit(1);
      if (!binding) throw new Error("fixture binding missing");
      const request = e4DeliveryRequest({
        deliveryId,
        messageId,
        sessionId: sandbox.sessionId,
        placementGeneration: placement.generation,
        agentId: binding.agentId,
      });
      await stack.owner.dispatchDelivery({
        computerId: sandbox.computerId,
        inputHash: computeDirectInputHash(request),
        installationId: randomUUID(),
        request,
      });
      const run = (await first.client.waitFor("delivery:run")) as { requestId: string };
      const turnId = randomUUID();
      first.client.send({ type: "delivery:received", requestId: run.requestId, deliveryId, turnId });
      await first.client.waitFor("delivery:verified");

      // Custody survives a disconnect, whether the Runner completed or only received the work.
      // A stopped reconnect must preserve the evidence until its true result is recorded.
      first.client.socket.close();
      await first.client.closed;
      await vi.waitFor(() => expect(stack.hub.describe(sandbox.sandboxId).connected).toBe(false));
      await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sandbox.sessionId));

      const { client } = await authenticatedCloudRunner(stack.address, token);
      await client.waitFor("server:welcome");

      // Accepted received evidence is cancelled, never rejected/cleared as if custody were absent.
      // Report-only still refuses readiness and any new execution permission.
      client.send(readyFrame(claims.resourceName));
      expect((await client.waitFor("error")).code).toBe("RUNNER_SCOPE_REPORT_ONLY");
      client.send({ type: "delivery:received", requestId: run.requestId, deliveryId, turnId });
      expect(await client.waitFor("delivery:cancel")).toMatchObject({ deliveryId });
      const freshRequestId = randomUUID();
      client.send({
        type: "delivery:received",
        requestId: freshRequestId,
        deliveryId: randomUUID(),
        turnId: randomUUID(),
      });
      const denied = (await client.waitFor("delivery:verified")) as { status: string; code?: string };
      expect(denied).toMatchObject({ requestId: freshRequestId, status: "rejected", code: "scope_inactive" });
      client.send({
        type: "credential:frame",
        frame: {
          type: "runtime:execution:open",
          requestId: randomUUID(),
          sessionId: sandbox.sessionId,
          agentId: binding.agentId,
          placementGeneration: placement.generation,
          runId: randomUUID(),
          source: { kind: "delivery", deliveryId, turnId },
          sandbox: {
            sandboxId: sandbox.sandboxId,
            resourceUid: row?.currentResourceUid as string,
            environmentGeneration: 1,
          },
        },
      });
      const credential = (await client.waitFor("credential:frame")) as { frame: { status: string; code?: string } };
      expect(credential.frame).toMatchObject({ status: "rejected", code: "execution_authority_denied" });

      // The saved final report is recorded exactly as if the channel had stayed open.
      const report = e4TurnReport(request, turnId, outcome);
      client.send({ type: "delivery:report", requestId: randomUUID(), report });
      const ack = (await client.waitFor("delivery:report:ack")) as { status: string };
      expect(ack.status).toBe("recorded");
      const [recorded] = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId));
      expect(recorded?.reportedAt).not.toBeNull();
      expect(recorded?.resultHash).toBe(report.resultHash);
      client.socket.close();
      await client.closed;
    },
  );

  it("reconnects a restored authority into a fresh execution-capable channel after a paused report-only reconnect", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId, { heartbeatIntervalMs: 40 });
    await stack.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    const token = await stack.tokens.issue(claims);
    const [placement] = await unit.database
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, sandbox.sessionId))
      .limit(1);
    if (!placement) throw new Error("fixture placement missing");
    const [binding] = await unit.database.select().from(imBindings).limit(1);
    if (!binding) throw new Error("fixture binding missing");

    // Active channel: accept one Cloud turn so durable `received` custody exists.
    const first = await connectRunner(stack.address);
    first.send({ type: "auth", requestId: randomUUID(), token, cloudDeliveryVersion: 1 });
    expect(await first.waitFor("auth:result")).toMatchObject({ ok: true });
    await first.waitFor("server:welcome");
    first.send(readyFrame(claims.resourceName));
    await waitForLifecycle(stack.service, accountId, sandbox.sandboxId, "ready");
    const { deliveryId, messageId } = await pendingDelivery(sandbox.sessionId, placement.generation);
    const request = e4DeliveryRequest({
      deliveryId,
      messageId,
      sessionId: sandbox.sessionId,
      placementGeneration: placement.generation,
      agentId: binding.agentId,
    });
    await stack.owner.dispatchDelivery({
      computerId: sandbox.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: randomUUID(),
      request,
    });
    const run = (await first.waitFor("delivery:run")) as { requestId: string };
    const turnId = randomUUID();
    first.send({ type: "delivery:received", requestId: run.requestId, deliveryId, turnId });
    expect(((await first.waitFor("delivery:verified")) as { status: string }).status).toBe("verified");
    first.socket.close();
    await first.closed;
    await vi.waitFor(() => expect(stack.hub.describe(sandbox.sandboxId).connected).toBe(false));

    // Reauthorization required: the reconnect latches report-only. It cannot become ready, and the
    // accepted turn must not receive a grant on this execution-ineligible connection.
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, binding.id));
    const paused = await connectRunner(stack.address);
    paused.send({ type: "auth", requestId: randomUUID(), token, cloudDeliveryVersion: 1 });
    expect(await paused.waitFor("auth:result")).toMatchObject({ ok: true });
    await paused.waitFor("server:welcome");
    paused.send(readyFrame(claims.resourceName));
    expect(((await paused.waitFor("error")) as { code: string }).code).toBe("RUNNER_SCOPE_REPORT_ONLY");
    expect(stack.hub.describe(sandbox.sandboxId)).toMatchObject({ connected: true, ready: false });

    const recovery = stack.owner.recoverAccepted(deliveryId);
    const query = (await paused.waitFor("delivery:query")) as { requestId: string };
    paused.send({
      type: "delivery:query:result",
      requestId: query.requestId,
      deliveryId,
      turnId,
      phase: "received",
    });
    expect(await recovery).toBe("pending");
    expect(paused.frames.some((frame) => frame.type === "delivery:verified")).toBe(false);
    expect(paused.socket.readyState).toBe(WebSocket.OPEN);

    // The user restores authorization: the heartbeat cadence detects the active chain and retires
    // the report-only connection so the Runner re-establishes an execution-capable handshake.
    await unit.database.update(imBindings).set({ status: "active" }).where(eq(imBindings.id, binding.id));
    // Restoration alone must not mint a grant before the report-only socket is replaced.
    const pausedConnection = stack.fence.connectionForSandbox(sandbox.sandboxId);
    if (!pausedConnection) throw new Error("fixture paused connection missing");
    expect(pausedConnection.executionEligible).toBe(false);
    const issuance = vi.spyOn(stack.grants, "issue");
    await stack.owner.handleDeliveryReceived(pausedConnection, { requestId: run.requestId, deliveryId, turnId });
    expect(issuance).not.toHaveBeenCalled();
    issuance.mockRestore();
    paused.send({ type: "heartbeat", requestId: randomUUID() });
    const closed = await paused.closed;
    expect(closed.code).toBe(1013);
    expect(closed.reason).toContain("authority restored");

    // Fresh active handshake: readiness is accepted, the accepted turn re-verifies with a grant,
    // and the credential execution-open is delegated instead of being denied by the latch.
    const resumed = await connectRunner(stack.address);
    resumed.send({ type: "auth", requestId: randomUUID(), token, cloudDeliveryVersion: 1 });
    expect(await resumed.waitFor("auth:result")).toMatchObject({ ok: true });
    const welcome = (await resumed.waitFor("server:welcome")) as {
      cloudDeliveryVersion?: number;
      resourceUid?: string;
    };
    expect(welcome.cloudDeliveryVersion).toBe(1);
    resumed.send(readyFrame(claims.resourceName));
    await vi.waitFor(() => expect(stack.hub.describe(sandbox.sandboxId).ready).toBe(true));

    resumed.send({ type: "delivery:received", requestId: run.requestId, deliveryId, turnId });
    const verified = (await resumed.waitFor("delivery:verified")) as {
      status: string;
      model?: { token?: string };
    };
    expect(verified.status).toBe("verified");
    expect(verified.model?.token).toBeTruthy();

    const delegation = vi.spyOn(stack.owner, "handleCredentialFrame");
    resumed.send({
      type: "credential:frame",
      frame: {
        type: "runtime:execution:open",
        requestId: randomUUID(),
        sessionId: sandbox.sessionId,
        agentId: binding.agentId,
        placementGeneration: placement.generation,
        runId: randomUUID(),
        source: { kind: "session-message", messageId: randomUUID() },
        sandbox: {
          sandboxId: sandbox.sandboxId,
          resourceUid: String(welcome.resourceUid),
          environmentGeneration: 1,
        },
      },
    });
    const tunnel = (await resumed.waitFor("credential:frame")) as { frame: { status: string; code?: string } };
    expect(delegation).toHaveBeenCalledTimes(1);
    // No credential stack is wired into this fixture, so the delegated path fails closed; the
    // report-only latch and the scope binding no longer reject it first.
    expect(tunnel.frame).toMatchObject({ status: "rejected", code: "owner_unavailable" });
    resumed.socket.close();
    await resumed.closed;
  });

  it("rejects a report-only reconnect for a released, superseded, or foreign allocation", async () => {
    const accountId = await account();
    const released = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId);
    await stack.service.startForAccount(accountId, released.sandboxId);
    const [releasedRow] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, released.sandboxId));
    const releasedClaims = {
      sandboxId: released.sandboxId,
      sessionId: released.sessionId,
      environmentGeneration: 1,
      resourceName: releasedRow?.currentResourceName as string,
    };
    const releasedToken = await stack.tokens.issue(releasedClaims);
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, released.sessionId));
    await unit.database
      .update(sandboxes)
      .set({ lifecycle: "unallocated", currentResourceName: null })
      .where(eq(sandboxes.id, released.sandboxId));
    const releasedClient = await connectRunner(stack.address);
    releasedClient.send({
      type: "auth",
      requestId: randomUUID(),
      token: releasedToken,
      cloudDeliveryVersion: 1,
    });
    expect(await releasedClient.waitFor("auth:result")).toMatchObject({ ok: false });
    expect((await releasedClient.closed).code).toBe(RUNNER_WS_CLOSE.authFailed);

    const superseded = await ownedSandbox(accountId);
    await stack.service.startForAccount(accountId, superseded.sandboxId);
    const [supersededRow] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, superseded.sandboxId));
    const supersededClaims = {
      sandboxId: superseded.sandboxId,
      sessionId: superseded.sessionId,
      environmentGeneration: 1,
      resourceName: supersededRow?.currentResourceName as string,
    };
    const supersededToken = await stack.tokens.issue(supersededClaims);
    await unit.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, superseded.sessionId));
    await unit.database
      .update(sandboxes)
      .set({
        environmentGeneration: 2,
        currentResourceName: `${supersededClaims.resourceName}-new`,
        currentResourceUid: "replacement-uid",
      })
      .where(eq(sandboxes.id, superseded.sandboxId));
    const supersededClient = await connectRunner(stack.address);
    supersededClient.send({
      type: "auth",
      requestId: randomUUID(),
      token: supersededToken,
      cloudDeliveryVersion: 1,
    });
    expect(await supersededClient.waitFor("auth:result")).toMatchObject({ ok: false });
    expect((await supersededClient.closed).code).toBe(RUNNER_WS_CLOSE.authFailed);

    // A foreign Session claiming the same Sandbox never authenticates, even in report-only mode.
    const foreignToken = await stack.tokens.issue({ ...supersededClaims, sessionId: randomUUID() });
    const foreignClient = await connectRunner(stack.address);
    foreignClient.send({ type: "auth", requestId: randomUUID(), token: foreignToken, cloudDeliveryVersion: 1 });
    expect(await foreignClient.waitFor("auth:result")).toMatchObject({ ok: false });
    expect((await foreignClient.closed).code).toBe(RUNNER_WS_CLOSE.authFailed);
  });

  it("runs dispatch -> durable receipt -> verified -> report -> ack over a real socket", async () => {
    const accountId = await account();
    const sandbox = await ownedSandbox(accountId);
    const stack = await cloudDeliveryStack(accountId);
    await stack.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName: row?.currentResourceName as string,
    };
    const token = await stack.tokens.issue(claims);
    const { client } = await authenticatedCloudRunner(stack.address, token);
    const welcome = (await client.waitFor("server:welcome")) as { resourceUid?: string | null };
    // The verified allocation UID rides the welcome frame for credential sandbox facts.
    expect(typeof welcome.resourceUid).toBe("string");
    client.send(readyFrame(claims.resourceName));
    await waitForLifecycle(stack.service, accountId, sandbox.sandboxId, "ready");

    const [placement] = await unit.database
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, sandbox.sessionId))
      .limit(1);
    if (!placement) throw new Error("fixture placement missing");
    const { deliveryId, messageId } = await pendingDelivery(sandbox.sessionId, placement.generation);
    const [binding] = await unit.database.select().from(imBindings).limit(1);
    if (!binding) throw new Error("fixture binding missing");
    const request = e4DeliveryRequest({
      deliveryId,
      messageId,
      sessionId: sandbox.sessionId,
      placementGeneration: placement.generation,
      agentId: binding.agentId,
    });
    await stack.owner.dispatchDelivery({
      computerId: sandbox.computerId,
      inputHash: computeDirectInputHash(request),
      installationId: randomUUID(),
      request,
    });
    const run = (await client.waitFor("delivery:run")) as { requestId: string };
    const turnId = randomUUID();
    client.send({ type: "delivery:received", requestId: run.requestId, deliveryId, turnId });
    const verified = (await client.waitFor("delivery:verified")) as {
      status: string;
      model?: { model: string; baseUrl: string };
    };
    expect(verified.status).toBe("verified");
    expect(verified.model?.model).toBe(E4_MODEL);
    expect(verified.model?.baseUrl).toContain("/api/v1/cloud-model");

    const report = e4TurnReport(request, turnId);
    client.send({ type: "delivery:report", requestId: randomUUID(), report });
    const ack = (await client.waitFor("delivery:report:ack")) as { status: string };
    expect(ack.status).toBe("recorded");
    const [recorded] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId));
    if (!recorded) throw new Error("delivery row missing");
    expect(recorded.state).toBe("accepted");
    expect(recorded.reportedAt).not.toBeNull();

    // The credential tunnel answers with a typed rejection for an unknown execution.
    client.send({
      type: "credential:frame",
      frame: {
        type: "runtime:credential:acquire",
        requestId: randomUUID(),
        executionId: randomUUID(),
        provider: "feishu",
        bindingId: randomUUID(),
      },
    });
    const tunnel = (await client.waitFor("credential:frame")) as {
      frame: { status: string; code: string };
    };
    expect(tunnel.frame.status).toBe("rejected");
    // No credential stack was wired into this owner: the tunnel fails closed.
    expect(tunnel.frame.code).toBe("owner_unavailable");
    client.socket.close();
    await client.closed;
  });
});

describe("E7 physical control credential", () => {
  async function readyWithWorkspace(
    ctx: RunnerContext & { address: string },
    sandboxId: string,
  ): Promise<typeof sandboxes.$inferSelect> {
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
    if (!row) throw new Error("Missing Sandbox fixture");
    const scope = {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName as string,
    };
    const socket = {
      send(frame: { type: string; requestId?: string }) {
        if (frame.type !== "workspace:seal" || !frame.requestId) return;
        ctx.store?.plant(
          {
            storageUri: row.storageUri,
            sandboxId: row.id,
            sessionId: row.sessionId,
            environmentGeneration: row.environmentGeneration,
          },
          { saved: true, sealed: true, ownerGeneration: row.environmentGeneration },
        );
        ctx.hub.settleWorkspaceSeal(
          row.id,
          { type: "workspace:seal:result", requestId: frame.requestId, ok: true },
          socket as never,
        );
      },
      close() {},
    };
    ctx.hub.attach(scope, socket as never, { reuseCapable: true });
    ctx.hub.markReady(
      scope,
      {
        sandboxName: scope.resourceName.split("/").at(-1) as string,
        rootfs: "/opt/sandbox-root",
        nodeVersion: "v24.19.0",
        piVersion: "0.84.2",
        runnerVersion: RUNNER_VERSION,
        reportedAt: new Date().toISOString(),
      },
      socket as never,
    );
    await ctx.service.promoteDeferredReadiness(row.id);
    const [ready] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
    if (!ready) throw new Error("Missing ready Sandbox fixture");
    expect(ready.lifecycle).toBe("ready");
    return ready;
  }

  async function transferStack() {
    const accountId = await account();
    const ctx = await createRunnerApp(accountId, { workspace: true });
    const a = await ownedSandbox(accountId, "control-a");
    await ctx.service.startForAccount(accountId, a.sandboxId);
    const rowA = await readyWithWorkspace(ctx, a.sandboxId);
    const claimsA = {
      sandboxId: a.sandboxId,
      sessionId: a.sessionId,
      environmentGeneration: rowA.environmentGeneration,
      resourceName: rowA.currentResourceName as string,
    };
    const sessionA = await ctx.tokens.issue(claimsA);
    const controlA = await ctx.tokens.issueControl(claimsA);
    const b = await ownedSandbox(accountId, "control-b");
    await ctx.service.startForAccount(accountId, b.sandboxId);
    const [rowB] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, b.sandboxId));
    if (!rowB) throw new Error("Missing borrower Sandbox fixture");
    expect(rowB.currentResourceName).toBe(rowA.currentResourceName);
    expect(rowB.currentResourceUid).toBe(rowA.currentResourceUid);
    return { ctx, a, b, claimsA, sessionA, controlA, rowA, rowB };
  }

  it("resolves only through the signed control credential and rejects a stale Session bearer", async () => {
    const { ctx, b, sessionA, controlA, rowB } = await transferStack();

    const legacy = await connectRunner(ctx.address);
    legacy.send({ type: "auth", requestId: randomUUID(), token: sessionA, workspaceVersion: 1 });
    expect((await legacy.waitFor("auth:result")).ok).toBe(false);
    await legacy.closed;

    const control = await connectRunner(ctx.address);
    control.send({
      type: "auth",
      requestId: randomUUID(),
      token: sessionA,
      controlToken: controlA,
      reuseVersion: 1,
      workspaceVersion: 1,
      renewExpired: true,
    });
    expect((await control.waitFor("auth:result")).ok).toBe(true);
    const welcome = await control.waitFor("server:welcome");
    expect(welcome).toMatchObject({
      sandboxId: b.sandboxId,
      sessionId: b.sessionId,
      environmentGeneration: rowB.environmentGeneration,
      resourceName: rowB.currentResourceName,
      reuseVersion: 1,
    });
    await vi.waitFor(() =>
      expect(ctx.hub.describe(b.sandboxId)).toMatchObject({ connected: true, reuseCapable: true }),
    );
    control.socket.close();
    await control.closed;
  });

  it("rejects a control attach when the provider no longer shows the tracked UID", async () => {
    const { ctx, sessionA, controlA, rowB } = await transferStack();
    ctx.fake.replaceUid(rowB.currentResourceName as string, "uid-replaced");
    const client = await connectRunner(ctx.address);
    client.send({
      type: "auth",
      requestId: randomUUID(),
      token: sessionA,
      controlToken: controlA,
      reuseVersion: 1,
      workspaceVersion: 1,
      renewExpired: true,
    });
    const closed = await client.closed;
    expect(closed.code).toBe(1013);
    expect(ctx.hub.describe(rowB.id).connected).toBe(false);
  });

  it("waits out the bounded provider read after validating the control credential", async () => {
    const accountId = await account();
    const ctx = await createBareRunnerApp(accountId, { authTimeoutMs: 200 });
    const sandbox = await ownedSandbox(accountId, "slow-control");
    await ctx.service.startForAccount(accountId, sandbox.sandboxId);
    const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
    if (!row) throw new Error("Missing Sandbox fixture");
    const claims = {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName as string,
    };
    const controlToken = await ctx.tokens.issueControl(claims);
    const sessionToken = await ctx.tokens.issue(claims);
    const existing = ctx.fake.getInstance.bind(ctx.fake);
    let reads = 0;
    ctx.fake.getInstance = async (name: string) => {
      reads += 1;
      // Deliberately slower than the ordinary 200 ms auth deadline: only the post-credential
      // provider-read deadline may cover this read.
      await new Promise((resolve) => setTimeout(resolve, 600));
      return existing(name);
    };

    const client = await connectRunner(ctx.address);
    client.send({
      type: "auth",
      requestId: randomUUID(),
      token: sessionToken,
      controlToken,
      reuseVersion: 1,
      workspaceVersion: 1,
      renewExpired: true,
    });
    expect((await client.waitFor("auth:result")).ok).toBe(true);
    const welcome = await client.waitFor("server:welcome");
    expect(welcome).toMatchObject({
      sandboxId: sandbox.sandboxId,
      environmentGeneration: row.environmentGeneration,
    });
    // The physical-holder resolution performed the provider read that exceeded the ordinary
    // 200 ms auth deadline; only the post-credential provider deadline could cover it.
    expect(reads).toBeGreaterThanOrEqual(1);
    client.socket.close();
    await client.closed;
  });

  it("renews an expired control credential only against the tracked physical binding", async () => {
    const { ctx, claimsA, sessionA } = await transferStack();
    const expiredIssuer = new RunnerBootstrapTokenService(JWT_SECRET, {
      ttlSeconds: 600,
      now: () => new Date(Date.now() - 3_600_000),
    });
    const expiredControl = await expiredIssuer.issueControl(claimsA);

    const renewed = await connectRunner(ctx.address);
    renewed.send({
      type: "auth",
      requestId: randomUUID(),
      token: sessionA,
      controlToken: expiredControl,
      reuseVersion: 1,
      workspaceVersion: 1,
      renewExpired: true,
    });
    const frame = await renewed.waitFor("auth:renewed");
    expect(typeof frame.controlToken).toBe("string");
    expect(frame.token).toBeUndefined();
    expect((await renewed.closed).code).toBe(1013);
  });

  it("rejects an expired control credential when the tracked binding is gone", async () => {
    const { ctx, claimsA, sessionA, rowB } = await transferStack();
    // Provider-confirmed absence: the tracked UID no longer exists, so renewal must fail closed.
    const instance = ctx.fake.instances.get(rowB.currentResourceName as string);
    if (instance) instance.gone = true;
    const expiredIssuer = new RunnerBootstrapTokenService(JWT_SECRET, {
      ttlSeconds: 600,
      now: () => new Date(Date.now() - 3_600_000),
    });
    const expiredControl = await expiredIssuer.issueControl(claimsA);
    const client = await connectRunner(ctx.address);
    client.send({
      type: "auth",
      requestId: randomUUID(),
      token: sessionA,
      controlToken: expiredControl,
      reuseVersion: 1,
      workspaceVersion: 1,
      renewExpired: true,
    });
    expect((await client.waitFor("auth:result")).ok).toBe(false);
    await client.closed;
  });
});
