import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_V2,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { projectComputerProviderReadiness } from "../services/computers/provider-readiness.js";

describe("ConnectionRegistry", () => {
  it("keeps two Workspace enrollments for one physical Computer independently online", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const firstWorkspaceComputerId = randomUUID();
    const secondWorkspaceComputerId = randomUUID();
    const firstSocket = socket();
    const secondSocket = socket();
    const firstInstanceId = randomUUID();
    const secondInstanceId = randomUUID();

    await registry.register(
      {
        computerId,
        workspaceComputerId: firstWorkspaceComputerId,
        workspaceId: randomUUID(),
        instanceId: firstInstanceId,
        lastHeartbeatAt: 1,
        socket: firstSocket,
      },
      async () => undefined,
    );
    await registry.register(
      {
        computerId,
        workspaceComputerId: secondWorkspaceComputerId,
        workspaceId: randomUUID(),
        instanceId: secondInstanceId,
        lastHeartbeatAt: 1,
        socket: secondSocket,
      },
      async () => undefined,
    );

    expect(firstSocket.close).not.toHaveBeenCalled();
    expect(secondSocket.close).not.toHaveBeenCalled();
    expect(registry.currentInstanceId(firstWorkspaceComputerId)).toBe(firstInstanceId);
    expect(registry.currentInstanceId(secondWorkspaceComputerId)).toBe(secondInstanceId);
  });

  it("waits for an in-flight registration before closing a rotated enrollment", async () => {
    const registry = new ConnectionRegistry();
    const workspaceComputerId = randomUUID();
    const runtimeSocket = socket();
    let finishPersist: (() => void) | undefined;
    let persistStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      persistStarted = resolve;
    });
    const persisted = new Promise<void>((resolve) => {
      finishPersist = resolve;
    });
    const registration = registry.register(
      {
        computerId: randomUUID(),
        workspaceComputerId,
        workspaceId: randomUUID(),
        instanceId: randomUUID(),
        lastHeartbeatAt: 1,
        socket: runtimeSocket,
      },
      async () => {
        persistStarted?.();
        await persisted;
      },
    );
    await started;

    let closed = false;
    const closing = registry.closeEnrollment(workspaceComputerId).then((result) => {
      closed = true;
      return result;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishPersist?.();
    await registration;
    await expect(closing).resolves.toBe(true);
    expect(runtimeSocket.close).toHaveBeenCalledWith(4002, "Machine credential rotated or revoked");
    expect(registry.currentInstanceId(workspaceComputerId)).toBeUndefined();
  });

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
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );
    await registry.register(
      {
        computerId,
        instanceId: secondInstance,
        lastHeartbeatAt: 2,
        socket: second,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
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
    const staleComputerId = randomUUID();
    const freshComputerId = randomUUID();
    await registry.register(
      {
        computerId: staleComputerId,
        instanceId: randomUUID(),
        lastHeartbeatAt: 10,
        socket: stale,
        workspaceComputerId: staleComputerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );
    await registry.register(
      {
        computerId: freshComputerId,
        instanceId: randomUUID(),
        lastHeartbeatAt: 20,
        socket: fresh,
        workspaceComputerId: freshComputerId,
        workspaceId: randomUUID(),
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

  it("advertises credential-grant capability only for the verified current instance", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const firstInstanceId = randomUUID();
    await registry.register(
      {
        capabilities: { imCredentialGrant: 0 },
        capabilitiesUpdatedAt: 1,
        computerId,
        instanceId: firstInstanceId,
        lastHeartbeatAt: 1,
        socket: socket(),
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );
    expect(registry.supports(computerId, firstInstanceId, "imCredentialGrant", 1)).toBe(false);

    const verifiedInstanceId = randomUUID();
    const verifiedSocket = socket();
    await registry.register(
      {
        capabilities: { imCredentialGrant: 1 },
        capabilitiesUpdatedAt: 2,
        computerId,
        instanceId: verifiedInstanceId,
        lastHeartbeatAt: 2,
        negotiatedCapabilities: {
          [RUNTIME_CAPABILITY.imCredentialGrant]: 2,
          [RUNTIME_CAPABILITY.sessionCollaboration]: 1,
        },
        providerReadiness: [{ provider: "codex", status: "ready" }],
        providerReadinessObservedAt: 2,
        providerReadinessProviders: ["codex"],
        socket: verifiedSocket,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );
    expect(registry.supports(computerId, firstInstanceId, "imCredentialGrant", 2)).toBe(false);
    expect(registry.supports(computerId, verifiedInstanceId, "imCredentialGrant", 2)).toBe(true);
    expect(registry.supportsCapability(computerId, verifiedInstanceId, RUNTIME_CAPABILITY.sessionCollaboration)).toBe(
      true,
    );
    expect(registry.capabilityVersion(computerId, verifiedInstanceId, RUNTIME_CAPABILITY.imCredentialGrant, 2)).toBe(2);
    expect(registry.supportsCapability(computerId, firstInstanceId, RUNTIME_CAPABILITY.sessionCollaboration)).toBe(
      false,
    );
    expect(registry.supportsProvider(computerId, verifiedInstanceId, "codex", 2)).toBe(true);
    expect(registry.supportsProvider(computerId, verifiedInstanceId, "claude-code", 2)).toBe(false);
    expect(registry.providerReadiness(computerId, 2)).toEqual([
      { observation: { provider: "codex", status: "ready" }, observedAt: 2 },
    ]);

    expect(registry.touch(computerId, verifiedInstanceId, verifiedSocket, 3, { imCredentialGrant: 0 })).toBe(true);
    expect(registry.supports(computerId, verifiedInstanceId, "imCredentialGrant", 3)).toBe(false);
    expect(registry.touch(computerId, verifiedInstanceId, verifiedSocket, 4, { imCredentialGrant: 1 })).toBe(true);
    expect(registry.supports(computerId, verifiedInstanceId, "imCredentialGrant", 4)).toBe(true);
  });

  it("falls back to a fresh legacy credential-grant capability", async () => {
    const registry = new ConnectionRegistry();
    const workspaceComputerId = randomUUID();
    const instanceId = randomUUID();
    await registry.register(
      {
        capabilities: { imCredentialGrant: 1 },
        capabilitiesUpdatedAt: 100,
        computerId: workspaceComputerId,
        instanceId,
        lastHeartbeatAt: 100,
        socket: socket(),
        workspaceComputerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );

    expect(registry.capabilityVersion(workspaceComputerId, instanceId, RUNTIME_CAPABILITY.imCredentialGrant, 100)).toBe(
      1,
    );
    expect(
      registry.capabilityVersion(
        workspaceComputerId,
        instanceId,
        RUNTIME_CAPABILITY.imCredentialGrant,
        100 + RUNTIME_CLIENT_CAPABILITY_TTL_MS + 1,
      ),
    ).toBeUndefined();
    expect(
      registry.capabilityVersion(workspaceComputerId, instanceId, RUNTIME_CAPABILITY.sessionCollaboration, 100),
    ).toBeUndefined();
  });

  it("adds the current v2 connection fence without changing the domain frame", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const connectionId = randomUUID();
    const instanceId = randomUUID();
    const send = vi.fn((_data: string, callback: (error?: Error) => void) => callback());
    const runtimeSocket = {
      close: vi.fn(),
      readyState: WebSocket.OPEN,
      send,
      terminate: vi.fn(),
    } as unknown as WebSocket;
    await registry.register(
      {
        active: false,
        computerId,
        connectionId,
        instanceId,
        lastHeartbeatAt: 1,
        protocolVersion: RUNTIME_PROTOCOL_V2,
        socket: runtimeSocket,
        providerReadiness: [{ provider: "codex", status: "ready" }],
        providerReadinessObservedAt: 1,
        providerReadinessProviders: ["codex"],
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );
    await expect(
      registry.send(computerId, instanceId, { type: "session:reconcile", requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(registry.providerReadiness(computerId, 1)).toEqual([]);
    expect(registry.activate(computerId, instanceId, runtimeSocket)).toBe(true);
    expect(registry.providerReadiness(computerId, 1)).toMatchObject([
      { observation: { provider: "codex", status: "ready" } },
    ]);
    await registry.send(computerId, instanceId, { type: "session:reconcile", requestId: randomUUID() });
    const serialized = send.mock.calls[0]?.[0];
    expect(JSON.parse(String(serialized))).toMatchObject({
      type: "session:reconcile",
      connectionId,
    });
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
        providerReadiness: [{ provider: "codex", status: "sign-in" }],
        providerReadinessObservedAt: 1,
        providerReadinessProviders: ["codex"],
        socket: currentSocket,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );

    expect(registry.providerReadiness(computerId, 1)).toEqual([
      {
        observation: { provider: "codex", status: "sign-in" },
        observedAt: 1,
      },
    ]);
    expect(registry.providerReadiness(computerId, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 2)).toEqual([]);

    expect(
      registry.touch(computerId, instanceId, currentSocket, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 3, undefined, [
        { provider: "codex", status: "ready" },
      ]),
    ).toBe(true);
    expect(registry.providerReadiness(computerId, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 3)).toMatchObject([
      {
        observation: { provider: "codex", status: "ready" },
      },
    ]);
    expect(
      registry.touch(computerId, instanceId, currentSocket, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 4, undefined, []),
    ).toBe(true);
    expect(registry.providerReadiness(computerId, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 4)).toEqual([]);
    expect(
      registry.touch(
        computerId,
        instanceId,
        currentSocket,
        RUNTIME_CLIENT_CAPABILITY_TTL_MS * 2 + 4,
        undefined,
        undefined,
      ),
    ).toBe(true);
    expect(registry.providerReadiness(computerId, RUNTIME_CLIENT_CAPABILITY_TTL_MS * 2 + 4)).toEqual([]);
    expect(
      projectComputerProviderReadiness(
        computerId,
        "online",
        new Date(RUNTIME_CLIENT_CAPABILITY_TTL_MS * 2 + 4),
        registry,
      ),
    ).toEqual([
      { provider: "codex", status: "checking", observedAt: null },
      { provider: "claude-code", status: "checking", observedAt: null },
    ]);
    expect(registry.remove(computerId, instanceId, currentSocket)).toBe(true);
    expect(registry.providerReadiness(computerId, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 3)).toEqual([]);
  });

  it("removes an old instance readiness observation when a replacement becomes current", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const oldInstanceId = randomUUID();
    const newInstanceId = randomUUID();
    const oldSocket = socket();
    await registry.register(
      {
        computerId,
        instanceId: oldInstanceId,
        lastHeartbeatAt: 1,
        providerReadiness: [{ provider: "codex", status: "ready" }],
        providerReadinessObservedAt: 1,
        providerReadinessProviders: ["codex"],
        socket: oldSocket,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );
    expect(registry.supportsProvider(computerId, oldInstanceId, "codex", 1)).toBe(true);

    await registry.register(
      {
        capabilities: { imCredentialGrant: 0 },
        capabilitiesUpdatedAt: 2,
        computerId,
        instanceId: newInstanceId,
        lastHeartbeatAt: 2,
        providerReadiness: [],
        providerReadinessProviders: ["codex"],
        socket: socket(),
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
      },
      async () => undefined,
    );

    expect(oldSocket.close).toHaveBeenCalledWith(4001, "Replaced by a newer daemon instance");
    expect(registry.providerReadiness(computerId, 2)).toEqual([]);
    expect(registry.supportsProvider(computerId, oldInstanceId, "codex", 2)).toBe(false);
    expect(registry.supportsProvider(computerId, newInstanceId, "codex", 2)).toBe(false);
  });

  it("tracks IM CLI readiness with freshness and active-instance fences", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    const runtimeSocket = socket();
    await registry.register(
      {
        computerId,
        instanceId,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
        lastHeartbeatAt: 1,
        socket: runtimeSocket,
        imCliReadiness: [{ provider: "codex", status: "ready" }],
        imCliReadinessObservedAt: 10,
      },
      async () => undefined,
    );
    expect(registry.imCliReadiness(computerId, 10)).toEqual([
      { observation: { provider: "codex", status: "ready" }, observedAt: 10 },
    ]);
    expect(registry.supportsImCli(computerId, "codex", 10)).toBe(true);
    expect(registry.supportsImCli(computerId, "claude-code", 10)).toBe(false);
    expect(registry.imCliReadiness(computerId, 10 + RUNTIME_CLIENT_CAPABILITY_TTL_MS + 1)).toEqual([]);
    expect(registry.imCliReadiness(randomUUID(), 10)).toEqual([]);
    expect(registry.touch(computerId, instanceId, runtimeSocket, 20, undefined, undefined, [])).toBe(true);
    expect(registry.imCliReadiness(computerId, 20)).toEqual([]);
    expect(
      registry.touch(computerId, instanceId, runtimeSocket, 30, undefined, undefined, [
        { provider: "claude-code", status: "install" },
      ]),
    ).toBe(true);
    expect(registry.imCliReadiness(computerId, 30)).toMatchObject([
      { observation: { provider: "claude-code", status: "install" } },
    ]);
    expect(registry.touch(computerId, instanceId, runtimeSocket, 31, undefined, undefined, undefined)).toBe(true);
    expect(registry.activate(computerId, randomUUID(), runtimeSocket)).toBe(false);
  });

  it("maps send failures to explicit registry errors and protects v2 fences", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    const sendErrorSocket = {
      ...socket(),
      readyState: WebSocket.OPEN,
      send: vi.fn((_data: string, callback: (error?: Error) => void) => callback(new Error("send failed"))),
    } as unknown as WebSocket;
    await registry.register(
      {
        computerId,
        instanceId,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
        lastHeartbeatAt: 1,
        socket: sendErrorSocket,
      },
      async () => undefined,
    );
    await expect(registry.send(randomUUID(), instanceId, {})).rejects.toMatchObject({ code: "instance_replaced" });
    await expect(registry.send(computerId, randomUUID(), {})).rejects.toMatchObject({ code: "instance_replaced" });
    await expect(registry.send(computerId, instanceId, {})).rejects.toMatchObject({ code: "unavailable" });

    const closedSocket = { ...socket(), readyState: WebSocket.CLOSED } as unknown as WebSocket;
    await registry.register(
      {
        computerId,
        instanceId: randomUUID(),
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
        lastHeartbeatAt: 1,
        socket: closedSocket,
      },
      async () => undefined,
    );
    await expect(registry.send(computerId, registry.currentInstanceId(computerId) as string, {})).rejects.toMatchObject(
      { code: "unavailable" },
    );

    const v2 = {
      ...socket(),
      readyState: WebSocket.OPEN,
      send: vi.fn((_data: string, callback: (error?: Error) => void) => callback()),
    } as unknown as WebSocket;
    await registry.register(
      {
        computerId,
        instanceId,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
        connectionId: randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        lastHeartbeatAt: 1,
        socket: v2,
      },
      async () => undefined,
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(registry.send(computerId, instanceId, circular)).rejects.toMatchObject({ code: "frame_too_large" });
    const tooLarge = { text: "x".repeat(RUNTIME_MAX_FRAME_BYTES * 2) };
    await expect(registry.send(computerId, instanceId, tooLarge)).rejects.toMatchObject({ code: "frame_too_large" });
    const callbackError = vi.fn((_data: string, callback: (error?: Error) => void) => callback(new Error("failed")));
    const callbackSocket = { ...v2, readyState: WebSocket.OPEN, send: callbackError } as unknown as WebSocket;
    await registry.register(
      {
        computerId,
        instanceId,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
        connectionId: randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        lastHeartbeatAt: 1,
        socket: callbackSocket,
      },
      async () => undefined,
    );
    await expect(registry.send(computerId, instanceId, {})).rejects.toMatchObject({ code: "unavailable" });

    const missingFence = { ...socket(), readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
    const missingFenceInstance = randomUUID();
    await registry.register(
      {
        computerId,
        instanceId: missingFenceInstance,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        lastHeartbeatAt: 1,
        socket: missingFence,
      },
      async () => undefined,
    );
    await expect(registry.send(computerId, missingFenceInstance, {})).rejects.toMatchObject({
      code: "instance_replaced",
    });

    const staleFence = randomUUID();
    const fencedInstance = randomUUID();
    await registry.register(
      {
        computerId,
        instanceId: fencedInstance,
        workspaceComputerId: computerId,
        workspaceId: randomUUID(),
        connectionId: staleFence,
        protocolVersion: RUNTIME_PROTOCOL_V2,
        lastHeartbeatAt: 1,
        socket: missingFence,
      },
      async () => undefined,
    );
    await expect(registry.send(computerId, fencedInstance, { connectionId: randomUUID() })).rejects.toMatchObject({
      code: "instance_replaced",
    });

    const raceRegistry = new ConnectionRegistry();
    const raceComputerId = randomUUID();
    const raceInstanceId = randomUUID();
    let finishSend: ((error?: Error) => void) | undefined;
    const raceSocket = {
      ...socket(),
      readyState: WebSocket.OPEN,
      send: vi.fn((_data: string, callback: (error?: Error) => void) => {
        finishSend = callback;
      }),
    } as unknown as WebSocket;
    await raceRegistry.register(
      {
        computerId: raceComputerId,
        instanceId: raceInstanceId,
        workspaceComputerId: raceComputerId,
        workspaceId: randomUUID(),
        lastHeartbeatAt: 1,
        socket: raceSocket,
      },
      async () => undefined,
    );
    const sending = raceRegistry.send(raceComputerId, raceInstanceId, {});
    await raceRegistry.register(
      {
        computerId: raceComputerId,
        instanceId: randomUUID(),
        workspaceComputerId: raceComputerId,
        workspaceId: randomUUID(),
        lastHeartbeatAt: 2,
        socket: socket(),
      },
      async () => undefined,
    );
    finishSend?.();
    await expect(sending).rejects.toMatchObject({ code: "instance_replaced" });
  });

  it("does not publish or retain a registration when persistence fails", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    const publish = vi.fn();
    await expect(
      registry.register(
        {
          computerId,
          instanceId,
          workspaceComputerId: computerId,
          workspaceId: randomUUID(),
          lastHeartbeatAt: 1,
          socket: socket(),
        },
        async () => {
          throw new Error("persist failed");
        },
        publish,
      ),
    ).rejects.toThrow("persist failed");
    expect(publish).not.toHaveBeenCalled();
    expect(registry.currentInstanceId(computerId)).toBeUndefined();
  });
});

function socket(): WebSocket {
  return { close: vi.fn(), terminate: vi.fn() } as unknown as WebSocket;
}
