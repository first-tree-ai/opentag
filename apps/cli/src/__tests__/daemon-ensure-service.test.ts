import { describe, expect, it, vi } from "vitest";
import { ENSURE_SERVICE_DEFERRED_EXIT_CODE, executeDaemonEnsureService } from "../commands/daemon/ensure-service.js";

const service = {
  currentHome: "/home/user/.opentag-dev",
  definitionPath: "/service/opentag-dev.service",
  drifted: false,
  logHint: "journal",
  platform: "systemd" as const,
  serviceId: "opentag-dev",
  state: "active" as const,
};

describe("daemon ensure-service command", () => {
  it("maps a deferred core result to the installer exit contract", async () => {
    const writeOutput = vi.fn();
    await expect(
      executeDaemonEnsureService({
        reconcileService: async () => ({
          reason: "credentials-missing",
          service: { ...service, state: "not-installed" },
          status: "deferred",
        }),
        writeOutput,
      }),
    ).resolves.toBe(ENSURE_SERVICE_DEFERRED_EXIT_CODE);
    expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining("deferred until login"));
  });

  it("maps a ready core result to success", async () => {
    const writeOutput = vi.fn();
    await expect(
      executeDaemonEnsureService({
        reconcileService: async () => ({ action: "restarted", service, status: "ready" }),
        writeOutput,
      }),
    ).resolves.toBe(0);
    expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining("restarted and is active"));
  });

  it("maps a core failure to a non-zero exit", async () => {
    const writeError = vi.fn();
    await expect(
      executeDaemonEnsureService({
        reconcileService: async () => {
          throw new Error("restart failed");
        },
        writeError,
      }),
    ).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledWith("restart failed");
  });
});
