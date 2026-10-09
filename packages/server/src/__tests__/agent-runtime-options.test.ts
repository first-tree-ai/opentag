import { randomUUID } from "node:crypto";
import { agentRuntimeOptionsPath, RUNTIME_CAPABILITY } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app.js";
import { AgentRuntimeOptionsOwner } from "../runtime/agent-runtime-options-owner.js";
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

async function fixture(capability = true, ttlMs = 1000) {
  const registry = new ConnectionRegistry();
  const computerId = randomUUID();
  const instanceId = randomUUID();
  const installationId = randomUUID();
  const frames: Record<string, unknown>[] = [];
  await registry.register(
    {
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
    await expect(promise).rejects.toMatchObject({ statusCode: 503 });
    expect(f.frames[1]).toMatchObject({ type: "agent-runtime:options:cancel" });
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
});
