import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeChannelTarget } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { type HandoffReadiness, UpdateManager, type UpdaterStateSnapshot } from "../runtime/update-manager.js";
import { recordingLogger } from "./recording-logger.js";

const execFileAsync = promisify(execFile);

interface Harness {
  manager: UpdateManager;
  state: () => UpdaterStateSnapshot | undefined;
  logs: Parameters<typeof recordingLogger>[0];
  installs: string[];
  handoffs: number;
  isQuiesced(): boolean;
  resumes: number;
  setProtectedWork(total: number): void;
  setRecoverable(recoverable: boolean): void;
  quiescedDuringInstall: boolean[];
  flushSleep(): void;
  settle(): Promise<void>;
  failNextInstall(reason: string, options?: { transient?: boolean }): void;
}

function harness(
  overrides: {
    currentVersion?: string;
    failSaveForState?: UpdaterStateSnapshot["state"];
    stored?: UpdaterStateSnapshot;
    discoverTarget?: () => Promise<RuntimeChannelTarget | undefined>;
    discoveryIntervalMs?: number;
    discoveryMaxBackoffMs?: number;
    installRetryIntervalMs?: number;
    installRetryMaxBackoffMs?: number;
    beforeLoad?: () => Promise<void>;
    beforeSave?: (state: UpdaterStateSnapshot) => Promise<void>;
    handoffReadiness?: () => Promise<HandoffReadiness>;
    maxHandoffDeferralMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Harness {
  let stored = overrides.stored ? structuredClone(overrides.stored) : undefined;
  const installs: string[] = [];
  const entries: Parameters<typeof recordingLogger>[0] = [];
  const sleepers: Array<() => void> = [];
  let protectedTotal = 0;
  let recoverable = false;
  const quiescedDuringInstall: boolean[] = [];
  let handoffs = 0;
  let quiesced = false;
  let resumes = 0;
  const pendingFailures: Array<{ reason: string; transient: boolean }> = [];
  const manager = new UpdateManager({
    channel: "staging",
    currentVersion: overrides.currentVersion ?? "0.0.2-staging.1.1",
    logger: recordingLogger(entries),
    protectedWork: () => ({ total: protectedTotal }),
    canInterruptWork: () => recoverable,
    quiesce: () => {
      quiesced = true;
      return () => {
        if (!quiesced) return;
        quiesced = false;
        resumes += 1;
      };
    },
    executeUpdate: async (target) => {
      quiescedDuringInstall.push(quiesced);
      const failure = pendingFailures.shift();
      if (failure) {
        throw Object.assign(new Error(failure.reason), { transient: failure.transient });
      }
      installs.push(target);
    },
    onHandoff: () => {
      handoffs += 1;
    },
    loadState: async () => {
      await overrides.beforeLoad?.();
      return stored;
    },
    saveState: async (state) => {
      if (state.state === overrides.failSaveForState) throw new Error("state disk unavailable");
      await overrides.beforeSave?.(state);
      stored = structuredClone(state);
    },
    checkIntervalMs: 10,
    ...(overrides.discoverTarget ? { discoverTarget: overrides.discoverTarget } : {}),
    ...(overrides.discoveryIntervalMs ? { discoveryIntervalMs: overrides.discoveryIntervalMs } : {}),
    ...(overrides.discoveryMaxBackoffMs ? { discoveryMaxBackoffMs: overrides.discoveryMaxBackoffMs } : {}),
    ...(overrides.installRetryIntervalMs ? { installRetryIntervalMs: overrides.installRetryIntervalMs } : {}),
    ...(overrides.installRetryMaxBackoffMs ? { installRetryMaxBackoffMs: overrides.installRetryMaxBackoffMs } : {}),
    ...(overrides.handoffReadiness ? { handoffReadiness: overrides.handoffReadiness } : {}),
    ...(overrides.maxHandoffDeferralMs ? { maxHandoffDeferralMs: overrides.maxHandoffDeferralMs } : {}),
    now: overrides.now ?? (() => 1_700_000_000_000),
    sleep:
      overrides.sleep ??
      (async () => {
        await new Promise<void>((resolve) => sleepers.push(resolve));
      }),
  });
  return {
    manager,
    state: () => stored,
    logs: entries,
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
    setRecoverable: (value) => {
      recoverable = value;
    },
    quiescedDuringInstall,
    flushSleep: () => {
      for (const resolve of sleepers.splice(0)) resolve();
    },
    settle: async () => {
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
        for (const resolve of sleepers.splice(0)) resolve();
      }
    },
    failNextInstall: (reason, options) => {
      pendingFailures.push({ reason, transient: options?.transient ?? false });
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

  it("continues handoff when the installed-state write fails after the update commits", async () => {
    const h = harness({ failSaveForState: "installed" });
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();

    expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
    expect(h.handoffs).toBe(1);
    expect(h.isQuiesced()).toBe(true);
    expect(h.logs).toContainEqual({
      level: "warn",
      fields: {
        channel: "staging",
        target: "0.0.3-staging.1.1",
        error: "state disk unavailable",
      },
      message: "The update was installed but its durable state could not be recorded; continuing supervisor handoff",
    });
  });

  it("installs an exact target that differs only by SemVer build metadata", async () => {
    const h = harness({ currentVersion: "1.2.3+build.1" });
    h.manager.observe(target("1.2.3+build.2"));
    await h.settle();

    expect(h.installs).toEqual(["1.2.3+build.2"]);
    expect(h.handoffs).toBe(1);
    expect(h.state()).toMatchObject({ state: "installed", target: "1.2.3+build.2" });
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

  it("records and clears local recovery diagnostics without changing updater state", async () => {
    const h = harness();
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();

    await h.manager.recordRecoveryStatus("upgrade_required");
    expect(h.state()).toMatchObject({ state: "installed", recoveryStatus: "upgrade_required" });

    await h.manager.recordRecoveryStatus("authentication_repair");
    expect(h.state()).toMatchObject({ state: "installed", recoveryStatus: "authentication_repair" });

    await h.manager.recordRecoveryStatus(undefined);
    expect(h.state()).not.toHaveProperty("recoveryStatus");
  });

  it("ignores targets advertised for another channel", async () => {
    const h = harness();
    h.manager.observe(target("0.0.9", "prod"));
    await h.settle();
    expect(h.installs).toEqual([]);
  });

  it("discovers a channel target independently of heartbeat and coalesces concurrent reads", async () => {
    const discoverTarget = vi.fn(async () => target("0.0.3-staging.1.1"));
    const h = harness({ discoverTarget });

    h.manager.startDiscovery();
    await Promise.all([h.manager.discoverNow(), h.manager.discoverNow()]);
    await h.settle();

    expect(discoverTarget).toHaveBeenCalledOnce();
    expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
    h.manager.stop();
  });

  it("keeps built metadata recovery alive until a retry runs", async () => {
    const builtModuleUrl = new URL("../../dist/index.mjs", import.meta.url).href;
    const script = `
      import { UpdateManager } from ${JSON.stringify(builtModuleUrl)};
      let reads = 0;
      let manager;
      manager = new UpdateManager({
        channel: "staging",
        currentVersion: "0.0.1-staging.1.1",
        protectedWork: () => ({ total: 0 }),
        executeUpdate: async () => undefined,
        onHandoff: () => undefined,
        loadState: async () => undefined,
        saveState: async () => undefined,
        discoverTarget: async () => {
          reads += 1;
          if (reads >= 2) manager.stop();
          throw new Error("metadata unavailable");
        },
        discoveryIntervalMs: 100,
        discoveryMaxBackoffMs: 100,
      });
      manager.startDiscovery();
      manager.holdRecoveryAlive();
      await new Promise((resolve) => setTimeout(resolve, 20));
      process.on("beforeExit", () => {
        process.stdout.write("beforeExit reads=" + reads + "\\n");
        process.exitCode = reads >= 2 ? 0 : 1;
      });
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });

    expect(stdout).toContain("beforeExit reads=2");
  });

  it("preserves an installing attempt when recovery status is saved concurrently", async () => {
    let stored: UpdaterStateSnapshot | undefined;
    let releaseInstalling!: () => void;
    let installingStarted!: () => void;
    let releaseRecovery!: () => void;
    let recoverySaveStarted!: () => void;
    let recoverySaveBlocked = true;
    const installingGate = new Promise<void>((resolve) => {
      releaseInstalling = resolve;
    });
    const installingReady = new Promise<void>((resolve) => {
      installingStarted = resolve;
    });
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const recoveryReady = new Promise<void>((resolve) => {
      recoverySaveStarted = resolve;
    });
    const manager = new UpdateManager({
      channel: "staging",
      currentVersion: "0.0.2-staging.1.1",
      protectedWork: () => ({ total: 0 }),
      executeUpdate: async () => undefined,
      onHandoff: () => undefined,
      loadState: async () => (stored ? structuredClone(stored) : undefined),
      saveState: async (state) => {
        if (state.state === "installing") {
          installingStarted();
          await installingGate;
        }
        if (state.recoveryStatus === "upgrade_required" && recoverySaveBlocked) {
          recoverySaveBlocked = false;
          recoverySaveStarted();
          await recoveryGate;
        }
        stored = structuredClone(state);
      },
    });

    manager.observe(target("0.0.3-staging.1.1"));
    await installingReady;
    const recoveryStatus = manager.recordRecoveryStatus("upgrade_required");
    releaseInstalling();
    await vi.waitFor(() => expect(stored).toMatchObject({ state: "installed", target: "0.0.3-staging.1.1" }));
    await recoveryReady;
    releaseRecovery();
    await recoveryStatus;

    expect(stored).toMatchObject({
      state: "installed",
      target: "0.0.3-staging.1.1",
      recoveryStatus: "upgrade_required",
    });
    expect(stored?.attempts["0.0.3-staging.1.1"]).toMatchObject({ result: "installed" });
  });

  it("uses bounded exponential backoff after unavailable release metadata", async () => {
    vi.useFakeTimers();
    try {
      const discoverTarget = vi.fn(async () => {
        throw new Error("release endpoint unavailable");
      });
      const h = harness({ discoverTarget, discoveryIntervalMs: 10, discoveryMaxBackoffMs: 25 });

      h.manager.startDiscovery();
      await vi.advanceTimersByTimeAsync(0);
      expect(discoverTarget).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(19);
      expect(discoverTarget).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(discoverTarget).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(24);
      expect(discoverTarget).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(discoverTarget).toHaveBeenCalledTimes(3);
      h.manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts running work instead of waiting, keeping admission open until the handoff", async () => {
    const h = harness();
    h.setRecoverable(true);
    h.setProtectedWork(2);
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
    expect(h.quiescedDuringInstall).toEqual([false]);
    expect(h.handoffs).toBe(1);
    expect(h.isQuiesced()).toBe(true);
    expect(h.state()).toMatchObject({ state: "installed", target: "0.0.3-staging.1.1" });
  });

  it("leaves running work and admission alone when the install fails", async () => {
    const h = harness();
    h.setRecoverable(true);
    h.setProtectedWork(2);
    h.failNextInstall("checksum mismatch");
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.handoffs).toBe(0);
    expect(h.isQuiesced()).toBe(false);
    expect(h.resumes).toBe(0);
    expect(h.state()?.state).toBe("blocked");
  });

  it("stops waiting for protected work once interrupted work becomes recoverable", async () => {
    const h = harness();
    h.setProtectedWork(2);
    h.manager.observe(target("0.0.3-staging.1.1"));
    await h.settle();
    expect(h.state()?.state).toBe("awaiting_protected_work");
    expect(h.installs).toEqual([]);

    h.setRecoverable(true);
    h.flushSleep();
    await h.settle();
    expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
    expect(h.quiescedDuringInstall).toEqual([false]);
    expect(h.handoffs).toBe(1);
    expect(h.isQuiesced()).toBe(true);
  });

  describe("cancelled before an interruptible install starts", () => {
    function gate() {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release, released };
    }

    function heldLoad() {
      const held = gate();
      const h = harness({ beforeLoad: () => held.released });
      h.setRecoverable(true);
      h.setProtectedWork(2);
      return { h, held };
    }

    function heldAttemptWrite() {
      const held = gate();
      let reached: () => void = () => undefined;
      const writing = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let holding = true;
      const h = harness({
        beforeSave: async (state) => {
          if (state.state !== "installing" || !holding) return;
          holding = false;
          reached();
          await held.released;
        },
      });
      h.setRecoverable(true);
      h.setProtectedWork(2);
      return { h, held, writing };
    }

    it("does not install or hand off when stopped during the state read", async () => {
      const { h, held } = heldLoad();
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      h.manager.stop();
      held.release();
      await h.settle();
      expect(h.installs).toEqual([]);
      expect(h.handoffs).toBe(0);
      expect(h.isQuiesced()).toBe(false);
      expect(h.state()?.attempts ?? {}).toEqual({});
    });

    it("installs only the newer target observed during the state read", async () => {
      const { h, held } = heldLoad();
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      h.manager.observe(target("0.0.3-staging.1.2"));
      held.release();
      await h.settle();
      expect(h.installs).toEqual(["0.0.3-staging.1.2"]);
      expect(Object.keys(h.state()?.attempts ?? {})).toEqual(["0.0.3-staging.1.2"]);
      expect(h.handoffs).toBe(1);
    });

    it("withdraws the attempt when stopped during its write, so a restart can still install the target", async () => {
      const { h, held, writing } = heldAttemptWrite();
      h.manager.observe(target("0.0.3-staging.1.1"));
      await writing;
      h.manager.stop();
      held.release();
      await h.settle();
      expect(h.installs).toEqual([]);
      expect(h.handoffs).toBe(0);
      expect(h.isQuiesced()).toBe(false);
      expect(h.state()?.attempts).toEqual({});
      expect(h.state()?.state).toBe("idle");
      expect(h.state()?.lastAttempt).toBeUndefined();
    });

    it("installs only the newer target observed during the attempt write", async () => {
      const { h, held, writing } = heldAttemptWrite();
      h.manager.observe(target("0.0.3-staging.1.1"));
      await writing;
      h.manager.observe(target("0.0.3-staging.1.2"));
      held.release();
      await h.settle();
      expect(h.installs).toEqual(["0.0.3-staging.1.2"]);
      expect(Object.keys(h.state()?.attempts ?? {})).toEqual(["0.0.3-staging.1.2"]);
      expect(h.state()?.lastAttempt?.target).toBe("0.0.3-staging.1.2");
      expect(h.handoffs).toBe(1);
    });

    it("keeps the last finished attempt when a later one is withdrawn", async () => {
      const previous = { target: "0.0.2-staging.0.1", startedAt: "T0", finishedAt: "T1", result: "failed" as const };
      const held = gate();
      let reached: () => void = () => undefined;
      const writing = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let holding = true;
      const h = harness({
        stored: {
          schemaVersion: 1,
          currentVersion: "0.0.2-staging.1.1",
          state: "idle",
          attempts: {},
          lastAttempt: previous,
        },
        beforeSave: async (state) => {
          if (state.state !== "installing" || !holding) return;
          holding = false;
          reached();
          await held.released;
        },
      });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await writing;
      h.manager.stop();
      held.release();
      await h.settle();
      expect(h.installs).toEqual([]);
      expect(h.state()?.lastAttempt).toEqual(previous);
    });

    it("logs and leaves the record when withdrawing the attempt cannot be saved", async () => {
      const held = gate();
      let reached: () => void = () => undefined;
      const writing = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let holding = true;
      const h = harness({
        beforeSave: async (state) => {
          if (state.state === "installing" && holding) {
            holding = false;
            reached();
            await held.released;
            return;
          }
          if (state.state === "idle") throw new Error("state disk unavailable");
        },
      });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await writing;
      h.manager.stop();
      held.release();
      await h.settle();
      expect(h.installs).toEqual([]);
      expect(h.handoffs).toBe(0);
      expect(h.state()?.state).toBe("installing");
      expect(h.logs.some((entry) => JSON.stringify(entry).includes("could not be withdrawn"))).toBe(true);
    });
  });

  it("waits with no force timeout while interrupted work could not be recovered", async () => {
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

  it("withdraws transient download failures and retries with bounded exponential backoff instead of blocking", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ installRetryIntervalMs: 10, installRetryMaxBackoffMs: 25 });
      h.setRecoverable(true);
      h.failNextInstall("Release manifest fetch failed: fetch failed", { transient: true });
      h.failNextInstall("Release manifest fetch failed: HTTP 503", { transient: true });

      h.manager.observe(target("0.0.3-staging.1.1"));
      await vi.advanceTimersByTimeAsync(0);

      // The transient download failure withdraws the attempt rather than blocking the target.
      expect(h.installs).toEqual([]);
      expect(h.handoffs).toBe(0);
      expect(h.state()).toMatchObject({ state: "idle", target: "0.0.3-staging.1.1", attempts: {} });
      expect(h.state()?.lastAttempt).toBeUndefined();

      // Re-observing the same target while the retry timer is pending does not bypass the backoff.
      h.manager.observe(target("0.0.3-staging.1.1"));
      await vi.advanceTimersByTimeAsync(9);
      expect(h.installs).toEqual([]);

      // First retry fires at 10ms and hits a second transient failure; backoff doubles to 20ms.
      await vi.advanceTimersByTimeAsync(1);
      expect(h.installs).toEqual([]);
      expect(h.state()).toMatchObject({ state: "idle", target: "0.0.3-staging.1.1", attempts: {} });

      await vi.advanceTimersByTimeAsync(19);
      expect(h.installs).toEqual([]);

      // Second retry fires at 20ms and succeeds without ever pausing admission during the downloads.
      await vi.advanceTimersByTimeAsync(1);
      expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
      expect(h.quiescedDuringInstall).toEqual([false, false, false]);
      expect(h.resumes).toBe(0);
      expect(h.handoffs).toBe(1);
      expect(h.state()).toMatchObject({ state: "installed", target: "0.0.3-staging.1.1" });
      h.manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a restarted daemon or a newer target to proceed after a withdrawn transient download failure", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ installRetryIntervalMs: 50, installRetryMaxBackoffMs: 100 });
      h.setRecoverable(true);
      h.failNextInstall("Release manifest fetch failed: fetch failed", { transient: true });

      h.manager.observe(target("0.0.3-staging.1.1"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.state()).toMatchObject({ state: "idle", attempts: {} });

      // A restarted daemon reading the persisted state sees no unfinished attempt and can install the same target.
      const restarted = harness({ stored: h.state() });
      restarted.setRecoverable(true);
      restarted.manager.observe(target("0.0.3-staging.1.1"));
      await vi.advanceTimersByTimeAsync(0);
      expect(restarted.installs).toEqual(["0.0.3-staging.1.1"]);
      expect(restarted.handoffs).toBe(1);
      restarted.manager.stop();

      // Observing a newer target cancels the old retry timer and installs immediately.
      h.manager.observe(target("0.0.3-staging.1.2"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.installs).toEqual(["0.0.3-staging.1.2"]);
      expect(h.handoffs).toBe(1);
      h.manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks after a single quiesced attempt when sessionRecovery is unavailable so admission is not paused repeatedly", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ installRetryIntervalMs: 10, installRetryMaxBackoffMs: 25 });
      h.failNextInstall("Release manifest fetch failed: fetch failed", { transient: true });

      h.manager.observe(target("0.0.3-staging.1.1"));
      await vi.advanceTimersByTimeAsync(0);

      expect(h.installs).toEqual([]);
      expect(h.quiescedDuringInstall).toEqual([true]);
      expect(h.resumes).toBe(1);
      expect(h.isQuiesced()).toBe(false);
      expect(h.state()).toMatchObject({
        state: "blocked",
        target: "0.0.3-staging.1.1",
        lastAttempt: {
          target: "0.0.3-staging.1.1",
          result: "failed",
          failureReason: "Release manifest fetch failed: fetch failed",
        },
      });

      // Advancing past the retry window does not trigger another quiesce/install cycle.
      await vi.advanceTimersByTimeAsync(100);
      expect(h.quiescedDuringInstall).toEqual([true]);
      expect(h.resumes).toBe(1);
      h.manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("handoff readiness", () => {
    const notReady: HandoffReadiness = { ready: false, reason: "launchd domain gui/501 is in on-demand-only mode" };

    it("defers the handoff while the supervisor cannot restart the service, keeping admission open", async () => {
      let readiness: HandoffReadiness = notReady;
      let checks = 0;
      const h = harness({
        handoffReadiness: async () => {
          checks += 1;
          return readiness;
        },
      });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      await h.settle();
      expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
      expect(h.handoffs).toBe(0);
      expect(h.isQuiesced()).toBe(false);
      expect(checks).toBeGreaterThan(1);
      expect(h.state()).toMatchObject({ state: "installed", target: "0.0.3-staging.1.1" });
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({ reason: notReady.reason, target: "0.0.3-staging.1.1" }),
          message:
            "Supervisor cannot restart the service now; keeping the running version and retrying the handoff later",
        }),
      );

      readiness = { ready: true };
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.isQuiesced()).toBe(true);
      expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "Supervisor can restart the service again; continuing the deferred handoff",
        }),
      );
    });

    it("hands off without deferring when the supervisor is ready", async () => {
      const h = harness({ handoffReadiness: async () => ({ ready: true }) });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.resumes).toBe(0);
      expect(h.logs.filter((entry) => entry.level === "warn")).toEqual([]);
    });

    it("hands off when the readiness check fails", async () => {
      const h = harness({
        handoffReadiness: async () => {
          throw new Error("launchctl unavailable");
        },
      });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({ error: "launchctl unavailable" }),
          message: "Supervisor restart readiness could not be checked; continuing the handoff",
        }),
      );
    });

    it("hands off when the readiness check is uncertain", async () => {
      const h = harness({ handoffReadiness: async () => ({ ready: true, uncertain: "log show failed" }) });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({ detail: "log show failed" }),
          message: "Supervisor restart readiness is uncertain; continuing the handoff",
        }),
      );
    });

    it("hands off anyway after the maximum deferral", async () => {
      let clock = 1_700_000_000_000;
      const h = harness({
        handoffReadiness: async () => {
          clock += 3_600_000;
          return notReady;
        },
        maxHandoffDeferralMs: 7_200_000,
        now: () => clock,
      });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      await h.settle();
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.isQuiesced()).toBe(true);
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message:
            "Supervisor still reports that it cannot restart the service after the maximum deferral; handing off anyway",
        }),
      );
    });

    it("drains work accepted during the deferral when interrupted work could not be recovered", async () => {
      let readiness: HandoffReadiness = notReady;
      const h = harness({ handoffReadiness: async () => readiness });
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      expect(h.quiescedDuringInstall).toEqual([true]);
      expect(h.handoffs).toBe(0);
      expect(h.isQuiesced()).toBe(false);
      expect(h.resumes).toBe(1);

      h.setProtectedWork(1);
      readiness = { ready: true };
      await h.settle();
      expect(h.handoffs).toBe(0);
      expect(h.isQuiesced()).toBe(true);

      h.setProtectedWork(0);
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.isQuiesced()).toBe(true);
    });

    it("installs a newer target observed while the handoff is deferred", async () => {
      let readiness: HandoffReadiness = notReady;
      const h = harness({ handoffReadiness: async () => readiness });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      h.manager.observe(target("0.0.3-staging.1.2"));
      await h.settle();
      expect(h.installs).toEqual(["0.0.3-staging.1.1", "0.0.3-staging.1.2"]);
      expect(h.handoffs).toBe(0);

      readiness = { ready: true };
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.state()).toMatchObject({ state: "installed", target: "0.0.3-staging.1.2" });
    });

    it("keeps recording recovery diagnostics while the handoff is deferred", async () => {
      const h = harness({ handoffReadiness: async () => notReady });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      expect(h.handoffs).toBe(0);
      await h.manager.recordRecoveryStatus("upgrade_required");
      expect(h.state()).toMatchObject({ recoveryStatus: "upgrade_required", state: "installed" });
    });

    it("wakes the handoff retry wait when a newer target is observed", async () => {
      const h = harness({ handoffReadiness: async () => notReady, sleep: () => new Promise<void>(() => undefined) });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      h.manager.observe(target("0.0.3-staging.1.2"));
      await h.settle();
      expect(h.installs).toEqual(["0.0.3-staging.1.1", "0.0.3-staging.1.2"]);
      expect(h.handoffs).toBe(0);
    });

    it("still hands off a deferred install after the channel target returns to the running version", async () => {
      let readiness: HandoffReadiness = notReady;
      const h = harness({ handoffReadiness: async () => readiness });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      h.manager.observe(target("0.0.2-staging.1.1"));
      await h.settle();
      expect(h.handoffs).toBe(0);

      readiness = { ready: true };
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.installs).toEqual(["0.0.3-staging.1.1"]);
    });

    it("still hands off a deferred install after a newer target fails to install", async () => {
      let readiness: HandoffReadiness = notReady;
      const h = harness({ handoffReadiness: async () => readiness });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      h.failNextInstall("checksum mismatch");
      h.manager.observe(target("0.0.3-staging.1.2"));
      await h.settle();
      expect(h.state()).toMatchObject({ state: "blocked", target: "0.0.3-staging.1.2" });
      expect(h.handoffs).toBe(0);

      readiness = { ready: true };
      await h.settle();
      expect(h.handoffs).toBe(1);
      expect(h.isQuiesced()).toBe(true);
    });

    it("stops deferring when stopped", async () => {
      const h = harness({ handoffReadiness: async () => notReady });
      h.setRecoverable(true);
      h.manager.observe(target("0.0.3-staging.1.1"));
      await h.settle();
      h.manager.stop();
      await h.settle();
      expect(h.handoffs).toBe(0);
      expect(h.isQuiesced()).toBe(false);
    });
  });
});
