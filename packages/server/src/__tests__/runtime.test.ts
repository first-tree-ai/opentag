import { randomUUID } from "node:crypto";
import { HTTP_PATHS, ServerRuntimeFrameSchema } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import { AuthServiceError } from "../services/auth/index.js";
import type { ComputerService } from "../services/computers/index.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const me = {
  user: { id: randomUUID(), email: "admin@example.com", displayName: "Admin" },
  memberships: [{ teamId: randomUUID(), teamName: "example", teamDisplayName: "Example", role: "admin" as const }],
};

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn().mockResolvedValue(me),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      me,
      tokenExpiresAt: new Date(Date.now() + 60_000),
    }),
  };
}

function computerService() {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(true),
    listForUser: vi.fn().mockResolvedValue({ computers: [] }),
  };
}

describe("Computer runtime WebSocket", () => {
  it("requires auth, registers without Team authority, and heartbeats", async () => {
    const auth = authService();
    const computers = computerService();
    const app = createApp({
      authService: auth,
      computerService: computers as unknown as ComputerService,
      runtime: { authTimeoutMs: 1_000, heartbeatIntervalMs: 20, heartbeatTimeoutMs: 2_000, registerTimeoutMs: 1_000 },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const welcome = await nextFrame(socket);
    expect(welcome.type).toBe("server:welcome");

    const authRequestId = randomUUID();
    socket.send(JSON.stringify({ type: "auth", requestId: authRequestId, accessToken: "access" }));
    expect(await nextFrame(socket)).toMatchObject({ type: "auth:result", requestId: authRequestId, ok: true });

    const register = {
      type: "computer:register",
      requestId: randomUUID(),
      computerId: randomUUID(),
      instanceId: randomUUID(),
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    };
    socket.send(JSON.stringify(register));
    expect(await nextFrame(socket)).toMatchObject({ type: "computer:register:result", ok: true });
    expect(computers.register).toHaveBeenCalledWith(me.user.id, register);
    expect(JSON.stringify(register)).not.toContain("team");

    const heartbeat = {
      type: "heartbeat",
      requestId: randomUUID(),
      computerId: register.computerId,
      instanceId: register.instanceId,
    };
    socket.send(JSON.stringify(heartbeat));
    expect(await nextFrame(socket)).toMatchObject({
      type: "heartbeat:result",
      requestId: heartbeat.requestId,
      ok: true,
    });
    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    expect(computers.disconnect).toHaveBeenCalledWith(register.computerId, register.instanceId);
  });

  it("rejects registration before authentication", async () => {
    const app = createApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      runtime: { authTimeoutMs: 1_000 },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    await nextFrame(socket);
    socket.send(
      JSON.stringify({
        type: "computer:register",
        requestId: randomUUID(),
        computerId: randomUUID(),
        instanceId: randomUUID(),
        displayName: "host",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      }),
    );
    expect(await nextFrame(socket)).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
  });

  it("closes an unauthenticated socket when the auth deadline expires", async () => {
    const app = createApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      runtime: { authTimeoutMs: 10 },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    await nextFrame(socket);
    expect(await nextFrame(socket)).toMatchObject({ type: "error", code: "RUNTIME_AUTH_TIMEOUT" });
    await expect(closeCode(socket)).resolves.toBe(4408);
  });

  it("revalidates live membership on heartbeat", async () => {
    const auth = authService();
    const computers = computerService();
    computers.heartbeat.mockRejectedValueOnce(
      new AuthServiceError("AUTH_MEMBERSHIP_REQUIRED", "deterministic", "membership required", 403),
    );
    const app = createApp({ authService: auth, computerService: computers as unknown as ComputerService });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    await nextFrame(socket);
    const authRequestId = randomUUID();
    socket.send(JSON.stringify({ type: "auth", requestId: authRequestId, accessToken: "access" }));
    await nextFrame(socket);
    const computerId = randomUUID();
    const instanceId = randomUUID();
    socket.send(
      JSON.stringify({
        type: "computer:register",
        requestId: randomUUID(),
        computerId,
        instanceId,
        displayName: "host",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      }),
    );
    await nextFrame(socket);
    socket.send(JSON.stringify({ type: "heartbeat", requestId: randomUUID(), computerId, instanceId }));
    expect(await nextFrame(socket)).toMatchObject({ type: "error", code: "AUTH_MEMBERSHIP_REQUIRED" });
    await expect(closeCode(socket)).resolves.toBe(4403);
  });
});

function nextFrame(socket: WebSocket): Promise<ReturnType<typeof ServerRuntimeFrameSchema.parse>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      try {
        resolve(ServerRuntimeFrameSchema.parse(JSON.parse(data.toString())));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", resolve));
}
