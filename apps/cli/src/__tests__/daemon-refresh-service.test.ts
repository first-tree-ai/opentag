import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeDaemonRefreshService } from "../commands/daemon/refresh-service.js";
import { channelConfig } from "../core/channel/config.js";
import { SUPERVISOR_RESTART_EXIT_CODE } from "../core/daemon/handoff.js";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import { createLaunchdBackend, renderLaunchdPlist, renderLaunchdWrapper } from "../core/daemon/service/launchd.js";
import { buildServicePath } from "../core/daemon/service/shared.js";
import { createSystemdBackend, renderSystemdUnit } from "../core/daemon/service/systemd.js";
import type { CommandResult, ServiceRunner } from "../core/daemon/service/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function result(code: number, stdout: string, stderr: string): CommandResult {
  return { code, stderr, stdout, timedOut: false };
}

function fakeRunner(handler: (program: string, args: readonly string[]) => CommandResult = () => result(0, "", "")) {
  return {
    run: vi.fn(async (program: string, args: readonly string[]) => handler(program, args)),
  } satisfies ServiceRunner;
}

describe("reserved supervisor restart exit code", () => {
  it("is a clean forced restart in the systemd unit and a plain KeepAlive exit on launchd", () => {
    expect(SUPERVISOR_RESTART_EXIT_CODE).toBe(75);
    const unit = renderSystemdUnit({
      home: "/home/test/.opentag-staging",
      invocation: { args: [], program: "/home/test/.local/bin/opentag-staging" },
      path: "/usr/bin:/bin",
      serviceId: "opentag-staging",
    });
    expect(unit).toContain("SuccessExitStatus=0 75");
    expect(unit).toContain("RestartForceExitStatus=75");
    expect(unit).toContain("Restart=on-failure");

    // launchd restarts any unsuccessful exit already; the wrapper keeps resolving the stable shim.
    const wrapper = renderLaunchdWrapper({ args: [], program: "/home/test/.local/bin/opentag-staging" });
    expect(wrapper).toContain("opentag-staging");
    const plist = renderLaunchdPlist({
      home: "/Users/test/.opentag-staging",
      label: "opentag-staging",
      path: "/usr/bin:/bin",
      stderrPath: "/tmp/err.log",
      stdoutPath: "/tmp/out.log",
      wrapperPath: "/tmp/wrapper",
    });
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
  });
});

describe("systemd refreshDefinition", () => {
  it("rewrites a drifted unit and reloads systemd without restarting the service", async () => {
    const userHome = await tempDir("opentag-systemd-refresh-user-");
    const home = await tempDir("opentag-systemd-refresh-home-");
    const invocation = { args: [], program: "/home/test/.local/bin/opentag-staging" };
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return result(0, "4242", "");
      return result(0, "", "");
    });
    const backend = createSystemdBackend({
      home,
      invocation,
      runner,
      serviceId: channelConfig.serviceId,
      uid: 1000,
      userHome,
      username: "test",
    });
    const unitPath = join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`);

    await expect(backend.refreshDefinition()).rejects.toThrow("not installed");

    await mkdir(join(userHome, ".config", "systemd", "user"), { recursive: true });
    await writeFile(unitPath, "[Unit]\nDescription=drifted\n");
    const info = await backend.refreshDefinition();
    expect(info.state).toBe("active");
    const rewritten = await readFile(unitPath, "utf8");
    expect(rewritten).toBe(
      renderSystemdUnit({
        home,
        invocation,
        path: buildServicePath(invocation, "linux"),
        serviceId: channelConfig.serviceId,
      }),
    );
    const daemonReloads = runner.run.mock.calls.filter(([, args]) => args.includes("daemon-reload"));
    expect(daemonReloads).toHaveLength(1);
    const restarts = runner.run.mock.calls.filter(
      ([, args]) => args.includes("restart") || (args.includes("start") && !args.includes("is-active")),
    );
    expect(restarts).toHaveLength(0);

    const withToken = rewritten.replace(
      "[Install]",
      'Environment="CLAUDE_CODE_OAUTH_TOKEN=synthetic-token"\n\n[Install]',
    );
    await writeFile(unitPath, withToken);
    const refreshed = await backend.refreshDefinition();
    expect(refreshed.drifted).toBe(false);
    expect((await stat(unitPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(unitPath, "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN=synthetic-token");
    await backend.installAndStart();
    expect(await readFile(unitPath, "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN=synthetic-token");

    // An unchanged legacy definition still needs private permissions, without a reload.
    runner.run.mockClear();
    const stable = await readFile(unitPath, "utf8");
    await chmod(unitPath, 0o644);
    await backend.refreshDefinition();
    expect((await stat(unitPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(unitPath, "utf8")).toBe(stable);
    expect(runner.run.mock.calls.filter(([, args]) => args.includes("daemon-reload"))).toHaveLength(0);
  });
});

describe("launchd refreshDefinition", () => {
  it("rewrites the plist and wrapper without bootout or bootstrap", async () => {
    const userHome = await tempDir("opentag-launchd-refresh-user-");
    const home = await tempDir("opentag-launchd-refresh-home-");
    const invocation = { args: [], program: "/Users/test/.local/bin/opentag-staging" };
    let loaded = true;
    const runner = fakeRunner((_, args) => {
      switch (args[0]) {
        case "bootout":
          loaded = false;
          break;
        case "bootstrap":
          loaded = true;
          break;
        case "print":
          if (args[1] === "gui/1000") return result(0, "domain", "");
          return loaded ? result(0, "pid = 4242\nstate = running\n", "") : result(113, "", "Could not find service");
      }
      return result(0, "", "");
    });
    const backend = createLaunchdBackend({
      home,
      invocation,
      runner,
      serviceId: channelConfig.serviceId,
      uid: 1000,
      userHome,
    });
    const plistPath = join(userHome, "Library", "LaunchAgents", `${channelConfig.serviceId}.plist`);
    const wrapperPath = resolveDaemonPaths(home).serviceWrapper(channelConfig.serviceId);

    await expect(backend.refreshDefinition()).rejects.toThrow("not installed");

    await mkdir(join(userHome, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, "<plist>drifted</plist>");
    const info = await backend.refreshDefinition();
    expect(info.state).toBe("active");
    expect(await readFile(plistPath, "utf8")).toContain("ProgramArguments");
    expect(await readFile(wrapperPath, "utf8")).toBe(renderLaunchdWrapper(invocation));
    const supervisorMutations = runner.run.mock.calls.filter(([, args]) =>
      ["bootout", "bootstrap", "kickstart", "enable"].includes(String(args[0])),
    );
    expect(supervisorMutations).toHaveLength(0);

    const withToken = (await readFile(plistPath, "utf8")).replace(
      "<key>PATH</key>",
      "<key>CLAUDE_CODE_OAUTH_TOKEN</key><string>synthetic-token</string>\n    <key>PATH</key>",
    );
    await writeFile(plistPath, withToken);
    const refreshed = await backend.refreshDefinition();
    expect(refreshed.drifted).toBe(false);
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(plistPath, "utf8")).toContain("<string>synthetic-token</string>");
    await backend.installAndStart();
    expect(await readFile(plistPath, "utf8")).toContain("<string>synthetic-token</string>");

    // Preserve an unchanged credential-bearing plist while migrating its old public mode.
    runner.run.mockClear();
    const stable = await readFile(plistPath, "utf8");
    await chmod(plistPath, 0o644);
    await backend.refreshDefinition();
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(plistPath, "utf8")).toBe(stable);
    expect(runner.run.mock.calls.filter(([, args]) => ["bootout", "bootstrap"].includes(String(args[0])))).toHaveLength(
      0,
    );
  });
});

describe("daemon refresh-service command", () => {
  it("reports success and failure through the manager", async () => {
    const outputs: string[] = [];
    const errors: string[] = [];
    const ok = await executeDaemonRefreshService({
      manager: {
        refreshDefinition: async () => ({
          currentHome: "/tmp/home",
          definitionPath: "/tmp/unit",
          logHint: "journal",
          platform: "systemd" as const,
          serviceId: "opentag-staging",
          state: "active" as const,
        }),
      },
      writeOutput: (message) => outputs.push(message),
      writeError: (message) => errors.push(message),
    });
    expect(ok).toBe(0);
    expect(outputs.join("\n")).toContain("State: active");

    const failed = await executeDaemonRefreshService({
      manager: {
        refreshDefinition: async () => {
          throw new Error("not installed");
        },
      },
      writeOutput: (message) => outputs.push(message),
      writeError: (message) => errors.push(message),
    });
    expect(failed).toBe(1);
    expect(errors.join("\n")).toContain("INTERNAL_ERROR: not installed");
  });
});
