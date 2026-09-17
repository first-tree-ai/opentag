import { randomUUID } from "node:crypto";
import {
  HTTP_PATHS,
  PROVIDER_PROXY_MAX_FRAME_BYTES,
  RUNNER_WS_CLOSE,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_PROVIDER_PROXY_PATH,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
} from "@opentag/shared";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { registerExecutionWebSocketRoutes } from "../api/execution-websockets.js";
import { AuthServiceError } from "../services/auth/index.js";
import { RunnerBootstrapTokenService } from "../services/sandboxes/runner-bootstrap-token.js";
import { RunnerHub } from "../services/sandboxes/runner-hub.js";

/** Echo transport: reports every frame's byte length and binary flag back to the client. */
const echoProxyTransport = {
  attach(socket: WebSocket) {
    socket.on("message", (data, binary) =>
      socket.send(JSON.stringify({ length: Buffer.byteLength(data as Buffer), binary })),
    );
  },
};

function exchange(address: string, path: string, payload: string): Promise<{ code: number; frames: unknown[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address.replace("http:", "ws:") + path);
    const frames: unknown[] = [];
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Socket did not close"));
    }, 3_000);
    socket.on("open", () => socket.send(payload));
    socket.on("message", (data) => frames.push(JSON.parse(String(data))));
    socket.on("error", reject);
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, frames });
    });
  });
}

function binaryExchange(address: string, path: string, payload: Buffer): Promise<{ length: number; binary: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address.replace("http:", "ws:") + path);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Proxy socket did not answer"));
    }, 3_000);
    socket.on("open", () => socket.send(payload));
    socket.on("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(String(data)));
    });
    socket.on("error", reject);
  });
}

it("Local Computer and Cloud Runner share one upgrade listener but retain separate protocol bounds", async () => {
  const app = Fastify();
  registerExecutionWebSocketRoutes(app, {
    computerService: {} as never,
    machineAuthService: {} as never,
    sandboxRunnerService: {} as never,
    runnerChannel: {
      tokens: new RunnerBootstrapTokenService("test-only-bootstrap-key-with-32-characters"),
      hub: new RunnerHub(),
    },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(app.server.listenerCount("upgrade")).toBe(1);
    const padding = " ".repeat(RUNTIME_MAX_FRAME_BYTES);
    const [local, cloud] = await Promise.all([
      exchange(address, HTTP_PATHS.computerRuntimeWebSocket, `${padding}{}`),
      exchange(address, HTTP_PATHS.sandboxRunnerWebSocket, `${padding}{"type":"auth","token":"invalid"}`),
    ]);
    expect(local.frames).toContainEqual(
      expect.objectContaining({ type: "error", code: "PROTOCOL_ERROR", message: "The runtime frame is too large" }),
    );
    expect(cloud.frames).toContainEqual(expect.objectContaining({ type: "auth:result", ok: false }));
    expect(cloud.code).toBe(RUNNER_WS_CLOSE.authFailed);
  } finally {
    await app.close();
  }
});

it("Runner, local runtime, and provider proxy routes compose with separate frame budgets", async () => {
  const app = Fastify();
  registerExecutionWebSocketRoutes(app, {
    computerService: {} as never,
    machineAuthService: {} as never,
    sandboxRunnerService: {} as never,
    runnerChannel: {
      tokens: new RunnerBootstrapTokenService("test-only-bootstrap-key-with-32-characters"),
      hub: new RunnerHub(),
    },
    runtimeProviderProxy: { transport: echoProxyTransport as never },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(app.server.listenerCount("upgrade")).toBe(1);
    const padding = " ".repeat(RUNTIME_MAX_FRAME_BYTES);
    const [local, cloud, proxy] = await Promise.all([
      exchange(address, HTTP_PATHS.computerRuntimeWebSocket, `${padding}{}`),
      exchange(address, HTTP_PATHS.sandboxRunnerWebSocket, `${padding}{"type":"auth","token":"invalid"}`),
      binaryExchange(address, RUNTIME_PROVIDER_PROXY_PATH, Buffer.alloc(PROVIDER_PROXY_MAX_FRAME_BYTES)),
    ]);
    // The local runtime keeps its 64 KiB application-level bound…
    expect(local.frames).toContainEqual(
      expect.objectContaining({ type: "error", code: "PROTOCOL_ERROR", message: "The runtime frame is too large" }),
    );
    // …the Runner control channel still accepts a frame larger than 64 KiB…
    expect(cloud.frames).toContainEqual(expect.objectContaining({ type: "auth:result", ok: false }));
    expect(cloud.code).toBe(RUNNER_WS_CLOSE.authFailed);
    // …and one full binary proxy chunk (64 KiB + header) reaches the transport untouched even
    // with the Runner channel mounted on the same upgrade listener.
    expect(proxy).toEqual({ length: PROVIDER_PROXY_MAX_FRAME_BYTES, binary: true });
  } finally {
    await app.close();
  }
});

it("without a Runner, the proxy keeps its full binary chunk budget and the local runtime keeps its bound", async () => {
  // Runner allocation disabled is the product default; the transport budget then collapses to
  // the proxy bound, and a 64 KiB maxPayload would sever the last 4 bytes of a full chunk.
  const app = Fastify();
  registerExecutionWebSocketRoutes(app, {
    computerService: {} as never,
    machineAuthService: {} as never,
    runtimeProviderProxy: { transport: echoProxyTransport as never },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(app.server.listenerCount("upgrade")).toBe(1);
    const padding = " ".repeat(RUNTIME_MAX_FRAME_BYTES);
    const [local, proxy] = await Promise.all([
      exchange(address, HTTP_PATHS.computerRuntimeWebSocket, `${padding}{}`),
      binaryExchange(address, RUNTIME_PROVIDER_PROXY_PATH, Buffer.alloc(PROVIDER_PROXY_MAX_FRAME_BYTES)),
    ]);
    expect(local.frames).toContainEqual(
      expect.objectContaining({ type: "error", code: "PROTOCOL_ERROR", message: "The runtime frame is too large" }),
    );
    expect(proxy).toEqual({ length: PROVIDER_PROXY_MAX_FRAME_BYTES, binary: true });
  } finally {
    await app.close();
  }
});

it.each([{ override: true }, { override: false }])(
  "runtime first-frame authentication uses runtimeAuthService only when provided (override=$override)",
  async ({ override }) => {
    const reject = () =>
      new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "machine authentication required", 401);
    const selected = { verifyMachineToken: vi.fn().mockRejectedValue(reject()) };
    const unselected = { verifyMachineToken: vi.fn().mockRejectedValue(reject()) };
    const app = Fastify();
    registerExecutionWebSocketRoutes(app, {
      computerService: {} as never,
      machineAuthService: (override ? unselected : selected) as never,
      ...(override ? { runtimeAuthService: selected as never } : {}),
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const result = await exchange(
        address,
        HTTP_PATHS.computerRuntimeWebSocket,
        JSON.stringify({
          type: "auth",
          requestId: randomUUID(),
          protocolVersion: RUNTIME_PROTOCOL_V2,
          supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
          machineToken: "fixture-token",
        }),
      );
      expect(result.frames).toContainEqual(expect.objectContaining({ type: "error", code: "AUTH_INVALID_TOKEN" }));
      expect(result.code).toBe(4401);
      expect(selected.verifyMachineToken).toHaveBeenCalledWith("fixture-token");
      expect(unselected.verifyMachineToken).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
