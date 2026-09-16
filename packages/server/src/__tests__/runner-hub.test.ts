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
