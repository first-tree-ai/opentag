import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientLogBindings, ClientLogger } from "@opentag/client";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { registerDaemonCommand } from "../commands/daemon/index.js";
import * as daemonShared from "../commands/daemon/shared.js";
import { executeDaemonServiceCommand } from "../commands/daemon/shared.js";
import { channelConfig } from "../core/channel/config.js";
import { acquireDaemonOwner } from "../core/daemon/ownership.js";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import * as daemonRuntime from "../core/daemon/runtime.js";
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
      .filter((command) => !["ensure-service", "service-run"].includes(command.name()))
      .map((command) => command.name());
    expect(visible).toEqual(["install", "start", "stop", "restart", "status", "uninstall"]);
    expect(daemon?.helpInformation()).not.toContain("service-run");
    expect(daemon?.helpInformation()).not.toContain("ensure-service");
    expect(daemon?.helpInformation()).not.toMatch(/^\s+run\b/mu);
  });

  it("dispatches every daemon lifecycle wrapper to its shared executor", async () => {
    const execute = vi.spyOn(daemonShared, "executeDaemonServiceCommand").mockResolvedValue(0);
    const serviceRun = vi.spyOn(daemonRuntime, "runDaemonServiceEntry").mockResolvedValue(0);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      for (const [command, action] of [
        ["install", "installAndStart"],
        ["start", "start"],
        ["stop", "stop"],
        ["restart", "restart"],
        ["status", "status"],
        ["uninstall", "uninstall"],
      ] as const) {
        await createProgram().parseAsync(["node", "opentag", "daemon", command]);
        expect(execute).toHaveBeenLastCalledWith(action);
        await createProgram().parseAsync(["node", "opentag", "daemon", command, "--json"]);
        expect(execute).toHaveBeenLastCalledWith(action, { json: true });
      }
      await createProgram().parseAsync(["node", "opentag", "daemon", "service-run"]);
      await createProgram().parseAsync(["node", "opentag", "daemon", "ensure-service"]);
      expect(serviceRun).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = previousExitCode;
      execute.mockRestore();
      serviceRun.mockRestore();
    }
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

  it("presents daemon service results and failures as JSON", async () => {
    const manager = fakeManager("active");
    const output: string[] = [];
    const errors: string[] = [];
    await expect(
      executeDaemonServiceCommand("status", { manager, json: true, writeOutput: (message) => output.push(message) }),
    ).resolves.toBe(0);
    const failing = fakeManager("active");
    failing.status = vi.fn().mockRejectedValue(new Error("connection refused"));
    await expect(
      executeDaemonServiceCommand("status", {
        manager: failing,
        json: true,
        writeError: (message) => errors.push(message),
      }),
    ).resolves.toBe(3);
    expect(output.join("\n")).toContain('"ok":true');
    expect(errors.join("\n")).toContain('"category":"unavailable"');
  });

  it("uses the documented lifecycle exit states", async () => {
    const active = fakeManager("active");
    expect(await executeDaemonServiceCommand("stop", { manager: active, writeOutput: () => undefined })).toBe(0);
    expect(await executeDaemonServiceCommand("uninstall", { manager: active, writeOutput: () => undefined })).toBe(0);
    const inactive = fakeManager("inactive");
    expect(await executeDaemonServiceCommand("start", { manager: inactive, writeOutput: () => undefined })).toBe(0);
  });

  it("treats deterministic service configuration failures as clean service exits", async () => {
    const messages: Array<{ fields: ClientLogBindings; message: string }> = [];
    const home = await mkdtemp(join(tmpdir(), "opentag-service-entry-"));
    try {
      const exitCode = await runDaemonServiceEntry({
        home,
        logger: recordingLogger(messages),
      });
      expect(exitCode).toBe(0);
      expect(messages).toContainEqual(
        expect.objectContaining({
          fields: expect.objectContaining({ category: "configuration", instanceId: expect.any(String) }),
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("treats a live daemon owner conflict as a clean service exit", async () => {
    const messages: Array<{ fields: ClientLogBindings; message: string }> = [];
    const home = await mkdtemp(join(tmpdir(), "opentag-service-owner-busy-"));
    const owner = await acquireDaemonOwner(home, "existing-instance");
    try {
      await expect(
        runDaemonServiceEntry({
          home,
          logger: recordingLogger(messages),
        }),
      ).resolves.toBe(0);
      expect(messages).toContainEqual(
        expect.objectContaining({
          fields: expect.objectContaining({ category: "ownership", instanceId: expect.any(String) }),
        }),
      );
    } finally {
      await owner.release();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("treats a malformed daemon owner as a clean service exit", async () => {
    const messages: Array<{ fields: ClientLogBindings; message: string }> = [];
    const home = await mkdtemp(join(tmpdir(), "opentag-service-owner-malformed-"));
    try {
      const paths = resolveDaemonPaths(home);
      await mkdir(paths.daemonState, { mode: 0o700, recursive: true });
      await writeFile(paths.daemonOwner, "{}\n", { mode: 0o600 });
      await expect(
        runDaemonServiceEntry({
          home,
          logger: recordingLogger(messages),
        }),
      ).resolves.toBe(0);
      expect(messages).toContainEqual(
        expect.objectContaining({ fields: expect.objectContaining({ category: "ownership" }) }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses service mutation while a live unmanaged daemon owns the home", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-unmanaged-"));
    const userHome = await mkdtemp(join(tmpdir(), "opentag-service-user-"));
    const owner = await acquireDaemonOwner(home, "foreground-instance");
    const runner = {
      run: vi.fn(async (_program: string, args: readonly string[]) => ({
        code: 0,
        stderr: "",
        stdout: args.includes("LoadState") ? "not-found" : "",
        timedOut: false,
      })),
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
      expect(runner.run).not.toHaveBeenCalledWith(
        "systemctl",
        ["--user", "start", `${channelConfig.serviceId}.service`],
        expect.any(Object),
      );
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

function recordingLogger(
  entries: Array<{ fields: ClientLogBindings; message: string }>,
  bindings: ClientLogBindings = {},
): ClientLogger {
  const record = (fields: ClientLogBindings, message: string) =>
    entries.push({ fields: { ...bindings, ...fields }, message });
  return {
    child: (childBindings) => recordingLogger(entries, { ...bindings, ...childBindings }),
    debug: record,
    error: record,
    info: record,
    warn: record,
  };
}
