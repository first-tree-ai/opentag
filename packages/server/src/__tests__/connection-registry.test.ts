import { randomUUID } from "node:crypto";
import { RUNTIME_CLIENT_CAPABILITY_TTL_MS } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";

describe("ConnectionRegistry", () => {
  it("fences replacement close, heartbeat, and stale-instance cleanup by exact socket", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const first = socket();
    const second = socket();
    const firstInstance = randomUUID();
    const secondInstance = randomUUID();
    await registry.register(
      {
        computerId,
        instanceId: firstInstance,
        lastHeartbeatAt: 1,
        socket: first,
        userId: randomUUID(),
      },
      async () => undefined,
    );
    await registry.register(
      {
        computerId,
        instanceId: secondInstance,
        lastHeartbeatAt: 2,
        socket: second,
        userId: randomUUID(),
      },
      async () => undefined,
    );

    expect(first.close).toHaveBeenCalledWith(4001, "Replaced by a newer daemon instance");
    expect(registry.touch(computerId, firstInstance, first, 3)).toBe(false);
    expect(registry.remove(computerId, firstInstance, first)).toBe(false);
    expect(registry.isCurrent(computerId, secondInstance, second)).toBe(true);
    expect(registry.touch(computerId, secondInstance, second, 4)).toBe(true);
  });

  it("terminates only stale sockets and closes all current sockets during shutdown", async () => {
    const registry = new ConnectionRegistry();
    const stale = socket();
    const fresh = socket();
    await registry.register(
      {
        computerId: randomUUID(),
        instanceId: randomUUID(),
        lastHeartbeatAt: 10,
        socket: stale,
        userId: randomUUID(),
      },
      async () => undefined,
    );
    await registry.register(
      {
        computerId: randomUUID(),
        instanceId: randomUUID(),
        lastHeartbeatAt: 20,
        socket: fresh,
        userId: randomUUID(),
      },
      async () => undefined,
    );
    registry.terminateStale(15);
    expect(stale.terminate).toHaveBeenCalledOnce();
    expect(fresh.terminate).not.toHaveBeenCalled();
    registry.closeAll();
    expect(stale.close).toHaveBeenCalledWith(1001, "Server shutting down");
    expect(fresh.close).toHaveBeenCalledWith(1001, "Server shutting down");
  });

  it("advertises message-tool readiness only for the verified current instance", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const firstInstanceId = randomUUID();
    await registry.register(
      {
        capabilities: { imMessageTool: 0 },
        capabilitiesUpdatedAt: 1,
        computerId,
        instanceId: firstInstanceId,
        lastHeartbeatAt: 1,
        socket: socket(),
        userId: randomUUID(),
      },
      async () => undefined,
    );
    expect(registry.supports(computerId, firstInstanceId, "imMessageTool", 1)).toBe(false);

    const verifiedInstanceId = randomUUID();
    const verifiedSocket = socket();
    await registry.register(
      {
        capabilities: { imMessageTool: 1 },
        capabilitiesUpdatedAt: 2,
        computerId,
        instanceId: verifiedInstanceId,
        lastHeartbeatAt: 2,
        socket: verifiedSocket,
        userId: randomUUID(),
      },
      async () => undefined,
    );
    expect(registry.supports(computerId, firstInstanceId, "imMessageTool", 2)).toBe(false);
    expect(registry.supports(computerId, verifiedInstanceId, "imMessageTool", 2)).toBe(true);

    expect(registry.touch(computerId, verifiedInstanceId, verifiedSocket, 3, { imMessageTool: 0 })).toBe(true);
    expect(registry.supports(computerId, verifiedInstanceId, "imMessageTool", 3)).toBe(false);
    expect(registry.touch(computerId, verifiedInstanceId, verifiedSocket, 4, { imMessageTool: 1 })).toBe(true);
    expect(registry.supports(computerId, verifiedInstanceId, "imMessageTool", 4)).toBe(true);
  });

  it("returns only fresh readiness observations from the current Computer instance", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    const currentSocket = socket();
    await registry.register(
      {
        computerId,
        instanceId,
        lastHeartbeatAt: 1,
        providerReadiness: { provider: "codex", status: "sign-in" },
        providerReadinessObservedAt: 1,
        socket: currentSocket,
        userId: randomUUID(),
      },
      async () => undefined,
    );

    expect(registry.providerReadiness(computerId, 1)).toEqual({
      observation: { provider: "codex", status: "sign-in" },
      observedAt: 1,
    });
    expect(registry.providerReadiness(computerId, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 2)).toBeUndefined();

    expect(
      registry.touch(computerId, instanceId, currentSocket, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 3, undefined, {
        provider: "codex",
        status: "ready",
      }),
    ).toBe(true);
    expect(registry.providerReadiness(computerId, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 3)).toMatchObject({
      observation: { provider: "codex", status: "ready" },
    });
    expect(registry.remove(computerId, instanceId, currentSocket)).toBe(true);
    expect(registry.providerReadiness(computerId, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 3)).toBeUndefined();
  });
});

function socket(): WebSocket {
  return { close: vi.fn(), terminate: vi.fn() } as unknown as WebSocket;
}
