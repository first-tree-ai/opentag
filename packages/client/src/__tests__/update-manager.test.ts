import type { RuntimeChannelTarget } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { UpdateManager, type UpdaterStateSnapshot } from "../runtime/update-manager.js";
import { recordingLogger } from "./recording-logger.js";

interface Harness {
  manager: UpdateManager;
  state: () => UpdaterStateSnapshot | undefined;
  installs: string[];
  handoffs: number;
  isQuiesced(): boolean;
  resumes: number;
  setProtectedWork(total: number): void;
  flushSleep(): void;
  settle(): Promise<void>;
  failNextInstall(reason: string): void;
}

function harness(overrides: { currentVersion?: string; stored?: UpdaterStateSnapshot } = {}): Harness {
  let stored = overrides.stored ? structuredClone(overrides.stored) : undefined;
  const installs: string[] = [];
  const entries: Parameters<typeof recordingLogger>[0] = [];
  const sleepers: Array<() => void> = [];
  let protectedTotal = 0;
  let handoffs = 0;
  let quiesced = false;
  let resumes = 0;
  let nextFailure: string | undefined;
  const manager = new UpdateManager({
    channel: "staging",
    currentVersion: overrides.currentVersion ?? "0.0.2-staging.1.1",
    logger: recordingLogger(entries),
    protectedWork: () => ({ total: protectedTotal }),
    quiesce: () => {
      quiesced = true;
      return () => {
        if (!quiesced) return;
        quiesced = false;
        resumes += 1;
      };
    },
    executeUpdate: async (target) => {
      if (nextFailure) {
        const reason = nextFailure;
        nextFailure = undefined;
        throw new Error(reason);
      }
      installs.push(target);
    },
    onHandoff: () => {
      handoffs += 1;
    },
    loadState: async () => stored,
    saveState: async (state) => {
      stored = structuredClone(state);
    },
    checkIntervalMs: 10,
    now: () => 1_700_000_000_000,
    sleep: async () => {
      await new Promise<void>((resolve) => sleepers.push(resolve));
    },
  });
  return {
    manager,
    state: () => stored,
    installs,
    get handoffs() {
      return handoffs;
    },
    isQuiesced: () => quiesced,
    get resumes() {
      return resumes;
    },
    setProtectedWork: (total) => {
      protectedTotal = total;
    },
    flushSleep: () => {
      for (const resolve of sleepers.splice(0)) resolve();
    },
    settle: async () => {
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
        for (const resolve of sleepers.splice(0)) resolve();
      }
    },
    failNextInstall: (reason) => {
      nextFailure = reason;
    },
  };
}

function target(version: string, channel: "dev" | "staging" | "prod" = "staging"): RuntimeChannelTarget {
  return { channel, version };
}

describe("UpdateManager", () => {
  it("records the running version before any target is advertised", async () => {
    const h = harness({ currentVersion: "0.0.3-staging.1.1" });
    await h.manager.syncRunningVersion();
    expect(h.state()).toMatchObject({
      currentVersion: "0.0.3-staging.1.1",
      state: "idle",
      attempts: {},
    });
  });

  it("converges a blocked target when that target is now the running version", async () => {
    const h = harness({
      currentVersion: "0.0.3-staging.1.1",
      stored: {
        schemaVersion: 1,
        currentVersion: "0.0.2-staging.1.1",
        state: "blocked",
        target: "0.0.3-staging.1.1",
        attempts: {
          "0.0.3-staging.1.1": {
            target: "0.0.3-staging.1.1",
            startedAt: "2026-08-31T00:00:00.000Z",
            finishedAt: "2026-08-31T00:00:01.000Z",
            result: "failed",
            failureReason: "handoff interrupted",
          },
        },
      },
    });
    await h.manager.syncRunningVersion();
    expect(h.state()).toMatchObject({ currentVersion: "0.0.3-staging.1.1", state: "installed" });
    expect(h.state()?.attempts["0.0.3-staging.1.1"]).toMatchObject({ result: "installed" });
    expect(h.state()?.attempts["0.0.3-staging.1.1"]?.failureReason).toBeUndefined();
  });

  it("installs a newer advertised target exactly once and hands off", async () => {
    const h = harness();
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();

    expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
    expect(h.handoffs).toBe(1);
    expect(h.isQuiesced()).toBe(true);
    expect(h.state()).toMatchObject({
      currentVersion: "0.0.2-staging.1.1",
      state: "installed",
      target: "0.0.3-staging.1.1",
    });
    expect(h.state()?.attempts["0.0.3-staging.1.1"]).toMatchObject({ result: "installed" });
  });

  it("records an equal target for status, ignores older targets, and never auto-downgrades", async () => {
    const h = harness();
    h.manager.observe(target("0.0.2-staging.1.1"));
    h.manager.observe(target("0.0.2-staging.1.0"));
    h.manager.observe(target("0.0.1"));
    await h.settle();
    expect(h.installs).toEqual([]);
    expect(h.state()).toMatchObject({
      currentVersion: "0.0.2-staging.1.1",
      target: "0.0.2-staging.1.1",
      state: "idle",
    });
  });

  it("ignores targets advertised for another channel", async () => {
    const h = harness();
    h.manager.observe(target("0.0.9", "prod"));
    await h.settle();
    expect(h.installs).toEqual([]);
  });

  it("waits indefinitely for protected work with no force timeout", async () => {
    const h = harness();
    h.setProtectedWork(2);
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.state()?.state).toBe("awaiting_protected_work");
    expect(h.isQuiesced()).toBe(true);

    // Many poll cycles pass with protected work still present: no attempt, no timeout failure.
    for (let cycle = 0; cycle < 50; cycle += 1) h.flushSleep();
    await h.settle();
    expect(h.installs).toEqual([]);
    expect(h.state()?.state).toBe("awaiting_protected_work");
    expect(h.state()?.attempts).toEqual({});

    h.setProtectedWork(0);
    h.flushSleep();
    await h.settle();
    expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
    expect(h.handoffs).toBe(1);
  });

  it("coalesces to the newest target observed while waiting for protected work", async () => {
    const h = harness();
    h.setProtectedWork(1);
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    h.manager.observe(target("0.0.3-staging.1.2"));
    h.setProtectedWork(0);
    h.flushSleep();
    await h.settle();
    expect(h.installs).toEqual(["0.0.3-staging.1.2"]);
    expect(Object.keys(h.state()?.attempts ?? {})).toEqual(["0.0.3-staging.1.2"]);
  });

  it("cancels a pending upgrade when the channel target returns to the running version", async () => {
    const h = harness();
    h.setProtectedWork(1);
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.isQuiesced()).toBe(true);

    h.manager.observe(target("0.0.2-staging.1.1"));
    h.setProtectedWork(0);
    h.flushSleep();
    await h.settle();
    expect(h.installs).toEqual([]);
    expect(h.isQuiesced()).toBe(false);
    expect(h.state()).toMatchObject({ state: "idle", target: "0.0.2-staging.1.1" });
  });

  it("blocks after a failed attempt and never retries the same target", async () => {
    const h = harness();
    h.failNextInstall("checksum mismatch");
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.installs).toEqual([]);
    expect(h.handoffs).toBe(0);
    expect(h.state()).toMatchObject({ state: "blocked", target: "0.0.3-staging.1.1" });
    expect(h.state()?.lastAttempt).toMatchObject({ result: "failed", failureReason: "checksum mismatch" });
    expect(h.isQuiesced()).toBe(false);
    expect(h.resumes).toBe(1);

    // Re-observing the same target, even after a simulated restart, must not retry it.
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    const restarted = harness({ stored: h.state() });
    restarted.manager.observe(target("0.0.3-staging.1.1"));
    await restarted.settle();
    expect(restarted.installs).toEqual([]);
    expect(restarted.state()?.state).toBe("blocked");
  });

  it("treats an interrupted attempt as blocked instead of retrying it", async () => {
    const h = harness({
      stored: {
        schemaVersion: 1,
        currentVersion: "0.0.2-staging.1.1",
        state: "installing",
        target: "0.0.3-staging.1.1",
        attempts: { "0.0.3-staging.1.1": { target: "0.0.3-staging.1.1", startedAt: "2023-11-14T22:13:20.000Z" } },
      },
    });
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.installs).toEqual([]);
    expect(h.state()?.state).toBe("blocked");
    expect(h.state()?.attempts["0.0.3-staging.1.1"]).toMatchObject({
      result: "failed",
      failureReason: "The previous upgrade attempt was interrupted before it completed",
    });
  });

  it("attempts a new target after a blocked one", async () => {
    const h = harness();
    h.failNextInstall("download failed");
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.state()?.state).toBe("blocked");

    h.manager.observe(target("0.0.3-staging.1.2"));
    await h.settle();
    expect(h.installs).toEqual(["0.0.3-staging.1.2"]);
    expect(h.handoffs).toBe(1);
    expect(h.state()?.state).toBe("installed");
  });

  it("does not re-install a target a manual upgrade already recorded", async () => {
    const h = harness({
      stored: {
        schemaVersion: 1,
        currentVersion: "0.0.2-staging.1.1",
        state: "installed",
        target: "0.0.3-staging.1.1",
        attempts: {
          "0.0.3-staging.1.1": {
            target: "0.0.3-staging.1.1",
            startedAt: "2023-11-14T22:13:20.000Z",
            finishedAt: "2023-11-14T22:13:30.000Z",
            result: "installed",
          },
        },
      },
    });
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.installs).toEqual([]);
    expect(h.handoffs).toBe(0);
  });

  it("stops waiting when stopped", async () => {
    const h = harness();
    h.setProtectedWork(1);
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    h.manager.stop();
    h.flushSleep();
    await h.settle();
    h.setProtectedWork(0);
    h.flushSleep();
    await h.settle();
    expect(h.installs).toEqual([]);
  });
});
