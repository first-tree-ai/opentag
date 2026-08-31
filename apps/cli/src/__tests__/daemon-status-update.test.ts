import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeDaemonServiceCommand, formatUpdateStatus } from "../commands/daemon/shared.js";
import { writeUpdaterState } from "../core/update/updater-state.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function activeManager() {
  const info = {
    currentHome: "/tmp/home",
    definitionPath: "/tmp/unit",
    logHint: "journal",
    platform: "systemd" as const,
    serviceId: "opentag-staging",
    state: "active" as const,
  };
  return {
    installAndStart: vi.fn(async () => info),
    preflight: vi.fn(async () => undefined),
    refreshDefinition: vi.fn(async () => info),
    restart: vi.fn(async () => info),
    start: vi.fn(async () => info),
    status: vi.fn(async () => info),
    stop: vi.fn(async () => ({ ...info, state: "inactive" as const })),
    uninstall: vi.fn(async () => ({ ...info, state: "not-installed" as const })),
  };
}

describe("daemon status update visibility", () => {
  it("formats current, target, state, and the last attempt with its failure reason", () => {
    expect(
      formatUpdateStatus({
        currentVersion: "0.0.2",
        state: "blocked",
        target: "0.0.3",
        lastAttempt: {
          target: "0.0.3",
          startedAt: "2023-11-14T22:13:20.000Z",
          finishedAt: "2023-11-14T22:13:30.000Z",
          result: "failed",
          failureReason: "checksum mismatch",
        },
      }),
    ).toBe(
      [
        "Update current: 0.0.2",
        "Update state: blocked",
        "Update target: 0.0.3",
        "Update last attempt: 0.0.3 failed at 2023-11-14T22:13:30.000Z (checksum mismatch)",
      ].join("\n"),
    );
    expect(formatUpdateStatus({ currentVersion: "0.0.3", state: "idle" })).toBe(
      ["Update current: 0.0.3", "Update state: idle"].join("\n"),
    );
  });

  it("appends the durable updater state to daemon status when one exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-status-update-"));
    directories.push(home);
    vi.stubEnv("OPENTAG_HOME", home);
    await writeUpdaterState(home, {
      schemaVersion: 1,
      currentVersion: "0.0.2",
      state: "awaiting_protected_work",
      target: "0.0.3",
      attempts: {},
    });
    const outputs: string[] = [];
    const exitCode = await executeDaemonServiceCommand("status", {
      manager: activeManager(),
      writeOutput: (message) => outputs.push(message),
    });
    expect(exitCode).toBe(0);
    const text = outputs.join("\n");
    expect(text).toContain("State: active");
    expect(text).toContain("Update current: 0.0.2");
    expect(text).toContain("Update state: awaiting_protected_work");
    expect(text).toContain("Update target: 0.0.3");
  });

  it("omits the update section when no updater state was recorded", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-status-empty-"));
    directories.push(home);
    vi.stubEnv("OPENTAG_HOME", home);
    const outputs: string[] = [];
    const exitCode = await executeDaemonServiceCommand("status", {
      manager: activeManager(),
      writeOutput: (message) => outputs.push(message),
    });
    expect(exitCode).toBe(0);
    expect(outputs.join("\n")).not.toContain("Update");
  });
});
