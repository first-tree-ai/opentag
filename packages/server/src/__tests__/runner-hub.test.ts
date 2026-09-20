/**
 * RunnerHub attach policy: a live, heartbeating same-scope connection is never evicted by a
 * second token holder (duplicate), a dead same-scope connection is replaced so a legitimate
 * reconnect lands, and no attach ever disturbs another Sandbox's connection.
 *
 * The acceptance, seal and bookkeeping sections below pin the correlated-request contract:
 * exactly one active run per Sandbox, cancellation and authority gates that run before a frame
 * leaves the Server, and a final refusal to settle anything from a superseded socket.
 */
import {
  RUNNER_WS_CLOSE,
  type RunnerAcceptanceResultFrame,
  type RunnerReadiness,
  type RunnerServerFrame,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
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

/** A socket whose writes always fail, as a closed transport would. */
function brokenSocket(): RunnerControlSocket & { closes: { code: number; reason: string }[] } {
  const closes: { code: number; reason: string }[] = [];
  return {
    closes,
    send() {
      throw new Error("socket closed");
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

const READINESS: RunnerReadiness = {
  sandboxName: "ots-s-unit-1",
  rootfs: "/opt/sandbox-root",
  nodeVersion: "v24.19.0",
  piVersion: "0.84.2",
  runnerVersion: "0.0.5",
  reportedAt: "2026-01-01T00:00:00.000Z",
};

/** An attached, ready Runner with one usable acceptance slot. */
function readyRunner(options: { now?: () => number } = {}) {
  const hub = new RunnerHub(options.now ? { now: options.now } : {});
  const socket = fakeSocket();
  hub.attach(scope, socket);
  hub.markReady(scope, READINESS, socket);
  return { hub, socket };
}

function runFrameOf(socket: ReturnType<typeof fakeSocket>, index = 0) {
  return socket.sent.filter((frame) => frame.type === "acceptance:run")[index] as
    | { type: "acceptance:run"; requestId: string }
    | undefined;
}

const COMMAND = { mode: "offline" as const, deadlineAtMs: 60_000 };

describe("RunnerHub acceptance runs", () => {
  it("holds the run frame behind the authority check and settles on the correlated result", async () => {
    const { hub, socket } = readyRunner();
    let releaseAuthority!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const authorize = vi.fn(async () => {
      await gate;
      return true;
    });
    const pending = hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000, authorize });
    // The authority check is the last gate: nothing may reach the Runner before it resolves.
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    expect(runFrameOf(socket)).toBeUndefined();
    expect(hub.isBusy(scope.sandboxId)).toBe(true);

    releaseAuthority();
    const frame = (await vi.waitFor(() => {
      const sent = runFrameOf(socket);
      expect(sent).toBeDefined();
      return sent;
    })) as { requestId: string };
    expect(
      hub.resolveAcceptanceResult(
        scope.sandboxId,
        { type: "acceptance:result", requestId: frame.requestId, mode: "offline", outcome: "passed" },
        socket,
      ),
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({ outcome: "passed", requestId: frame.requestId });
    // The slot and the pending map are released once the run settles.
    expect(hub.isBusy(scope.sandboxId)).toBe(false);
    expect(
      hub.resolveAcceptanceResult(
        scope.sandboxId,
        { type: "acceptance:result", requestId: frame.requestId, mode: "offline", outcome: "passed" },
        socket,
      ),
    ).toBe(false);
  });

  it("refuses every unrunnable request without leaving a pending slot behind", async () => {
    const now = () => 10_000;
    await expect(new RunnerHub({ now }).runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000 })).rejects.toThrow(
      "No Runner is connected for this Sandbox",
    );

    const notReady = new RunnerHub({ now });
    notReady.attach(scope, fakeSocket());
    // Attached but not ready: the Runner never reported native readiness.
    await expect(notReady.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000 })).rejects.toThrow(
      "The Runner has not reported native readiness",
    );

    const { hub, socket } = readyRunner({ now });
    await expect(
      hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000, socket: fakeSocket() }),
    ).rejects.toThrow("The Runner connection was replaced");

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000, signal: aborted.signal }),
    ).rejects.toThrow("The acceptance request was already cancelled");
    // None of the refusals emitted a run frame.
    expect(runFrameOf(socket)).toBeUndefined();
  });

  it("refuses a concurrent run while one holds the Sandbox slot", async () => {
    const { hub, socket } = readyRunner();
    const first = hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000 });
    const frame = runFrameOf(socket) as { requestId: string };
    await expect(hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000 })).rejects.toThrow(
      "Another acceptance run is already active for this Sandbox",
    );
    expect(hub.isBusy(scope.sandboxId)).toBe(true);
    hub.resolveAcceptanceResult(
      scope.sandboxId,
      { type: "acceptance:result", requestId: frame.requestId, mode: "offline", outcome: "passed" },
      socket,
    );
    await expect(first).resolves.toMatchObject({ outcome: "passed" });
  });

  it("cancels an in-flight run on abort and rejects its waiter once", async () => {
    const { hub, socket } = readyRunner();
    const controller = new AbortController();
    const pending = hub.runAcceptance(scope.sandboxId, COMMAND, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const frame = runFrameOf(socket) as { requestId: string };
    controller.abort();
    await expect(pending).rejects.toThrow("The acceptance request was cancelled");
    expect(socket.sent).toContainEqual({ type: "acceptance:cancel", requestId: frame.requestId });
    expect(hub.isBusy(scope.sandboxId)).toBe(false);
  });

  it("cancels and rejects a run that exceeds its deadline", async () => {
    const { hub, socket } = readyRunner();
    const pending = hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 20 });
    const frame = runFrameOf(socket) as { requestId: string };
    await expect(pending).rejects.toThrow("The acceptance run exceeded its deadline");
    expect(socket.sent).toContainEqual({ type: "acceptance:cancel", requestId: frame.requestId });
    expect(hub.isBusy(scope.sandboxId)).toBe(false);
  });

  it("never sends a frame when the authority check denies, throws, or is cancelled while pending", async () => {
    const denied = readyRunner();
    await expect(
      denied.hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000, authorize: async () => false }),
    ).rejects.toThrow("The Sandbox environment can no longer run acceptance");
    expect(runFrameOf(denied.socket)).toBeUndefined();
    expect(denied.hub.isBusy(scope.sandboxId)).toBe(false);

    const failed = readyRunner();
    await expect(
      failed.hub.runAcceptance(scope.sandboxId, COMMAND, {
        timeoutMs: 5_000,
        authorize: async () => {
          throw new Error("row lock unavailable");
        },
      }),
    ).rejects.toThrow("The acceptance authority could not be validated");
    expect(runFrameOf(failed.socket)).toBeUndefined();

    // Abort while the authority check is still outstanding: the frame must never leave, and no
    // cancel frame is emitted because nothing was sent.
    const cancelled = readyRunner();
    const controller = new AbortController();
    let releaseAuthority!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const pending = cancelled.hub.runAcceptance(scope.sandboxId, COMMAND, {
      timeoutMs: 5_000,
      signal: controller.signal,
      authorize: async () => {
        await gate;
        return true;
      },
    });
    controller.abort();
    releaseAuthority();
    await expect(pending).rejects.toThrow("The acceptance request was cancelled");
    expect(runFrameOf(cancelled.socket)).toBeUndefined();
    expect(cancelled.hub.isBusy(scope.sandboxId)).toBe(false);
  });

  it("fails the run instead of hanging when the control channel is not writable", async () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const broken = brokenSocket();
    hub.attach(scope, broken);
    hub.markReady(scope, READINESS, broken);
    await expect(hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000 })).rejects.toThrow(
      "The Runner control channel is not writable",
    );
    expect(hub.isBusy(scope.sandboxId)).toBe(false);
  });

  it("routes a result only from the current socket and only for a live request id", async () => {
    const { hub, socket } = readyRunner();
    const pending = hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 5_000 });
    const frame = runFrameOf(socket) as { requestId: string };
    const result: RunnerAcceptanceResultFrame = {
      type: "acceptance:result",
      requestId: frame.requestId,
      mode: "offline",
      outcome: "failed",
    };
    expect(hub.resolveAcceptanceResult(scope.sandboxId, result, fakeSocket())).toBe(false);
    expect(hub.resolveAcceptanceResult(scope.sandboxId, { ...result, requestId: crypto.randomUUID() }, socket)).toBe(
      false,
    );
    expect(hub.resolveAcceptanceResult(scope.sandboxId, result, socket)).toBe(true);
    await expect(pending).resolves.toMatchObject({ outcome: "failed" });
  });

  it("rejects a pending run when the Runner disconnects or is replaced", async () => {
    const detached = readyRunner();
    const pendingDetach = detached.hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 60_000 });
    detached.hub.detach(scope.sandboxId, detached.socket);
    await expect(pendingDetach).rejects.toThrow("The Runner disconnected");

    const replaced = readyRunner();
    const pendingReplace = replaced.hub.runAcceptance(scope.sandboxId, COMMAND, { timeoutMs: 60_000 });
    replaced.hub.attach(scope, fakeSocket());
    await expect(pendingReplace).rejects.toThrow("The Runner connection was replaced");
  });

  it("re-checks the abort signal after an authority check that outlives the notification", async () => {
    const { hub, socket } = readyRunner();
    // A signal that flips to aborted without dispatching to its listeners pins the defensive
    // re-check between the listener registration and the actual send.
    const signal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const pending = hub.runAcceptance(scope.sandboxId, COMMAND, {
      timeoutMs: 5_000,
      signal,
      authorize: async () => {
        (signal as { aborted: boolean }).aborted = true;
        return true;
      },
    });
    await expect(pending).rejects.toThrow("The acceptance request was cancelled");
    expect(runFrameOf(socket)).toBeUndefined();
    expect(hub.isBusy(scope.sandboxId)).toBe(false);
  });
});

describe("RunnerHub connection bookkeeping", () => {
  it("marks readiness only for the current socket and the current scope", () => {
    const { hub, socket } = readyRunner();
    expect(hub.markReady(scope, READINESS, fakeSocket())).toBe(false);
    expect(hub.markReady({ ...scope, environmentGeneration: 2 }, READINESS, socket)).toBe(false);
    expect(hub.describe(scope.sandboxId).ready).toBe(true);
  });

  it("refreshes liveness through noteActivity for the current socket only", () => {
    let now = 10_000;
    const { hub, socket } = readyRunner({ now: () => now });
    now += 500;
    expect(hub.noteActivity(scope.sandboxId, socket)).toBe(true);
    expect(hub.noteActivity(scope.sandboxId, fakeSocket())).toBe(false);
    now += 100;
    // The activity note refreshed lastSeenAt, so a 300ms cutoff still keeps the connection.
    expect(hub.sweepStale(now - 300)).toBe(0);
    expect(hub.describe(scope.sandboxId).connected).toBe(true);
  });

  it("reports reuse capability and leaves unknown Sandboxes disconnected", () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    expect(hub.describe("unknown-sandbox")).toEqual({
      connected: false,
      ready: false,
      readiness: null,
      scope: null,
      reuseCapable: false,
    });
    const socket = fakeSocket();
    hub.attach(scope, socket, { reuseCapable: true });
    expect(hub.describe(scope.sandboxId).reuseCapable).toBe(true);
    expect(hub.currentSocket(scope.sandboxId)).toBe(socket);
    expect(hub.currentSocket("unknown-sandbox")).toBeUndefined();
  });

  it("fails a connection on heartbeat write, on stale sweep and on shutdown", () => {
    let now = 10_000;
    const hub = new RunnerHub({ now: () => now });
    const broken = brokenSocket();
    hub.attach(scope, broken);
    expect(hub.acknowledge(scope.sandboxId, broken, { type: "server:heartbeat" })).toBe(true);
    expect(hub.describe(scope.sandboxId).connected).toBe(false);

    const healthy = fakeSocket();
    hub.attach(otherSandboxScope, healthy);
    expect(hub.heartbeatAll({ type: "server:heartbeat" })).toBe(1);
    now += 120_000;
    expect(hub.sweepStale(now - 1_000)).toBe(1);
    expect(hub.describe(otherSandboxScope.sandboxId).connected).toBe(false);

    const shuttingDown = new RunnerHub({ now: () => now });
    const last = fakeSocket();
    shuttingDown.attach(scope, last);
    shuttingDown.closeAll();
    expect(shuttingDown.describe(scope.sandboxId).connected).toBe(false);
    expect(last.closes).toEqual([{ code: RUNNER_WS_CLOSE.protocolError, reason: "control channel failed" }]);
  });

  it("ignores a heartbeat from a superseded socket", () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const stale = fakeSocket();
    const current = fakeSocket();
    hub.attach(scope, stale);
    hub.attach(scope, current);
    expect(hub.acknowledge(scope.sandboxId, stale, { type: "server:heartbeat" })).toBe(false);
    expect(stale.sent).toHaveLength(0);
    expect(hub.isCurrent(scope.sandboxId, current)).toBe(true);
  });

  it("closes a scope only when it still matches and sends only to the current socket", () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const socket = fakeSocket();
    hub.attach(scope, socket);
    // A different generation never closes the current connection.
    hub.closeScope({ ...scope, environmentGeneration: 2 });
    expect(hub.isCurrent(scope.sandboxId, socket)).toBe(true);
    expect(hub.sendToCurrent(scope.sandboxId, fakeSocket(), { type: "server:heartbeat" })).toBe(false);
    expect(hub.sendToCurrent(scope.sandboxId, socket, { type: "server:heartbeat" })).toBe(true);
    expect(socket.sent).toEqual([{ type: "server:heartbeat" }]);
    hub.closeScope(scope);
    expect(hub.describe(scope.sandboxId).connected).toBe(false);
  });

  it("fails the connection when an outbound send throws", () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const broken = brokenSocket();
    hub.attach(scope, broken);
    expect(hub.sendToCurrent(scope.sandboxId, broken, { type: "server:heartbeat" })).toBe(false);
    expect(hub.describe(scope.sandboxId).connected).toBe(false);
  });

  it("detaches nothing for an unknown Sandbox or a superseded socket", () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const socket = fakeSocket();
    hub.attach(scope, socket);
    hub.detach("unknown-sandbox", socket);
    hub.detach(scope.sandboxId, fakeSocket());
    expect(hub.isCurrent(scope.sandboxId, socket)).toBe(true);
  });

  it("fails every connection on a heartbeat sweep, including one that closed itself", () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const broken = brokenSocket();
    broken.close = () => {
      // A real transport close reaches the route's detach handler before #fail checks the map.
      hub.detach(scope.sandboxId, broken);
    };
    hub.attach(scope, broken);
    expect(hub.heartbeatAll({ type: "server:heartbeat" })).toBe(0);
    expect(hub.describe(scope.sandboxId).connected).toBe(false);
  });

  it("fails the seal when the control channel is not writable", async () => {
    const hub = new RunnerHub({ now: () => 10_000 });
    const broken = brokenSocket();
    hub.attach(scope, broken);
    await expect(hub.requestWorkspaceSeal(scope.sandboxId, { timeoutMs: 5_000 })).rejects.toThrow(
      "The Runner control channel is not writable",
    );
    expect(hub.isBusy(scope.sandboxId)).toBe(false);
  });
});
