import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { RuntimeOwnershipFence } from "../runtime/runtime-ownership-fence.js";

describe("RuntimeOwnershipFence", () => {
  it("fences sockets and dispatch before allowing recovery", () => {
    const events: string[] = [];
    const fence = new RuntimeOwnershipFence({
      deliveryWorker: {
        pause: vi.fn(() => events.push("worker:pause")),
        resume: vi.fn(() => events.push("worker:resume")),
      },
      domainOwner: { close: vi.fn(() => events.push("domain:close")) },
      registry: {
        fenceAll: vi.fn(() => events.push("registry:fence")),
        unfence: vi.fn(() => events.push("registry:unfence")),
      },
      runtimeTestOwner: { close: vi.fn(() => events.push("runtime-test:close")) },
    });

    expect(fence.isAvailable()).toBe(true);
    fence.fence();
    fence.fence();
    expect(fence.isAvailable()).toBe(false);
    expect(events).toEqual(["registry:fence", "domain:close", "worker:pause", "runtime-test:close"]);

    fence.resume();
    fence.resume();
    expect(fence.isAvailable()).toBe(true);
    expect(events).toEqual([
      "registry:fence",
      "domain:close",
      "worker:pause",
      "runtime-test:close",
      "registry:unfence",
      "worker:resume",
    ]);
  });

  it("prevents a registered runtime from receiving traffic during the fenced interval", async () => {
    const registry = new ConnectionRegistry();
    const computerId = randomUUID();
    const instanceId = randomUUID();
    const socket = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      send: vi.fn((_data: string, callback: (error?: Error) => void) => callback()),
      terminate: vi.fn(),
    } as unknown as WebSocket;
    await registry.register(
      {
        computerId,
        installationId: randomUUID(),
        instanceId,
        lastHeartbeatAt: Date.now(),
        socket,
      },
      async () => undefined,
    );
    const fence = new RuntimeOwnershipFence({
      deliveryWorker: { pause: vi.fn(), resume: vi.fn() },
      domainOwner: { close: vi.fn() },
      registry,
    });

    fence.fence();

    await expect(registry.send(computerId, instanceId, { type: "runtime:mutation" })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1013, "Runtime ownership lease lost");
  });
});
