import { randomUUID } from "node:crypto";
import { HTTP_PATHS, ServerRuntimeFrameSchema } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
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

  it("serializes concurrent registration persistence and publishes one final winner", async () => {
    const registry = new ConnectionRegistry();
    const computers = computerService();
    const computerId = randomUUID();
    const firstInstanceId = randomUUID();
    const secondInstanceId = randomUUID();
    let persistedInstanceId: string | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    computers.register.mockImplementation(async (_userId, frame) => {
      if (frame.instanceId === firstInstanceId) await firstBlocked;
      persistedInstanceId = frame.instanceId;
    });
    const app = createApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
      runtime: { registry },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const first = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const second = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const firstFrames = frameQueue(first);
    const secondFrames = frameQueue(second);
    await Promise.all([authenticate(first, firstFrames), authenticate(second, secondFrames)]);
    const firstRegister = registerFrame(computerId, firstInstanceId);
    const secondRegister = registerFrame(computerId, secondInstanceId);
    first.send(JSON.stringify(firstRegister));
    await vi.waitFor(() => expect(computers.register).toHaveBeenCalledTimes(1));
    second.send(JSON.stringify(secondRegister));
    await new Promise((resolve) => setImmediate(resolve));
    expect(computers.register).toHaveBeenCalledTimes(1);
    const firstClosed = closeCode(first);
    releaseFirst?.();

    expect(await firstFrames.next()).toMatchObject({ type: "computer:register:result", ok: true });
    expect(await secondFrames.next()).toMatchObject({ type: "computer:register:result", ok: true });
    await expect(firstClosed).resolves.toBe(4001);
    expect(persistedInstanceId).toBe(secondInstanceId);
    expect(registry.currentInstanceId(computerId)).toBe(secondInstanceId);
    second.close();
  });

  it("rejects an auth-frame flood while authentication is in flight without queueing it", async () => {
    let releaseAuth: (() => void) | undefined;
    const authBlocked = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const auth = authService();
    vi.mocked(auth.getAuthenticatedUser).mockImplementation(async () => {
      await authBlocked;
      return { me, tokenExpiresAt: new Date(Date.now() + 60_000) };
    });
    const app = createApp({ authService: auth, computerService: computerService() as unknown as ComputerService });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = frameQueue(socket);
    await frames.next();
    const closed = closeCode(socket);
    socket.send(JSON.stringify({ type: "auth", requestId: randomUUID(), accessToken: "first" }));
    for (let index = 0; index < 100; index += 1) {
      socket.send(JSON.stringify({ type: "auth", requestId: randomUUID(), accessToken: `flood-${index}` }));
    }
    await vi.waitFor(() => expect(auth.getAuthenticatedUser).toHaveBeenCalledTimes(1));
    expect(await frames.next()).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    await expect(closed).resolves.toBe(4400);
    releaseAuth?.();
    expect(auth.getAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate register frames while persistence is in flight", async () => {
    let releaseRegister: (() => void) | undefined;
    const registerBlocked = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    const computers = computerService();
    computers.register.mockImplementation(async () => registerBlocked);
    const registry = new ConnectionRegistry();
    const app = createApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
      runtime: { registry },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = frameQueue(socket);
    await authenticate(socket, frames);
    const frame = registerFrame(randomUUID(), randomUUID());
    const closed = closeCode(socket);
    socket.send(JSON.stringify(frame));
    socket.send(JSON.stringify({ ...frame, requestId: randomUUID() }));
    await vi.waitFor(() => expect(computers.register).toHaveBeenCalledTimes(1));
    expect(await frames.next()).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    await expect(closed).resolves.toBe(4400);
    releaseRegister?.();
    await vi.waitFor(() => expect(computers.disconnect).toHaveBeenCalledWith(frame.computerId, frame.instanceId));
    expect(computers.register).toHaveBeenCalledTimes(1);
    expect(registry.currentInstanceId(frame.computerId)).toBeUndefined();
  });

  it("finishes a closed pending replacement as offline and fences the old socket", async () => {
    const registry = new ConnectionRegistry();
    const computers = computerService();
    const computerId = randomUUID();
    const oldInstanceId = randomUUID();
    const replacementInstanceId = randomUUID();
    let persistedInstanceId: string | undefined;
    let releaseReplacement: (() => void) | undefined;
    const replacementBlocked = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    computers.register.mockImplementation(async (_userId, frame) => {
      if (frame.instanceId === replacementInstanceId) await replacementBlocked;
      persistedInstanceId = frame.instanceId;
    });
    computers.disconnect.mockImplementation(async (_computerId, instanceId) => {
      if (persistedInstanceId !== instanceId) return false;
      persistedInstanceId = undefined;
      return true;
    });
    const app = createApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
      runtime: { registry },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const oldSocket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const oldFrames = frameQueue(oldSocket);
    await authenticate(oldSocket, oldFrames);
    oldSocket.send(JSON.stringify(registerFrame(computerId, oldInstanceId)));
    expect(await oldFrames.next()).toMatchObject({ type: "computer:register:result", ok: true });

    const replacement = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const replacementFrames = frameQueue(replacement);
    await authenticate(replacement, replacementFrames);
    replacement.send(JSON.stringify(registerFrame(computerId, replacementInstanceId)));
    await vi.waitFor(() => expect(computers.register).toHaveBeenCalledTimes(2));
    const oldClosed = closeCode(oldSocket);
    const replacementClosed = closeCode(replacement);
    replacement.close();
    await replacementClosed;
    await new Promise((resolve) => setImmediate(resolve));
    releaseReplacement?.();

    await expect(oldClosed).resolves.toBe(4001);
    await vi.waitFor(() => expect(computers.disconnect).toHaveBeenCalledWith(computerId, replacementInstanceId));
    expect(persistedInstanceId).toBeUndefined();
    expect(registry.currentInstanceId(computerId)).toBeUndefined();
  });
});

async function authenticate(socket: WebSocket, frames = frameQueue(socket)): Promise<void> {
  await frames.next();
  socket.send(JSON.stringify({ type: "auth", requestId: randomUUID(), accessToken: "access" }));
  expect(await frames.next()).toMatchObject({ type: "auth:result", ok: true });
}

function registerFrame(computerId: string, instanceId: string) {
  return {
    type: "computer:register" as const,
    requestId: randomUUID(),
    computerId,
    instanceId,
    displayName: "host",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.0.1",
  };
}

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

function frameQueue(socket: WebSocket): { next(): Promise<ReturnType<typeof ServerRuntimeFrameSchema.parse>> } {
  type Frame = ReturnType<typeof ServerRuntimeFrameSchema.parse>;
  const buffered: Frame[] = [];
  const waiting: Array<(frame: Frame) => void> = [];
  socket.on("message", (data) => {
    const frame = ServerRuntimeFrameSchema.parse(JSON.parse(data.toString()));
    const resolve = waiting.shift();
    if (resolve) resolve(frame);
    else buffered.push(frame);
  });
  return {
    next: async () => {
      const frame = buffered.shift();
      if (frame) return frame;
      return new Promise<Frame>((resolve) => waiting.push(resolve));
    },
  };
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", resolve));
}
