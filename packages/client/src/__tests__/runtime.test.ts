import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AccessTokenProvider } from "../auth/token-provider.js";
import { RuntimeConnection } from "../runtime/runtime-connection.js";

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
      socket.send(JSON.stringify(welcome()));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
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
      socket.send(JSON.stringify(welcome(1_000, 2_000)));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + (connections === 1 ? 30 : 60_000)).toISOString(),
            }),
          );
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
      socket.send(JSON.stringify(welcome(1_000, 2_000)));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
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
      socket.send(JSON.stringify(welcome(1_000, 2_000)));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
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
      socket.send(JSON.stringify(welcome(1_000, 2_000)));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
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
      socket.send(JSON.stringify(welcome(10, 500)));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
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
      socket.send(JSON.stringify(welcome(10, 500)));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
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
      socket.send(JSON.stringify({ ...welcome(), protocolVersion: 2 }));
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
    await expect(connection.run()).rejects.toThrow("invalid runtime frame");
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
  return { type: "server:welcome", protocolVersion: 1, heartbeatIntervalMs, heartbeatTimeoutMs };
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
