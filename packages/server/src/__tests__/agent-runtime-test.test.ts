import { randomUUID } from "node:crypto";
import { AGENT_RUNTIME_TEST_TEMPLATE, RUNTIME_CAPABILITY } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import { AgentRuntimeTestOwner } from "../runtime/agent-runtime-test-owner.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import type { AgentService } from "../services/agents/index.js";
import { AgentRuntimeTestService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";

const userId = "53e2babe-e4ac-4eac-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const agent = {
  id: agentId,
  createdByUserId: userId,
  computerId,
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex" as const,
  receiveMode: "all_message" as const,
  status: "active" as const,
  revision: 4,
  runtimeConfig: {
    revision: 2,
    model: "gpt-5.6",
    reasoningEffort: "medium",
    instructions: "Follow instructions.",
    maxDurationMs: null,
  },
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Agent Runtime test owner", () => {
  it("rejects invalid pending and TTL configuration", () => {
    const registry = new ConnectionRegistry();
    expect(() => new AgentRuntimeTestOwner(registry, { maxPending: 0 })).toThrow(
      "Agent Runtime test pending limit must be a positive safe integer",
    );
    expect(() => new AgentRuntimeTestOwner(registry, { ttlMs: 0 })).toThrow(
      "Agent Runtime test TTL must be a positive safe integer",
    );
  });

  it("ignores non-result frames and cancels when the caller signal is already aborted", async () => {
    const fixture = await testOwnerFixture();
    expect(fixture.owner.businessOptions().parse({ type: "session:reconcile" })).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.owner.start(fixture.computerId, {
        computerId: fixture.computerId,
        provider: "codex",
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: "failed", code: "cancelled" });
    expect(fixture.owner.pendingCount()).toBe(0);
  });

  it("enforces one in-flight test per Computer, a global pending limit, TTL, and cancel cleanup", async () => {
    const fixture = await testOwnerFixture({ maxPending: 1, ttlMs: 30 });
    const first = fixture.owner.start(fixture.computerId, {
      computerId: fixture.computerId,
      provider: "codex",
    });
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(1));
    expect(fixture.frames[0]).toMatchObject({
      type: "agent-runtime:test",
      provider: "codex",
      computerId: fixture.computerId,
    });
    expect(fixture.frames[0]).not.toHaveProperty("prompt");
    expect(fixture.owner.pendingCount()).toBe(1);
    expect(fixture.owner.hasComputerInFlight(fixture.computerId)).toBe(true);

    await expect(
      fixture.owner.start(fixture.computerId, { computerId: fixture.computerId, provider: "codex" }),
    ).resolves.toEqual({ status: "failed", code: "busy" });

    const secondComputer = await registerComputer(fixture.registry, {
      negotiatedCapabilities: { [RUNTIME_CAPABILITY.agentRuntimeTest]: 1 },
    });
    await expect(
      fixture.owner.start(secondComputer.computerId, {
        computerId: secondComputer.computerId,
        provider: "claude-code",
      }),
    ).resolves.toEqual({ status: "failed", code: "busy" });

    const requestId = (fixture.frames[0] as { requestId: string }).requestId;
    await fixture.owner.businessOptions().handle(
      {
        type: "agent-runtime:test:result",
        requestId,
        status: "passed",
      },
      fixture.context,
    );
    await expect(first).resolves.toEqual({ status: "passed" });
    expect(fixture.owner.pendingCount()).toBe(0);
    expect(fixture.owner.hasComputerInFlight(fixture.computerId)).toBe(false);

    const timedOut = fixture.owner.start(fixture.computerId, {
      computerId: fixture.computerId,
      provider: "codex",
    });
    await expect(timedOut).resolves.toEqual({ status: "failed", code: "timeout" });
    expect(fixture.frames.some((frame) => (frame as { type: string }).type === "agent-runtime:test:cancel")).toBe(true);
    expect(fixture.owner.pendingCount()).toBe(0);

    const controller = new AbortController();
    const cancelled = fixture.owner.start(fixture.computerId, {
      computerId: fixture.computerId,
      provider: "codex",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fixture.owner.pendingCount()).toBe(1));
    controller.abort();
    await expect(cancelled).resolves.toEqual({ status: "failed", code: "cancelled" });
    expect(fixture.owner.pendingCount()).toBe(0);
  });

  it("does not cache a completed result and ignores a late result after cleanup", async () => {
    const fixture = await testOwnerFixture();
    const pending = fixture.owner.start(fixture.computerId, {
      computerId: fixture.computerId,
      provider: "codex",
      model: "gpt-5.6",
    });
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(1));
    const requestId = (fixture.frames[0] as { requestId: string }).requestId;
    await fixture.owner.businessOptions().handle(
      {
        type: "agent-runtime:test:result",
        requestId,
        status: "failed",
        code: "provider_failed",
      },
      fixture.context,
    );
    await expect(pending).resolves.toEqual({ status: "failed", code: "provider_failed" });
    expect(fixture.owner.pendingCount()).toBe(0);

    await fixture.owner.businessOptions().handle(
      {
        type: "agent-runtime:test:result",
        requestId,
        status: "passed",
      },
      fixture.context,
    );
    expect(fixture.owner.pendingCount()).toBe(0);

    const next = fixture.owner.start(fixture.computerId, {
      computerId: fixture.computerId,
      provider: "codex",
    });
    await vi.waitFor(() => expect(fixture.frames.length).toBeGreaterThan(1));
    expect((fixture.frames[1] as { requestId: string }).requestId).not.toBe(requestId);
    fixture.owner.close();
    await expect(next).resolves.toEqual({ status: "failed", code: "cancelled" });
    expect(fixture.owner.pendingCount()).toBe(0);
  });

  it("ignores a result from the wrong Computer instance and does not cache it", async () => {
    const fixture = await testOwnerFixture();
    const pending = fixture.owner.start(fixture.computerId, {
      computerId: fixture.computerId,
      provider: "codex",
    });
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(1));
    const requestId = (fixture.frames[0] as { requestId: string }).requestId;
    await fixture.owner
      .businessOptions()
      .handle(
        { type: "agent-runtime:test:result", requestId, status: "passed" },
        { ...fixture.context, instanceId: randomUUID() },
      );
    expect(fixture.owner.pendingCount()).toBe(1);
    expect(fixture.owner.hasComputerInFlight(fixture.computerId)).toBe(true);
    await fixture.owner
      .businessOptions()
      .handle(
        { type: "agent-runtime:test:result", requestId, status: "passed" },
        { ...fixture.context, computerId: randomUUID() },
      );
    expect(fixture.owner.pendingCount()).toBe(1);
    await fixture.owner
      .businessOptions()
      .handle({ type: "agent-runtime:test:result", requestId, status: "passed" }, fixture.context);
    await expect(pending).resolves.toEqual({ status: "passed" });
    expect(fixture.owner.pendingCount()).toBe(0);
    expect(fixture.owner.hasComputerInFlight(fixture.computerId)).toBe(false);
  });

  it("clears pending and per-Computer state after send failure, TTL, and close", async () => {
    const failingRegistry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    await failingRegistry.register(
      {
        computerId,
        installationId: randomUUID(),
        instanceId,
        lastHeartbeatAt: 1,
        negotiatedCapabilities: { [RUNTIME_CAPABILITY.agentRuntimeTest]: 1 },
        socket: {
          readyState: WebSocket.OPEN,
          close: vi.fn(),
          terminate: vi.fn(),
          send: vi.fn((_serialized: string, callback: (error?: Error) => void) => {
            callback(new Error("unavailable"));
          }),
        } as unknown as WebSocket,
      },
      async () => undefined,
    );
    const failingOwner = new AgentRuntimeTestOwner(failingRegistry);
    await expect(failingOwner.start(computerId, { computerId, provider: "codex" })).resolves.toEqual({
      status: "failed",
      code: "computer_unavailable",
    });
    expect(failingOwner.pendingCount()).toBe(0);
    expect(failingOwner.hasComputerInFlight(computerId)).toBe(false);

    const fixture = await testOwnerFixture({ ttlMs: 20 });
    const timedOut = fixture.owner.start(fixture.computerId, {
      computerId: fixture.computerId,
      provider: "codex",
    });
    await expect(timedOut).resolves.toEqual({ status: "failed", code: "timeout" });
    expect(fixture.owner.pendingCount()).toBe(0);
    expect(fixture.owner.hasComputerInFlight(fixture.computerId)).toBe(false);

    const closing = fixture.owner.start(fixture.computerId, {
      computerId: fixture.computerId,
      provider: "codex",
    });
    await vi.waitFor(() => expect(fixture.owner.pendingCount()).toBe(1));
    fixture.owner.close();
    await expect(closing).resolves.toEqual({ status: "failed", code: "cancelled" });
    expect(fixture.owner.pendingCount()).toBe(0);
    expect(fixture.owner.hasComputerInFlight(fixture.computerId)).toBe(false);
  });

  it("returns sanitized Computer and capability failures without dispatch", async () => {
    const registry = new ConnectionRegistry();
    const owner = new AgentRuntimeTestOwner(registry);
    await expect(owner.start(randomUUID(), { computerId: randomUUID(), provider: "codex" })).resolves.toEqual({
      status: "failed",
      code: "computer_unavailable",
    });
    const connected = await registerComputer(registry, { negotiatedCapabilities: {} });
    await expect(
      owner.start(connected.computerId, { computerId: connected.computerId, provider: "codex" }),
    ).resolves.toEqual({ status: "failed", code: "capability_missing" });
    expect(connected.frames).toEqual([]);
  });
});

describe("Agent Runtime test HTTP API", () => {
  it("returns passed or a sanitized failure and only reads the saved Agent configuration", async () => {
    const owner = {
      start: vi.fn().mockResolvedValue({ status: "passed" }),
    };
    const service = agentService();
    const { app } = appWith(service, new AgentRuntimeTestService(service as never, owner as never));
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/runtime-test`,
      headers: { authorization: "Bearer access" },
      payload: { expectedRevision: 4, expectedRuntimeConfigRevision: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "passed" });
    expect(service.getConfigById).toHaveBeenCalledWith(userId, agentId);
    expect(service.createForAccount).not.toHaveBeenCalled();
    expect(service.updateById).not.toHaveBeenCalled();
    expect(service.suspendById).not.toHaveBeenCalled();
    expect(service.reactivateById).not.toHaveBeenCalled();
    expect(service.rebindById).not.toHaveBeenCalled();
    expect(service.deleteById).not.toHaveBeenCalled();
    expect(owner.start).toHaveBeenCalledWith(computerId, {
      computerId,
      provider: "codex",
      model: "gpt-5.6",
      reasoningEffort: "medium",
      signal: expect.any(AbortSignal),
    });

    owner.start.mockResolvedValue({ status: "failed", code: "timeout" });
    const failed = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/runtime-test`,
      headers: { authorization: "Bearer access" },
      payload: { expectedRevision: 4, expectedRuntimeConfigRevision: 2 },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ status: "failed", code: "timeout" });
  });

  it("returns stale_configuration without dispatching when expected revisions do not match", async () => {
    const owner = { start: vi.fn() };
    const service = agentService();
    const { app } = appWith(service, new AgentRuntimeTestService(service as never, owner as never));
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/runtime-test`,
      headers: { authorization: "Bearer access" },
      payload: { expectedRevision: 3, expectedRuntimeConfigRevision: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "failed", code: "stale_configuration" });
    expect(owner.start).not.toHaveBeenCalled();
    expect(service.updateById).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers and extra request fields", async () => {
    const { app } = appWith(
      agentService(),
      new AgentRuntimeTestService(agentService() as never, { start: vi.fn() } as never),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/agents/${agentId}/runtime-test`,
          payload: { expectedRevision: 4, expectedRuntimeConfigRevision: 2 },
        })
      ).statusCode,
    ).toBe(401);
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/runtime-test`,
      headers: { authorization: "Bearer access" },
      payload: {
        expectedRevision: 4,
        expectedRuntimeConfigRevision: 2,
        prompt: "ignore me",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(AGENT_RUNTIME_TEST_TEMPLATE).toBe("/api/v1/agents/:agentId/runtime-test");
  });

  it("does not cancel a completed request and cancels when the HTTP client disconnects", async () => {
    let seenSignal: AbortSignal | undefined;
    let release: ((result: { status: "passed" }) => void) | undefined;
    const owner = {
      start: vi.fn(
        (_computerId: string, input: { signal?: AbortSignal }) =>
          new Promise<{ status: "passed" }>((resolve) => {
            seenSignal = input.signal;
            release = resolve;
          }),
      ),
    };
    const service = agentService();
    const { app } = appWith(service, new AgentRuntimeTestService(service as never, owner as never));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `${address}/api/v1/agents/${agentId}/runtime-test`;
    const headers = {
      authorization: "Bearer access",
      "content-type": "application/json",
    };
    const body = JSON.stringify({ expectedRevision: 4, expectedRuntimeConfigRevision: 2 });

    const completed = fetch(url, { method: "POST", headers, body });
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    expect(seenSignal?.aborted).toBe(false);
    release?.({ status: "passed" });
    const response = await completed;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "passed" });
    expect(seenSignal?.aborted).toBe(false);

    let disconnectSignal: AbortSignal | undefined;
    release = undefined;
    const controller = new AbortController();
    owner.start.mockImplementation(
      (_computerId: string, input: { signal?: AbortSignal }) =>
        new Promise<{ status: "passed" }>((resolve) => {
          disconnectSignal = input.signal;
          release = resolve;
        }),
    );
    const disconnected = fetch(url, { method: "POST", headers, body, signal: controller.signal });
    await vi.waitFor(() => expect(disconnectSignal).toBeDefined());
    expect(disconnectSignal?.aborted).toBe(false);
    controller.abort();
    await expect(disconnected).rejects.toThrow();
    await vi.waitFor(() => expect(disconnectSignal?.aborted).toBe(true));
    expect(service.updateById).not.toHaveBeenCalled();
  });
});

function agentService() {
  return {
    createForAccount: vi.fn(),
    listForAccount: vi.fn(),
    getById: vi.fn(),
    getUsageById: vi.fn(),
    getConfigById: vi.fn().mockResolvedValue(agent),
    updateById: vi.fn(),
    suspendById: vi.fn(),
    reactivateById: vi.fn(),
    rebindById: vi.fn(),
    deleteById: vi.fn(),
  };
}

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Admin" },
        setupCompletedAt: null,
      },
    }),
  };
}

function appWith(service: ReturnType<typeof agentService>, runtimeTest: AgentRuntimeTestService) {
  const app = createApp({
    authService: authService(),
    agentService: service as unknown as AgentService,
    agentRuntimeTestService: runtimeTest,
  });
  apps.push(app);
  return { app, service };
}

async function testOwnerFixture(options?: { maxPending?: number; ttlMs?: number }) {
  const registry = new ConnectionRegistry();
  const registered = await registerComputer(registry, {
    negotiatedCapabilities: { [RUNTIME_CAPABILITY.agentRuntimeTest]: 1 },
  });
  const owner = new AgentRuntimeTestOwner(registry, options);
  const context: RuntimeBusinessContext = {
    computerId: registered.computerId,
    installationId: registered.installationId,
    instanceId: registered.instanceId,
    signal: new AbortController().signal,
  };
  return { ...registered, context, owner, registry };
}

async function registerComputer(
  registry: ConnectionRegistry,
  entry: { negotiatedCapabilities: Record<string, number> },
) {
  const computerId = randomUUID();
  const instanceId = randomUUID();
  const installationId = randomUUID();
  const frames: unknown[] = [];
  await registry.register(
    {
      computerId,
      installationId,
      instanceId,
      lastHeartbeatAt: 1,
      negotiatedCapabilities: entry.negotiatedCapabilities,
      socket: {
        readyState: WebSocket.OPEN,
        close: vi.fn(),
        terminate: vi.fn(),
        send: vi.fn((serialized: string, callback: (error?: Error) => void) => {
          frames.push(JSON.parse(serialized));
          callback();
        }),
      } as unknown as WebSocket,
    },
    async () => undefined,
  );
  return { computerId, frames, instanceId, installationId };
}
