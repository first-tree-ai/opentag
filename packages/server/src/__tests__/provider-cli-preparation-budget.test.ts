import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type ServerRuntimeBusinessFrame } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { ProviderCliReconcileOwner } from "../runtime/provider-cli-reconcile-owner.js";
import { deferred } from "./support/deferred.js";

async function fixture(prewarm: boolean, timeoutMs = 30) {
  const registry = new ConnectionRegistry();
  const computerId = randomUUID(),
    instanceId = randomUUID(),
    installationId = randomUUID(),
    agentId = randomUUID();
  const frames: ServerRuntimeBusinessFrame[] = [];
  const callbacks: ((error?: Error) => void)[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    send: vi.fn((body: string, callback: (error?: Error) => void) => {
      frames.push(JSON.parse(body));
      callbacks.push(callback);
    }),
  } as unknown as WebSocket;
  await registry.register(
    {
      computerId,
      instanceId,
      installationId,
      active: true,
      lastHeartbeatAt: Date.now(),
      socket,
      negotiatedCapabilities: {
        [RUNTIME_CAPABILITY.providerCliPrewarm]: 1,
        [RUNTIME_CAPABILITY.providerCliReconcile]: 1,
      },
    },
    async () => undefined,
  );
  const source = {
    shouldPrewarmOfficialProviderClis: vi.fn(async () => prewarm),
    listActiveProviderCliRequirements: vi.fn(async () => [
      {
        agentId,
        integrationId: randomUUID(),
        provider: "slack" as const,
        credentialGeneration: 1,
        expectedIdentity: { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" },
      },
    ]),
    issueIntegrationCliValidationGrant: vi.fn(),
  };
  const owner = new ProviderCliReconcileOwner(registry, source, { preparationTimeoutMs: timeoutMs });
  const input = { computerId, agentId, runtimeProvider: "codex" as const };
  return { registry, owner, input, frames, callbacks, source, socket, computerId, instanceId, installationId };
}

describe("Provider preparation operation budget", () => {
  it.each([true, false])("bounds prewarm=%s socket waiting on timeout and allows a new attempt", async (prewarm) => {
    const f = await fixture(prewarm);
    try {
      await expect(f.owner.prepareComputer(f.input)).rejects.toThrow("timed out");
      expect(f.callbacks).toHaveLength(1);
      const next = f.owner.prepareComputer(f.input).then(
        () => "started",
        (error) => String(error),
      );
      await vi.waitFor(() => expect(f.callbacks).toHaveLength(2), { interval: 1 });
      f.callbacks[0]?.(new Error("late old send error"));
      if (prewarm) expect(f.registry.providerReadiness(f.computerId)[0]?.observation.status).toBe("checking");
      f.owner.close();
      expect(await next).toContain("closed");
      if (prewarm) expect(f.source.listActiveProviderCliRequirements).not.toHaveBeenCalled();
    } finally {
      f.owner.close();
      for (const callback of f.callbacks) callback();
    }
  });

  it.each([true, false])("close rejects a prewarm=%s admitted wait before its send callback", async (prewarm) => {
    const f = await fixture(prewarm, 5000);
    const result = f.owner.prepareComputer(f.input).then(
      () => "started",
      (error) => String(error),
    );
    try {
      await vi.waitFor(() => expect(f.callbacks).toHaveLength(1), { interval: 1 });
      let drained = false;
      const closing = f.owner.close().then(() => {
        drained = true;
      });
      expect(await result).toContain("closed");
      expect(drained).toBe(false);
      for (const callback of f.callbacks) callback(new Error("closed send"));
      await closing;
      expect(drained).toBe(true);
      await expect(f.owner.prepareComputer(f.input)).rejects.toThrow("closed");
    } finally {
      for (const callback of f.callbacks) callback(new Error("late closed send"));
    }
  });

  it("keeps the operation budget after a ready result while active requirement send is pending", async () => {
    const f = await fixture(true, 100);
    try {
      const result = f.owner.prepareComputer(f.input).then(
        () => "started",
        (error) => String(error),
      );
      await vi.waitFor(() => expect(f.frames[0]?.type).toBe("provider-cli:prewarm"), { interval: 1 });
      f.callbacks[0]?.();
      await vi.waitFor(() => expect(f.frames[1]?.type).toBe("provider-cli:requirement"), { interval: 1 });
      const frame = f.frames[0];
      assert(frame?.type === "provider-cli:prewarm");
      await f.owner.businessOptions().handle(
        {
          type: "provider-cli:prewarm:result",
          requestId: frame.requestId,
          runtime: { provider: "codex", status: "ready" },
          providers: [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "ready" },
          ],
        },
        {
          ...f.input,
          installationId: f.installationId,
          instanceId: f.instanceId,
          signal: new AbortController().signal,
        },
      );
      expect(f.registry.providerReadiness(f.computerId)[0]?.observation.status).toBe("ready");
      expect(await result).toContain("timed out");
      expect(f.registry.providerReadiness(f.computerId)[0]?.observation.status).toBe("ready");
    } finally {
      f.owner.close();
      for (const callback of f.callbacks) callback();
    }
  });

  it("uses one original deadline across source lookup, prewarm and active dispatch", async () => {
    vi.useFakeTimers();
    const f = await fixture(true, 100);
    const lookup = deferred<boolean>();
    f.source.shouldPrewarmOfficialProviderClis.mockImplementation(() => lookup.promise);
    let finished = false;
    const result = f.owner
      .prepareComputer(f.input)
      .then(
        () => "started",
        (error) => String(error),
      )
      .finally(() => {
        finished = true;
      });
    try {
      await vi.advanceTimersByTimeAsync(40);
      lookup.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.frames[0]?.type).toBe("provider-cli:prewarm");
      await vi.advanceTimersByTimeAsync(40);
      f.callbacks[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.frames[1]?.type).toBe("provider-cli:requirement");
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(19);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toContain("timed out");
    } finally {
      f.owner.close();
      for (const callback of f.callbacks) callback();
      vi.useRealTimers();
    }
  });

  it("replaces only the old connection preparation and permits the new instance", async () => {
    const f = await fixture(true, 5000);
    f.source.listActiveProviderCliRequirements.mockResolvedValue([]);
    const result = f.owner.prepareComputer(f.input).then(
      () => "started",
      (error) => String(error),
    );
    try {
      await vi.waitFor(() => expect(f.callbacks).toHaveLength(1), { interval: 1 });
      const instanceId = randomUUID(),
        installationId = randomUUID();
      const socket = {
        readyState: WebSocket.OPEN,
        close: vi.fn(),
        send: vi.fn((_body: string, callback: (error?: Error) => void) => callback()),
      } as unknown as WebSocket;
      await f.registry.register(
        {
          computerId: f.computerId,
          instanceId,
          installationId,
          active: true,
          lastHeartbeatAt: Date.now(),
          socket,
          negotiatedCapabilities: {
            [RUNTIME_CAPABILITY.providerCliPrewarm]: 1,
            [RUNTIME_CAPABILITY.providerCliReconcile]: 1,
          },
        },
        async () => undefined,
      );
      await f.owner.onComputerRegistered({ computerId: f.computerId, instanceId, installationId });
      expect(await result).toContain("replaced");
      await expect(f.owner.prepareComputer(f.input)).resolves.toBeUndefined();
      f.callbacks[0]?.(new Error("old socket"));
      expect(f.registry.providerReadiness(f.computerId)[0]?.observation.status).toBe("checking");
    } finally {
      f.owner.close();
      for (const callback of f.callbacks) callback();
    }
  });
});
