import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";

describe("ConnectionRegistry", () => {
  it("fences replacement close, heartbeat, and stale-instance cleanup by exact socket", () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const first = socket();
    const second = socket();
    const firstInstance = randomUUID();
    const secondInstance = randomUUID();
    registry.register({
      computerId,
      instanceId: firstInstance,
      lastHeartbeatAt: 1,
      socket: first,
      userId: randomUUID(),
    });
    registry.register({
      computerId,
      instanceId: secondInstance,
      lastHeartbeatAt: 2,
      socket: second,
      userId: randomUUID(),
    });

    expect(first.close).toHaveBeenCalledWith(4001, "Replaced by a newer daemon instance");
    expect(registry.touch(computerId, firstInstance, first, 3)).toBe(false);
    expect(registry.remove(computerId, firstInstance, first)).toBe(false);
    expect(registry.isCurrent(computerId, secondInstance, second)).toBe(true);
    expect(registry.touch(computerId, secondInstance, second, 4)).toBe(true);
  });

  it("terminates only stale sockets and closes all current sockets during shutdown", () => {
    const registry = new ConnectionRegistry();
    const stale = socket();
    const fresh = socket();
    registry.register({
      computerId: randomUUID(),
      instanceId: randomUUID(),
      lastHeartbeatAt: 10,
      socket: stale,
      userId: randomUUID(),
    });
    registry.register({
      computerId: randomUUID(),
      instanceId: randomUUID(),
      lastHeartbeatAt: 20,
      socket: fresh,
      userId: randomUUID(),
    });
    registry.terminateStale(15);
    expect(stale.terminate).toHaveBeenCalledOnce();
    expect(fresh.terminate).not.toHaveBeenCalled();
    registry.closeAll();
    expect(stale.close).toHaveBeenCalledWith(1001, "Server shutting down");
    expect(fresh.close).toHaveBeenCalledWith(1001, "Server shutting down");
  });
});

function socket(): WebSocket {
  return { close: vi.fn(), terminate: vi.fn() } as unknown as WebSocket;
}
