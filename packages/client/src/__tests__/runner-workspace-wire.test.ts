import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectImMessageDeliveryRequest, RunnerWorkspaceObject } from "@opentag/shared";
import { expect, it, type Mock, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { CloudTurnRunnerOptions } from "../runner/cloud-turns.js";
import type { NativeSandbox } from "../runner/native-sandbox.js";
import { runRunnerServe } from "../runner/serve.js";
import type { NativeWebExecutionChannel } from "../runner/web-gateway.js";
import { createWorkspaceArchive } from "../runner/workspace-archive.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const sandboxId = "2b63a21e-f6c7-4474-91ea-4dabf0566a24";
const sessionId = "5f9a1c3e-2d4b-4e6f-8a1b-9c0d1e2f3a4b";
// E6: two different Sessions of ONE Agent on separate Runner/Sandbox allocations.
const agentId = "0f1e2d3c-4b5a-4968-8777-000000000001";
const sessionA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const sessionB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const sandboxA = "cccccccc-3333-4333-8333-cccccccccccc";
const sandboxB = "dddddddd-4444-4444-8444-dddddddddddd";

function digest(bytes: Buffer) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    md5: createHash("md5").update(bytes).digest("base64"),
  };
}

interface ProtocolPeerOptions {
  /** Allocation instance prefix; the welcome resource name and the Runner sandbox name must match it. */
  readonly instancePrefix?: string;
  readonly sandboxId?: string;
  readonly sessionId?: string;
  /** Deterministic save failure: reject the Nth and every later archive upload without storing it. */
  readonly rejectUploadsFrom?: number;
  readonly authReply?: (frame: Record<string, unknown>, attempt: number) => object | object[] | undefined;
  readonly httpToken?: () => string;
}

/** A storage/control protocol peer over real loopback HTTP + WS; not a GCP/native substitute. */
async function protocolPeer(options: ProtocolPeerOptions = {}) {
  const instancePrefix = options.instancePrefix ?? "ots-test";
  const peerSandboxId = options.sandboxId ?? sandboxId;
  const peerSessionId = options.sessionId ?? sessionId;
  let generation = 1;
  let uploads = 0;
  let authAttempts = 0;
  let bytes = Buffer.alloc(0);
  let object: RunnerWorkspaceObject = {
    generation: "1",
    metageneration: "1",
    ownerGeneration: 1,
    saved: false,
    sealed: false,
    ...digest(bytes),
  };
  let current: WebSocket | undefined;
  const frames: Record<string, unknown>[] = [];
  const claimTokens: string[] = [];
  const waiters = new Set<() => void>();
  const readyObjects: RunnerWorkspaceObject[] = [];
  const upload = async (request: IncomingMessage, response: ServerResponse) => {
    uploads += 1;
    if (options.rejectUploadsFrom !== undefined && uploads >= options.rejectUploadsFrom) {
      response.writeHead(412).end();
      return;
    }
    if (
      request.headers["x-opentag-storage-generation"] !== object.generation ||
      request.headers["x-opentag-storage-metageneration"] !== object.metageneration
    ) {
      response.writeHead(412).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bytes = Buffer.concat(chunks);
    expect(Number(request.headers["content-length"])).toBe(bytes.length);
    expect(request.headers["content-md5"]).toBe(digest(bytes).md5);
    object = {
      ...object,
      ...digest(bytes),
      generation: String(Number(object.generation) + 1),
      metageneration: "1",
      saved: true,
      sealed: request.headers["x-opentag-workspace-sealed"] === "true",
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(object));
  };
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    // Record every claim attempt, including rejected ones: a bearer used for the wrong
    // assignment must be visible to the tests instead of hidden behind a 403.
    if (request.url?.endsWith("/claim")) claimTokens.push(String(request.headers.authorization ?? ""));
    if (request.headers.authorization !== `Bearer ${options.httpToken?.() ?? `fixture-${generation}`}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.url?.endsWith("/claim")) {
      if (object.ownerGeneration < generation) {
        object = {
          ...object,
          ownerGeneration: generation,
          sealed: false,
          metageneration: String(Number(object.metageneration) + 1),
        };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(object));
    } else if (request.method === "PUT") {
      await upload(request, response);
    } else {
      response.setHeader("content-type", "application/octet-stream");
      response.end(bytes);
    }
  };
  const http = createServer((request, response) => {
    void serve(request, response).catch(() => response.destroy());
  });
  const wss = new WebSocketServer({ server: http });
  const authenticate = (socket: WebSocket, frame: Record<string, unknown>) => {
    expect(frame.workspaceVersion).toBe(1);
    const reply = options.authReply?.(frame, ++authAttempts);
    if (reply) {
      for (const item of Array.isArray(reply) ? reply : [reply]) socket.send(JSON.stringify(item));
      return;
    }
    socket.send(JSON.stringify({ type: "auth:result", ok: true }));
    socket.send(
      JSON.stringify({
        type: "server:welcome",
        protocolVersion: 1,
        sandboxId: peerSandboxId,
        sessionId: peerSessionId,
        environmentGeneration: generation,
        resourceName: `projects/p/locations/r/instances/${instancePrefix}-${generation}`,
        resourceUid: `uid-${generation}`,
        cloudDeliveryVersion: 1,
        workspaceVersion: 1,
        heartbeatIntervalMs: 50,
        heartbeatTimeoutMs: 10_000,
      }),
    );
  };
  wss.on("connection", (socket) => {
    current = socket;
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "auth") authenticate(socket, frame);
      if (frame.type === "heartbeat") socket.send(JSON.stringify({ type: "server:heartbeat" }));
      if (frame.type === "runner:ready") readyObjects.push({ ...object });
      for (const waiter of waiters) waiter();
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    instancePrefix,
    identity: { sandboxId: peerSandboxId, sessionId: peerSessionId },
    readyObjects,
    claimTokens,
    object: () => ({ ...object }),
    resetObject() {
      bytes = Buffer.alloc(0);
      object = {
        generation: "1",
        metageneration: "1",
        ownerGeneration: 1,
        saved: false,
        sealed: false,
        ...digest(bytes),
      };
    },
    /** Seed a genuine saved archive for the next claim/download (the borrower's own storage). */
    seedObject(content: Buffer) {
      bytes = Buffer.from(content);
      object = {
        generation: "1",
        metageneration: "1",
        ownerGeneration: 1,
        saved: true,
        sealed: false,
        ...digest(bytes),
      };
    },
    count(type: string) {
      return frames.filter((frame) => frame.type === type).length;
    },
    advance() {
      generation += 1;
      frames.length = 0;
    },
    send(frame: object) {
      current?.send(JSON.stringify(frame));
    },
    disconnect() {
      current?.terminate();
    },
    wait(type: string, after = 0): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`missing ${type}`));
        }, 5_000);
        const check = () => {
          const found = frames.filter((frame) => frame.type === type)[after];
          if (!found) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        };
        waiters.add(check);
        check();
      });
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

it("retains unsaved files through rejected auth and renews before saving on a fresh connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-auth-recovery-"));
  let currentToken = "fixture-1";
  let rejected = false;
  const retryBlocked = deferred();
  const allowRetry = deferred();
  const peer = await protocolPeer({
    httpToken: () => currentToken,
    authReply: (frame, attempt) => {
      expect(frame.renewExpired).toBe(true);
      if (attempt === 2) {
        rejected = true;
        return { type: "auth:result", ok: false };
      }
      if (attempt === 3) {
        currentToken = "fixture-renewed";
        return { type: "auth:renewed", token: currentToken };
      }
      expect(frame.token).toBe(currentToken);
      return undefined;
    },
  });
  const workspace = join(root, "workspace");
  const native = {
    launch: vi.fn(async () => mkdir(workspace, { recursive: true })),
    destroy: vi.fn(async () => undefined),
    probe: vi.fn(async () => ({ nodeVersion: "v24.20.0", piVersion: "test", runnerVersion: "0.0.5" })),
  };
  const stop = new AbortController();
  let exited = false;
  const running = runRunnerServe(
    {
      backendUrl: peer.url,
      bootstrapToken: currentToken,
      sandboxName: "ots-test-1",
      workspace,
      stateDir: join(root, "private"),
      workspacePersistence: true,
    },
    {
      installSignalHandlers: false,
      signal: stop.signal,
      stderr: { write: () => undefined },
      sandboxFactory: () => native as unknown as NativeSandbox,
      sleep: async () => {
        if (rejected) {
          retryBlocked.resolve();
          await allowRetry.promise;
        }
      },
    },
  ).finally(() => {
    exited = true;
  });
  try {
    await peer.wait("runner:ready");
    const saved = peer.object().generation;
    const destroys = native.destroy.mock.calls.length;
    await writeFile(join(workspace, "unsaved.txt"), "work after the last save");
    peer.disconnect();
    await retryBlocked.promise;
    expect(exited).toBe(false);
    expect(native.destroy).toHaveBeenCalledTimes(destroys);
    expect(peer.object().generation).toBe(saved);
    expect(await readFile(join(workspace, "unsaved.txt"), "utf8")).toBe("work after the last save");
    allowRetry.resolve();
    await peer.wait("auth", 3);
    await peer.wait("runner:ready", 1);
    const requestId = randomUUID();
    peer.send({ type: "workspace:seal", requestId });
    expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });
    expect(peer.object().sealed).toBe(true);
    expect(Number(peer.object().generation)).toBeGreaterThan(Number(saved));
  } finally {
    allowRetry.resolve();
    stop.abort();
    await running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "handles checkpoint, report replay and seal over real sockets (unsaveable=%s)",
  async (unsaveable) => {
    const root = await mkdtemp(join(tmpdir(), "opentag-e5-wire-"));
    const peer = await protocolPeer();
    const stops: AbortController[] = [];
    const processes: Promise<number>[] = [];
    const webExecutions = vi.fn(async () => {
      expect(peer.object().saved).toBe(true);
      return {} as NativeWebExecutionChannel;
    });
    const start = (generation: number) => {
      const workspace = join(root, `workspace-${generation}`);
      const native = {
        launch: vi.fn(async () => {
          await mkdir(workspace, { recursive: true });
        }),
        destroy: vi.fn(async () => undefined),
        probe: vi.fn(async () => ({ nodeVersion: "v24.20.0", piVersion: "test", runnerVersion: "0.0.5" })),
      };
      const stop = new AbortController();
      stops.push(stop);
      const running = runRunnerServe(
        {
          backendUrl: peer.url,
          bootstrapToken: `fixture-${generation}`,
          sandboxName: `ots-test-${generation}`,
          workspace,
          stateDir: join(root, `private-${generation}`),
          workspacePersistence: true,
          webTools: true,
        },
        {
          installSignalHandlers: false,
          signal: stop.signal,
          stderr: { write: () => undefined },
          sandboxFactory: () => native as unknown as NativeSandbox,
          webAuthority: {} as never,
          onWebGateway: (gateway) => {
            vi.spyOn(gateway, "openExecution").mockImplementation(webExecutions);
          },
          cloudTurnSeams: {
            openExecution: async () => ({ close: async () => undefined, executionDir: "/run/test" }),
            runWorker: async () => {
              await mkdir(join(workspace, ".opentag/pi-session"), { recursive: true });
              await writeFile(join(workspace, ".opentag/pi-session/binding.json"), '{"sessionId":"pi-original"}');
              await writeFile(join(workspace, ".opentag/pi-session/history.jsonl"), '{"text":"remember progress"}\n');
              await writeFile(join(workspace, "output.txt"), "completed work");
              if (unsaveable) await link(join(workspace, "output.txt"), join(workspace, "hard-link"));
              return {
                code: 0,
                stderr: "",
                stdout: `${JSON.stringify({
                  kind: "result",
                  completion: { outcome: "completed", executionEffects: "completed", finalText: "done" },
                })}\n`,
              };
            },
          },
        },
      );
      processes.push(running);
      return { workspace, native, stop, running };
    };
    try {
      const first = start(1);
      expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
      expect(peer.readyObjects[0]?.saved).toBe(true);
      expect(webExecutions).toHaveBeenCalledTimes(1);
      const initialLaunches = first.native.launch.mock.calls.length;
      const delivery = cloudDeliveryFixture({ sessionId });
      peer.send({ type: "delivery:run", requestId: delivery.requestId, delivery });
      await peer.wait("delivery:received");
      peer.send({
        type: "delivery:verified",
        requestId: delivery.requestId,
        status: "verified",
        model: {
          baseUrl: "https://server.example.com/api/v1/cloud-model",
          token: "fixture-model-token-1234567890123456",
          model: delivery.runtime.model,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      const reportFrame = await peer.wait("delivery:report");
      const report = reportFrame.report as { turnId: string; resultHash: string };
      const savedGeneration = peer.object().generation;
      if (unsaveable) {
        expect(report).toMatchObject({
          outcome: "failed",
          errorReason: "workspace_failed",
          executionEffects: "completed",
        });
        expect(report).toHaveProperty("finalText", expect.stringContaining("not durably saved"));
        expect(savedGeneration).toBe(peer.readyObjects[0]?.generation);
        expect(first.native.launch).toHaveBeenCalledTimes(initialLaunches);
        // The failure report must replay on a new connection even though prepare cannot save.
        peer.disconnect();
        await peer.wait("auth", 1);
        expect((await peer.wait("delivery:report", 1)).report).toEqual(report);
        const requestId = randomUUID();
        peer.send({ type: "workspace:seal", requestId });
        peer.send({
          type: "delivery:report:ack",
          requestId: randomUUID(),
          turnId: report.turnId,
          resultHash: report.resultHash,
          status: "recorded",
        });
        expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: false });
        expect(peer.object().generation).toBe(savedGeneration);
        expect(first.native.launch).toHaveBeenCalledTimes(initialLaunches);
        expect(await readFile(join(first.workspace, "output.txt"), "utf8")).toBe("completed work");
        return;
      }
      expect(Number(savedGeneration)).toBeGreaterThan(Number(peer.readyObjects[0]?.generation));
      // Namespace replacement must not silently renew an execution-scoped web authority.
      expect(webExecutions).toHaveBeenCalledTimes(1);
      const requestId = randomUUID();
      peer.send({ type: "workspace:seal", requestId });
      // The report is the only parent-private state needed by Server; ACK must unblock the seal
      // without waiting behind the seal operation in the Runner's WSS control queue.
      peer.send({
        type: "delivery:report:ack",
        requestId: randomUUID(),
        turnId: report.turnId,
        resultHash: report.resultHash,
        status: "recorded",
      });
      expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });
      expect(peer.object().sealed).toBe(true);
      first.stop.abort();
      await first.running;
      peer.advance();
      const second = start(2);
      expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
      expect(await readFile(join(second.workspace, "output.txt"), "utf8")).toBe("completed work");
      expect(await readFile(join(second.workspace, ".opentag/pi-session/binding.json"), "utf8")).toContain(
        "pi-original",
      );
      expect(await readFile(join(second.workspace, ".opentag/pi-session/history.jsonl"), "utf8")).toContain(
        "remember progress",
      );
      expect(peer.object().ownerGeneration).toBe(2);
      expect(peer.object().sealed).toBe(false);
      expect(webExecutions).toHaveBeenCalledTimes(2);
    } finally {
      for (const stop of stops) stop.abort();
      await Promise.allSettled(processes);
      await peer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

/* ------------------------------------------------------------------------------------------------
 * E6: two concurrent Sessions of ONE Agent, each on its own trusted runRunnerServe instance.
 *
 * Everything below stays an explicit double: the loopback peers stand in for the Server storage
 * and control protocol, and the native Sandbox plus cloud-turn seams stand in for native execution.
 * These tests prove Runner composition over real HTTP/WS sockets; they never call GCP or a model.
 * ---------------------------------------------------------------------------------------------- */

type CloudTurnSeams = Pick<CloudTurnRunnerOptions, "openExecution" | "runWorker">;
type WirePeer = Awaited<ReturnType<typeof protocolPeer>>;

/** A single-shot explicit barrier; overlap is proven by the barrier, never guessed from timing. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A real in-sandbox worker reacts to cancellation; the execution double must not finish anyway. */
function untilAbortedOr(signal: AbortSignal, released: Promise<void>): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("worker aborted"));
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error("worker aborted"));
    signal.addEventListener("abort", abort, { once: true });
    released.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Session-specific Pi continuity and output files; the real worker owns these, not the Runner. */
async function writeSessionFiles(workspace: string, label: "a" | "b", ownSessionId: string): Promise<void> {
  const sessionDirectory = join(workspace, ".opentag/pi-session");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "binding.json"), JSON.stringify({ sessionId: ownSessionId }));
  await writeFile(join(sessionDirectory, "history.jsonl"), `${JSON.stringify({ text: `${label}-history` })}\n`);
  await writeFile(join(workspace, `output-${label}.txt`), `${label}-output`);
}

/** Explicit execution double for one Session: both Sessions share the overlap/release barriers. */
function sessionWorker(control: {
  readonly label: "a" | "b";
  readonly sessionId: string;
  readonly workspace: string;
  readonly entered: Deferred;
  readonly siblingEntered: Deferred;
  readonly release?: Deferred;
  readonly running: Set<string>;
}): NonNullable<CloudTurnSeams["runWorker"]> {
  return async (workerInput, signal) => {
    const request = JSON.parse(workerInput.stdin) as { delivery: { sessionId: string }; executionDir: string };
    expect(request.delivery.sessionId).toBe(control.sessionId);
    expect(request.executionDir).toBe(`/run/${control.label}`);
    await writeSessionFiles(control.workspace, control.label, control.sessionId);
    control.running.add(control.label);
    control.entered.resolve();
    try {
      await untilAbortedOr(signal, control.siblingEntered.promise);
      await untilAbortedOr(signal, control.release?.promise ?? Promise.resolve());
      return {
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          kind: "result",
          completion: { outcome: "completed", executionEffects: "completed", finalText: `${control.label} done` },
        })}\n`,
      };
    } finally {
      control.running.delete(control.label);
    }
  };
}

async function expectSessionFiles(
  workspace: string,
  own: "a" | "b",
  ownSessionId: string,
  other: "a" | "b",
): Promise<void> {
  expect(await readFile(join(workspace, `output-${own}.txt`), "utf8")).toBe(`${own}-output`);
  expect(await readFile(join(workspace, ".opentag/pi-session/binding.json"), "utf8")).toContain(ownSessionId);
  const history = await readFile(join(workspace, ".opentag/pi-session/history.jsonl"), "utf8");
  expect(history).toContain(`${own}-history`);
  expect(history).not.toContain(`${other}-history`);
  await expect(readFile(join(workspace, `output-${other}.txt`), "utf8")).rejects.toThrow();
}

/** Same Agent, different Session of that Agent on each Runner. */
function sessionDelivery(ownSessionId: string): DirectImMessageDeliveryRequest {
  const fixture = cloudDeliveryFixture({ sessionId: ownSessionId });
  return { ...fixture, agentId, runtime: { ...fixture.runtime, agentId } };
}

function modelGrant(delivery: DirectImMessageDeliveryRequest) {
  return {
    baseUrl: "https://server.example.com/api/v1/cloud-model",
    token: "fixture-model-token-1234567890123456",
    model: delivery.runtime.model,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

interface WireTurnReport {
  readonly sessionId: string;
  readonly outcome: string;
  readonly errorReason?: string;
  readonly executionEffects: string;
  readonly finalText?: string;
  readonly turnId: string;
  readonly resultHash: string;
}

interface WireRunner {
  readonly sandboxName: string;
  readonly workspace: string;
  readonly native: { launch: Mock; destroy: Mock; probe: Mock };
  readonly webExecutions: Mock;
  readonly stop: AbortController;
  readonly running: Promise<number>;
}

/** One trusted Runner instance against one loopback peer; native/storage seams remain doubles. */
function startWireRunner(input: {
  root: string;
  peer: WirePeer;
  label: "a" | "b";
  generation: number;
  workspace: string;
  seams: CloudTurnSeams;
}): WireRunner {
  const sandboxName = `${input.peer.instancePrefix}-${input.generation}`;
  const native = {
    launch: vi.fn(async () => {
      await mkdir(input.workspace, { recursive: true });
    }),
    destroy: vi.fn(async () => undefined),
    probe: vi.fn(async () => ({ nodeVersion: "v24.20.0", piVersion: "test", runnerVersion: "0.0.5" })),
  };
  const webExecutions = vi.fn(async () => {
    expect(input.peer.object().saved).toBe(true);
    return {} as NativeWebExecutionChannel;
  });
  const stop = new AbortController();
  const running = runRunnerServe(
    {
      backendUrl: input.peer.url,
      bootstrapToken: `fixture-${input.generation}`,
      sandboxName,
      workspace: input.workspace,
      stateDir: join(input.root, `state-${input.label}-${input.generation}`),
      workspacePersistence: true,
      webTools: true,
    },
    {
      installSignalHandlers: false,
      signal: stop.signal,
      stderr: { write: () => undefined },
      sandboxFactory: () => native as unknown as NativeSandbox,
      webAuthority: {} as never,
      onWebGateway: (gateway) => {
        vi.spyOn(gateway, "openExecution").mockImplementation(webExecutions);
      },
      cloudTurnSeams: {
        openExecution: async () => ({ close: async () => undefined, executionDir: `/run/${input.label}` }),
        ...input.seams,
      },
    },
  );
  return { sandboxName, workspace: input.workspace, native, webExecutions, stop, running };
}

it.each(["pending", "accepted"] as const)(
  "seals a received %s input over the live control channel",
  async (custody) => {
    const root = await mkdtemp(join(tmpdir(), "opentag-receipt-seal-"));
    const peer = await protocolPeer();
    const runWorker = vi.fn(async () => {
      throw new Error("Received input must not execute while sealing");
    });
    const runner = startWireRunner({
      root,
      peer,
      label: "a",
      generation: 1,
      workspace: join(root, "workspace"),
      seams: {
        openExecution: async () => {
          throw new Error("No execution bridge before verification");
        },
        runWorker,
      },
    });
    try {
      await peer.wait("runner:ready");
      const delivery = cloudDeliveryFixture({ sessionId });
      peer.send({ type: "delivery:run", requestId: delivery.requestId, delivery });
      await peer.wait("delivery:received");
      const requestId = randomUUID();
      peer.send({ type: "workspace:seal", requestId });
      expect(await peer.wait("delivery:received", 1)).toMatchObject({ requestId: delivery.requestId });
      expect(peer.count("delivery:report")).toBe(0);
      if (custody === "pending") {
        peer.send({
          type: "delivery:verified",
          requestId: delivery.requestId,
          status: "rejected",
          code: "scope_inactive",
        });
      } else {
        peer.send({ type: "delivery:cancel", requestId: randomUUID(), deliveryId: delivery.deliveryId });
        const report = (await peer.wait("delivery:report")).report as WireTurnReport;
        expect(report).toMatchObject({ outcome: "cancelled", executionEffects: "not_started" });
        peer.send({
          type: "delivery:report:ack",
          requestId: randomUUID(),
          turnId: report.turnId,
          resultHash: report.resultHash,
          status: "recorded",
        });
      }
      expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });
      expect(peer.object().sealed).toBe(true);
      expect(runWorker).not.toHaveBeenCalled();
    } finally {
      runner.stop.abort();
      await runner.running;
      await peer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("runs two Sessions of one Agent concurrently and restores each Session independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e6-wire-"));
  const peerA = await protocolPeer({ instancePrefix: "ots-e6-a", sandboxId: sandboxA, sessionId: sessionA });
  const peerB = await protocolPeer({ instancePrefix: "ots-e6-b", sandboxId: sandboxB, sessionId: sessionB });
  const stops: AbortController[] = [];
  const processes: Promise<number>[] = [];
  const entered = { a: deferred(), b: deferred() };
  const release = { a: deferred(), b: deferred() };
  const running = new Set<string>();
  const delivery = { a: sessionDelivery(sessionA), b: sessionDelivery(sessionB) };
  const start = (label: "a" | "b", generation: number, workspace: string) => {
    const runner = startWireRunner({
      root,
      peer: label === "a" ? peerA : peerB,
      label,
      generation,
      workspace,
      seams: {
        runWorker: sessionWorker({
          label,
          sessionId: label === "a" ? sessionA : sessionB,
          workspace,
          entered: entered[label],
          siblingEntered: entered[label === "a" ? "b" : "a"],
          release: release[label],
          running,
        }),
      },
    });
    stops.push(runner.stop);
    processes.push(runner.running);
    return runner;
  };
  try {
    const runnerA = start("a", 1, join(root, "workspace-a"));
    const runnerB = start("b", 1, join(root, "workspace-b"));
    expect(peerA.identity.sessionId).not.toBe(peerB.identity.sessionId);
    expect(peerA.identity.sandboxId).not.toBe(peerB.identity.sandboxId);
    expect(runnerA.sandboxName).not.toBe(runnerB.sandboxName);
    expect(runnerA.workspace).not.toBe(runnerB.workspace);
    expect(delivery.a.agentId).toBe(delivery.b.agentId);
    expect(delivery.a.sessionId).not.toBe(delivery.b.sessionId);

    expect((await peerA.wait("runner:ready")).workspaceRestored).toBe(true);
    expect((await peerB.wait("runner:ready")).workspaceRestored).toBe(true);
    expect(peerA.readyObjects.at(-1)?.saved).toBe(true);
    expect(peerB.readyObjects.at(-1)?.saved).toBe(true);
    expect(runnerA.webExecutions).toHaveBeenCalledTimes(1);
    expect(runnerB.webExecutions).toHaveBeenCalledTimes(1);

    for (const [peer, each] of [
      [peerA, delivery.a],
      [peerB, delivery.b],
    ] as const) {
      peer.send({ type: "delivery:run", requestId: each.requestId, delivery: each });
      await peer.wait("delivery:received");
      peer.send({
        type: "delivery:verified",
        requestId: each.requestId,
        status: "verified",
        model: modelGrant(each),
      });
    }

    // Explicit overlap barrier: both native execution doubles are inside their worker at once.
    await Promise.all([entered.a.promise, entered.b.promise]);
    expect(running).toEqual(new Set(["a", "b"]));
    expect(peerA.count("delivery:report")).toBe(0);
    expect(peerB.count("delivery:report")).toBe(0);
    await expectSessionFiles(runnerA.workspace, "a", sessionA, "b");
    await expectSessionFiles(runnerB.workspace, "b", sessionB, "a");

    // Cancelling Session A while both run must not stop Session B's live execution.
    peerA.send({ type: "delivery:cancel", requestId: randomUUID(), deliveryId: delivery.a.deliveryId });
    const reportA = (await peerA.wait("delivery:report")).report as WireTurnReport;
    expect(reportA).toMatchObject({
      sessionId: sessionA,
      outcome: "cancelled",
      errorReason: "client_shutdown",
      executionEffects: "may_have_occurred",
    });
    expect(running.has("b")).toBe(true);
    expect(peerB.count("delivery:report")).toBe(0);

    release.b.resolve();
    const reportB = (await peerB.wait("delivery:report")).report as WireTurnReport;
    expect(reportB).toMatchObject({ sessionId: sessionB, outcome: "completed", executionEffects: "completed" });
    // Each Session checkpointed its own files, independent of the other's outcome.
    expect(Number(peerA.object().generation)).toBeGreaterThan(Number(peerA.readyObjects.at(-1)?.generation));
    expect(Number(peerB.object().generation)).toBeGreaterThan(Number(peerB.readyObjects.at(-1)?.generation));

    runnerA.stop.abort();
    runnerB.stop.abort();
    await Promise.all([runnerA.running, runnerB.running]);
    peerA.advance();
    peerB.advance();

    // Independent checkpoint/restore: each Session restores only its own files and Pi history.
    const restoredA = start("a", 2, join(root, "restored-a"));
    const restoredB = start("b", 2, join(root, "restored-b"));
    expect((await peerA.wait("runner:ready")).workspaceRestored).toBe(true);
    expect((await peerB.wait("runner:ready")).workspaceRestored).toBe(true);
    expect(restoredA.workspace).not.toBe(runnerA.workspace);
    expect(restoredB.workspace).not.toBe(runnerB.workspace);
    await expectSessionFiles(restoredA.workspace, "a", sessionA, "b");
    await expectSessionFiles(restoredB.workspace, "b", sessionB, "a");
  } finally {
    for (const stop of stops) stop.abort();
    await Promise.allSettled(processes);
    await Promise.all([peerA.close(), peerB.close()]);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("keeps Session B running to its own checkpoint when Session A cannot save", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e6-save-"));
  const peerA = await protocolPeer({
    instancePrefix: "ots-e6-a",
    sandboxId: sandboxA,
    sessionId: sessionA,
    rejectUploadsFrom: 2,
  });
  const peerB = await protocolPeer({ instancePrefix: "ots-e6-b", sandboxId: sandboxB, sessionId: sessionB });
  const stops: AbortController[] = [];
  const processes: Promise<number>[] = [];
  const entered = { a: deferred(), b: deferred() };
  const releaseB = deferred();
  const running = new Set<string>();
  const delivery = { a: sessionDelivery(sessionA), b: sessionDelivery(sessionB) };
  const start = (label: "a" | "b", generation: number, workspace: string) => {
    const runner = startWireRunner({
      root,
      peer: label === "a" ? peerA : peerB,
      label,
      generation,
      workspace,
      seams: {
        runWorker: sessionWorker({
          label,
          sessionId: label === "a" ? sessionA : sessionB,
          workspace,
          entered: entered[label],
          siblingEntered: entered[label === "a" ? "b" : "a"],
          ...(label === "b" ? { release: releaseB } : {}),
          running,
        }),
      },
    });
    stops.push(runner.stop);
    processes.push(runner.running);
    return runner;
  };
  try {
    const runnerA = start("a", 1, join(root, "workspace-a"));
    const runnerB = start("b", 1, join(root, "workspace-b"));
    expect((await peerA.wait("runner:ready")).workspaceRestored).toBe(true);
    expect((await peerB.wait("runner:ready")).workspaceRestored).toBe(true);
    // Each Session committed exactly once after its restore; Session A's next save fails.
    expect(peerA.readyObjects.at(-1)?.saved).toBe(true);
    expect(peerB.readyObjects.at(-1)?.saved).toBe(true);

    for (const [peer, each] of [
      [peerA, delivery.a],
      [peerB, delivery.b],
    ] as const) {
      peer.send({ type: "delivery:run", requestId: each.requestId, delivery: each });
      await peer.wait("delivery:received");
      peer.send({
        type: "delivery:verified",
        requestId: each.requestId,
        status: "verified",
        model: modelGrant(each),
      });
    }
    await Promise.all([entered.a.promise, entered.b.promise]);
    expect(running.has("b")).toBe(true);

    const reportA = (await peerA.wait("delivery:report")).report as WireTurnReport;
    expect(reportA).toMatchObject({
      sessionId: sessionA,
      outcome: "failed",
      errorReason: "workspace_failed",
      executionEffects: "completed",
    });
    expect(reportA.finalText).toContain("not durably saved");
    // Session B kept executing through Session A's durable-boundary failure.
    expect(running.has("b")).toBe(true);
    expect(peerB.count("delivery:report")).toBe(0);

    releaseB.resolve();
    const reportB = (await peerB.wait("delivery:report")).report as WireTurnReport;
    expect(reportB).toMatchObject({ sessionId: sessionB, outcome: "completed", executionEffects: "completed" });
    expect(Number(peerB.object().generation)).toBeGreaterThan(Number(peerB.readyObjects.at(-1)?.generation));
    await expectSessionFiles(runnerB.workspace, "b", sessionB, "a");
    // Session A's unsaved local effects stay on Session A's own root, never in Session B's.
    await expectSessionFiles(runnerA.workspace, "a", sessionA, "b");

    runnerA.stop.abort();
    runnerB.stop.abort();
    await Promise.all([runnerA.running, runnerB.running]);
    peerB.advance();

    // Session B's own checkpoint still restores cleanly; Session A's failed save stays out of it.
    const restoredB = start("b", 2, join(root, "restored-b"));
    expect((await peerB.wait("runner:ready")).workspaceRestored).toBe(true);
    await expectSessionFiles(restoredB.workspace, "b", sessionB, "a");
  } finally {
    for (const stop of stops) stop.abort();
    await Promise.allSettled(processes);
    await Promise.all([peerA.close(), peerB.close()]);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

/* ----------------------------------------------------------------------------------------------
 * E7 assignment rebind over the same physical Runner: one process, two Sessions.
 * ------------------------------------------------------------------------------------------- */

const REBIND_SANDBOX_B = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const REBIND_SESSION_B = "ffffffff-6666-4666-8666-ffffffffffff";
const REBIND_RESOURCE_UID = "uid-1";

async function buildSeededArchive(root: string, name: string, content: string): Promise<Buffer> {
  const seedDir = join(root, `seed-${name}`);
  await mkdir(seedDir, { recursive: true });
  await writeFile(join(seedDir, name), content);
  const archivePath = join(root, `seed-${name}.tar.gz`);
  await createWorkspaceArchive(seedDir, archivePath);
  return readFile(archivePath);
}

async function runRebindScenario(input: {
  root: string;
  peer: Awaited<ReturnType<typeof protocolPeer>>;
  stop: AbortController;
  state: { destroyed: number; launched: number };
  web?: { close: () => Promise<void> };
  /** Test seam: additional native delete behavior (for example a one-shot failure). */
  destroy?: () => Promise<void>;
  /** Test seam replacing the reconnect backoff so reconnects are observable, not timed. */
  sleep?: (ms: number) => Promise<void>;
}) {
  const workspace = join(input.root, "workspace");
  const stderr: string[] = [];
  (input.state as { stderr?: string[] }).stderr = stderr;
  const native = {
    launch: vi.fn(async () => {
      input.state.launched += 1;
    }),
    destroy: vi.fn(async () => {
      input.state.destroyed += 1;
      await input.destroy?.();
    }),
    probe: vi.fn(async () => ({ nodeVersion: "v24.20.0", piVersion: "test", runnerVersion: "0.0.5" })),
  };
  const running = runRunnerServe(
    {
      backendUrl: input.peer.url,
      bootstrapToken: "fixture-a",
      controlToken: "control-a",
      sandboxName: "ots-test-1",
      workspace,
      stateDir: join(input.root, "private"),
      workspacePersistence: true,
      ...(input.web ? { webTools: true } : {}),
    },
    {
      installSignalHandlers: false,
      signal: input.stop.signal,
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      sandboxFactory: () => native as unknown as NativeSandbox,
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(input.web
        ? {
            webAuthority: {} as never,
            onWebGateway: (gateway: { openExecution: (...args: never[]) => Promise<NativeWebExecutionChannel> }) => {
              vi.spyOn(gateway, "openExecution").mockResolvedValue({
                close: input.web?.close,
              } as never);
            },
          }
        : {}),
    },
  );
  return { workspace, native, running, stderr };
}

function rebindWelcomeReply(frame: Record<string, unknown>) {
  return [
    { type: "auth:result", ok: true, ...(frame.requestId ? { requestId: frame.requestId } : {}) },
    {
      type: "server:welcome",
      protocolVersion: 1,
      sandboxId: REBIND_SANDBOX_B,
      sessionId: REBIND_SESSION_B,
      environmentGeneration: 2,
      // The physical Instance identity never changes across a Session transfer.
      resourceName: "projects/p/locations/r/instances/ots-test-1",
      resourceUid: REBIND_RESOURCE_UID,
      cloudDeliveryVersion: 1,
      workspaceVersion: 1,
      reuseVersion: 1,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 10_000,
    },
    { type: "server:credential", token: "fixture-b" },
  ];
}

it("rebinds one physical Runner to a transferred Session, restoring only its archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-rebind-"));
  let httpToken = "fixture-a";
  let firstAuth: Record<string, unknown> | undefined;
  const peer = await protocolPeer({
    httpToken: () => httpToken,
    authReply: (frame, attempt) => {
      if (attempt === 1) {
        firstAuth = frame;
        return undefined;
      }
      httpToken = "fixture-b";
      return rebindWelcomeReply(frame);
    },
  });
  const stop = new AbortController();
  const state = { destroyed: 0, launched: 0 };
  const { workspace, running } = await runRebindScenario({ root, peer, stop, state });
  try {
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    expect(firstAuth).toMatchObject({
      controlToken: "control-a",
      reuseVersion: 1,
      workspaceVersion: 1,
      token: "fixture-a",
    });
    expect(peer.claimTokens).toEqual(["Bearer fixture-a"]);
    await writeFile(join(workspace, "old-session.txt"), "not visible to the next Session");
    // Private trusted-parent material must be removed by the rebind: neither the journal root, nor
    // per-turn credential material, nor the public socket root can leak into the next Session.
    await mkdir(join(root, "private", "turn-material"), { recursive: true });
    await mkdir(join(root, "private", "bridge-public"), { recursive: true });
    await writeFile(join(root, "private", "turn-material", "stale-credential"), "A private");
    await writeFile(join(root, "private", "bridge-public", "stale.sock"), "A public");
    const requestId = randomUUID();
    peer.send({ type: "workspace:seal", requestId });
    expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });

    // The borrower has its own storage URI and its own archive: the rebind must download and
    // restore B's bytes, not merely wipe A's workspace.
    peer.seedObject(await buildSeededArchive(root, "b-marker.txt", "B assignment state"));
    peer.advance();
    peer.disconnect();
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    expect(peer.claimTokens).toEqual(["Bearer fixture-a", "Bearer fixture-b"]);
    expect(state.destroyed).toBeGreaterThanOrEqual(1);
    expect(await readFile(join(workspace, "b-marker.txt"), "utf8")).toBe("B assignment state");
    await expect(readFile(join(workspace, "old-session.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, "private", "turn-material"))).toEqual([]);
    expect(await readdir(join(root, "private", "bridge-public"))).toEqual([]);
  } finally {
    stop.abort();
    await running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("requires the assignment credential on a process restart, never the static birth bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-restart-"));
  let httpToken = "fixture-a";
  let restarted = false;
  const peer = await protocolPeer({
    httpToken: () => httpToken,
    authReply: (frame) =>
      restarted
        ? [
            { type: "auth:result", ok: true, ...(frame.requestId ? { requestId: frame.requestId } : {}) },
            {
              type: "server:welcome",
              protocolVersion: 1,
              sandboxId,
              sessionId,
              environmentGeneration: 1,
              resourceName: "projects/p/locations/r/instances/ots-test-1",
              resourceUid: "uid-1",
              cloudDeliveryVersion: 1,
              workspaceVersion: 1,
              reuseVersion: 1,
              heartbeatIntervalMs: 50,
              heartbeatTimeoutMs: 10_000,
            },
            { type: "server:credential", token: "fixture-fresh" },
          ]
        : undefined,
  });
  const workspace = join(root, "workspace");
  const stateDir = join(root, "private");
  const start = () => {
    const stop = new AbortController();
    const running = runRunnerServe(
      {
        backendUrl: peer.url,
        bootstrapToken: "fixture-a",
        controlToken: "control-a",
        sandboxName: "ots-test-1",
        workspace,
        stateDir,
        workspacePersistence: true,
      },
      {
        installSignalHandlers: false,
        signal: stop.signal,
        stderr: { write: () => undefined },
        sandboxFactory: () =>
          ({
            launch: async () => undefined,
            destroy: async () => undefined,
            probe: async () => ({ nodeVersion: "v24.20.0", piVersion: "test", runnerVersion: "0.0.5" }),
          }) as unknown as NativeSandbox,
      },
    );
    return { stop, running };
  };

  const first = start();
  await peer.wait("runner:ready");
  // The marker records an unsealed local assignment; the `httpToken` fixture is then rotated so
  // only the Server-issued credential for the restarted parent can claim the workspace.
  await vi.waitFor(() => expect(peer.object().saved).toBe(true));
  first.stop.abort();
  await first.running;

  restarted = true;
  httpToken = "fixture-fresh";
  const second = start();
  try {
    await peer.wait("runner:ready", 1);
    expect(peer.claimTokens).toEqual(["Bearer fixture-a", "Bearer fixture-fresh"]);
  } finally {
    second.stop.abort();
    await second.running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("requires the welcomed credential on a control first bind even with no local marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-first-bind-"));
  const peer = await protocolPeer({
    // Only the Server-issued credential for the welcomed assignment is accepted: the static env
    // bearer (birth Session A) would be visible as a rejected claim attempt.
    httpToken: () => "fixture-b",
    authReply: (frame) => [
      { type: "auth:result", ok: true, ...(frame.requestId ? { requestId: frame.requestId } : {}) },
      {
        type: "server:welcome",
        protocolVersion: 1,
        sandboxId: REBIND_SANDBOX_B,
        sessionId: REBIND_SESSION_B,
        environmentGeneration: 1,
        resourceName: "projects/p/locations/r/instances/ots-test-1",
        resourceUid: REBIND_RESOURCE_UID,
        cloudDeliveryVersion: 1,
        workspaceVersion: 1,
        reuseVersion: 1,
        heartbeatIntervalMs: 50,
        heartbeatTimeoutMs: 10_000,
      },
    ],
  });
  const stop = new AbortController();
  const state = { destroyed: 0, launched: 0 };
  const { running } = await runRebindScenario({ root, peer, stop, state });
  try {
    await peer.wait("auth");
    // The Runner is connected and heartbeating while it waits; no HTTP claim may have used the
    // static birth bearer before the current assignment credential arrived.
    await peer.wait("heartbeat", 1);
    expect(peer.claimTokens).toEqual([]);
    peer.send({ type: "server:credential", token: "fixture-b" });
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    expect(peer.claimTokens).toEqual(["Bearer fixture-b"]);
  } finally {
    stop.abort();
    await running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("fails closed for an unmarked new assignment when stale local state exists", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-unmarked-"));
  let httpToken = "fixture-a";
  const peer = await protocolPeer({
    httpToken: () => httpToken,
    authReply: (frame, attempt) => {
      if (attempt === 1) return undefined;
      httpToken = "fixture-b";
      return rebindWelcomeReply(frame);
    },
  });
  const stop = new AbortController();
  const state = { destroyed: 0, launched: 0 };
  const { workspace, running } = await runRebindScenario({ root, peer, stop, state });
  expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
  // The workspace is sealed, then the trusted marker is removed: the local bytes still exist but
  // nothing proves they belong to a settled assignment, so the new one must be refused.
  const requestId = randomUUID();
  peer.send({ type: "workspace:seal", requestId });
  expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });
  await writeFile(join(workspace, "unsaved.txt"), "bytes with no marker");
  stop.abort();
  await running;
  // Restart on the same state root with the marker gone but the workspace still populated.
  await rm(join(root, "private", "assignment.json"), { force: true });
  const secondStop = new AbortController();
  const secondState = { destroyed: 0, launched: 0 };
  const second = await runRebindScenario({
    root,
    peer,
    stop: secondStop,
    state: secondState,
    sleep: async () => undefined,
  });
  try {
    peer.advance();
    await vi.waitFor(
      () => {
        expect(second.stderr.join("")).toContain("refusing a new assignment: unmarked local workspace state exists");
      },
      { timeout: 5_000, interval: 25 },
    );
    expect(peer.count("runner:ready")).toBe(0);
    expect(await readFile(join(root, "workspace", "unsaved.txt"), "utf8")).toBe("bytes with no marker");
  } finally {
    secondStop.abort();
    await second.running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("drains an in-flight rebind cleanup before the next connection can start", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-drain-"));
  let httpToken = "fixture-a";
  let attempts = 0;
  const peer = await protocolPeer({
    httpToken: () => httpToken,
    authReply: (frame, attempt) => {
      attempts = attempt;
      if (attempt === 1) return undefined;
      httpToken = "fixture-b";
      return rebindWelcomeReply(frame);
    },
  });
  const stop = new AbortController();
  const state = { destroyed: 0, launched: 0 };
  const closeStarted = deferred();
  const allowClose = deferred();
  let reconnectCalls = 0;
  const { running } = await runRebindScenario({
    root,
    peer,
    stop,
    state,
    web: {
      close: async () => {
        closeStarted.resolve();
        await allowClose.promise;
      },
    },
    sleep: async () => {
      reconnectCalls += 1;
    },
  });
  try {
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    const requestId = randomUUID();
    peer.send({ type: "workspace:seal", requestId });
    expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });
    peer.seedObject(await buildSeededArchive(root, "b-marker.txt", "B assignment state"));
    peer.advance(); // the peer's storage generation catches up with the B welcome

    // The next connection triggers the rebind cleanup; park it inside the cleanup close.
    peer.disconnect();
    await closeStarted.promise;
    // Disconnect the connection that owns the in-flight cleanup.
    peer.disconnect();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // No successor connection may start while the old cleanup is unsettled, and readiness must
    // not be published for the new assignment yet.
    expect(reconnectCalls).toBe(1);
    expect(attempts).toBe(2);
    expect(peer.count("auth")).toBe(1);
    expect(peer.count("runner:ready")).toBe(0);

    allowClose.resolve();
    await vi.waitFor(() => expect(reconnectCalls).toBe(2));
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(peer.count("auth")).toBe(2);
    expect(await readFile(join(root, "workspace", "b-marker.txt"), "utf8")).toBe("B assignment state");
  } finally {
    allowClose.resolve();
    stop.abort();
    await running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("persists the durable marker before adopting the new assignment in memory", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-marker-write-"));
  let httpToken = "fixture-a";
  const peer = await protocolPeer({
    httpToken: () => httpToken,
    authReply: (frame, attempt) => {
      if (attempt === 1) return undefined;
      httpToken = "fixture-b";
      return rebindWelcomeReply(frame);
    },
  });
  const stop = new AbortController();
  const state = { destroyed: 0, launched: 0 };
  const allowReconnect = deferred();
  let reconnectCalls = 0;
  const { workspace, running, stderr } = await runRebindScenario({
    root,
    peer,
    stop,
    state,
    sleep: async () => {
      reconnectCalls += 1;
      if (reconnectCalls > 1) await allowReconnect.promise;
    },
  });
  try {
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    const requestId = randomUUID();
    peer.send({ type: "workspace:seal", requestId });
    expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });
    peer.seedObject(await buildSeededArchive(root, "b-marker.txt", "B assignment state"));
    peer.advance();

    // Block the next durable marker write: the atomic rename cannot replace a directory.
    await rm(join(root, "private", "assignment.json"), { force: true });
    await mkdir(join(root, "private", "assignment.json"), { recursive: true });

    peer.disconnect();
    await vi.waitFor(
      () => {
        expect(stderr.join("")).toContain("The Runner assignment marker was not durable");
      },
      { timeout: 5_000, interval: 25 },
    );
    // The failed write is not adopted in memory: the runner parks before another reconnect and
    // prepares nothing while the durable marker still proves the old sealed assignment.
    expect(reconnectCalls).toBe(2);
    expect(peer.claimTokens).toEqual(["Bearer fixture-a"]);
    expect(peer.count("runner:ready")).toBe(0);

    // Unblock and let the retry persist the marker before it prepares the new assignment.
    await rm(join(root, "private", "assignment.json"), { recursive: true, force: true });
    allowReconnect.resolve();
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    const persisted = JSON.parse(await readFile(join(root, "private", "assignment.json"), "utf8")) as {
      sandboxId: string;
    };
    expect(persisted.sandboxId).toBe(REBIND_SANDBOX_B);
    expect(peer.claimTokens).toEqual(["Bearer fixture-a", "Bearer fixture-b"]);
    expect(await readFile(join(workspace, "b-marker.txt"), "utf8")).toBe("B assignment state");
  } finally {
    allowReconnect.resolve();
    stop.abort();
    await running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("fails fatally and stops reconnecting when rebind cleanup cannot delete the native sandbox", {
  timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-destroy-fail-"));
  let httpToken = "fixture-a";
  const peer = await protocolPeer({
    httpToken: () => httpToken,
    authReply: (frame, attempt) => {
      if (attempt === 1) return undefined;
      httpToken = "fixture-b";
      return rebindWelcomeReply(frame);
    },
  });
  const firstStop = new AbortController();
  const first = await runRebindScenario({
    root,
    peer,
    stop: firstStop,
    state: { destroyed: 0, launched: 0 },
  });
  try {
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    const requestId = randomUUID();
    peer.send({ type: "workspace:seal", requestId });
    expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });
    firstStop.abort();
    expect(await first.running).toBe(143);
  } finally {
    firstStop.abort();
  }
  peer.advance();

  // The restarted parent launches the native sandbox before the welcome; its rebind cleanup now
  // cannot delete that namespace. The Runner must terminate instead of reconnecting over it.
  let destroyCalls = 0;
  let reconnectCalls = 0;
  const secondStop = new AbortController();
  const secondState = { destroyed: 0, launched: 0 };
  const second = await runRebindScenario({
    root,
    peer,
    stop: secondStop,
    state: secondState,
    destroy: async () => {
      destroyCalls += 1;
      if (destroyCalls === 1) throw new Error("sandbox delete failed");
    },
    sleep: async () => {
      reconnectCalls += 1;
    },
  });
  try {
    expect(await second.running).toBe(5);
    expect(secondState.launched).toBe(1);
    // The fatal cleanup failure plus the shutdown retry; no reconnect over the unverified namespace.
    expect(destroyCalls).toBe(2);
    expect(reconnectCalls).toBe(0);
    expect(peer.count("runner:ready")).toBe(0);
    expect(peer.claimTokens).toEqual(["Bearer fixture-a"]);
  } finally {
    secondStop.abort();
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("fails closed when a new assignment arrives without a sealed workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-unsealed-"));
  let httpToken = "fixture-a";
  const peer = await protocolPeer({
    httpToken: () => httpToken,
    authReply: (frame, attempt) => {
      if (attempt === 1) return undefined;
      httpToken = "fixture-b";
      return rebindWelcomeReply(frame);
    },
  });
  const stop = new AbortController();
  const state = { destroyed: 0, launched: 0 };
  const { running, stderr } = await runRebindScenario({ root, peer, stop, state });
  try {
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    // No seal: the old assignment may still hold unsaved work, so B must never execute. The
    // refusal is observed on the Runner's own log, with no sleep-based timing assumption.
    peer.advance();
    peer.disconnect();
    await vi.waitFor(
      () => {
        expect(stderr.join("")).toContain("refusing a new assignment: the previous workspace was not sealed");
      },
      { timeout: 5_000, interval: 50 },
    );
    expect(peer.claimTokens).toEqual(["Bearer fixture-a"]);
    expect(peer.count("runner:ready")).toBe(0);
  } finally {
    stop.abort();
    await running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("fails closed when rebind cleanup cannot close the previous web execution", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-e7-cleanup-fail-"));
  let httpToken = "fixture-a";
  const peer = await protocolPeer({
    httpToken: () => httpToken,
    authReply: (frame, attempt) => {
      if (attempt === 1) return undefined;
      httpToken = "fixture-b";
      return rebindWelcomeReply(frame);
    },
  });
  const stop = new AbortController();
  const state = { destroyed: 0, launched: 0 };
  const { workspace, running, stderr } = await runRebindScenario({
    root,
    peer,
    stop,
    state,
    web: {
      close: async () => {
        throw new Error("cleanup failed");
      },
    },
  });
  try {
    expect((await peer.wait("runner:ready")).workspaceRestored).toBe(true);
    await writeFile(join(workspace, "old-session.txt"), "must survive a failed cleanup");
    // The previous assignment IS sealed, so the rebind reaches the cleanup step whose execution
    // close is forced to fail: the failure must stop the hand-off.
    const requestId = randomUUID();
    peer.send({ type: "workspace:seal", requestId });
    expect(await peer.wait("workspace:seal:result")).toMatchObject({ requestId, ok: true });
    peer.seedObject(await buildSeededArchive(root, "b-marker.txt", "must not be restored"));
    peer.advance();
    peer.disconnect();
    await vi.waitFor(
      () => {
        expect(stderr.join("")).toContain("cleanup failed");
      },
      { timeout: 5_000, interval: 50 },
    );
    expect(peer.claimTokens).toEqual(["Bearer fixture-a"]);
    expect(peer.count("runner:ready")).toBe(0);
    // The unsealed/old workspace is retained, never replaced by the new assignment's archive.
    expect(await readFile(join(workspace, "old-session.txt"), "utf8")).toBe("must survive a failed cleanup");
    // No claim/PUT ran for the new assignment: the seeded object is untouched.
    expect(peer.object().generation).toBe("1");
  } finally {
    stop.abort();
    await running;
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});
