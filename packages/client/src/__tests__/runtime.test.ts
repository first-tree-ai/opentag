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
      jitter: () => 0,
      platform: "linux",
      tokenProvider: tokenProvider(),
    });

    await connection.run();
    expect(frames.map((frame) => frame.type)).toEqual(["auth", "computer:register", "heartbeat"]);
    const register = frames[1];
    expect(register).toMatchObject({ computerId, displayName: "workstation", platform: "linux" });
    expect(register).not.toHaveProperty("teamId");
    expect(register?.instanceId).toEqual(expect.any(String));
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
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
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
      platform: "darwin",
      tokenProvider: { getAccessTokenLease } as unknown as AccessTokenProvider,
    });

    await connection.run();
    expect(getAccessTokenLease.mock.calls).toEqual([[false], [true]]);
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
