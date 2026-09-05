import { describe, expect, it, vi } from "vitest";
import type { RuntimeOwnershipLease } from "../runtime/runtime-ownership-lease.js";
import { RuntimeOwnershipRecovery } from "../runtime/runtime-ownership-recovery.js";

const lease: RuntimeOwnershipLease = {
  instanceId: "instance-2",
  state: { mode: "single" as const, status: "owned" as const, instanceId: "instance-2" },
  release: vi.fn(async () => undefined),
};

describe("RuntimeOwnershipRecovery", () => {
  it("fences synchronously before attempting to acquire a replacement lease", async () => {
    const events: string[] = [];
    let currentLease: RuntimeOwnershipLease | undefined = {
      ...lease,
      release: vi.fn(async () => {
        events.push("old:release");
      }),
    };
    const acquire = vi.fn(async () => {
      expect(events).toEqual(["fence", "old:release"]);
      return lease;
    });
    const recovery = new RuntimeOwnershipRecovery({
      acquire,
      fence: {
        fence: () => events.push("fence"),
        resume: () => events.push("resume"),
      },
      getLease: () => currentLease,
      onFailed: async () => undefined,
      onRecovered: () => events.push("recovered"),
      setLease: (next) => {
        currentLease = next;
      },
    });

    await recovery.configure();
    recovery.onLost();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());

    expect(events).toEqual(["fence", "old:release", "resume", "recovered"]);
  });
});
