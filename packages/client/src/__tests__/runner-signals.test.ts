import { afterEach, describe, expect, it, vi } from "vitest";
import { installRunnerSignalHandlers, registerRunnerSignalCleanup } from "../runner/signals.js";

/**
 * The install helper only registers process listeners; tests drive them through
 * their captured callbacks, without invoking any pre-existing Vitest listeners.
 * Added listeners are removed after each test so no handler leaks across files.
 */
const added: Array<{ signal: "SIGINT" | "SIGTERM"; listener: (signal: "SIGINT" | "SIGTERM") => void }> = [];

function installCapture(exit: (code: number) => void): void {
  const before = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  } as const;
  installRunnerSignalHandlers(exit);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!before[signal].includes(listener)) {
        added.push({ signal, listener });
      }
    }
  }
}

function deliverSignal(signal: "SIGINT" | "SIGTERM"): void {
  for (const entry of added) {
    if (entry.signal === signal) entry.listener(signal);
  }
}

afterEach(() => {
  for (const { signal, listener } of added.splice(0)) {
    process.removeListener(signal, listener);
  }
  registerRunnerSignalCleanup(undefined);
  vi.restoreAllMocks();
});

describe("runner signal lifecycle", () => {
  it("runs the registered cleanup and exits 143 on SIGTERM, ignoring a repeated signal", async () => {
    const exits: number[] = [];
    installCapture((code) => exits.push(code));
    let cleaned = 0;
    let releaseCleanup: () => void = () => undefined;
    const cleanupPending = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    registerRunnerSignalCleanup(async () => {
      cleaned += 1;
      await cleanupPending;
    });
    deliverSignal("SIGTERM");
    await vi.waitFor(() => expect(cleaned).toBe(1));
    deliverSignal("SIGTERM");
    expect(exits).toEqual([]);
    releaseCleanup();
    await vi.waitFor(() => expect(exits).toEqual([143]));
    expect(exits).toEqual([143]);
    expect(cleaned).toBe(1);
  });

  it("exits 130 on SIGINT and reports cleanup failures without hiding the exit code", async () => {
    const exits: number[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    installCapture((code) => exits.push(code));
    registerRunnerSignalCleanup(async () => {
      throw new Error("cleanup exploded");
    });
    deliverSignal("SIGINT");
    await vi.waitFor(() => {
      expect(exits).toEqual([130]);
    });
    expect(stderrSpy.mock.calls.flat().join("")).toMatch(/signal cleanup failed: cleanup exploded/);
  });

  it("still exits when no cleanup is registered", async () => {
    const exits: number[] = [];
    installCapture((code) => exits.push(code));
    registerRunnerSignalCleanup(undefined);
    deliverSignal("SIGTERM");
    await vi.waitFor(() => {
      expect(exits).toEqual([143]);
    });
  });
});
