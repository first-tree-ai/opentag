/**
 * E5 Runner workspace HTTP API against a real Fastify app on a real loopback listener, a real
 * WebSocket Runner channel, and the embedded PostgreSQL engine. The object store is a
 * deterministic in-memory double with the GCS contract semantics; uploads and downloads cross
 * real HTTP with streamed bodies (never just inject), and the full stop -> seal -> delete ->
 * restore flow runs end to end.
 */
import { randomUUID } from "node:crypto";
import {
  accountSandboxRunnerStopPath,
  HTTP_PATHS,
  RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES,
  RUNNER_WORKSPACE_PATH,
  RUNNER_WS_CLOSE,
  type RunnerWorkspaceObject,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import { imBindings, sandboxes, users } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ComputerService } from "../services/computers/index.js";
import { SandboxService } from "../services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "../services/sandboxes/runner-bootstrap-token.js";
import { RunnerHub } from "../services/sandboxes/runner-hub.js";
import { RunnerWorkspaceService } from "../services/sandboxes/runner-workspace-service.js";
import { SandboxRunnerService } from "../services/sandboxes/sandbox-runner-service.js";
import { WorkspaceObjectStoreError } from "../services/sandboxes/workspace-object-store.js";
import { SessionService } from "../services/sessions/index.js";
import { FakeCloudRunAdmin } from "./support/fake-cloud-run-admin.js";
import { FakeWorkspaceObjectStore, workspaceDigests } from "./support/fake-workspace-store.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
const apps: ReturnType<typeof createApp>[] = [];

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const RUNNER_VERSION = "0.0.5";
const JWT_SECRET = "unit-test-jwt-secret-at-least-32-characters";
const cloudIdentities = { enabled: true, runnerVersion: RUNNER_VERSION, storageBase: "gs://unit-cloud/sandboxes" };
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

async function account() {
  const id = randomUUID();
  await unit.database.insert(users).values({ id, email: `${id}@example.test`, displayName: "E5 fixture" });
  return id;
}
async function ownedSandbox(accountId: string) {
  const cloud = await new ComputerService(unit.database, unusedAccountResolver, {
    cloudIdentities,
  }).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(unit.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `e5-ws-${randomUUID().slice(0, 8)}`,
    displayName: "E5 WS",
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

interface WorkspaceStack {
  app: ReturnType<typeof createApp>;
  address: string;
  fake: FakeCloudRunAdmin;
  store: FakeWorkspaceObjectStore;
  tokens: RunnerBootstrapTokenService;
  hub: RunnerHub;
  service: SandboxRunnerService;
  workspace: RunnerWorkspaceService;
}

async function createWorkspaceApp(
  accountId: string,
  options: { sealTimeoutMs?: number } = {},
): Promise<WorkspaceStack> {
  const fake = new FakeCloudRunAdmin();
  const store = new FakeWorkspaceObjectStore();
  const tokens = new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: 600 });
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
    workspace: { store, ...(options.sealTimeoutMs !== undefined ? { sealTimeoutMs: options.sealTimeoutMs } : {}) },
  });
  const workspace = new RunnerWorkspaceService(unit.database, { tokens, hub, store, runnerService: service });
  const app = createApp({
    authService: authService(accountId),
    sandboxRunnerService: service,
    runnerChannel: { tokens, hub },
    runnerWorkspace: workspace,
  });
  apps.push(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, address, fake, store, tokens, hub, service, workspace };
}

interface StartedSandbox {
  sandbox: { sandboxId: string; sessionId: string; computerId: string };
  claims: { sandboxId: string; sessionId: string; environmentGeneration: number; resourceName: string };
  token: string;
}

async function startedSandbox(
  stack: Pick<WorkspaceStack, "service" | "tokens">,
  accountId: string,
): Promise<StartedSandbox> {
  const sandbox = await ownedSandbox(accountId);
  await stack.service.startForAccount(accountId, sandbox.sandboxId);
  const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandbox.sandboxId));
  if (!row) throw new Error("Missing allocated Sandbox fixture");
  const claims = {
    sandboxId: sandbox.sandboxId,
    sessionId: sandbox.sessionId,
    environmentGeneration: row.environmentGeneration,
    resourceName: row.currentResourceName as string,
  };
  const token = await stack.tokens.issue(claims);
  return { sandbox, claims, token };
}

async function sandboxRow(sandboxId: string) {
  const [row] = await unit.database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
  return row as typeof sandboxes.$inferSelect;
}

interface RunnerClient {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function connectRunner(address: string): Promise<RunnerClient> {
  const url = `${address.replace("http", "ws")}${HTTP_PATHS.sandboxRunnerWebSocket}`;
  const socket = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  const consumed = new Set<Record<string, unknown>>();
  const waiters: { type: string; resolve: (frame: Record<string, unknown>) => void }[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    frames.push(frame);
    const index = waiters.findIndex((waiter) => waiter.type === frame.type);
    if (index >= 0) {
      consumed.add(frame);
      waiters.splice(index, 1)[0]?.resolve(frame);
    }
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
            const existing = frames.find((frame) => frame.type === type && !consumed.has(frame));
            if (existing) {
              consumed.add(existing);
              return settle(existing);
            }
            const timer = setTimeout(() => fail(new Error(`timed out waiting for ${type}`)), timeoutMs);
            waiters.push({
              type,
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

/** Authenticate with the E5 workspace capability; the welcome must echo it. */
async function authenticatedWorkspaceRunner(stack: WorkspaceStack, token: string) {
  const client = await connectRunner(stack.address);
  client.send({ type: "auth", requestId: randomUUID(), token, workspaceVersion: 1 });
  const authResult = await client.waitFor("auth:result");
  expect(authResult.ok).toBe(true);
  const welcome = await client.waitFor("server:welcome");
  expect(welcome.workspaceVersion).toBe(1);
  return client;
}

const READY_READINESS = {
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: RUNNER_VERSION,
} as const;

function readyFrame(resourceName: string, workspaceRestored: boolean) {
  return {
    type: "runner:ready",
    readiness: { sandboxName: resourceName.split("/").at(-1) as string, ...READY_READINESS },
    ...(workspaceRestored ? { workspaceRestored: true as const } : {}),
  };
}

async function waitForLifecycle(
  stack: Pick<WorkspaceStack, "service">,
  accountId: string,
  sandboxId: string,
  lifecycle: string,
) {
  await vi.waitFor(async () => {
    expect((await stack.service.statusForAccount(accountId, sandboxId)).lifecycle).toBe(lifecycle);
  });
}

/* ------------------------------- HTTP helpers ---------------------------- */

function claimRequest(stack: WorkspaceStack, token: string | undefined) {
  return fetch(`${stack.address}${RUNNER_WORKSPACE_PATH}/claim`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: "{}",
  });
}

function downloadRequest(stack: WorkspaceStack, token: string, pins: { generation: string; metageneration: string }) {
  const url = new URL(`${stack.address}${RUNNER_WORKSPACE_PATH}/archive`);
  url.searchParams.set("generation", pins.generation);
  url.searchParams.set("metageneration", pins.metageneration);
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

function uploadRequest(
  stack: WorkspaceStack,
  token: string,
  input: {
    body: Buffer | ReadableStream<Uint8Array>;
    generation: string;
    metageneration: string;
    sealed: boolean;
    bytes: number;
    sha256: string;
    md5: string;
  },
) {
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "content-length": String(input.bytes),
      "x-opentag-storage-generation": input.generation,
      "x-opentag-storage-metageneration": input.metageneration,
      "x-opentag-workspace-sha256": input.sha256,
      "content-md5": input.md5,
      "x-opentag-workspace-sealed": String(input.sealed),
    },
    body: input.body,
    duplex: "half",
  };
  return fetch(`${stack.address}${RUNNER_WORKSPACE_PATH}/archive`, init);
}

/** A truthful upload: digests computed over the exact streamed bytes. */
function putArchive(
  stack: WorkspaceStack,
  token: string,
  previous: RunnerWorkspaceObject,
  content: Buffer,
  sealed: boolean,
) {
  const digests = workspaceDigests(content);
  return uploadRequest(stack, token, {
    body: content,
    ...digests,
    generation: previous.generation,
    metageneration: previous.metageneration,
    sealed,
  });
}

/* --------------------------------- suites -------------------------------- */

describe("workspace route authentication", () => {
  it("rejects missing, malformed, and non-Runner credentials on every route", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);

    const noToken = await claimRequest(stack, undefined);
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toMatchObject({ error: { code: "RUNNER_WORKSPACE_UNAUTHORIZED" } });
    expect(noToken.headers.get("cache-control")).toBe("no-store");

    const garbage = await claimRequest(stack, "not-a-token");
    expect(garbage.status).toBe(401);

    const download = await fetch(`${stack.address}${RUNNER_WORKSPACE_PATH}/archive?generation=1&metageneration=1`);
    expect(download.status).toBe(401);
    const upload = await fetch(`${stack.address}${RUNNER_WORKSPACE_PATH}/archive`, { method: "PUT" });
    expect(upload.status).toBe(401);
    runner.socket.close();
    await runner.closed;
  });

  it("rejects a token for a foreign sandbox and a token from a superseded generation", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);

    // A token minted for another Sandbox of the same Account never crosses over.
    const other = await ownedSandbox(accountId);
    const foreignToken = await stack.tokens.issue({
      sandboxId: other.sandboxId,
      sessionId: other.sessionId,
      environmentGeneration: 1,
      resourceName: "projects/unit-project/locations/us-west1/instances/foreign",
    });
    const foreign = await claimRequest(stack, foreignToken);
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: "RUNNER_WORKSPACE_SCOPE_STALE" } });

    // The allocation moves on; the old generation's token is stale even though unexpired.
    await unit.database
      .update(sandboxes)
      .set({ environmentGeneration: 2, currentResourceName: `${started.claims.resourceName}-next` })
      .where(eq(sandboxes.id, started.sandbox.sandboxId));
    const stale = await claimRequest(stack, started.token);
    expect(stale.status).toBe(403);
    runner.socket.close();
    await runner.closed;
  });

  it("requires the exact current Runner channel before any workspace access", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    // No control connection at all: the token alone is not enough.
    const noChannel = await claimRequest(stack, started.token);
    expect(noChannel.status).toBe(409);
    expect(await noChannel.json()).toMatchObject({ error: { code: "RUNNER_WORKSPACE_CHANNEL_REQUIRED" } });
  });
});

describe("workspace claim", () => {
  it("claims the empty seed for the first generation and stays idempotent", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);

    const first = await claimRequest(stack, started.token);
    expect(first.status).toBe(200);
    const seed = (await first.json()) as RunnerWorkspaceObject;
    expect(seed).toMatchObject({ ownerGeneration: 1, saved: false, sealed: false, bytes: 0 });
    expect(seed.generation).toMatch(/^[1-9][0-9]*$/);
    expect(seed.metageneration).toMatch(/^[1-9][0-9]*$/);

    const again = await claimRequest(stack, started.token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(seed);
    expect(stack.store.claims).toBe(3);
    runner.socket.close();
    await runner.closed;
  });

  it("rejects a non-empty claim body and never accepts account authentication", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);

    const withPayload = await fetch(`${stack.address}${RUNNER_WORKSPACE_PATH}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${started.token}`, "content-type": "application/json" },
      body: JSON.stringify({ storageUri: "gs://attacker/bucket" }),
    });
    expect(withPayload.status).toBe(400);
    expect(stack.store.claims).toBe(1);
    runner.socket.close();
    await runner.closed;
  });

  it("keeps a same-owner seal on claim and reads (never initializes) a releasing allocation", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    const row = await sandboxRow(started.sandbox.sandboxId);

    // A same-owner claim must not clear an existing seal.
    const sealed = stack.store.plant(
      { storageUri: row.storageUri, sandboxId: row.id, sessionId: row.sessionId, environmentGeneration: 1 },
      { sealed: true, saved: true },
    );
    const reclaim = await claimRequest(stack, started.token);
    expect(reclaim.status).toBe(200);
    expect(await reclaim.json()).toEqual(sealed);
    expect(claimed.generation).not.toBe(sealed.generation);

    // Releasing: same-owner metadata is readable, but nothing is ever initialized or reclaimed.
    await unit.database.update(sandboxes).set({ lifecycle: "releasing" }).where(eq(sandboxes.id, row.id));
    const releasing = await claimRequest(stack, started.token);
    expect(releasing.status).toBe(200);
    expect(await releasing.json()).toEqual(sealed);

    // A releasing claim cannot take back an object already fenced by a newer environment.
    stack.store.plant(
      { storageUri: row.storageUri, sandboxId: row.id, sessionId: row.sessionId, environmentGeneration: 2 },
      { ownerGeneration: 2 },
    );
    const denied = await claimRequest(stack, started.token);
    expect(denied.status).toBe(409);
    expect(stack.store.stored(row.storageUri)?.ownerGeneration).toBe(2);
    runner.socket.close();
    await runner.closed;
  });
});

describe("workspace archive transfer", () => {
  it("uploads a streamed body with exact bytes and digests, then downloads the pinned archive", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;

    // Stream the body as two chunks with a pause, proving the route never buffers whole-body:
    // the store sees the first chunk while the client has not produced the last yet.
    const content = Buffer.concat([Buffer.from("first-half-"), Buffer.from("second-half".repeat(64))]);
    const digests = workspaceDigests(content);
    let releaseSecondHalf!: () => void;
    const secondHalfGate = new Promise<void>((resolve) => {
      releaseSecondHalf = resolve;
    });
    let storeSawFirstChunk!: () => void;
    const storeConsuming = new Promise<void>((resolve) => {
      storeSawFirstChunk = resolve;
    });
    stack.store.onWriteBody = () => storeSawFirstChunk();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(content.subarray(0, 11));
        await secondHalfGate;
        controller.enqueue(content.subarray(11));
        controller.close();
      },
    });
    const pendingUpload = uploadRequest(stack, started.token, {
      body: stream,
      ...digests,
      generation: claimed.generation,
      metageneration: claimed.metageneration,
      sealed: false,
    });
    await storeConsuming;
    // The upload is mid-flight inside the store; the response cannot have completed yet.
    releaseSecondHalf();
    const upload = await pendingUpload;
    expect(upload.status).toBe(200);
    const saved = (await upload.json()) as RunnerWorkspaceObject;
    expect(saved).toMatchObject({
      ownerGeneration: 1,
      saved: true,
      sealed: false,
      bytes: digests.bytes,
      sha256: digests.sha256,
      md5: digests.md5,
    });
    expect(saved.generation).not.toBe(claimed.generation);
    expect(stack.store.writes).toHaveLength(1);

    // Download pins exactly this generation; bytes arrive intact with the integrity headers.
    const download = await downloadRequest(stack, started.token, saved);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-length")).toBe(String(digests.bytes));
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("x-opentag-storage-generation")).toBe(saved.generation);
    expect(download.headers.get("x-opentag-workspace-sha256")).toBe(digests.sha256);
    const downloaded = Buffer.from(await download.arrayBuffer());
    expect(downloaded.equals(content)).toBe(true);
    runner.socket.close();
    await runner.closed;
  });

  it("fails closed on stale pins, unsaved archives, and missing objects", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;

    // Nothing saved yet: the seed has no archive bytes to download.
    const unsaved = await downloadRequest(stack, started.token, claimed);
    expect(unsaved.status).toBe(409);

    const saved = (await (
      await putArchive(stack, started.token, claimed, Buffer.from("workspace-bytes"), false)
    ).json()) as RunnerWorkspaceObject;

    const wrongGeneration = await downloadRequest(stack, started.token, {
      generation: claimed.generation,
      metageneration: saved.metageneration,
    });
    expect(wrongGeneration.status).toBe(409);
    const wrongMeta = await downloadRequest(stack, started.token, {
      generation: saved.generation,
      metageneration: "99",
    });
    expect(wrongMeta.status).toBe(409);
    const badQuery = await fetch(
      `${stack.address}${RUNNER_WORKSPACE_PATH}/archive?generation=${saved.generation}&metageneration=${saved.metageneration}&storageUri=gs://x/y`,
      { headers: { authorization: `Bearer ${started.token}` } },
    );
    expect(badQuery.status).toBe(400);
    runner.socket.close();
    await runner.closed;
  });

  it("validates every upload header before consuming the body", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    const digests = workspaceDigests(Buffer.from("unit"));
    const baseHeaders: Record<string, string> = {
      authorization: `Bearer ${started.token}`,
      "content-type": "application/octet-stream",
      "content-length": String(digests.bytes),
      "x-opentag-storage-generation": claimed.generation,
      "x-opentag-storage-metageneration": claimed.metageneration,
      "x-opentag-workspace-sha256": digests.sha256,
      "content-md5": digests.md5,
      "x-opentag-workspace-sealed": "false",
    };
    const cases: Record<string, string>[] = [
      { "content-type": "application/json" },
      { "content-length": "0" },
      { "content-length": String(RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES + 1) },
      { "content-length": "abc" },
      { "x-opentag-storage-generation": "nope" },
      { "x-opentag-storage-metageneration": "" },
      { "x-opentag-workspace-sha256": digests.sha256.toUpperCase() },
      { "content-md5": "not-base64!!" },
      { "x-opentag-workspace-sealed": "yes" },
    ];
    for (const overrides of cases) {
      const headers = { ...baseHeaders, ...overrides };
      for (const [name, value] of Object.entries(overrides)) {
        if (value === "") delete headers[name];
      }
      const response = await stack.app.inject({
        method: "PUT",
        url: `${RUNNER_WORKSPACE_PATH}/archive`,
        headers,
        payload: Buffer.from("unit"),
      });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: overrides["content-type"] ? "VALIDATION_ERROR" : "RUNNER_WORKSPACE_BAD_REQUEST" },
      });
    }
    // No malformed upload ever reached the store.
    expect(stack.store.writes).toHaveLength(0);
    runner.socket.close();
    await runner.closed;
  });

  it("enforces preconditions, seal discipline, and the one-upload-per-sandbox bound", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    const content = Buffer.from("progress");

    // A save requires matching preconditions from a claim.
    const stalePins = await putArchive(stack, started.token, { ...claimed, metageneration: "99" }, content, false);
    expect(stalePins.status).toBe(409);
    // A preparing environment never accepts a sealed save.
    const earlySeal = await putArchive(stack, started.token, claimed, content, true);
    expect(earlySeal.status).toBe(409);

    const saved = (await (
      await putArchive(stack, started.token, claimed, content, false)
    ).json()) as RunnerWorkspaceObject;
    expect(saved.saved).toBe(true);

    // One upload per Sandbox per process: the gated first upload holds the slot.
    let openGate!: () => void;
    stack.store.writeGate = {
      promise: new Promise<void>((resolve) => {
        openGate = resolve;
      }),
      open: () => openGate(),
    };
    const first = putArchive(stack, started.token, saved, Buffer.from("second"), false);
    await vi.waitFor(() => expect(stack.store.writeGate).toBeUndefined()); // gate consumed by the first upload
    const concurrent = await putArchive(stack, started.token, saved, Buffer.from("concurrent"), false);
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({ error: { code: "RUNNER_WORKSPACE_CONFLICT" } });
    stack.store.writeGate = undefined;
    openGate();
    expect((await first).status).toBe(200);

    // A sealed object refuses further unsealed writes (the runner seals while ready or releasing).
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");
    const head = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    const sealedSave = await putArchive(stack, started.token, head, Buffer.from("sealed-bytes"), true);
    expect(sealedSave.status).toBe(200);
    const sealedObject = (await sealedSave.json()) as RunnerWorkspaceObject;
    expect(sealedObject.sealed).toBe(true);
    const afterSeal = await putArchive(stack, started.token, sealedObject, Buffer.from("too-late"), false);
    expect(afterSeal.status).toBe(409);
    runner.socket.close();
    await runner.closed;
  });

  it("rejects a body whose real byte count differs from the declared Content-Length", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const context = await stack.workspace.authenticate(`Bearer ${started.token}`);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    const digests = workspaceDigests(Buffer.from("declared"));

    async function* shortBody(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
    }
    await expect(
      stack.workspace.saveArchive(context, {
        generation: claimed.generation,
        metageneration: claimed.metageneration,
        bytes: digests.bytes,
        sha256: digests.sha256,
        md5: digests.md5,
        sealed: false,
        body: shortBody(),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "RUNNER_WORKSPACE_BAD_REQUEST" });
    expect(stack.store.writes).toHaveLength(0);
    runner.socket.close();
    await runner.closed;
  });

  it("maps store failures to stable redacted errors", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    stack.store.failNextClaimWith = new WorkspaceObjectStoreError("unavailable", "GCS claim failed with HTTP 500");
    const claim = await claimRequest(stack, started.token);
    expect(claim.status).toBe(503);
    expect(await claim.json()).toMatchObject({ error: { code: "RUNNER_WORKSPACE_UNAVAILABLE" } });
    runner.socket.close();
    await runner.closed;
  });
});

describe("workspace capability negotiation", () => {
  /** Legacy E3/E4 seam: no workspace store, so no capability gates and no workspace routes. */
  async function createLegacyRunnerApp(accountId: string) {
    const fake = new FakeCloudRunAdmin();
    const tokens = new RunnerBootstrapTokenService(JWT_SECRET, { ttlSeconds: 600 });
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
    const app = createApp({
      authService: authService(accountId),
      sandboxRunnerService: service,
      runnerChannel: { tokens, hub },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    return { app, address, fake, tokens, hub, service };
  }

  it("fails closed against an execution-capable Runner without the workspace capability", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const client = await connectRunner(stack.address);
    client.send({ type: "auth", requestId: randomUUID(), token: started.token });
    const authResult = await client.waitFor("auth:result");
    expect(authResult.ok).toBe(false);
    expect((await client.closed).code).toBe(RUNNER_WS_CLOSE.authFailed);
    // The unauthenticated Runner never becomes visible as connected, and the allocation never readies.
    expect(stack.hub.describe(started.sandbox.sandboxId).connected).toBe(false);
    expect((await stack.service.statusForAccount(accountId, started.sandbox.sandboxId)).lifecycle).toBe("preparing");
  });

  it("echoes the workspace version when requested AND configured", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const client = await connectRunner(stack.address);
    client.send({ type: "auth", requestId: randomUUID(), token: started.token, workspaceVersion: 1 });
    expect((await client.waitFor("auth:result")).ok).toBe(true);
    const welcome = await client.waitFor("server:welcome");
    expect(welcome.workspaceVersion).toBe(1);
    client.socket.close();
    await client.closed;
  });

  it("never echoes an unconfigured capability and keeps the exact legacy E3/E4 behavior", async () => {
    // A workspace-capable Runner against a Server without the store: no echo, no routes, and the
    // legacy auth/readiness behavior is untouched.
    const legacyAccount = await account();
    const legacy = await createLegacyRunnerApp(legacyAccount);
    const legacyStarted = await startedSandbox(legacy, legacyAccount);
    expect(legacy.fake.createCalls[0]?.workspacePersistence).toBeUndefined();
    const client = await connectRunner(legacy.address);
    client.send({ type: "auth", requestId: randomUUID(), token: legacyStarted.token, workspaceVersion: 1 });
    expect((await client.waitFor("auth:result")).ok).toBe(true);
    const welcome = await client.waitFor("server:welcome");
    expect(welcome.workspaceVersion).toBeUndefined();
    const noRoutes = await fetch(`${legacy.address}${RUNNER_WORKSPACE_PATH}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${legacyStarted.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(noRoutes.status).toBe(404);
    client.send(readyFrame(legacyStarted.claims.resourceName, false));
    await waitForLifecycle(legacy, legacyAccount, legacyStarted.sandbox.sandboxId, "ready");
    client.socket.close();
    await client.closed;
  });

  it("rejects readiness without a restored workspace and accepts it after restore", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    runner.send(readyFrame(started.claims.resourceName, false));
    const error = await runner.waitFor("error");
    expect(error.code).toBe("RUNNER_WORKSPACE_NOT_RESTORED");
    const blocked = await stack.service.statusForAccount(accountId, started.sandbox.sandboxId);
    expect(blocked.lifecycle).toBe("preparing");
    expect(blocked.runnerReady).toBe(false);
    // The connection stays authenticated: after the actual claim/restore the report is accepted.
    const claim = await claimRequest(stack, started.token);
    expect(claim.status).toBe(200);
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");
    runner.socket.close();
    await runner.closed;
  });

  it("permits ingress replacement of a released generation only with persistence, arming the Runner env", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    expect(stack.fake.createCalls[0]?.workspacePersistence).toBe(true);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");

    const stopPromise = stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    const sealFrame = await runner.waitFor("workspace:seal");
    const sealed = await putArchive(stack, started.token, claimed, Buffer.from("state"), true);
    expect(sealed.status).toBe(200);
    runner.send({ type: "workspace:seal:result", requestId: sealFrame.requestId, ok: true });
    await stopPromise;
    await runner.closed;

    // The ingress worker may now replace the released generation; the new create arms persistence.
    const outcome = await stack.service.ensureIngressAllocation(accountId, started.sandbox.sandboxId);
    expect(outcome).toBe("pending");
    expect((await sandboxRow(started.sandbox.sandboxId)).environmentGeneration).toBe(2);
    expect(stack.fake.createCalls).toHaveLength(2);
    expect(stack.fake.createCalls[1]?.workspacePersistence).toBe(true);
  });
});

describe("workspace release and restore", () => {
  /** Drive the runner side of a seal request: upload the sealed archive, then ack. */
  async function answerSeal(
    stack: WorkspaceStack,
    runner: RunnerClient,
    token: string,
    previous: RunnerWorkspaceObject,
    content: Buffer,
    sealFrame: Record<string, unknown>,
  ) {
    const uploaded = (await (await putArchive(stack, token, previous, content, true)).json()) as RunnerWorkspaceObject;
    expect(uploaded.sealed).toBe(true);
    runner.send({ type: "workspace:seal:result", requestId: sealFrame.requestId, ok: true });
    return uploaded;
  }

  it("seals before deletion on stop and restores the same archive into the next generation", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");
    const progress = Buffer.from("turn-1-progress");
    const saved = (await (
      await putArchive(stack, started.token, claimed, progress, false)
    ).json()) as RunnerWorkspaceObject;

    // Stop: the Runner channel stays alive, a seal is requested, and deletion waits for proof.
    const stopPromise = fetch(`${stack.address}${accountSandboxRunnerStopPath(started.sandbox.sandboxId)}`, {
      method: "POST",
      headers: { authorization: "Bearer access", "content-type": "application/json" },
      body: "{}",
    });
    const sealFrame = await runner.waitFor("workspace:seal");
    // The environment is releasing before the save completes: new starts conflict.
    expect((await sandboxRow(started.sandbox.sandboxId)).lifecycle).toBe("releasing");
    const final = Buffer.from("final-sealed-state");
    const sealedObject = await answerSeal(stack, runner, started.token, saved, final, sealFrame);

    const stopResponse = await stopPromise;
    expect(stopResponse.status).toBe(200);
    expect(await stopResponse.json()).toMatchObject({ lifecycle: "unallocated" });
    expect(stack.fake.liveInstanceCount()).toBe(0);
    expect((await runner.closed).code).toBe(RUNNER_WS_CLOSE.staleScope);
    const rowAfter = await sandboxRow(started.sandbox.sandboxId);
    expect(stack.store.stored(rowAfter.storageUri)).toMatchObject({ saved: true, sealed: true, ownerGeneration: 1 });
    expect(stack.store.storedBytes(rowAfter.storageUri)?.equals(final)).toBe(true);
    expect(sealedObject.saved).toBe(true);

    // The next generation claims the same storage URI and downloads the exact sealed bytes.
    await stack.service.startForAccount(accountId, started.sandbox.sandboxId);
    const row2 = await sandboxRow(started.sandbox.sandboxId);
    expect(row2.environmentGeneration).toBe(2);
    const claims2 = {
      sandboxId: started.sandbox.sandboxId,
      sessionId: started.sandbox.sessionId,
      environmentGeneration: 2,
      resourceName: row2.currentResourceName as string,
    };
    const token2 = await stack.tokens.issue(claims2);
    const runner2 = await authenticatedWorkspaceRunner(stack, token2);
    const claimed2 = (await (await claimRequest(stack, token2)).json()) as RunnerWorkspaceObject;
    expect(claimed2).toMatchObject({ ownerGeneration: 2, saved: true, sealed: false });
    const restored = await downloadRequest(stack, token2, claimed2);
    expect(restored.status).toBe(200);
    expect(Buffer.from(await restored.arrayBuffer()).equals(final)).toBe(true);
    runner2.send(readyFrame(claims2.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");
    runner2.socket.close();
    await runner2.closed;
  });

  it("keeps the physical binding on seal failure and recovers through retry", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId, { sealTimeoutMs: 2_000 });
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");

    // First stop: the Runner reports a failed save; the binding and releasing lifecycle persist.
    const firstStop = stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    const failedStop = expect(firstStop).rejects.toMatchObject({ statusCode: 503 });
    const sealFrame = await runner.waitFor("workspace:seal");
    runner.send({
      type: "workspace:seal:result",
      requestId: sealFrame.requestId,
      ok: false,
      code: "workspace_save_failed",
    });
    await failedStop;
    const failedRow = await sandboxRow(started.sandbox.sandboxId);
    expect(failedRow.lifecycle).toBe("releasing");
    expect(failedRow.lastErrorCode).toBe("workspace_save_failed");
    expect(stack.fake.liveInstanceCount()).toBe(1);
    // The Runner channel stays attached through the failed save.
    expect(stack.hub.describe(started.sandbox.sandboxId).connected).toBe(true);

    // Retry: the Runner seals for real this time and the release completes.
    const retryStop = stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    const retrySeal = await runner.waitFor("workspace:seal", 5_000);
    await answerSeal(stack, runner, started.token, claimed, Buffer.from("recovered"), retrySeal);
    const status = await retryStop;
    expect(status.lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("retries from the stored sealed proof after a dropped ack — no live Runner needed", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId, { sealTimeoutMs: 250 });
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");

    // The upload lands but the ack never arrives (socket drops first): the first stop times out.
    const firstStop = stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    const failedStop = expect(firstStop).rejects.toMatchObject({ statusCode: 503 });
    await runner.waitFor("workspace:seal");
    const sealed = (await (
      await putArchive(stack, started.token, claimed, Buffer.from("durable"), true)
    ).json()) as RunnerWorkspaceObject;
    expect(sealed.sealed).toBe(true);
    runner.socket.close();
    await runner.closed;
    await failedStop;
    expect((await sandboxRow(started.sandbox.sandboxId)).lastErrorCode).toBe("workspace_save_failed");

    // Retry with NO live Runner: the stored sealed proof short-circuits the seal request.
    const retry = await stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    expect(retry.lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("releases without a save when the physical Instance is proven absent", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");
    await putArchive(stack, started.token, claimed, Buffer.from("last-good"), false);
    runner.socket.close();
    await runner.closed;

    // The Instance is gone (lost out of band): nothing can be saved; the last archive is kept.
    const name = started.claims.resourceName;
    const instance = stack.fake.instances.get(name);
    if (!instance) throw new Error("fixture instance missing");
    instance.gone = true;
    const status = await stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    expect(status.lifecycle).toBe("unallocated");
    const row = await sandboxRow(started.sandbox.sandboxId);
    expect(stack.store.stored(row.storageUri)).toMatchObject({ saved: true, sealed: false });
    expect(stack.fake.deleteCalls.every((call) => call.name === name && call.uid === instance.uid)).toBe(true);
  });

  it("serializes concurrent stops through the single in-flight seal", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId);
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");

    const firstStop = stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    const secondStop = stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    const sealFrame = await runner.waitFor("workspace:seal");
    await answerSeal(stack, runner, started.token, claimed, Buffer.from("once"), sealFrame);
    const [first, second] = await Promise.all([firstStop, secondStop]);
    expect(first.lifecycle).toBe("unallocated");
    expect(second.lifecycle).toBe("unallocated");
    // Seal is coalesced; repeated UID-conditional deletion is idempotent across stop callers.
    expect(runner.frames.filter((frame) => frame.type === "workspace:seal")).toHaveLength(1);
    expect(stack.fake.deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(stack.fake.deleteCalls.map((call) => `${call.name}:${call.uid}`)).size).toBe(1);
    expect(stack.fake.liveInstanceCount()).toBe(0);
  });

  it("seals through a reconnected report-only Runner channel while releasing", async () => {
    const accountId = await account();
    const stack = await createWorkspaceApp(accountId, { sealTimeoutMs: 2_000 });
    const started = await startedSandbox(stack, accountId);
    const runner = await authenticatedWorkspaceRunner(stack, started.token);
    const claimed = (await (await claimRequest(stack, started.token)).json()) as RunnerWorkspaceObject;
    runner.send(readyFrame(started.claims.resourceName, true));
    await waitForLifecycle(stack, accountId, started.sandbox.sandboxId, "ready");

    // The channel drops before the stop begins; the first stop finds no live Runner.
    runner.socket.close();
    await runner.closed;
    await vi.waitFor(() => expect(stack.hub.describe(started.sandbox.sandboxId).connected).toBe(false));
    await expect(stack.service.stopForAccount(accountId, started.sandbox.sandboxId)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect((await sandboxRow(started.sandbox.sandboxId)).lastErrorCode).toBe("workspace_save_failed");
    expect(stack.fake.liveInstanceCount()).toBe(1);

    // The Runner reconnects against the releasing allocation (channel scope, report-only) and the
    // retried stop seals through it.
    const reconnected = await connectRunner(stack.address);
    reconnected.send({ type: "auth", requestId: randomUUID(), token: started.token, workspaceVersion: 1 });
    expect((await reconnected.waitFor("auth:result")).ok).toBe(true);
    const retryStop = stack.service.stopForAccount(accountId, started.sandbox.sandboxId);
    const sealFrame = await reconnected.waitFor("workspace:seal");
    await answerSeal(stack, reconnected, started.token, claimed, Buffer.from("final"), sealFrame);
    expect((await retryStop).lifecycle).toBe("unallocated");
    expect(stack.fake.liveInstanceCount()).toBe(0);
    await reconnected.closed;
  });
});
