import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeDaemonRefreshService,
  registerDaemonRefreshServiceCommand,
} from "../commands/daemon/refresh-service.js";
import { channelConfig } from "../core/channel/config.js";
import { acquireDaemonOwner, inspectDaemonOwner } from "../core/daemon/ownership.js";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import {
  acquireProcessFileLease,
  inspectDarwinProcessIdentity,
  inspectProcessFileLease,
  inspectProcessIdentity,
  ProcessLeaseMalformedError,
  type ProcessLeaseRecord,
  ProcessLeaseUnverifiableError,
} from "../core/daemon/process-lease.js";
import * as serviceIndex from "../core/daemon/service/index.js";
import { createDaemonServiceManager } from "../core/daemon/service/index.js";
import { createLaunchdBackend, renderLaunchdPlist, renderLaunchdWrapper } from "../core/daemon/service/launchd.js";
import { buildServicePath, resolveCliInvocation } from "../core/daemon/service/shared.js";
import { createSystemdBackend, renderSystemdUnit } from "../core/daemon/service/systemd.js";
import type { CommandResult, DaemonServiceInfo, ServiceRunner } from "../core/daemon/service/types.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(path);
  return path;
}

function result(code: number, stdout: string, stderr: string): CommandResult {
  return { code, stderr, stdout, timedOut: false };
}

const TIMED_OUT: CommandResult = { code: null, stdout: "", stderr: "", timedOut: true };
const NOT_LOADED = result(113, "", "Could not find service in domain");

function fakeRunner(handler: (program: string, args: readonly string[]) => CommandResult | Promise<CommandResult>) {
  return {
    run: vi.fn(async (program: string, args: readonly string[]) => handler(program, args)),
  } satisfies ServiceRunner;
}

function calls(runner: ReturnType<typeof fakeRunner>): string[] {
  return runner.run.mock.calls.map(([program, args]) => `${program} ${args.join(" ")}`);
}

async function writeFileWithParents(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const INVOCATION = { args: [], program: "/usr/bin/opentag" };

async function systemdFixture(options: { home?: string; unit?: boolean } = {}) {
  const userHome = await temporaryDirectory("opentag-systemd-branches-user-");
  const home = options.home ?? (await temporaryDirectory("opentag-systemd-branches-home-"));
  const unitPath = join(userHome, ".config", "systemd", "user", "opentag.service");
  const unit = renderSystemdUnit({
    home,
    invocation: INVOCATION,
    path: buildServicePath(INVOCATION, "linux"),
    serviceId: "opentag",
  });
  if (options.unit !== false) await writeFileWithParents(unitPath, unit);
  return { userHome, home, unitPath, unit };
}

function systemdBackend(runner: ServiceRunner, fixture: { userHome: string; home: string }) {
  return createSystemdBackend({
    home: fixture.home,
    invocation: INVOCATION,
    runner,
    serviceId: "opentag",
    uid: 1000,
    userHome: fixture.userHome,
    username: "test",
  });
}

describe("systemd backend branches", () => {
  it.each([
    ["times out", TIMED_OUT, "MainPID query timed out"],
    ["exits non-zero", result(1, "", "unit lookup failed"), "unit lookup failed"],
    ["exits non-zero without output", result(1, "", ""), "MainPID query exited with code 1"],
    ["reports a non-numeric value", result(0, "abc", ""), "invalid MainPID"],
    ["reports zero", result(0, "0", ""), "invalid MainPID"],
  ])("reports an unknown state when the MainPID query %s", async (_label, pidResult, detail) => {
    const fixture = await systemdFixture();
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return pidResult;
      return result(0, "", "");
    });
    const info = await systemdBackend(runner, fixture).status();
    expect(info).toMatchObject({ state: "unknown", drifted: false, configuredHome: fixture.home });
    expect(info.detail).toContain(detail);
    expect(info.pid).toBeUndefined();
  });

  it("reports an unknown state when is-active fails with unexpected output", async () => {
    const fixture = await systemdFixture();
    const runner = fakeRunner((_, args) =>
      args.includes("is-active") ? result(4, "", "Failed to connect to bus") : result(0, "", ""),
    );
    const info = await systemdBackend(runner, fixture).status();
    expect(info).toMatchObject({ state: "unknown", detail: "Failed to connect to bus" });
  });

  it("fails installAndStart when the service never becomes active", async () => {
    const fixture = await systemdFixture();
    const runner = fakeRunner((program, args) => {
      if (program === "loginctl") return result(0, "", "");
      if (args.includes("is-active")) return result(3, "inactive", "");
      return result(0, "", "");
    });
    await expect(systemdBackend(runner, fixture).installAndStart()).rejects.toThrow("did not become active");
    expect(calls(runner)).toContain("systemctl --user start opentag.service");
  });

  it("starts an inactive unit once and leaves an active unit alone", async () => {
    const fixture = await systemdFixture();
    let active = false;
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return active ? result(0, "active", "") : result(3, "inactive", "");
      if (args.includes("MainPID")) return result(0, "4242", "");
      if (args.includes("start")) active = true;
      return result(0, "", "");
    });
    const backend = systemdBackend(runner, fixture);
    await expect(backend.start()).resolves.toMatchObject({ state: "active", pid: 4242 });
    expect(calls(runner).filter((call) => call === "systemctl --user start opentag.service")).toHaveLength(1);

    runner.run.mockClear();
    await expect(backend.start()).resolves.toMatchObject({ state: "active", pid: 4242 });
    expect(calls(runner)).not.toContain("systemctl --user start opentag.service");
  });

  it("refuses to start or restart a unit that is not installed", async () => {
    const fixture = await systemdFixture({ unit: false });
    const backend = systemdBackend(
      fakeRunner(() => result(0, "", "")),
      fixture,
    );
    await expect(backend.start()).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    await expect(backend.restart()).rejects.toMatchObject({ code: "NOT_INSTALLED" });
  });

  it("restarts an installed unit and reports the new main PID", async () => {
    const fixture = await systemdFixture();
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return result(0, "4243", "");
      return result(0, "", "");
    });
    await expect(systemdBackend(runner, fixture).restart()).resolves.toMatchObject({ state: "active", pid: 4243 });
    expect(calls(runner)).toContain("systemctl --user restart opentag.service");
  });

  it("removes the unit and reloads systemd once the service confirms it stopped", async () => {
    const fixture = await systemdFixture();
    const runner = fakeRunner((_, args) =>
      args.includes("is-active") ? result(3, "inactive", "") : result(0, "", ""),
    );
    const info = await systemdBackend(runner, fixture).uninstall();
    expect(info).toMatchObject({ state: "not-installed", drifted: true });
    await expect(access(fixture.unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    const sequence = calls(runner);
    expect(sequence.indexOf("systemctl --user disable --now opentag.service")).toBeLessThan(
      sequence.indexOf("systemctl --user daemon-reload"),
    );
  });
});

async function launchdFixture(options: { definitions?: boolean } = {}) {
  const userHome = await temporaryDirectory("opentag-launchd-branches-user-");
  const home = await temporaryDirectory("opentag-launchd-branches-home-");
  const plistPath = join(userHome, "Library", "LaunchAgents", "opentag.plist");
  const wrapperPath = resolveDaemonPaths(home).serviceWrapper("opentag");
  if (options.definitions !== false) {
    await writeFileWithParents(wrapperPath, renderLaunchdWrapper(INVOCATION));
    await writeFileWithParents(
      plistPath,
      renderLaunchdPlist({
        home,
        label: "opentag",
        path: buildServicePath(INVOCATION, "darwin"),
        stderrPath: resolveDaemonPaths(home).daemonStderrLog,
        stdoutPath: resolveDaemonPaths(home).daemonStdoutLog,
        wrapperPath,
      }),
    );
  }
  return { userHome, home, plistPath, wrapperPath };
}

function launchdBackend(runner: ServiceRunner, fixture: { userHome: string; home: string }) {
  return createLaunchdBackend({
    home: fixture.home,
    invocation: INVOCATION,
    runner,
    serviceId: "opentag",
    uid: 501,
    userHome: fixture.userHome,
    sleep: async () => undefined,
    activationAttempts: 2,
    evictionAttempts: 2,
  });
}

const TARGET = "gui/501/opentag";

describe("launchd backend branches", () => {
  it("fails activation when the status check times out after the plist disappeared", async () => {
    const fixture = await launchdFixture({ definitions: false });
    let enabled = false;
    const runner = fakeRunner(async (_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "enable") {
        enabled = true;
        await rm(fixture.plistPath);
        return result(0, "", "");
      }
      if (args[0] === "print") return enabled ? TIMED_OUT : NOT_LOADED;
      return result(0, "", "");
    });
    await expect(launchdBackend(runner, fixture).installAndStart()).rejects.toThrow(
      "launchd activation status check timed out",
    );
  });

  it("fails activation when the loaded service's status check times out", async () => {
    const fixture = await launchdFixture({ definitions: false });
    let enabled = false;
    const runner = fakeRunner((_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "enable") enabled = true;
      if (args[0] === "print") return enabled ? TIMED_OUT : NOT_LOADED;
      return result(0, "", "");
    });
    await expect(launchdBackend(runner, fixture).installAndStart()).rejects.toThrow(
      "launchd activation status check timed out",
    );
    await access(fixture.plistPath);
  });

  it("reports a bootstrap failure that persists across the retry", async () => {
    const fixture = await launchdFixture({ definitions: false });
    const runner = fakeRunner((_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") return NOT_LOADED;
      if (args[0] === "bootstrap") return result(5, "", "Input/output error");
      return result(0, "", "");
    });
    await expect(launchdBackend(runner, fixture).installAndStart()).rejects.toThrow(
      "launchd bootstrap failed: Input/output error",
    );
    expect(calls(runner).filter((call) => call.startsWith("launchctl bootstrap"))).toHaveLength(2);
  });

  it("fails start when the loaded-state check times out or fails", async () => {
    for (const [loaded, message] of [
      [TIMED_OUT, "launchd start state check timed out"],
      [result(1, "", "Bad request"), "launchd start state check failed: Bad request"],
    ] as const) {
      const fixture = await launchdFixture();
      let prints = 0;
      const runner = fakeRunner((_, args) => {
        if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
        if (args[0] === "print" && args[1] === TARGET) {
          prints += 1;
          return prints === 1 ? NOT_LOADED : loaded;
        }
        return result(0, "", "");
      });
      await expect(launchdBackend(runner, fixture).start()).rejects.toThrow(message);
    }
  });

  it("stops a loaded service and reports the evicted status", async () => {
    const fixture = await launchdFixture();
    const runner = fakeRunner((_, args) => (args[0] === "print" ? NOT_LOADED : result(0, "", "")));
    const info = await launchdBackend(runner, fixture).stop();
    expect(info).toMatchObject({ state: "inactive", configuredHome: fixture.home, drifted: false });
    expect(calls(runner)).toContain(`launchctl bootout ${TARGET}`);
  });
});

describe("daemon service manager branches", () => {
  async function systemdManager(runner: ServiceRunner, fixture: { userHome: string; home: string }) {
    return createDaemonServiceManager({
      home: fixture.home,
      invocation: INVOCATION,
      platform: "linux",
      runner,
      uid: 1000,
      userHome: fixture.userHome,
      username: "test",
    });
  }

  async function channelSystemdFixture() {
    const userHome = await temporaryDirectory("opentag-manager-branches-user-");
    const home = await temporaryDirectory("opentag-manager-branches-home-");
    const unitPath = join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`);
    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({
        home,
        invocation: INVOCATION,
        path: buildServicePath(INVOCATION, "linux"),
        serviceId: channelConfig.serviceId,
      }),
    );
    return { userHome, home, unitPath };
  }

  it("refreshes the definition through the manager's mutation guard", async () => {
    const fixture = await channelSystemdFixture();
    // Drift only the PATH so the unit still exposes the OPENTAG_HOME the manager verifies first.
    await writeFile(
      fixture.unitPath,
      renderSystemdUnit({
        home: fixture.home,
        invocation: INVOCATION,
        path: "/drifted/bin",
        serviceId: channelConfig.serviceId,
      }),
    );
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return result(0, "4242", "");
      return result(0, "", "");
    });
    const manager = await systemdManager(runner, fixture);
    const info = await manager.refreshDefinition();
    expect(info).toMatchObject({ state: "active", pid: 4242, runtimeOwner: { consistency: "missing" } });
    expect(await readFile(fixture.unitPath, "utf8")).not.toContain("/drifted/bin");
    expect(calls(runner)).toContain("systemctl --user daemon-reload");
  });

  it("fails stop when the service stays active", async () => {
    const fixture = await channelSystemdFixture();
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return result(0, "4242", "");
      return result(0, "", "");
    });
    const manager = await systemdManager(runner, fixture);
    await expect(manager.stop()).rejects.toThrow("did not reach a stopped state");
    expect(calls(runner)).toContain(`systemctl --user stop ${channelConfig.serviceId}.service`);
  });

  it("reports a consistent runtime owner when the service PID matches the live owner", async () => {
    const fixture = await channelSystemdFixture();
    const owner = await acquireDaemonOwner(fixture.home, "instance");
    try {
      const runner = fakeRunner((_, args) => {
        if (args.includes("is-active")) return result(0, "active", "");
        if (args.includes("MainPID")) return result(0, String(process.pid), "");
        return result(0, "", "");
      });
      const manager = await systemdManager(runner, fixture);
      await expect(manager.status()).resolves.toMatchObject({
        state: "active",
        runtimeOwner: { consistency: "consistent", pid: process.pid },
      });
    } finally {
      await owner.release();
    }
  });
});

describe("daemon refresh-service command wiring", () => {
  const info: DaemonServiceInfo = {
    currentHome: "/tmp/home",
    definitionPath: "/tmp/unit",
    logHint: "journal",
    platform: "systemd",
    serviceId: "opentag-staging",
    state: "active",
  };

  it("builds the default manager when none is injected", async () => {
    const create = vi
      .spyOn(serviceIndex, "createDaemonServiceManager")
      .mockResolvedValue({ refreshDefinition: async () => info } as serviceIndex.DaemonServiceManager);
    const outputs: string[] = [];
    expect(await executeDaemonRefreshService({ writeOutput: (message) => outputs.push(message) })).toBe(0);
    expect(create).toHaveBeenCalledOnce();
    expect(outputs.join("\n")).toContain("State: active");
  });

  it("runs through Commander and records the exit code", async () => {
    vi.spyOn(serviceIndex, "createDaemonServiceManager").mockResolvedValue({
      refreshDefinition: async () => info,
    } as serviceIndex.DaemonServiceManager);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command().name("opentag");
    registerDaemonRefreshServiceCommand(program.command("daemon"));
    await program.parseAsync(["node", "opentag", "daemon", "refresh-service"]);
    expect(process.exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Service: opentag-staging"));
  });
});

interface TestLease extends ProcessLeaseRecord {
  leaseId: string;
}

function leaseOptions(
  getProcessIdentity: (
    pid: number,
  ) => Promise<{ id: string; state: "identified" } | { state: "gone" | "unverifiable" }>,
) {
  return {
    createRecord: (processStartId: string): TestLease => ({
      leaseId: "lease-1",
      pid: process.pid,
      processStartId,
      startedAt: new Date().toISOString(),
    }),
    fileName: "lease.json",
    getId: (record: TestLease) => record.leaseId,
    parseRecord: (value: unknown) => value as TestLease,
    getProcessIdentity,
  };
}

describe("process lease branches", () => {
  const selfIdentity = async (pid: number) =>
    pid === process.pid ? ({ id: "self", state: "identified" } as const) : ({ state: "unverifiable" } as const);

  it("refuses takeover when the acquisition guard holder cannot be verified", async () => {
    const home = await temporaryDirectory("opentag-lease-guard-");
    await writeFile(
      join(home, ".lease.json.acquire"),
      JSON.stringify({ guardId: "g", pid: 2_147_483_647, processStartId: "other", startedAt: "2024-01-01T00:00:00Z" }),
      { mode: 0o600 },
    );
    await expect(acquireProcessFileLease(home, leaseOptions(selfIdentity))).rejects.toThrow(
      new ProcessLeaseUnverifiableError(
        `Cannot verify the process holding the acquisition guard at ${join(home, ".lease.json.acquire")}; refusing takeover`,
      ),
    );
  });

  it.each([
    ["[]"],
    ['"guard"'],
    ["null"],
    [JSON.stringify({ guardId: 1, pid: 1, processStartId: "x", startedAt: "" })],
  ])("rejects a malformed acquisition guard %s", async (guard) => {
    const home = await temporaryDirectory("opentag-lease-guard-malformed-");
    await writeFile(join(home, ".lease.json.acquire"), guard, { mode: 0o600 });
    await expect(acquireProcessFileLease(home, leaseOptions(selfIdentity))).rejects.toThrow(
      new ProcessLeaseMalformedError("The process lease acquisition guard is malformed"),
    );
  });

  it("rejects a lease path that is not a regular file", async () => {
    const home = await temporaryDirectory("opentag-lease-directory-");
    await mkdir(join(home, "lease.json"));
    await expect(inspectProcessFileLease(home, leaseOptions(selfIdentity))).rejects.toThrow(
      "must be a real regular file",
    );
  });

  it("dispatches darwin identity inspection through the injected inspector", async () => {
    const inspectDarwin = vi.fn(async () => ({ id: "darwin:start", state: "identified" as const }));
    await expect(
      inspectProcessIdentity(4242, { platform: "darwin", isProcessAlive: () => true, inspectDarwin }),
    ).resolves.toEqual({ id: "darwin:start", state: "identified" });
    expect(inspectDarwin).toHaveBeenCalledExactlyOnceWith(4242);
  });

  it("classifies darwin processes without a readable start time by liveness", async () => {
    const readProcessStart = vi.fn(async () => undefined);
    await expect(inspectDarwinProcessIdentity(4242, { readProcessStart, isProcessAlive: () => true })).resolves.toEqual(
      { state: "unverifiable" },
    );
    await expect(
      inspectDarwinProcessIdentity(4242, { readProcessStart, isProcessAlive: () => false }),
    ).resolves.toEqual({ state: "gone" });
    expect(readProcessStart).toHaveBeenCalledWith(4242, expect.objectContaining({ LANG: "C", LC_ALL: "C", TZ: "UTC" }));
  });
});

describe("daemon owner record shapes", () => {
  it.each([["[]\n"], ['"owner"\n'], ["null\n"]])("fails closed on a non-object owner record %j", async (record) => {
    const home = await temporaryDirectory("opentag-owner-shape-");
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.daemonState, { mode: 0o700, recursive: true });
    await writeFile(paths.daemonOwner, record, { mode: 0o600 });
    await expect(inspectDaemonOwner(home)).rejects.toMatchObject({ code: "MALFORMED" });
  });
});

describe("CLI invocation resolution fallbacks", () => {
  it("keeps non-existent script and executable paths when they cannot be canonicalized", async () => {
    await expect(
      resolveCliInvocation({
        binName: "missing-opentag",
        env: { PATH: "" },
        argv: ["node", "/nonexistent/opentag/index.mjs"],
        execPath: "/nonexistent/node/bin/node",
      }),
    ).resolves.toEqual({ args: ["/nonexistent/opentag/index.mjs"], program: "/nonexistent/node/bin/node" });
  });
});
