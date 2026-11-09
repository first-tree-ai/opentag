import { randomUUID } from "node:crypto";
import { agentRuntimeOptionsPath, RUNTIME_CAPABILITY } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import { AgentRuntimeOptionsOwner, isRuntimeOptionsAbortError } from "../runtime/agent-runtime-options-owner.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { AgentRuntimeOptionsService } from "../services/agents/agent-runtime-options-service.js";
import { AgentServiceError } from "../services/agents/errors.js";
import type { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";

const userId = randomUUID();
const agentId = randomUUID();
const options = { modelSuggestions: ["custom/model"], reasoningEffortAllowedValues: ["ultra"] };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(capability = true, ttlMs = 1000, registry = new ConnectionRegistry()) {
  const computerId = randomUUID();
  const instanceId = randomUUID();
  const installationId = randomUUID();
  const frames: Record<string, unknown>[] = [];
  await registry.register(
    {
      clientVersion: "0.1.1",
      computerId,
      instanceId,
      installationId,
      lastHeartbeatAt: Date.now(),
      negotiatedCapabilities: capability ? { [RUNTIME_CAPABILITY.agentRuntimeOptions]: 1 } : {},
      socket: {
        readyState: WebSocket.OPEN,
        close: vi.fn(),
        terminate: vi.fn(),
        send: vi.fn((serialized, callback) => {
          frames.push(JSON.parse(serialized));
          callback();
        }),
      } as unknown as WebSocket,
    },
    async () => undefined,
  );
  const owner = new AgentRuntimeOptionsOwner(registry, ttlMs);
  const input = { computerId, agentId, provider: "codex" as const, model: "custom/model" };
  const context = { computerId, instanceId, installationId, signal: new AbortController().signal };
  const agents = {
    getConfigById: vi.fn().mockResolvedValue({ computerId, runtimeProvider: "codex" }),
  } as unknown as Pick<AgentService, "getConfigById">;
  const service = new AgentRuntimeOptionsService(agents, owner, vi.fn().mockResolvedValue("local"));
  return { registry, owner, input, context, frames, service, agents };
}

describe("Agent runtime options", () => {
  it("isolates concurrent Computer queries and ignores cross-routed results", async () => {
    const first = await fixture();
    const second = await fixture(true, 1000, first.registry);
    const firstQuery = first.owner.start(first.input);
    const secondQuery = first.owner.start(second.input);
    const firstRequestId = first.frames[0]?.requestId;
    const secondRequestId = second.frames[0]?.requestId;
    expect(firstRequestId).not.toBe(secondRequestId);
    const firstOptions = { modelSuggestions: ["computer-a/model"], reasoningEffortAllowedValues: ["high"] };
    const secondOptions = { modelSuggestions: ["computer-b/model"], reasoningEffortAllowedValues: ["max"] };
    const firstResult = {
      type: "agent-runtime:options:result",
      requestId: firstRequestId,
      result: { status: "completed", options: firstOptions },
    };
    const secondResult = {
      type: "agent-runtime:options:result",
      requestId: secondRequestId,
      result: { status: "completed", options: secondOptions },
    };
    const business = first.owner.businessOptions();
    await business.handle(firstResult, second.context);
    await business.handle(secondResult, first.context);
    await business.handle(secondResult, second.context);
    expect(await secondQuery).toEqual(secondOptions);
    await business.handle(firstResult, first.context);
    expect(await firstQuery).toEqual(firstOptions);
    first.owner.close();
    second.owner.close();
  });

  it("correlates results with the current Computer instance and rejects foreign/late results", async () => {
    const f = await fixture();
    const promise = f.owner.start(f.input);
    expect(f.frames[0]).toMatchObject({ ...f.input, type: "agent-runtime:options" });
    const result = {
      type: "agent-runtime:options:result",
      requestId: f.frames[0]?.requestId,
      result: { status: "completed", options },
    };
    const business = f.owner.businessOptions();
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await business.handle(result, { ...f.context, instanceId: randomUUID() });
    expect(settled).toBe(false);
    await business.handle(result, f.context);
    expect(await promise).toEqual(options);
    await business.handle(result, f.context);
  });

  it("returns 501 for legacy clients, 503 offline, and cancels timed-out and aborted requests", async () => {
    const legacy = await fixture(false);
    await expect(legacy.service.get(userId, agentId)).rejects.toMatchObject({ statusCode: 501 });
    expect(legacy.frames).toHaveLength(0);
    const offline = new AgentRuntimeOptionsOwner(new ConnectionRegistry());
    await expect(offline.start(legacy.input)).rejects.toMatchObject({ statusCode: 503 });
    const timed = await fixture(true, 20);
    await expect(timed.owner.start(timed.input)).rejects.toMatchObject({ statusCode: 504 });
    expect(timed.frames[1]).toMatchObject({
      type: "agent-runtime:options:cancel",
      requestId: timed.frames[0]?.requestId,
    });
    const f = await fixture();
    const controller = new AbortController();
    const promise = f.owner.start(f.input, controller.signal);
    controller.abort();
    await expect(promise).rejects.toSatisfy(
      (error) => isRuntimeOptionsAbortError(error) && (error as AgentServiceError).statusCode === 503,
    );
    expect(f.frames[1]).toMatchObject({ type: "agent-runtime:options:cancel" });
    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedPromise = f.owner.start(f.input, preAborted.signal);
    await expect(preAbortedPromise).rejects.toBeInstanceOf(AgentServiceError);
    await expect(preAbortedPromise).rejects.toSatisfy(
      (error) =>
        isRuntimeOptionsAbortError(error) &&
        (error as AgentServiceError).statusCode === 503 &&
        (error as AgentServiceError).code === "SERVICE_UNAVAILABLE",
    );
    expect(f.frames).toHaveLength(2);
  });

  it("checks authorization and placement, and never dispatches Cloud model queries locally", async () => {
    const f = await fixture();
    vi.mocked(f.agents.getConfigById).mockRejectedValueOnce(
      new AgentServiceError("RESOURCE_NOT_FOUND", "deterministic", "Not found", 404),
    );
    await expect(f.service.get(userId, agentId)).rejects.toMatchObject({ statusCode: 404 });
    expect(f.frames).toHaveLength(0);
    const cloud = new AgentRuntimeOptionsService(f.agents, f.owner, async () => "cloud");
    await expect(cloud.get(userId, agentId)).rejects.toMatchObject({ statusCode: 501 });
    expect(f.frames).toHaveLength(0);
    const changed = f.service.get(userId, agentId);
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    vi.mocked(f.agents.getConfigById).mockResolvedValue({
      computerId: randomUUID(),
      runtimeProvider: "codex",
    } as never);
    await f.owner.businessOptions().handle(
      {
        type: "agent-runtime:options:result",
        requestId: f.frames[0]?.requestId,
        result: { status: "completed", options },
      },
      f.context,
    );
    await expect(changed).rejects.toMatchObject({ statusCode: 409 });
  });

  it("publishes an authenticated read-only HTTP query, validates inputs, and preserves null metadata", async () => {
    const f = await fixture();
    const authService = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({
        tokenExpiresAt: new Date("2030-01-01"),
        me: { user: { id: userId, email: "test@example.com", displayName: "Test" }, setupCompletedAt: null },
      }),
    } as unknown as UserAuthService;
    const app = createApp({
      authService,
      agentService: f.agents as AgentService,
      agentRuntimeOptionsService: f.service,
    });
    apps.push(app);
    const response = app.inject({
      method: "GET",
      url: `${agentRuntimeOptionsPath(agentId)}?model=custom%2Fmodel`,
      headers: { authorization: "Bearer test" },
    });
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    expect(f.frames[0]).toMatchObject({ model: "custom/model", provider: "codex" });
    const unknown = { ...options, reasoningEffortAllowedValues: null };
    await f.owner.businessOptions().handle(
      {
        type: "agent-runtime:options:result",
        requestId: f.frames[0]?.requestId,
        result: { status: "completed", options: unknown },
      },
      f.context,
    );
    const result = await response;
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(unknown);
    expect(result.headers["cache-control"]).toBe("no-store");
    const invalid = await app.inject({
      method: "GET",
      url: `${agentRuntimeOptionsPath(agentId)}?provider=pi`,
      headers: { authorization: "Bearer test" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(f.frames).toHaveLength(1);
  });

  it("cancels in-flight Computer queries without logging a 503 Request failed error when the HTTP client aborts, while preserving independent server failure logs and 503/504 for connected clients", async () => {
    const f = await fixture();
    const chunks: string[] = [];
    const authService = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({
        tokenExpiresAt: new Date("2030-01-01"),
        me: { user: { id: userId, email: "test@example.com", displayName: "Test" }, setupCompletedAt: null },
      }),
    } as unknown as UserAuthService;
    const app = createApp({
      authService,
      agentService: f.agents as AgentService,
      agentRuntimeOptionsService: f.service,
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });
    apps.push(app);
    let rawReply: { destroyed: boolean } | undefined;
    app.addHook("onRequest", async (_request, reply) => {
      rawReply = reply.raw;
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `${address}${agentRuntimeOptionsPath(agentId)}`;

    const cancelController = new AbortController();
    const cancelledFetch = fetch(url, {
      headers: { authorization: "Bearer test" },
      signal: cancelController.signal,
    });
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    cancelController.abort();
    await expect(cancelledFetch).rejects.toThrow();
    await vi.waitFor(() =>
      expect(f.frames[1]).toMatchObject({
        type: "agent-runtime:options:cancel",
        requestId: f.frames[0]?.requestId,
      }),
    );
    const errorLogsAfterCancel = () =>
      chunks
        .flatMap((chunk) => chunk.trim().split("\n"))
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { err?: { message?: string }; level?: number; msg?: string })
        .filter((record) => record.level === 50 && record.msg === "Request failed");
    expect(errorLogsAfterCancel()).toEqual([]);

    let enterBarrier: (() => void) | undefined;
    const enteredBarrier = new Promise<void>((resolve) => {
      enterBarrier = resolve;
    });
    let failBarrier: ((error: Error) => void) | undefined;
    vi.mocked(f.agents.getConfigById).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          enterBarrier?.();
          failBarrier = reject;
        }),
    );
    const storageAbortController = new AbortController();
    const disconnectedStorageFetch = fetch(url, {
      headers: { authorization: "Bearer test" },
      signal: storageAbortController.signal,
    });
    await enteredBarrier;
    storageAbortController.abort();
    await expect(disconnectedStorageFetch).rejects.toThrow();
    await vi.waitFor(() => expect(rawReply?.destroyed).toBe(true));
    failBarrier?.(new Error("storage invariant failed"));
    await vi.waitFor(() =>
      expect(errorLogsAfterCancel()).toEqual([
        expect.objectContaining({
          level: 50,
          msg: "Request failed",
          err: expect.objectContaining({ message: "storage invariant failed" }),
        }),
      ]),
    );

    const timed = await fixture(true, 20);
    const timedApp = createApp({
      authService,
      agentService: timed.agents as AgentService,
      agentRuntimeOptionsService: timed.service,
    });
    apps.push(timedApp);
    const timeoutResult = await timedApp.inject({
      method: "GET",
      url: agentRuntimeOptionsPath(agentId),
      headers: { authorization: "Bearer test" },
    });
    expect(timeoutResult.statusCode).toBe(504);

    const offlineOwner = new AgentRuntimeOptionsOwner(new ConnectionRegistry());
    const offlineService = new AgentRuntimeOptionsService(f.agents, offlineOwner, vi.fn().mockResolvedValue("local"));
    const offlineApp = createApp({
      authService,
      agentService: f.agents as AgentService,
      agentRuntimeOptionsService: offlineService,
    });
    apps.push(offlineApp);
    const offlineResult = await offlineApp.inject({
      method: "GET",
      url: agentRuntimeOptionsPath(agentId),
      headers: { authorization: "Bearer test" },
    });
    expect(offlineResult.statusCode).toBe(503);
  });
});
