import { randomUUID } from "node:crypto";
import { setImmediate as waitImmediate } from "node:timers/promises";
import {
  HTTP_PATHS,
  PROVIDER_READINESS_V1_HEADER,
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
  RuntimeCapabilitiesSchema,
  RuntimeHeartbeatIntervalMsSchema,
  RuntimeHeartbeatTimeoutMsSchema,
  ServerRuntimeFrameSchema,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { createApp } from "../app.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import type { UserAuthService } from "../services/auth/index.js";
import { AuthServiceError } from "../services/auth/index.js";
import type { ComputerService } from "../services/computers/index.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const workspaceId = randomUUID();
const me = {
  user: { id: randomUUID(), email: "admin@example.com", displayName: "Admin" },
  memberships: [
    {
      teamId: workspaceId,
      teamName: "example",
      teamDisplayName: "Example",
      role: "admin" as const,
      setupCompletedAt: null,
    },
  ],
};

const machineContext = {
  credentialId: randomUUID(),
  workspaceComputerId: randomUUID(),
  workspaceId,
  computerId: randomUUID(),
};

function machineAuthService() {
  return { verifyMachineToken: vi.fn().mockResolvedValue(machineContext) };
}

function createRuntimeApp(options: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    ...options,
    machineAuthService: options.machineAuthService ?? (machineAuthService() as never),
  });
}

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn().mockResolvedValue(me),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      me,
      tokenExpiresAt: new Date(Date.now() + 60_000),
    }),
  };
}

function computerService() {
  return {
    assertActiveCredential: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(true),
    listForUser: vi.fn().mockResolvedValue({ computers: [] }),
  };
}

describe("Computer runtime WebSocket", () => {
  it("rejects Account access and refresh tokens through the real Runtime WebSocket", async () => {
    const machineAuth = machineAuthService();
    machineAuth.verifyMachineToken.mockRejectedValue(
      new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "machine authentication required", 401),
    );
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      machineAuthService: machineAuth as never,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const accountToken of ["account-access", "account-refresh"]) {
      const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
      const frames = frameQueue(socket);
      await opened(socket);
      const closed = closeCode(socket);
      socket.send(
        JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, machineToken: accountToken }),
      );

      expect(await frames.next()).toMatchObject({ type: "error", code: "AUTH_INVALID_TOKEN" });
      await expect(closed).resolves.toBe(4401);
      expect(machineAuth.verifyMachineToken).toHaveBeenCalledWith(accountToken);
    }
  });

  it("hard-rejects legacy daemons that send an Account accessToken field", async () => {
    const machineAuth = machineAuthService();
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      machineAuthService: machineAuth as never,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = frameQueue(socket);
    await opened(socket);
    const closed = closeCode(socket);
    socket.send(
      JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, accessToken: "legacy-account" }),
    );

    expect(await frames.next()).toMatchObject({ type: "error", code: "AUTH_INVALID_TOKEN" });
    await expect(closed).resolves.toBe(4401);
    expect(machineAuth.verifyMachineToken).not.toHaveBeenCalled();
  });

  it("requires auth, registers without Team authority, and heartbeats", async () => {
    const auth = authService();
    const computers = computerService();
    const registry = new ConnectionRegistry();
    const app = createRuntimeApp({
      authService: auth,
      computerService: computers as unknown as ComputerService,
      runtime: {
        authTimeoutMs: 1_000,
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 2_000,
        registerTimeoutMs: 1_000,
        registry,
      },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`, {
      headers: { [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
    const frames = frameQueue(socket);
    await opened(socket);
    let receivedBeforeAuth = false;
    socket.once("message", () => {
      receivedBeforeAuth = true;
    });
    await waitImmediate();
    expect(receivedBeforeAuth).toBe(false);

    const authRequestId = randomUUID();
    socket.send(
      JSON.stringify({ type: "auth", requestId: authRequestId, protocolVersion: 1, machineToken: "machine" }),
    );
    expect(await frames.next()).toMatchObject({ type: "auth:result", requestId: authRequestId, ok: true });
    expect(await frames.next()).toMatchObject({
      type: "server:welcome",
      protocolVersion: 1,
      providerReadiness: { version: 1, providers: ["codex", "claude-code"] },
    });

    const register = {
      type: "computer:register",
      requestId: randomUUID(),
      computerId: machineContext.computerId,
      instanceId: randomUUID(),
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
      providerReadiness: [{ provider: "codex", status: "install" }],
    };
    socket.send(JSON.stringify(register));
    expect(await frames.next()).toMatchObject({ type: "computer:register:result", ok: true });
    expect(computers.register).toHaveBeenCalledWith(machineContext, {
      ...register,
      capabilities: { imCredentialGrant: 0 },
    });
    expect(registry.providerReadiness(machineContext.workspaceComputerId)).toMatchObject([
      {
        observation: { provider: "codex", status: "install" },
      },
    ]);
    expect(JSON.stringify(register)).not.toContain("team");

    const heartbeat = {
      type: "heartbeat",
      requestId: randomUUID(),
      computerId: register.computerId,
      instanceId: register.instanceId,
      providerReadiness: [{ provider: "codex", status: "sign-in" }],
    };
    socket.send(JSON.stringify(heartbeat));
    expect(await frames.next()).toMatchObject({
      type: "heartbeat:result",
      requestId: heartbeat.requestId,
      ok: true,
    });
    expect(registry.providerReadiness(machineContext.workspaceComputerId)).toMatchObject([
      {
        observation: { provider: "codex", status: "sign-in" },
      },
    ]);
    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    await vi.waitFor(() =>
      expect(computers.disconnect).toHaveBeenCalledWith(machineContext.workspaceComputerId, register.instanceId),
    );
  });

  it("negotiates v2 capabilities and fences every post-registration frame", async () => {
    const computers = computerService();
    let businessContext: { negotiatedCapabilities?: Record<string, number> } | undefined;
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
      runtime: {
        authTimeoutMs: 1_000,
        registerTimeoutMs: 1_000,
        business: {
          parse: (value) => businessFrame(value),
          laneKey: (frame) => String(frame.key),
          handle: (frame, context) => {
            businessContext = context;
            return { type: "test:result", requestId: frame.requestId, status: "ok" };
          },
          overloadResult: (frame) => ({ type: "test:result", requestId: frame.requestId, status: "busy" }),
          failureResult: (frame) => ({ type: "test:result", requestId: frame.requestId, status: "failed" }),
        },
      },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = rawFrameQueue(socket);
    await opened(socket);
    const authRequestId = randomUUID();
    socket.send(
      JSON.stringify({
        type: "auth",
        requestId: authRequestId,
        protocolVersion: RUNTIME_PROTOCOL_V2,
        supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
        machineToken: "machine",
      }),
    );
    expect(await frames.next()).toMatchObject({ type: "auth:result", requestId: authRequestId, ok: true });
    expect(await frames.next()).toMatchObject({
      type: "server:welcome",
      protocolVersion: RUNTIME_PROTOCOL_V2,
      requiredClientCapabilities: [],
    });

    const register = {
      type: "computer:register",
      requestId: randomUUID(),
      protocolVersion: RUNTIME_PROTOCOL_V2,
      computerId: machineContext.computerId,
      instanceId: randomUUID(),
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
      capabilities: { imCredentialGrant: 1 },
      supportedCapabilities: {
        ...RUNTIME_CLIENT_CAPABILITY_OFFERS,
        "client.unknownOptional": { min: 1, max: 1 },
      },
      requiredServerCapabilities: [],
    } as const;
    socket.send(JSON.stringify(register));
    const registered = await frames.next();
    expect(registered).toMatchObject({
      type: "computer:register:result",
      protocolVersion: RUNTIME_PROTOCOL_V2,
      ok: true,
    });
    const connectionId = registered.connectionId;
    expect(connectionId).toEqual(expect.any(String));

    const heartbeatRequestId = randomUUID();
    socket.send(
      JSON.stringify({
        type: "heartbeat",
        requestId: heartbeatRequestId,
        protocolVersion: RUNTIME_PROTOCOL_V2,
        connectionId,
        computerId: register.computerId,
        instanceId: register.instanceId,
        capabilities: { imCredentialGrant: 1 },
      }),
    );
    expect(await frames.next()).toMatchObject({
      type: "heartbeat:result",
      requestId: heartbeatRequestId,
      connectionId,
      protocolVersion: RUNTIME_PROTOCOL_V2,
      ok: true,
    });

    const businessRequestId = randomUUID();
    socket.send(
      JSON.stringify({
        type: "test:work",
        requestId: businessRequestId,
        key: "v2",
        connectionId,
      }),
    );
    expect(await frames.next()).toMatchObject({
      type: "test:result",
      requestId: businessRequestId,
      status: "ok",
      connectionId,
    });
    expect(businessContext?.negotiatedCapabilities).toMatchObject({
      "runtime.sessionCollaboration": 1,
    });

    socket.send(
      JSON.stringify({
        type: "heartbeat",
        requestId: randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        connectionId: randomUUID(),
        computerId: register.computerId,
        instanceId: register.instanceId,
        capabilities: { imCredentialGrant: 1 },
      }),
    );
    expect(await frames.next()).toMatchObject({ type: "error", code: "COMPUTER_NOT_REGISTERED" });
    await expect(closeCode(socket)).resolves.toBe(4409);
  });

  it("rejects missing required v2 capabilities before registration side effects", async () => {
    const computers = computerService();
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = frameQueue(socket);
    await authenticateV2(socket, frames);
    socket.send(
      JSON.stringify({
        type: "computer:register",
        requestId: randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        computerId: machineContext.computerId,
        instanceId: randomUUID(),
        displayName: "workstation",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.2",
        capabilities: { imCredentialGrant: 0 },
        supportedCapabilities: RUNTIME_CLIENT_CAPABILITY_OFFERS,
        requiredServerCapabilities: ["future.requiredFeature"],
      }),
    );
    expect(await frames.next()).toMatchObject({ type: "error", code: "PROTOCOL_CAPABILITY_UNSUPPORTED" });
    await expect(closeCode(socket)).resolves.toBe(4400);
    expect(computers.register).not.toHaveBeenCalled();
  });

  it("keeps the welcome frame compatible with an older strict v1 Client", async () => {
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      runtime: { authTimeoutMs: 1_000 },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = frameQueue(socket);
    await opened(socket);
    socket.send(JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, machineToken: "machine" }));
    await frames.next();

    const welcome = await frames.next();
    const legacyWelcomeSchema = z
      .object({
        type: z.literal("server:welcome"),
        protocolVersion: z.literal(1),
        capabilities: RuntimeCapabilitiesSchema,
        heartbeatIntervalMs: RuntimeHeartbeatIntervalMsSchema,
        heartbeatTimeoutMs: RuntimeHeartbeatTimeoutMsSchema,
      })
      .strict();
    expect(legacyWelcomeSchema.parse(welcome)).toEqual(welcome);
    socket.close();
  });

  it("rejects readiness for a Provider outside the exact Server-admitted set", async () => {
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      runtime: { authTimeoutMs: 1_000 },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`, {
      headers: { [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
    const frames = frameQueue(socket);
    await authenticate(socket, frames);
    socket.send(
      JSON.stringify({
        ...registerFrame(machineContext.computerId, randomUUID()),
        providerReadiness: [{ provider: "pi", status: "ready" }],
      }),
    );

    expect(await frames.next()).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    await expect(closeCode(socket)).resolves.toBe(4400);
  });

  it("does not publish a readiness observation rejected by the durable heartbeat guard", async () => {
    const computers = computerService();
    let resolveHeartbeat!: (accepted: boolean) => void;
    computers.heartbeat.mockImplementationOnce(() => new Promise<boolean>((resolve) => (resolveHeartbeat = resolve)));
    const registry = new ConnectionRegistry();
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
      runtime: { authTimeoutMs: 1_000, registry },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`, {
      headers: { [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
    const frames = frameQueue(socket);
    await authenticate(socket, frames);
    const register = {
      ...registerFrame(machineContext.computerId, randomUUID()),
      providerReadiness: [{ provider: "codex", status: "install" }],
    };
    socket.send(JSON.stringify(register));
    await frames.next();

    const heartbeat = {
      type: "heartbeat",
      requestId: randomUUID(),
      computerId: register.computerId,
      instanceId: register.instanceId,
      providerReadiness: [{ provider: "codex", status: "ready" }],
    };
    socket.send(JSON.stringify(heartbeat));
    await vi.waitFor(() => expect(computers.heartbeat).toHaveBeenCalled());
    expect(registry.providerReadiness(machineContext.workspaceComputerId)).toMatchObject([
      {
        observation: { provider: "codex", status: "install" },
      },
    ]);

    resolveHeartbeat(false);
    expect(await frames.next()).toMatchObject({ type: "error", code: "COMPUTER_NOT_REGISTERED" });
    expect(registry.providerReadiness(machineContext.workspaceComputerId)[0]?.observation.status).not.toBe("ready");
  });

  it("rejects registration before authentication", async () => {
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      runtime: { authTimeoutMs: 1_000 },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    await opened(socket);
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
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      runtime: { authTimeoutMs: 10 },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    expect(await nextFrame(socket)).toMatchObject({ type: "error", code: "RUNTIME_AUTH_TIMEOUT" });
    await expect(closeCode(socket)).resolves.toBe(4408);
  });

  it("rejects a heartbeat after enrollment authority is revoked", async () => {
    const computers = computerService();
    computers.heartbeat.mockRejectedValueOnce(
      new AuthServiceError("AUTH_MEMBERSHIP_REQUIRED", "deterministic", "membership required", 403),
    );
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    await authenticate(socket);
    const computerId = machineContext.computerId;
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
    const computerId = machineContext.computerId;
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
    const app = createRuntimeApp({
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
    expect(registry.currentInstanceId(machineContext.workspaceComputerId)).toBe(secondInstanceId);
    second.close();
  });

  it("rejects an auth-frame flood while authentication is in flight without queueing it", async () => {
    let releaseAuth: (() => void) | undefined;
    const authBlocked = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const machineAuth = machineAuthService();
    vi.mocked(machineAuth.verifyMachineToken).mockImplementation(async () => {
      await authBlocked;
      return machineContext;
    });
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      machineAuthService: machineAuth as never,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = frameQueue(socket);
    await opened(socket);
    const closed = closeCode(socket);
    socket.send(JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, machineToken: "first" }));
    for (let index = 0; index < 100; index += 1) {
      socket.send(
        JSON.stringify({
          type: "auth",
          requestId: randomUUID(),
          protocolVersion: 1,
          machineToken: `flood-${index}`,
        }),
      );
    }
    await vi.waitFor(() => expect(machineAuth.verifyMachineToken).toHaveBeenCalledTimes(1));
    expect(await frames.next()).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    await expect(closed).resolves.toBe(4400);
    releaseAuth?.();
    expect(machineAuth.verifyMachineToken).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate register frames while persistence is in flight", async () => {
    let releaseRegister: (() => void) | undefined;
    const registerBlocked = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    const computers = computerService();
    computers.register.mockImplementation(async () => registerBlocked);
    const registry = new ConnectionRegistry();
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
      runtime: { registry },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = frameQueue(socket);
    await authenticate(socket, frames);
    const frame = registerFrame(machineContext.computerId, randomUUID());
    const closed = closeCode(socket);
    socket.send(JSON.stringify(frame));
    socket.send(JSON.stringify({ ...frame, requestId: randomUUID() }));
    await vi.waitFor(() => expect(computers.register).toHaveBeenCalledTimes(1));
    expect(await frames.next()).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    await expect(closed).resolves.toBe(4400);
    releaseRegister?.();
    await vi.waitFor(() =>
      expect(computers.disconnect).toHaveBeenCalledWith(machineContext.workspaceComputerId, frame.instanceId),
    );
    expect(computers.register).toHaveBeenCalledTimes(1);
    expect(registry.currentInstanceId(machineContext.workspaceComputerId)).toBeUndefined();
  });

  it("finishes a closed pending replacement as offline and fences the old socket", async () => {
    const registry = new ConnectionRegistry();
    const computers = computerService();
    const computerId = machineContext.computerId;
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
    const app = createRuntimeApp({
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
    await vi.waitFor(() =>
      expect(computers.disconnect).toHaveBeenCalledWith(machineContext.workspaceComputerId, replacementInstanceId),
    );
    expect(persistedInstanceId).toBeUndefined();
    expect(registry.currentInstanceId(machineContext.workspaceComputerId)).toBeUndefined();
  });

  it("rejects unsupported auth versions before authenticating", async () => {
    const machineAuth = machineAuthService();
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      machineAuthService: machineAuth as never,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    await opened(socket);
    const requestId = randomUUID();
    socket.send(JSON.stringify({ type: "auth", requestId, protocolVersion: 3, machineToken: "machine" }));

    expect(await nextFrame(socket)).toMatchObject({
      type: "error",
      requestId,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expect(closeCode(socket)).resolves.toBe(4400);
    expect(machineAuth.verifyMachineToken).not.toHaveBeenCalled();
  });

  it("rejects binary frames before JSON decoding", async () => {
    const machineAuth = machineAuthService();
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computerService() as unknown as ComputerService,
      machineAuthService: machineAuth as never,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    await opened(socket);
    socket.send(
      Buffer.from(
        JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, machineToken: "machine" }),
      ),
      { binary: true },
    );

    expect(await nextFrame(socket)).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    await expect(closeCode(socket)).resolves.toBe(4400);
    expect(machineAuth.verifyMachineToken).not.toHaveBeenCalled();
  });

  it("keeps heartbeat independent from slow keyed business work and isolates handler failures", async () => {
    const computers = computerService();
    let releaseSlow: (() => void) | undefined;
    let markSlowStarted: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const app = createRuntimeApp({
      authService: authService(),
      computerService: computers as unknown as ComputerService,
      runtime: {
        business: {
          parse: (value) => businessFrame(value),
          laneKey: (frame) => String(frame.key),
          handle: async (frame) => {
            if (frame.key === "slow") {
              markSlowStarted?.();
              await slow;
            }
            if (frame.key === "fail") throw new Error("expected handler failure");
            return { type: "test:result", requestId: frame.requestId, status: "ok" };
          },
          overloadResult: (frame) => ({ type: "test:result", requestId: frame.requestId, status: "busy" }),
          failureResult: (frame) => ({ type: "test:result", requestId: frame.requestId, status: "failed" }),
          maxConcurrent: 2,
        },
      },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http", "ws")}${HTTP_PATHS.computerRuntimeWebSocket}`);
    const frames = rawFrameQueue(socket);
    await authenticateRaw(socket, frames);
    const register = registerFrame(machineContext.computerId, randomUUID());
    socket.send(JSON.stringify(register));
    expect(await frames.next()).toMatchObject({ type: "computer:register:result", ok: true });

    const slowRequestId = randomUUID();
    socket.send(JSON.stringify({ type: "test:work", requestId: slowRequestId, key: "slow" }));
    await slowStarted;
    const heartbeatRequestId = randomUUID();
    socket.send(
      JSON.stringify({
        type: "heartbeat",
        requestId: heartbeatRequestId,
        computerId: register.computerId,
        instanceId: register.instanceId,
      }),
    );
    expect(await frames.next()).toMatchObject({ type: "heartbeat:result", requestId: heartbeatRequestId, ok: true });
    releaseSlow?.();
    expect(await frames.next()).toMatchObject({ type: "test:result", requestId: slowRequestId, status: "ok" });

    const failedRequestId = randomUUID();
    socket.send(JSON.stringify({ type: "test:work", requestId: failedRequestId, key: "fail" }));
    expect(await frames.next()).toMatchObject({ type: "test:result", requestId: failedRequestId, status: "failed" });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});

async function authenticate(socket: WebSocket, frames = frameQueue(socket)): Promise<void> {
  await opened(socket);
  socket.send(JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, machineToken: "machine" }));
  expect(await frames.next()).toMatchObject({ type: "auth:result", ok: true });
  expect(await frames.next()).toMatchObject({ type: "server:welcome", protocolVersion: 1 });
}

async function authenticateV2(socket: WebSocket, frames = frameQueue(socket)): Promise<void> {
  await opened(socket);
  socket.send(
    JSON.stringify({
      type: "auth",
      requestId: randomUUID(),
      protocolVersion: RUNTIME_PROTOCOL_V2,
      supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
      machineToken: "machine",
    }),
  );
  expect(await frames.next()).toMatchObject({ type: "auth:result", ok: true });
  expect(await frames.next()).toMatchObject({ type: "server:welcome", protocolVersion: RUNTIME_PROTOCOL_V2 });
}

function opened(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function authenticateRaw(socket: WebSocket, frames: { next(): Promise<Record<string, unknown>> }): Promise<void> {
  await opened(socket);
  socket.send(JSON.stringify({ type: "auth", requestId: randomUUID(), protocolVersion: 1, machineToken: "machine" }));
  expect(await frames.next()).toMatchObject({ type: "auth:result", ok: true });
  expect(await frames.next()).toMatchObject({ type: "server:welcome", protocolVersion: 1 });
}

function businessFrame(value: unknown): (Record<string, unknown> & { type: string }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type !== "test:work" ||
    typeof record.requestId !== "string" ||
    typeof record.key !== "string" ||
    Object.keys(record).length !== 3
  ) {
    return undefined;
  }
  return record as Record<string, unknown> & { type: string };
}

function rawFrameQueue(socket: WebSocket): { next(): Promise<Record<string, unknown>> } {
  const buffered: Array<Record<string, unknown>> = [];
  const waiting: Array<(frame: Record<string, unknown>) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve) resolve(frame);
    else buffered.push(frame);
  });
  return {
    next: async () => {
      const frame = buffered.shift();
      if (frame) return frame;
      return new Promise<Record<string, unknown>>((resolve) => waiting.push(resolve));
    },
  };
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
