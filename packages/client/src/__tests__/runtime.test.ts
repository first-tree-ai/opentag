import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { AccessTokenProvider } from "../auth/token-provider.js";
import { RuntimeConnection } from "../runtime/runtime-connection.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((close) => close())));

describe("RuntimeConnection", () => {
  it("authenticates, registers a fresh instance, heartbeats, and stops without reconnecting", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const frames: Array<Record<string, unknown>> = [];
    const computerId = randomUUID();
    const instanceId = randomUUID();
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "auth") {
          completeAuth(socket, frame);
        } else if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
        } else if (frame.type === "heartbeat") {
          socket.send(
            JSON.stringify({
              type: "heartbeat:result",
              requestId: frame.requestId,
              ok: true,
              serverTime: new Date().toISOString(),
            }),
          );
          connection.stop();
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId, serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId,
      jitter: () => 0,
      platform: "linux",
      tokenProvider: tokenProvider(),
    });

    await connection.run();
    expect(frames.map((frame) => frame.type)).toEqual(["auth", "computer:register", "heartbeat"]);
    expect(frames[0]).toMatchObject({ protocolVersion: 1 });
    const register = frames[1];
    expect(register).toMatchObject({ computerId, displayName: "workstation", platform: "linux" });
    expect(register).not.toHaveProperty("teamId");
    expect(register?.instanceId).toBe(instanceId);
  });

  it("forces token refresh before reconnecting at the proactive refresh boundary", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    let connections = 0;
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      connections += 1;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(1_000, 2_000), connections === 1 ? 30 : 60_000);
        } else if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          if (connections === 2) connection.stop();
        }
      });
    });
    const getAccessTokenLease = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "old", expiresAt: new Date(Date.now() + 30).toISOString() })
      .mockResolvedValue({ accessToken: "new", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    connection = new RuntimeConnection({
      arch: "arm64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "darwin",
      tokenProvider: { getAccessTokenLease } as unknown as AccessTokenProvider,
    });

    await connection.run();
    expect(getAccessTokenLease.mock.calls).toEqual([[false], [true]]);
  });

  it("force-refreshes and reconnects when a registered server expires the access token", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    let connections = 0;
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      connections += 1;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(1_000, 2_000));
        } else if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          if (connections === 1) {
            socket.send(JSON.stringify({ type: "error", code: "AUTH_INVALID_TOKEN", message: "expired" }));
          } else {
            connection.stop();
          }
        }
      });
    });
    const getAccessTokenLease = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "old", expiresAt: new Date(Date.now() + 60_000).toISOString() })
      .mockResolvedValue({ accessToken: "new", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      tokenProvider: { getAccessTokenLease } as unknown as AccessTokenProvider,
    });

    await connection.run();
    expect(getAccessTokenLease.mock.calls).toEqual([[false], [true]]);
    expect(connections).toBe(2);
  });

  it("reuses a process instance across reconnects and resets backoff after registration", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const instanceId = randomUUID();
    const registeredInstanceIds: unknown[] = [];
    const retryDelays: number[] = [];
    let connections = 0;
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      connections += 1;
      if (connections <= 2) {
        socket.terminate();
        return;
      }
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(1_000, 2_000));
        } else if (frame.type === "computer:register") {
          registeredInstanceIds.push(frame.instanceId);
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          if (connections === 3) {
            setTimeout(() => socket.terminate(), 5);
          } else {
            connection.stop();
          }
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId,
      jitter: () => 1,
      platform: "linux",
      tokenProvider: tokenProvider(),
      waitForRetry: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    });

    await connection.run();
    expect(registeredInstanceIds).toEqual([instanceId, instanceId]);
    expect(retryDelays).toEqual([1_000, 2_000, 1_000]);
  });

  it("uses a distinct instance identity for another daemon process", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const instanceIds = [randomUUID(), randomUUID()];
    const registeredInstanceIds: unknown[] = [];
    let active: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(1_000, 2_000));
        } else if (frame.type === "computer:register") {
          registeredInstanceIds.push(frame.instanceId);
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          active.stop();
        }
      });
    });
    for (const instanceId of instanceIds) {
      active = new RuntimeConnection({
        arch: "x64",
        clientVersion: "0.0.1",
        computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
        displayName: "workstation",
        instanceId,
        platform: "linux",
        tokenProvider: tokenProvider(),
      });
      await active.run();
    }

    expect(registeredInstanceIds).toEqual(instanceIds);
  });

  it("does not create a WebSocket when stopped while the access token is pending", async () => {
    let finishToken: ((lease: { accessToken: string; expiresAt: string }) => void) | undefined;
    const getAccessTokenLease = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        finishToken = resolve;
      }),
    );
    const webSocketFactory = vi.fn((_url: string) => {
      throw new Error("WebSocket must not be created after stop");
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: {
        version: 1,
        computerId: randomUUID(),
        serverUrl: "http://127.0.0.1:3000",
        userId: randomUUID(),
      },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      tokenProvider: { getAccessTokenLease } as unknown as AccessTokenProvider,
      webSocketFactory,
    });

    const running = connection.run();
    await vi.waitFor(() => expect(getAccessTokenLease).toHaveBeenCalledOnce());
    connection.stop();
    finishToken?.({ accessToken: "access", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await running;

    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("keeps heartbeats single-flight when a result is slower than the interval", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    let heartbeatCount = 0;
    let releaseFirstHeartbeat: ((sendResult: () => void) => void) | undefined;
    let finishSecondHeartbeat: (() => void) | undefined;
    const firstHeartbeat = new Promise<() => void>((resolve) => {
      releaseFirstHeartbeat = resolve;
    });
    const secondHeartbeat = new Promise<void>((resolve) => {
      finishSecondHeartbeat = resolve;
    });
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(10, 500));
        } else if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
        } else if (frame.type === "heartbeat") {
          heartbeatCount += 1;
          const sendResult = () =>
            socket.send(
              JSON.stringify({
                type: "heartbeat:result",
                requestId: frame.requestId,
                ok: true,
                serverTime: new Date().toISOString(),
              }),
            );
          if (heartbeatCount === 1) releaseFirstHeartbeat?.(sendResult);
          else {
            connection.stop();
            finishSecondHeartbeat?.();
          }
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      tokenProvider: tokenProvider(),
    });

    const running = connection.run();
    const sendFirstResult = await firstHeartbeat;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(heartbeatCount).toBe(1);
    sendFirstResult();
    await secondHeartbeat;
    await running;
    expect(heartbeatCount).toBe(2);
  });

  it("fails closed on an unmatched heartbeat result", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(10, 500));
        } else if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
        } else if (frame.type === "heartbeat") {
          socket.send(
            JSON.stringify({
              type: "heartbeat:result",
              requestId: randomUUID(),
              ok: true,
              serverTime: new Date().toISOString(),
            }),
          );
        }
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      tokenProvider: tokenProvider(),
    });

    await expect(connection.run()).rejects.toThrow("unmatched heartbeat result");
  });

  it("fails closed on a protocol mismatch", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type !== "auth") return;
        socket.send(
          JSON.stringify({
            type: "auth:result",
            requestId: frame.requestId,
            ok: true,
            userId: randomUUID(),
            tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
        socket.send(JSON.stringify({ ...welcome(), protocolVersion: 2 }));
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      tokenProvider: tokenProvider(),
    });
    await expect(connection.run()).rejects.toThrow("protocol version is unsupported");
  });

  it("publishes registered state, dispatches business frames in isolation, and sends through the active socket", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    let receiveBusinessResult: ((frame: Record<string, unknown>) => void) | undefined;
    const businessResult = new Promise<Record<string, unknown>>((resolve) => {
      receiveBusinessResult = resolve;
    });
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") completeAuth(socket, frame, welcome(1_000, 2_000));
        else if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          setImmediate(() => socket.send(JSON.stringify({ type: "test:event", value: 1 })));
        } else if (frame.type === "test:result") receiveBusinessResult?.(frame);
      });
    });
    const logs: RecordedLog[] = [];
    const received: Record<string, unknown>[] = [];
    const states: string[] = [];
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      logger: recordingLogger(logs),
      parseBusinessFrame: (value) => {
        if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== "test:event") {
          return undefined;
        }
        return value as { type: string; value: number };
      },
      platform: "linux",
      tokenProvider: tokenProvider(),
    });
    connection.subscribeState((state) => states.push(state));
    connection.subscribeBusinessFrames(() => {
      throw new Error("listener failure");
    });
    connection.subscribeBusinessFrames((frame) => {
      received.push(frame);
    });

    const registered = connection.whenRegistered();
    const running = connection.run();
    await registered;
    await vi.waitFor(() => expect(received).toEqual([{ type: "test:event", value: 1 }]));
    await connection.send({ type: "test:result", ok: true }, { priority: "result" });
    await expect(businessResult).resolves.toMatchObject({ type: "test:result", ok: true });
    await vi.waitFor(() =>
      expect(logs).toContainEqual(
        expect.objectContaining({ level: "warn", message: "Runtime business frame listener failed" }),
      ),
    );
    connection.stop();
    await running;

    expect(states).toEqual([
      "stopped",
      "connecting",
      "authenticating",
      "welcoming",
      "registering",
      "registered",
      "stopped",
    ]);
  });

  it("rejects binary server frames before decoding them as JSON", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(Buffer.from(JSON.stringify({ type: "auth:result" })), { binary: true });
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      tokenProvider: tokenProvider(),
    });

    await expect(connection.run()).rejects.toThrow("binary runtime frame");
  });

  it("rejects oversized outbound frames without writing them to the socket", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const receivedTypes: unknown[] = [];
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        receivedTypes.push(frame.type);
        if (frame.type === "auth") completeAuth(socket, frame, welcome(1_000, 2_000));
        else if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
        }
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      tokenProvider: tokenProvider(),
    });
    const running = connection.run();
    await connection.whenRegistered();

    await expect(connection.send({ type: "test:large", text: "你".repeat(64 * 1024) })).rejects.toMatchObject({
      code: "frame_too_large",
    });
    expect(receivedTypes).toEqual(["auth", "computer:register"]);
    connection.stop();
    await running;
  });

  it("aborts an injected retry wait when stopped", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => socket.terminate());
    let retrySignal: AbortSignal | undefined;
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 1, computerId: randomUUID(), serverUrl: server.url, userId: randomUUID() },
      displayName: "workstation",
      instanceId: randomUUID(),
      jitter: () => 0,
      platform: "linux",
      tokenProvider: tokenProvider(),
      waitForRetry: async (_milliseconds, signal) => {
        retrySignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    const running = connection.run();
    await vi.waitFor(() => expect(retrySignal).toBeDefined());
    connection.stop();
    await running;
    expect(retrySignal?.aborted).toBe(true);
  });

  it("drains queued results and reports before trace frames", async () => {
    const socket = new ControlledWebSocket();
    const connection = controlledConnection(socket, { trace: 3 });
    const running = connection.run();
    await registerControlled(connection, socket);
    socket.autoFlush = false;

    const firstTrace = connection.send({ type: "test:trace", sequence: 1 }, { priority: "trace" });
    const secondTrace = connection.send({ type: "test:trace", sequence: 2 }, { priority: "trace" });
    const report = connection.send({ type: "test:report" }, { priority: "report" });
    const result = connection.send({ type: "test:result" }, { priority: "result" });
    expect(socket.businessTypes()).toEqual(["test:trace"]);

    socket.releaseNextSend();
    expect(socket.businessTypes()).toEqual(["test:trace", "test:result"]);
    socket.releaseNextSend();
    expect(socket.businessTypes()).toEqual(["test:trace", "test:result", "test:report"]);
    socket.releaseNextSend();
    expect(socket.businessTypes()).toEqual(["test:trace", "test:result", "test:report", "test:trace"]);
    socket.releaseNextSend();
    await Promise.all([firstTrace, secondTrace, report, result]);

    connection.stop();
    await running;
  });

  it("drops trace queue overflow without terminating the registered socket", async () => {
    const socket = new ControlledWebSocket();
    const connection = controlledConnection(socket, { trace: 1 });
    const running = connection.run();
    await registerControlled(connection, socket);
    socket.autoFlush = false;

    const accepted = connection.send({ type: "test:trace", sequence: 1 }, { priority: "trace" });
    await expect(connection.send({ type: "test:trace", sequence: 2 }, { priority: "trace" })).rejects.toMatchObject({
      code: "overflow",
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.releaseNextSend();
    await accepted;

    connection.stop();
    await running;
  });
});

function tokenProvider(): AccessTokenProvider {
  return {
    getAccessTokenLease: vi.fn().mockResolvedValue({
      accessToken: "access",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  } as unknown as AccessTokenProvider;
}

function welcome(heartbeatIntervalMs = 10, heartbeatTimeoutMs = 1_000) {
  return {
    type: "server:welcome",
    protocolVersion: 1,
    capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imMessageTool: 1 },
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
  };
}

function completeAuth(
  socket: WebSocket,
  frame: Record<string, unknown>,
  serverWelcome = welcome(),
  tokenExpiresInMs = 60_000,
): void {
  socket.send(
    JSON.stringify({
      type: "auth:result",
      requestId: frame.requestId,
      ok: true,
      userId: randomUUID(),
      tokenExpiresAt: new Date(Date.now() + tokenExpiresInMs).toISOString(),
    }),
  );
  socket.send(JSON.stringify(serverWelcome));
}

async function runtimeServer(): Promise<{ close(): Promise<void>; url: string; wss: WebSocketServer }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    wss,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function controlledConnection(socket: ControlledWebSocket, queueLimits: { trace: number }): RuntimeConnection {
  return new RuntimeConnection({
    arch: "x64",
    clientVersion: "0.0.1",
    computer: {
      version: 1,
      computerId: randomUUID(),
      serverUrl: "http://127.0.0.1:8000",
      userId: randomUUID(),
    },
    displayName: "workstation",
    instanceId: randomUUID(),
    platform: "linux",
    queueLimits,
    tokenProvider: tokenProvider(),
    webSocketFactory: () => socket as unknown as WebSocket,
  });
}

async function registerControlled(connection: RuntimeConnection, socket: ControlledWebSocket): Promise<void> {
  await vi.waitFor(() => expect(socket.listenerCount("open")).toBeGreaterThan(0));
  socket.open();
  await vi.waitFor(() => expect(socket.frame("auth")).toBeDefined());
  const auth = socket.frame("auth");
  socket.receive({
    type: "auth:result",
    requestId: auth?.requestId,
    ok: true,
    userId: randomUUID(),
    tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  socket.receive(welcome(1_000, 2_000));
  await vi.waitFor(() => expect(socket.frame("computer:register")).toBeDefined());
  const register = socket.frame("computer:register");
  socket.receive({ type: "computer:register:result", requestId: register?.requestId, ok: true });
  await connection.whenRegistered();
}

class ControlledWebSocket extends EventEmitter {
  autoFlush = true;
  readyState: number = WebSocket.CONNECTING;
  readonly #frames: Array<Record<string, unknown>> = [];
  readonly #sendCallbacks: Array<(error?: Error) => void> = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.#frames.push(JSON.parse(data) as Record<string, unknown>);
    if (!callback) return;
    if (this.autoFlush) callback();
    else this.#sendCallbacks.push(callback);
  }

  receive(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  frame(type: string): Record<string, unknown> | undefined {
    return this.#frames.find((frame) => frame.type === type);
  }

  businessTypes(): unknown[] {
    return this.#frames
      .filter((frame) => typeof frame.type === "string" && String(frame.type).startsWith("test:"))
      .map((frame) => frame.type);
  }

  releaseNextSend(): void {
    const callback = this.#sendCallbacks.shift();
    if (!callback) throw new Error("No controlled WebSocket send is pending");
    callback();
  }

  close(code = 1000): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code);
  }

  terminate(): void {
    this.close(1006);
  }
}
