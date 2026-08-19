import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerDaemonCommand } from "../commands/daemon/index.js";
import { executeDaemonServiceCommand } from "../commands/daemon/shared.js";
import { acquireDaemonOwner } from "../core/daemon/ownership.js";
import { runDaemonServiceEntry } from "../core/daemon/runtime.js";
import { createDaemonServiceManager, type DaemonServiceManager } from "../core/daemon/service/index.js";
import type { ServiceRunner } from "../core/daemon/service/types.js";

describe("daemon service commands", () => {
  it("exposes lifecycle commands without public runtime entrypoints", () => {
    const program = new Command().name("opentag");
    registerDaemonCommand(program);
    const daemon = program.commands.find((command) => command.name() === "daemon");
    expect(daemon).toBeDefined();
    const visible = daemon?.commands
      .filter((command) => command.name() !== "service-run")
      .map((command) => command.name());
    expect(visible).toEqual(["install", "start", "stop", "restart", "status", "uninstall"]);
    expect(daemon?.helpInformation()).not.toContain("service-run");
    expect(daemon?.helpInformation()).not.toMatch(/^\s+run\b/mu);
  });

  it("maps status to a stable exit code and redacted presentation", async () => {
    const manager = fakeManager("inactive");
    const output: string[] = [];
    const exitCode = await executeDaemonServiceCommand("status", {
      manager,
      writeOutput: (message) => output.push(message),
    });
    expect(exitCode).toBe(1);
    expect(output.join("\n")).toContain("State: inactive");
    expect(output.join("\n")).not.toContain("refresh-token");
  });

  it("does not report an unknown stop state as success", async () => {
    const manager = fakeManager("inactive");
    manager.stop = vi.fn(async () => ({ ...(await manager.status()), state: "unknown" as const }));
    await expect(executeDaemonServiceCommand("stop", { manager, writeOutput: () => undefined })).resolves.toBe(1);
  });

  it("treats deterministic service configuration failures as clean service exits", async () => {
    const messages: string[] = [];
    const home = await mkdtemp(join(tmpdir(), "opentag-service-entry-"));
    try {
      const exitCode = await runDaemonServiceEntry({
        home,
        log: (message) => messages.push(message),
      });
      expect(exitCode).toBe(0);
      expect(messages.join(" ")).toContain("not logged in");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("treats a live daemon owner conflict as a clean service exit", async () => {
    const messages: string[] = [];
    const home = await mkdtemp(join(tmpdir(), "opentag-service-owner-busy-"));
    const owner = await acquireDaemonOwner(home, "existing-instance");
    try {
      await expect(
        runDaemonServiceEntry({
          home,
          log: (message) => messages.push(message),
        }),
      ).resolves.toBe(0);
      expect(messages.join(" ")).toContain("already running");
    } finally {
      await owner.release();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("treats a malformed daemon owner as a clean service exit", async () => {
    const messages: string[] = [];
    const home = await mkdtemp(join(tmpdir(), "opentag-service-owner-malformed-"));
    try {
      await writeFile(join(home, "daemon-owner.json"), "{}\n", { mode: 0o600 });
      await expect(
        runDaemonServiceEntry({
          home,
          log: (message) => messages.push(message),
        }),
      ).resolves.toBe(0);
      expect(messages.join(" ")).toContain("malformed");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses service mutation while a live unmanaged daemon owns the home", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-unmanaged-"));
    const userHome = await mkdtemp(join(tmpdir(), "opentag-service-user-"));
    const owner = await acquireDaemonOwner(home, "foreground-instance");
    const runner = {
      run: vi.fn(async () => ({ code: 0, stderr: "", stdout: "", timedOut: false })),
    } satisfies ServiceRunner;
    try {
      const manager = await createDaemonServiceManager({
        home,
        invocation: { args: [], program: "/usr/bin/opentag" },
        platform: "linux",
        runner,
        uid: 1000,
        userHome,
        username: "test",
      });
      await expect(manager.start()).rejects.toThrow("outside the expected systemd service state");
      expect(runner.run).not.toHaveBeenCalled();
    } finally {
      await owner.release();
      await rm(home, { recursive: true, force: true });
      await rm(userHome, { recursive: true, force: true });
    }
  });
});

function fakeManager(state: "active" | "inactive"): DaemonServiceManager {
  const info = {
    currentHome: "/home/user/.opentag",
    definitionPath: "/service/opentag.service",
    drifted: false,
    logHint: "journal",
    platform: "systemd" as const,
    serviceId: "opentag",
    state,
  };
  return {
    installAndStart: vi.fn(async () => ({ ...info, state: "active" as const })),
    preflight: vi.fn(async () => undefined),
    restart: vi.fn(async () => ({ ...info, state: "active" as const })),
    start: vi.fn(async () => ({ ...info, state: "active" as const })),
    status: vi.fn(async () => info),
    stop: vi.fn(async () => ({ ...info, state: "inactive" as const })),
    uninstall: vi.fn(async () => ({ ...info, state: "not-installed" as const })),
  };
}
