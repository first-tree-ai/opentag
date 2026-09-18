import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerWorkspaceObject } from "@opentag/shared";
import { expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { NativeSandbox } from "../runner/native-sandbox.js";
import { runRunnerServe } from "../runner/serve.js";
import type { NativeWebExecutionChannel } from "../runner/web-gateway.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const sandboxId = "2b63a21e-f6c7-4474-91ea-4dabf0566a24";
const sessionId = "5f9a1c3e-2d4b-4e6f-8a1b-9c0d1e2f3a4b";

function digest(bytes: Buffer) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    md5: createHash("md5").update(bytes).digest("base64"),
  };
}

/** A storage/control protocol peer over real loopback HTTP + WS; not a GCP/native substitute. */
async function protocolPeer() {
  let generation = 1;
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
  const waiters = new Set<() => void>();
  const readyObjects: RunnerWorkspaceObject[] = [];
  const upload = async (request: IncomingMessage, response: ServerResponse) => {
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
    if (request.headers.authorization !== `Bearer fixture-${generation}`) {
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
  wss.on("connection", (socket) => {
    current = socket;
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "auth") {
        expect(frame.workspaceVersion).toBe(1);
        socket.send(JSON.stringify({ type: "auth:result", ok: true }));
        socket.send(
          JSON.stringify({
            type: "server:welcome",
            protocolVersion: 1,
            sandboxId,
            sessionId,
            environmentGeneration: generation,
            resourceName: `projects/p/locations/r/instances/ots-test-${generation}`,
            resourceUid: `uid-${generation}`,
            cloudDeliveryVersion: 1,
            workspaceVersion: 1,
            heartbeatIntervalMs: 50,
            heartbeatTimeoutMs: 10_000,
          }),
        );
      }
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
    readyObjects,
    object: () => ({ ...object }),
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
