/**
 * RunnerHub attach policy: a live, heartbeating same-scope connection is never evicted by a
 * second token holder (duplicate), a dead same-scope connection is replaced so a legitimate
 * reconnect lands, and no attach ever disturbs another Sandbox's connection.
 */
import { RUNNER_WS_CLOSE, type RunnerServerFrame } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../services/sandboxes/runner-hub.js";

function fakeSocket(): RunnerControlSocket & {
  sent: RunnerServerFrame[];
  closes: { code: number; reason: string }[];
} {
  const sent: RunnerServerFrame[] = [];
  const closes: { code: number; reason: string }[] = [];
  return {
    sent,
    closes,
    send(frame: RunnerServerFrame) {
      sent.push(frame);
    },
    close(code: number, reason: string) {
      closes.push({ code, reason });
    },
  };
}

const scope: RunnerScope = {
  sandboxId: "sandbox-1",
  sessionId: "session-1",
  environmentGeneration: 1,
  resourceName: "projects/p/locations/r/instances/ots-s-1",
};

const otherSandboxScope: RunnerScope = {
  sandboxId: "sandbox-2",
  sessionId: "session-2",
  environmentGeneration: 1,
  resourceName: "projects/p/locations/r/instances/ots-s-2",
};

describe("RunnerHub attach policy", () => {
  it("rejects a duplicate while the current same-scope connection is live, leaving it untouched", () => {
    let now = 10_000;
    const hub = new RunnerHub({ now: () => now });
    const live = fakeSocket();
    const newcomer = fakeSocket();
    expect(hub.attach(scope, live, { liveWindowMs: 45_000 })).toBe("attached");
    now += 5_000; // inside the live window (heartbeats keep lastSeenAt fresh)
    expect(hub.attach(scope, newcomer, { liveWindowMs: 45_000 })).toBe("duplicate");
    // The healthy connection was never closed or displaced, and the newcomer owns nothing.
    expect(live.closes).toHaveLength(0);
    expect(hub.isCurrent(scope.sandboxId, live)).toBe(true);
    expect(hub.isCurrent(scope.sandboxId, newcomer)).toBe(false);
    expect(hub.describe(scope.sandboxId).connected).toBe(true);
  });

  it("refreshes liveness on activity, so a heartbeating Runner is protected across windows", () => {
    let now = 10_000;
    const hub = new RunnerHub({ now: () => now });
    const live = fakeSocket();
    hub.attach(scope, live, { liveWindowMs: 1_000 });
    now += 900;
    expect(hub.acknowledge(scope.sandboxId, live, { type: "server:heartbeat" })).toBe(true);
    now += 900; // 1,800ms since attach but only 900ms since the heartbeat
    expect(hub.attach(scope, fakeSocket(), { liveWindowMs: 1_000 })).toBe("duplicate");
    expect(live.closes).toHaveLength(0);
    expect(hub.isCurrent(scope.sandboxId, live)).toBe(true);
  });

  it("replaces a same-scope connection that went silent past the window", () => {
    let now = 10_000;
    const hub = new RunnerHub({ now: () => now });
    const zombie = fakeSocket();
    const reconnect = fakeSocket();
    hub.attach(scope, zombie, { liveWindowMs: 1_000 });
    now += 1_500; // past the window: the dead connection is cleaned up for the reconnect
    expect(hub.attach(scope, reconnect, { liveWindowMs: 1_000 })).toBe("replaced");
    expect(zombie.closes).toEqual([
      { code: RUNNER_WS_CLOSE.replaced, reason: "replaced by a reconnect of the same Runner" },
    ]);
    expect(hub.isCurrent(scope.sandboxId, reconnect)).toBe(true);
  });

  it("reattaches cleanly once the dead connection was detached", () => {
    const now = 10_000;
    const hub = new RunnerHub({ now: () => now });
    const dead = fakeSocket();
    const reconnect = fakeSocket();
    hub.attach(scope, dead, { liveWindowMs: 45_000 });
    hub.detach(scope.sandboxId, dead);
    expect(hub.describe(scope.sandboxId).connected).toBe(false);
    expect(hub.attach(scope, reconnect, { liveWindowMs: 45_000 })).toBe("attached");
    expect(dead.closes).toHaveLength(0);
    expect(hub.isCurrent(scope.sandboxId, reconnect)).toBe(true);
  });

  it("closes a superseded scope as stale and never disturbs another Sandbox's connection", () => {
    const now = 10_000;
    const hub = new RunnerHub({ now: () => now });
    const current = fakeSocket();
    const other = fakeSocket();
    hub.attach(scope, current, { liveWindowMs: 45_000 });
    hub.attach(otherSandboxScope, other, { liveWindowMs: 45_000 });
    const nextGeneration: RunnerScope = {
      ...scope,
      environmentGeneration: 2,
      resourceName: "projects/p/locations/r/instances/ots-s-2g",
    };
    const replacement = fakeSocket();
    expect(hub.attach(nextGeneration, replacement, { liveWindowMs: 45_000 })).toBe("replaced");
    expect(current.closes).toEqual([
      { code: RUNNER_WS_CLOSE.staleScope, reason: "superseded by a new environment generation" },
    ]);
    // The other Sandbox's connection was never touched by any of this scope's churn.
    expect(other.closes).toHaveLength(0);
    expect(hub.isCurrent(otherSandboxScope.sandboxId, other)).toBe(true);
    expect(hub.isCurrent(scope.sandboxId, replacement)).toBe(true);
  });

  it("keeps unconditional last-wins replacement for callers that pass no live window", () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const first = fakeSocket();
    const second = fakeSocket();
    hub.attach(scope, first);
    expect(hub.attach(scope, second)).toBe("replaced");
    expect(first.closes).toHaveLength(1);
    expect(hub.isCurrent(scope.sandboxId, second)).toBe(true);
  });
});

describe("RunnerHub workspace seal", () => {
  it("sends the seal frame to the exact current socket and resolves on its correlated result", async () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const socket = fakeSocket();
    hub.attach(scope, socket);
    const sealPromise = hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 5_000, socket });
    const seal = socket.sent.find((frame) => frame.type === "workspace:seal") as
      | { type: "workspace:seal"; requestId: string }
      | undefined;
    expect(seal?.type).toBe("workspace:seal");
    const settled = hub.settleWorkspaceSeal(
      scope.sandboxId,
      { type: "workspace:seal:result", requestId: seal?.requestId as string, ok: true },
      socket,
    );
    expect(settled).toBe(true);
    await expect(sealPromise).resolves.toMatchObject({ ok: true, requestId: seal?.requestId });
  });

  it("joins concurrent seal requests onto the single in-flight seal", async () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const socket = fakeSocket();
    hub.attach(scope, socket);
    const first = hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 5_000, socket });
    const second = hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 5_000, socket });
    const seals = socket.sent.filter((frame) => frame.type === "workspace:seal");
    expect(seals).toHaveLength(1);
    const seal = seals[0] as { requestId: string };
    hub.settleWorkspaceSeal(
      scope.sandboxId,
      { type: "workspace:seal:result", requestId: seal.requestId, ok: true },
      socket,
    );
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("rejects immediately without a connected Runner and never sends a frame", async () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    await expect(hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 5_000 })).rejects.toMatchObject({
      name: "RunnerWorkspaceSealUnavailableError",
    });
  });

  it("rejects when the pinned socket is no longer the current connection", async () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const stale = fakeSocket();
    const current = fakeSocket();
    hub.attach(scope, stale);
    hub.attach(scope, current);
    await expect(hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 5_000, socket: stale })).rejects.toMatchObject({
      name: "RunnerWorkspaceSealUnavailableError",
      message: "The Runner connection was replaced",
    });
    expect(current.sent.some((frame) => frame.type === "workspace:seal")).toBe(false);
  });

  it("ignores results from a stale socket or an unknown request id", async () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const socket = fakeSocket();
    const stale = fakeSocket();
    hub.attach(scope, socket);
    const sealPromise = hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 5_000, socket });
    const seal = socket.sent.find((frame) => frame.type === "workspace:seal") as { requestId: string };
    // A stale socket may not settle it, even with the right request id.
    expect(
      hub.settleWorkspaceSeal(
        scope.sandboxId,
        { type: "workspace:seal:result", requestId: seal.requestId, ok: true },
        stale,
      ),
    ).toBe(false);
    // The current socket may not invent an id either.
    expect(
      hub.settleWorkspaceSeal(
        scope.sandboxId,
        { type: "workspace:seal:result", requestId: crypto.randomUUID(), ok: true },
        socket,
      ),
    ).toBe(false);
    hub.settleWorkspaceSeal(
      scope.sandboxId,
      { type: "workspace:seal:result", requestId: seal.requestId, ok: true },
      socket,
    );
    await expect(sealPromise).resolves.toMatchObject({ ok: true });
  });

  it("rejects the waiters on detach and on scope close", async () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const socket = fakeSocket();
    hub.attach(scope, socket);
    const pending = hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 60_000, socket });
    hub.detach(scope.sandboxId, socket);
    // The shared pending-rejection path (same as acceptance runs) fails the seal waiters.
    await expect(pending).rejects.toThrow("The Runner disconnected");

    hub.attach(scope, socket);
    const pendingClosed = hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 60_000, socket });
    hub.closeScope(scope);
    await expect(pendingClosed).rejects.toThrow("The Sandbox environment was released");
  });

  it("times out a seal that never settles and lets a later request retry", async () => {
    const now = 10_000;
    const hub = new RunnerHub({ now: () => now });
    const socket = fakeSocket();
    hub.attach(scope, socket);
    const pending = hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 50, socket });
    await expect(pending).rejects.toMatchObject({ message: "The workspace seal exceeded its deadline" });
    // The slot is released: a retry issues a fresh frame and can settle.
    const retry = hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 5_000, socket });
    const seals = socket.sent.filter((frame) => frame.type === "workspace:seal");
    expect(seals).toHaveLength(2);
    const second = seals[1] as { requestId: string };
    hub.settleWorkspaceSeal(
      scope.sandboxId,
      { type: "workspace:seal:result", requestId: second.requestId, ok: true },
      socket,
    );
    await expect(retry).resolves.toMatchObject({ ok: true });
  });
});
