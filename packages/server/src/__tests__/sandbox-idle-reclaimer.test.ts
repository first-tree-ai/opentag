import { describe, expect, it, vi } from "vitest";
import { SandboxIdleReclaimer } from "../services/sandboxes/idle-reclaimer.js";

describe("SandboxIdleReclaimer shutdown", () => {
  it.each([false, true])("drains an in-flight sweep before shutdown (failure=%s)", async (failed) => {
    let resolve!: (result: { claimed: number; released: number; recovered: number; failed: number }) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<{ claimed: number; released: number; recovered: number; failed: number }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const reclaimIdleSandboxes = vi.fn(() => promise);
    const onDiagnostic = vi.fn();
    const reclaimer = new SandboxIdleReclaimer({ service: { reclaimIdleSandboxes }, onDiagnostic });
    reclaimer.start();
    reclaimer.sweep();
    reclaimer.sweep();
    let stopped = false;
    const stop = reclaimer.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(reclaimIdleSandboxes).toHaveBeenCalledTimes(1);
    if (failed) reject(new Error("Provider unavailable"));
    else resolve({ claimed: 0, released: 0, recovered: 0, failed: 0 });
    await stop;
    expect(stopped).toBe(true);
    expect(onDiagnostic).toHaveBeenCalledTimes(failed ? 1 : 0);
    await reclaimer.stop();
  });
});
