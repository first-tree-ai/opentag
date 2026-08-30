import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentials, writeMachineCredentialsAtomically } from "@opentag/client";
import { getChannelConfig } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelConfig } from "../core/channel/config.js";
import { acquireDaemonOwner } from "../core/daemon/ownership.js";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import { createDaemonServiceManager, formatDaemonServiceInfo } from "../core/daemon/service/index.js";
import { createLaunchdBackend, renderLaunchdPlist, renderLaunchdWrapper } from "../core/daemon/service/launchd.js";
import { buildServicePath } from "../core/daemon/service/shared.js";
import { createSystemdBackend, renderSystemdUnit } from "../core/daemon/service/systemd.js";
import type { CommandResult, ServiceRunner } from "../core/daemon/service/types.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("systemd service backend", () => {
  it("formats complete service information and exposes unsupported platform behavior", async () => {
    expect(
      formatDaemonServiceInfo({
        currentHome: "/tmp/home",
        definitionPath: "/tmp/unit",
        detail: "needs attention",
        drifted: true,
        logHint: "journal",
        pid: 42,
        platform: "systemd",
        runtimeOwner: { consistency: "consistent", pid: 42 },
        serviceId: "opentag",
        state: "active",
        configuredHome: "/tmp/home",
      }),
    ).toContain("Runtime owner: 42/consistent");
    expect(
      formatDaemonServiceInfo({
        currentHome: "/tmp/home",
        definitionPath: "/tmp/unit",
        drifted: false,
        logHint: "journal",
        platform: "unsupported",
        runtimeOwner: undefined,
        serviceId: "opentag",
        state: "unknown",
      }),
    ).toContain("Runtime owner: missing");

    const home = await temporaryDirectory("opentag-unsupported-home-");
    const userHome = await temporaryDirectory("opentag-unsupported-user-");
    const manager = await createDaemonServiceManager({
      home,
      invocation: { args: [], program: "/usr/bin/opentag" },
      platform: "freebsd",
      runner: fakeRunner(),
      userHome,
      uid: 1000,
      username: "test",
    });
    await expect(manager.status()).resolves.toMatchObject({ platform: "unsupported", state: "unknown" });
    await expect(manager.preflight()).rejects.toThrow("supports Linux and macOS only");
    await expect(manager.installAndStart()).rejects.toThrow("supports Linux and macOS only");
    await expect(manager.start()).rejects.toThrow("does not expose a verifiable OPENTAG_HOME");
  });

  it("rejects invalid and unenrolled machine credentials before service mutation", async () => {
    const userHome = await temporaryDirectory("opentag-invalid-credentials-user-");
    const home = await temporaryDirectory("opentag-invalid-credentials-home-");
    const runner = fakeRunner((_, args) =>
      args.includes("show-environment") ? result(0, "", "") : result(3, "inactive", ""),
    );
    const manager = await createDaemonServiceManager({
      home,
      invocation: { args: [], program: "/usr/bin/opentag" },
      platform: "linux",
      runner,
      uid: 1000,
      userHome,
      username: "test",
    });
    await expect(manager.installAndStart()).rejects.toThrow("not enrolled");
    await writeFileWithParents(`${resolveDaemonPaths(home).config}/computer-credentials.json`, "malformed");
    await expect(manager.installAndStart()).rejects.toThrow("credentials are invalid");
  });

  it("refuses mutation when the daemon owner record is malformed", async () => {
    const userHome = await temporaryDirectory("opentag-owner-malformed-user-");
    const home = await temporaryDirectory("opentag-owner-malformed-home-");
    const unitPath = join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`);
    const invocation = { args: [], program: "/usr/bin/opentag" };
    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({
        home,
        invocation,
        path: buildServicePath(invocation, "linux"),
        serviceId: channelConfig.serviceId,
      }),
    );
    await writeFileWithParents(resolveDaemonPaths(home).daemonOwner, "{}\n");
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return result(0, "42", "");
      return result(0, "", "");
    });
    const manager = await createDaemonServiceManager({
      home,
      invocation,
      platform: "linux",
      runner,
      uid: 1000,
      userHome,
      username: "test",
    });
    await expect(manager.start()).rejects.toThrow("owner record is malformed");
  });
  it("renders a user unit with an absolute hidden entry and no secrets", () => {
    const unit = renderSystemdUnit({
      home: "/Users/Test Home/.opentag-dev%1",
      invocation: { args: ["/app/index.mjs"], program: "/usr/bin/node" },
      path: "/usr/bin:/bin",
      serviceId: "opentag-dev",
    });
    expect(unit).toContain('ExecStart="/usr/bin/node" "/app/index.mjs" "daemon" "service-run"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("OPENTAG_HOME=/Users/Test Home/.opentag-dev%%1");
    expect(unit).not.toMatch(/access|refresh|secret-token/iu);
  });

  it("fails preflight for root without invoking systemctl", async () => {
    const runner = fakeRunner();
    const backend = createSystemdBackend({
      home: "/tmp/home",
      invocation: { args: [], program: "/usr/bin/opentag" },
      runner,
      serviceId: "opentag",
      uid: 0,
      userHome: "/tmp/user",
      username: "root",
    });
    await expect(backend.preflight()).rejects.toThrow("non-root");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("ignores the invoking shell XDG_CONFIG_HOME when locating the account service definition", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-account-home-");
    const shellXdgConfigHome = await temporaryDirectory("opentag-systemd-shell-xdg-");
    const home = await temporaryDirectory("opentag-systemd-home-");
    const invocation = { args: [], program: "/usr/bin/opentag" };
    const unitPath = join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`);
    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({
        home,
        invocation,
        path: buildServicePath(invocation, "linux"),
        serviceId: channelConfig.serviceId,
      }),
    );
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return result(0, "321", "");
      if (args.includes("LoadState")) return result(0, "not-found", "");
      return result(0, "", "");
    });
    const manager = await createDaemonServiceManager({
      env: { PATH: "/usr/bin", XDG_CONFIG_HOME: shellXdgConfigHome },
      home,
      invocation,
      platform: "linux",
      runner,
      uid: 1000,
      userHome,
      username: "test",
    });

    await expect(manager.status()).resolves.toMatchObject({
      definitionPath: unitPath,
      pid: 321,
      state: "active",
    });
  });

  it("keeps the unit when systemd disable fails during uninstall", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-");
    const unitPath = join(userHome, ".config", "systemd", "user", "opentag.service");
    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({
        home: "/tmp/home",
        invocation: { args: [], program: "/usr/bin/opentag" },
        path: "/usr/bin:/bin",
        serviceId: "opentag",
      }),
    );
    const runner = fakeRunner((_, args) =>
      args.includes("disable") ? result(1, "", "permission denied") : result(0, "inactive", ""),
    );
    const backend = createSystemdBackend({
      home: "/tmp/home",
      invocation: { args: [], program: "/usr/bin/opentag" },
      runner,
      serviceId: "opentag",
      uid: 1000,
      userHome,
      username: "test",
    });
    await expect(backend.uninstall()).rejects.toThrow("permission denied");
    expect(await readFile(unitPath, "utf8")).toContain("opentag");
  });

  it("installs, enables, starts, and reports a linger recovery hint", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-");
    let active = false;
    const calls: string[] = [];
    const runner = fakeRunner((program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "loginctl") return result(1, "", "permission denied");
      if (args.includes("show-environment")) return result(0, "", "");
      if (args.includes("LoadState")) return result(0, "not-found", "");
      if (args.includes("is-active")) return active ? result(0, "active", "") : result(3, "inactive", "");
      if (args.includes("start")) active = true;
      if (args.includes("MainPID")) return result(0, "321", "");
      return result(0, "", "");
    });
    const backend = createSystemdBackend({
      home: "/tmp/opentag home",
      invocation: { args: [], program: "/usr/bin/opentag" },
      runner,
      serviceId: "opentag",
      uid: 1000,
      userHome,
      username: "test",
    });
    const info = await backend.installAndStart();
    expect(info).toMatchObject({ pid: 321, state: "active" });
    expect(info.logHint).toBe("/tmp/opentag home/logs/client.log (fallback: journalctl --user -u opentag.service -f)");
    expect(info.detail).toContain("enable lingering manually");
    expect(calls).toEqual(
      expect.arrayContaining([
        "systemctl --user daemon-reload",
        "systemctl --user enable opentag.service",
        "systemctl --user start opentag.service",
        "loginctl enable-linger test",
      ]),
    );
  });

  it("renders the service with the newly installed binary before a stale PATH shim", async () => {
    const root = await temporaryDirectory("opentag-systemd-path-");
    const userHome = join(root, "user");
    const home = join(root, "home");
    const installedBin = join(root, "installed-bin");
    const staleBin = join(root, "stale-bin");
    const installedCli = join(installedBin, channelConfig.binName);
    const staleCli = join(staleBin, channelConfig.binName);
    await Promise.all([
      writeFileWithParents(installedCli, "#!/usr/bin/env node\n"),
      writeFileWithParents(staleCli, "#!/usr/bin/env node\n"),
    ]);
    await Promise.all([chmod(installedCli, 0o755), chmod(staleCli, 0o755)]);
    await writeMachineCredential(home);
    expect(await readCredentials(home)).toBeUndefined();
    let active = false;
    const runner = fakeRunner((program, args) => {
      if (program === "loginctl") return result(0, "", "");
      if (args.includes("show-environment")) return result(0, "", "");
      if (args.includes("LoadState")) return result(0, "not-found", "");
      if (args.includes("is-active")) return active ? result(0, "active", "") : result(3, "inactive", "");
      if (args.includes("start")) active = true;
      if (args.includes("MainPID")) return result(0, "321", "");
      return result(0, "", "");
    });
    const manager = await createDaemonServiceManager({
      env: { PATH: `${installedBin}:${staleBin}` },
      home,
      platform: "linux",
      runner,
      uid: 1000,
      userHome,
      username: "test",
    });

    await expect(manager.installAndStart()).resolves.toMatchObject({ state: "active" });
    const unit = await readFile(
      join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`),
      "utf8",
    );
    expect(unit).toContain(`ExecStart="${installedCli}" "daemon" "service-run"`);
    expect(unit).not.toContain(staleCli);
    expect(unit).toContain(staleBin);
    expect(unit.indexOf(installedBin)).toBeLessThan(unit.indexOf(staleBin));
  });

  it("detects and reconciles an active service whose PATH predates user-directory inheritance", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-path-drift-");
    const home = await temporaryDirectory("opentag-systemd-home-");
    const invocation = { args: [], program: "/opt/opentag/bin/opentag" };
    const unitPath = join(userHome, ".config", "systemd", "user", "opentag.service");
    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({
        home,
        invocation,
        path: buildServicePath(invocation, "linux"),
        serviceId: "opentag",
      }),
    );
    const runner = fakeRunner((program, args) => {
      if (program === "loginctl" || args.includes("show-environment")) return result(0, "", "");
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return result(0, "321", "");
      return result(0, "", "");
    });
    const backend = createSystemdBackend({
      home,
      invocation,
      runner,
      serviceId: "opentag",
      sourcePath: "/home/test/.local/bin:/usr/bin",
      uid: 1000,
      userHome,
      username: "test",
    });

    await expect(backend.status()).resolves.toMatchObject({ drifted: true, state: "active" });
    await expect(backend.installAndStart()).resolves.toMatchObject({ drifted: false, state: "active" });
    expect(runner.run).toHaveBeenCalledWith("systemctl", ["--user", "restart", "opentag.service"], expect.any(Object));
    await expect(readFile(unitPath, "utf8")).resolves.toContain("/home/test/.local/bin");
  });

  it.each([
    ["a timed out MainPID query", { code: null, stderr: "", stdout: "", timedOut: true }],
    ["a failed MainPID query", result(1, "", "manager unavailable")],
    ["an invalid MainPID", result(0, "0", "")],
  ])("reports active systemd state as unknown after %s", async (_label, pidResult) => {
    const userHome = await temporaryDirectory("opentag-systemd-");
    const unitPath = join(userHome, ".config", "systemd", "user", "opentag.service");
    const invocation = { args: [], program: "/usr/bin/opentag" };
    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({
        home: "/tmp/home",
        invocation,
        path: buildServicePath(invocation, "linux"),
        serviceId: "opentag",
      }),
    );
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return pidResult;
      return result(0, "", "");
    });
    const backend = createSystemdBackend({
      home: "/tmp/home",
      invocation,
      runner,
      serviceId: "opentag",
      uid: 1000,
      userHome,
      username: "test",
    });

    await expect(backend.status()).resolves.toMatchObject({ state: "unknown" });
    expect((await backend.status()).detail).toBeTruthy();
  });

  it.each([
    ["orphaned timeout", { code: null, stdout: "", stderr: "", timedOut: true }, "definition-less service target"],
    ["orphaned loaded", result(0, "loaded", ""), "service target loaded"],
    ["orphaned manager error", result(1, "", "manager denied"), "manager denied"],
  ] as const)("reports a definition-less systemd target as unknown after %s", async (_label, response, detail) => {
    const userHome = await temporaryDirectory("opentag-systemd-orphan-");
    const runner = fakeRunner((_, args) => (args.includes("LoadState") ? response : result(0, "", "")));
    const backend = createSystemdBackend({
      home: "/tmp/systemd-orphan",
      invocation: { args: [], program: "/usr/bin/opentag" },
      runner,
      serviceId: "opentag",
      uid: 1000,
      userHome,
      username: "test",
    });
    await expect(backend.status()).resolves.toMatchObject({
      state: response.code === 0 && response.stdout === "not-found" ? "not-installed" : "unknown",
    });
    if (response.stdout !== "not-found") expect((await backend.status()).detail).toContain(detail);
  });

  it("covers systemd definition, manager, and inactive-state diagnostics", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-status-");
    const unitPath = join(userHome, ".config", "systemd", "user", "opentag.service");
    const invocation = { args: [], program: "/usr/bin/opentag" };
    await writeFileWithParents(unitPath, "[Service]\nExecStart=/bin/true\n");
    const invalidRunner = fakeRunner(() => result(0, "active", ""));
    const invalidBackend = createSystemdBackend({
      home: "/tmp/home",
      invocation,
      runner: invalidRunner,
      serviceId: "opentag",
      uid: 1000,
      userHome,
      username: "test",
    });
    await expect(invalidBackend.status()).resolves.toMatchObject({ state: "unknown", drifted: true });

    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({
        home: "/tmp/home",
        invocation,
        path: buildServicePath(invocation, "linux"),
        serviceId: "opentag",
      }),
    );
    const cases: Array<[string, CommandResult, string]> = [
      ["active timeout", { code: null, stdout: "", stderr: "", timedOut: true }, "timed out"],
      ["active failure", result(1, "unexpected", "manager denied"), "manager denied"],
      ["inactive", result(3, "deactivating", ""), "inactive"],
    ];
    for (const [label, activeResult, expected] of cases) {
      const runner = fakeRunner((_, args) => (args.includes("is-active") ? activeResult : result(0, "", "")));
      const backend = createSystemdBackend({
        home: "/tmp/home",
        invocation,
        runner,
        serviceId: "opentag",
        uid: 1000,
        userHome,
        username: "test",
      });
      const info = await backend.status();
      expect(info.state, label).toBe(expected === "inactive" ? "inactive" : "unknown");
      if (expected !== "inactive") expect(info.detail).toBeTruthy();
    }
  });

  it("handles systemd preflight, missing installation, and uninstall stop verification failures", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-ops-");
    const invocation = { args: [], program: "/usr/bin/opentag" };
    const unavailable = createSystemdBackend({
      home: "/tmp/home",
      invocation,
      runner: fakeRunner((_, args) =>
        args.includes("show-environment") ? result(1, "", "not running") : result(0, "", ""),
      ),
      serviceId: "opentag",
      uid: 1000,
      userHome,
      username: "test",
    });
    await expect(unavailable.preflight()).rejects.toThrow("not running");
    const missingRunner = fakeRunner();
    const missing = createSystemdBackend({
      home: "/tmp/home",
      invocation,
      runner: missingRunner,
      serviceId: "opentag",
      uid: 1000,
      userHome,
      username: "test",
    });
    await expect(missing.start()).rejects.toThrow("not installed");
    await expect(missing.restart()).rejects.toThrow("not installed");
    await expect(missing.stop()).resolves.toMatchObject({ state: "not-installed" });
    await expect(missing.uninstall()).resolves.toMatchObject({ state: "not-installed" });

    const unitPath = join(userHome, ".config", "systemd", "user", "opentag.service");
    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({ home: "/tmp/home", invocation, path: "/usr/bin", serviceId: "opentag" }),
    );
    for (const afterStop of [
      { code: 0, stdout: "active", stderr: "", timedOut: false },
      { code: null, stdout: "", stderr: "", timedOut: true },
      result(3, "deactivating", ""),
    ]) {
      const runner = fakeRunner((_, args) => {
        if (args.includes("disable")) return result(0, "", "");
        if (args.includes("is-active")) return afterStop;
        return result(0, "", "");
      });
      const backend = createSystemdBackend({
        home: "/tmp/home",
        invocation,
        runner,
        serviceId: "opentag",
        uid: 1000,
        userHome,
        username: "test",
      });
      await expect(backend.uninstall()).rejects.toThrow("did not confirm");
    }
  });

  it("restarts an already active current systemd unit without issuing start", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-current-");
    const invocation = { args: [], program: "/usr/bin/opentag" };
    const unitPath = join(userHome, ".config", "systemd", "user", "opentag.service");
    const expected = renderSystemdUnit({
      home: "/tmp/home",
      invocation,
      path: buildServicePath(invocation, "linux"),
      serviceId: "opentag",
    });
    await writeFileWithParents(unitPath, expected);
    const calls: string[] = [];
    const runner = fakeRunner((program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (args.includes("show-environment")) return result(0, "", "");
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return result(0, "123", "");
      if (program === "loginctl") return result(0, "", "");
      return result(0, "", "");
    });
    const backend = createSystemdBackend({
      home: "/tmp/home",
      invocation,
      runner,
      serviceId: "opentag",
      uid: 1000,
      userHome,
      username: "test",
    });
    await expect(backend.installAndStart()).resolves.toMatchObject({ state: "active", pid: 123, drifted: false });
    expect(calls).not.toContain("systemctl --user start opentag.service");
    expect(calls).not.toContain("systemctl --user restart opentag.service");
  });

  it("refuses non-stop mutation when systemd cannot verify a live owner's PID", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-");
    const home = await temporaryDirectory("opentag-systemd-home-");
    const unitPath = join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`);
    const invocation = { args: [], program: "/usr/bin/opentag" };
    await writeFileWithParents(
      unitPath,
      renderSystemdUnit({
        home,
        invocation,
        path: buildServicePath(invocation, "linux"),
        serviceId: channelConfig.serviceId,
      }),
    );
    const runner = fakeRunner((_, args) => {
      if (args.includes("is-active")) return result(0, "active", "");
      if (args.includes("MainPID")) return { code: null, stderr: "", stdout: "", timedOut: true };
      return result(0, "", "");
    });
    const owner = await acquireDaemonOwner(home, "instance");
    try {
      const manager = await createDaemonServiceManager({
        home,
        invocation,
        platform: "linux",
        runner,
        uid: 1000,
        userHome,
        username: "test",
      });
      await expect(manager.restart()).rejects.toThrow("run daemon stop before restart");
      expect(runner.run).not.toHaveBeenCalledWith(
        "systemctl",
        ["--user", "restart", `${channelConfig.serviceId}.service`],
        expect.any(Object),
      );
    } finally {
      await owner.release();
    }
  });

  it("fails stop when systemd becomes inactive but the owner remains live", async () => {
    const setup = await createUnknownSystemdOwnerFixture();
    try {
      await expect(setup.manager.stop()).rejects.toThrow("still owns this home");
      expect(setup.runner.run).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "stop", `${channelConfig.serviceId}.service`],
        expect.any(Object),
      );
    } finally {
      await setup.owner.release();
    }
  });

  it("allows stop when systemd becomes inactive and releases the owner", async () => {
    const setup = await createUnknownSystemdOwnerFixture({ releaseOwnerOnStop: true });
    try {
      await expect(setup.manager.stop()).resolves.toMatchObject({
        runtimeOwner: { consistency: "missing" },
        state: "inactive",
      });
      expect(setup.runner.run).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "stop", `${channelConfig.serviceId}.service`],
        expect.any(Object),
      );
    } finally {
      await setup.owner.release();
    }
  });

  it.each(["installAndStart", "start", "stop", "restart", "uninstall"] as const)(
    "refuses %s when the installed service belongs to a different canonical home",
    async (mutation) => {
      const userHome = await temporaryDirectory("opentag-systemd-");
      const configuredHome = await temporaryDirectory("opentag-configured-home-");
      const requestedHome = await temporaryDirectory("opentag-requested-home-");
      const invocation = { args: [], program: "/usr/bin/opentag" };
      const unitPath = join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`);
      await writeFileWithParents(
        unitPath,
        renderSystemdUnit({
          home: configuredHome,
          invocation,
          path: buildServicePath(invocation, "linux"),
          serviceId: channelConfig.serviceId,
        }),
      );
      await writeMachineCredential(requestedHome);
      const runner = fakeRunner((_, args) => {
        if (args.includes("is-active")) return result(3, "inactive", "");
        return result(0, "", "");
      });
      const manager = await createDaemonServiceManager({
        home: requestedHome,
        invocation,
        platform: "linux",
        runner,
        uid: 1000,
        userHome,
        username: "test",
      });

      await expect(manager[mutation]()).rejects.toThrow("belongs to a different OpenTag home");
      const managerMutations = runner.run.mock.calls.filter(([, args]) =>
        args.some((argument) => ["daemon-reload", "disable", "enable", "restart", "start", "stop"].includes(argument)),
      );
      expect(managerMutations).toEqual([]);
    },
  );

  it("serializes concurrent first installs across homes for one channel target", async () => {
    const userHome = await temporaryDirectory("opentag-systemd-");
    const firstHome = await temporaryDirectory("opentag-first-home-");
    const secondHome = await temporaryDirectory("opentag-second-home-");
    const canonicalFirstHome = await realpath(firstHome);
    const invocation = { args: [], program: "/usr/bin/opentag" };
    for (const home of [firstHome, secondHome]) {
      await writeMachineCredential(home);
    }
    let active = false;
    let releaseReload: (() => void) | undefined;
    let reloadStarted: (() => void) | undefined;
    const reloadReached = new Promise<void>((resolve) => {
      reloadStarted = resolve;
    });
    const reloadBarrier = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    let blockedReload = false;
    const runner = {
      run: vi.fn(async (_program: string, args: readonly string[]) => {
        if (args.includes("show-environment")) return result(0, "", "");
        if (args.includes("LoadState")) return result(0, "not-found", "");
        if (args.includes("daemon-reload") && !blockedReload) {
          blockedReload = true;
          reloadStarted?.();
          await reloadBarrier;
        }
        if (args.includes("start")) active = true;
        if (args.includes("is-active")) return active ? result(0, "active", "") : result(3, "inactive", "");
        if (args.includes("MainPID")) return result(0, "321", "");
        if (_program === "loginctl") return result(0, "", "");
        return result(0, "", "");
      }),
    } satisfies ServiceRunner;
    const first = await createDaemonServiceManager({
      home: firstHome,
      invocation,
      platform: "linux",
      runner,
      uid: 1000,
      userHome,
      username: "test",
    });
    const second = await createDaemonServiceManager({
      home: secondHome,
      invocation,
      platform: "linux",
      runner,
      uid: 1000,
      userHome,
      username: "test",
    });

    const winner = first.installAndStart();
    await reloadReached;
    const targetHome = getChannelConfig(channelConfig.channel, userHome).defaultHome;
    await expect(readFile(resolveDaemonPaths(targetHome).serviceTargetOperation, "utf8")).resolves.toContain(
      "operationId",
    );
    await expect(readFile(resolveDaemonPaths(firstHome).serviceOperation, "utf8")).resolves.toContain("operationId");
    await expect(second.installAndStart()).rejects.toThrow("service-target operation is already running");
    await expect(readFile(resolveDaemonPaths(secondHome).serviceOperation, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    releaseReload?.();
    await expect(winner).resolves.toMatchObject({ configuredHome: canonicalFirstHome, state: "active" });

    const unitPath = join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`);
    expect(await readFile(unitPath, "utf8")).toContain(`OPENTAG_HOME=${canonicalFirstHome}`);
    await expect(second.installAndStart()).rejects.toThrow("belongs to a different OpenTag home");
  });

  it.each(["installAndStart", "stop"] as const)(
    "refuses %s when systemd retains a loaded target without a definition",
    async (mutation) => {
      const userHome = await temporaryDirectory("opentag-systemd-");
      const home = await temporaryDirectory("opentag-systemd-home-");
      const invocation = { args: [], program: "/usr/bin/opentag" };
      await writeMachineCredential(home);
      const runner = fakeRunner((_, args) => {
        if (args.includes("show-environment")) return result(0, "", "");
        if (args.includes("LoadState")) return result(0, "loaded", "");
        return result(0, "", "");
      });
      const manager = await createDaemonServiceManager({
        home,
        invocation,
        platform: "linux",
        runner,
        uid: 1000,
        userHome,
        username: "test",
      });

      await expect(manager[mutation]()).rejects.toThrow("does not expose a verifiable OPENTAG_HOME");
      expect(runner.run).not.toHaveBeenCalledWith(
        "systemctl",
        expect.arrayContaining([expect.stringMatching(/^(?:daemon-reload|disable|enable|start|stop)$/u)]),
        expect.any(Object),
      );
    },
  );
});

describe("launchd service backend", () => {
  it("uses exact production-visible identity and hides node behind the wrapper", () => {
    const wrapper = renderLaunchdWrapper({ args: ["/app/index.mjs"], program: "/usr/bin/node" });
    const plist = renderLaunchdPlist({
      home: "/Users/test/.opentag",
      label: "opentag",
      path: "/usr/bin:/bin",
      stderrPath: "/Users/test/.opentag/logs/daemon.stderr.log",
      stdoutPath: "/Users/test/.opentag/logs/daemon.stdout.log",
      wrapperPath: "/Users/test/.opentag/state/service/opentag",
    });
    expect(plist).toContain("<string>opentag</string>");
    expect(plist).toContain("<string>/Users/test/.opentag/state/service/opentag</string>");
    expect(plist).not.toContain("node");
    expect(plist).not.toContain("index.mjs");
    expect(wrapper).toContain("'/usr/bin/node' '/app/index.mjs' 'daemon' 'service-run'");
  });

  it("covers launchd orphan, malformed, and transient status reports", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-status-");
    const home = join(userHome, "home");
    const invocation = { args: [], program: "/usr/local/bin/opentag" };
    const scenarios: Array<[string, CommandResult, string]> = [
      ["orphan timeout", { code: null, stdout: "", stderr: "", timedOut: true }, "definition-less service target"],
      ["orphan error", result(1, "", "permission denied"), "permission denied"],
      ["loaded timeout", { code: null, stdout: "", stderr: "", timedOut: true }, "launchctl print timed out"],
      ["loaded error", result(1, "", "permission denied"), "permission denied"],
    ];
    for (const [label, response, expectedDetail] of scenarios) {
      const runner = fakeRunner((_, args) => (args[0] === "print" ? response : result(0, "", "")));
      const backend = createLaunchdBackend({
        home,
        invocation,
        runner,
        serviceId: "opentag",
        uid: 501,
        userHome,
        sleep: async () => undefined,
      });
      if (label.startsWith("loaded")) await writeLaunchdDefinitions({ home, invocation, userHome });
      const info = await backend.status();
      expect(info.state, label).toBe("unknown");
      expect(info.detail).toContain(expectedDetail);
      if (label.startsWith("loaded")) {
        const { rm: remove } = await import("node:fs/promises");
        await remove(join(userHome, "Library", "LaunchAgents", "opentag.plist"));
      }
    }
  });

  it("reports loaded LaunchAgents without a valid PID or process state", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-pid-");
    const home = join(userHome, "home");
    const invocation = { args: [], program: "/usr/local/bin/opentag" };
    await writeLaunchdDefinitions({ home, invocation, userHome });
    for (const output of ["state = running", "state = unknown", "pid = 0"]) {
      const runner = fakeRunner((_, args) => (args[0] === "print" ? result(0, output, "") : result(0, "", "")));
      const backend = createLaunchdBackend({ home, invocation, runner, serviceId: "opentag", uid: 501, userHome });
      await expect(backend.status()).resolves.toMatchObject({
        state: output === "state = unknown" ? "inactive" : "unknown",
      });
    }
    const invalidUserHome = await temporaryDirectory("opentag-launchd-invalid-");
    const invalidPlist = join(invalidUserHome, "Library", "LaunchAgents", "opentag.plist");
    await writeFileWithParents(invalidPlist, "<plist></plist>");
    const invalid = createLaunchdBackend({
      home,
      invocation,
      runner: fakeRunner(),
      serviceId: "opentag",
      uid: 501,
      userHome: invalidUserHome,
    });
    await expect(invalid.status()).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("valid OPENTAG_HOME"),
    });
  });

  it("handles launchd manager failures, eviction exhaustion, bootstrap retries, and missing installs", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-ops-");
    const home = join(userHome, "home");
    const invocation = { args: [], program: "/usr/local/bin/opentag" };
    const unavailable = createLaunchdBackend({
      home,
      invocation,
      runner: fakeRunner((_, args) => (args[0] === "print" ? result(1, "", "domain unavailable") : result(0, "", ""))),
      serviceId: "opentag",
      uid: 501,
      userHome,
    });
    await expect(unavailable.preflight()).rejects.toThrow("domain unavailable");
    const timedOut = createLaunchdBackend({
      home,
      invocation,
      runner: fakeRunner((_, args) =>
        args[0] === "print" ? { code: null, stdout: "", stderr: "", timedOut: true } : result(0, "", ""),
      ),
      serviceId: "opentag",
      uid: 501,
      userHome,
    });
    await expect(timedOut.preflight()).rejects.toThrow("command timed out");

    const missing = createLaunchdBackend({
      home,
      invocation,
      runner: fakeRunner(),
      serviceId: "opentag",
      uid: 501,
      userHome,
    });
    await expect(missing.start()).rejects.toThrow("not installed");
    await expect(missing.restart()).rejects.toThrow("not installed");
    await expect(missing.stop()).resolves.toMatchObject({ state: "not-installed" });
    await expect(missing.uninstall()).resolves.toMatchObject({ state: "not-installed" });

    await writeLaunchdDefinitions({ home, invocation, userHome });
    const exhausted = createLaunchdBackend({
      activationAttempts: 1,
      evictionAttempts: 1,
      evictionDelayMs: 0,
      home,
      invocation,
      runner: fakeRunner((_, args) =>
        args[0] === "print" ? result(0, "state = running\npid = 1", "") : result(0, "", ""),
      ),
      serviceId: "opentag",
      sleep: async () => undefined,
      uid: 501,
      userHome,
    });
    await expect(exhausted.stop()).rejects.toThrow("did not evict");

    let bootstrapAttempts = 0;
    const retryRunner = fakeRunner((_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") return result(1, "", "Could not find service");
      if (args[0] === "bootout") return result(1, "", "No such process");
      if (args[0] === "bootstrap") {
        bootstrapAttempts += 1;
        return bootstrapAttempts === 1 ? result(1, "", "busy") : result(0, "", "");
      }
      return result(0, "", "");
    });
    const retry = createLaunchdBackend({
      activationAttempts: 1,
      activationDelayMs: 0,
      evictionAttempts: 1,
      evictionDelayMs: 0,
      home: join(userHome, "retry-home"),
      invocation,
      runner: retryRunner,
      serviceId: "opentag",
      sleep: async () => undefined,
      uid: 501,
      userHome,
    });
    await expect(retry.installAndStart()).rejects.toThrow("did not become active");
    expect(bootstrapAttempts).toBe(2);

    const unknownLoaded = createLaunchdBackend({
      home,
      invocation,
      runner: fakeRunner((_, args) => {
        if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
        if (args[0] === "print") return result(1, "other state", "permission denied");
        return result(0, "", "");
      }),
      serviceId: "opentag",
      uid: 501,
      userHome,
    });
    await expect(unknownLoaded.start()).rejects.toThrow("start state check failed");
  });

  it("uninstalls a loaded launchd service without touching the host account", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-uninstall-");
    const home = join(userHome, "home");
    const invocation = { args: [], program: "/usr/local/bin/opentag" };
    await writeLaunchdDefinitions({ home, invocation, userHome });
    const runner = fakeRunner((_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") return result(1, "", "Could not find service");
      return result(0, "", "");
    });
    const backend = createLaunchdBackend({
      home,
      invocation,
      runner,
      serviceId: "opentag",
      sleep: async () => undefined,
      uid: 501,
      userHome,
    });
    await expect(backend.uninstall()).resolves.toMatchObject({ state: "not-installed" });
    await expect(readFile(join(userHome, "Library", "LaunchAgents", "opentag.plist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(home, "state", "service", "opentag"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores the invoking shell HOME when locating the account LaunchAgent definition", async () => {
    const shellHome = await temporaryDirectory("opentag-launchd-shell-home-");
    const userHome = await temporaryDirectory("opentag-launchd-user-home-");
    const home = await temporaryDirectory("opentag-launchd-home-");
    vi.stubEnv("HOME", shellHome);
    const manager = await createDaemonServiceManager({
      home,
      invocation: { args: [], program: "/usr/local/bin/opentag" },
      platform: "darwin",
      runner: fakeRunner(() => result(113, "", "Could not find service")),
      uid: 501,
      userHome,
      username: "test",
    });

    await expect(manager.status()).resolves.toMatchObject({
      definitionPath: join(userHome, "Library", "LaunchAgents", `${channelConfig.serviceId}.plist`),
    });
  });

  it("waits for eviction before bootstrapping", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-");
    const home = join(userHome, ".opentag");
    const calls: string[] = [];
    let loaded = true;
    let evictionChecks = 0;
    const runner = fakeRunner((_, args) => {
      calls.push(args.join(" "));
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") {
        if (evictionChecks > 0 && evictionChecks < 3) {
          evictionChecks += 1;
          return result(0, "state = running\npid = 77", "");
        }
        if (evictionChecks === 3) {
          loaded = false;
          evictionChecks += 1;
        }
        return loaded ? result(0, "state = running\npid = 77", "") : result(1, "", "Could not find service");
      }
      if (args[0] === "bootout") {
        evictionChecks = 1;
        return result(0, "", "");
      }
      if (args[0] === "bootstrap") {
        loaded = true;
        return result(0, "", "");
      }
      if (args[0] === "enable") return result(0, "", "");
      return result(0, "", "");
    });
    const backend = createLaunchdBackend({
      evictionDelayMs: 0,
      home,
      invocation: { args: [], program: "/usr/local/bin/opentag" },
      runner,
      serviceId: "opentag",
      sleep: async () => undefined,
      sourcePath: "/Users/test/.local/bin:relative:/usr/bin",
      uid: 501,
      userHome,
    });
    await expect(backend.installAndStart()).resolves.toMatchObject({
      logHint: `${join(home, "logs", "client.log")} (fallback: ${join(home, "logs", "daemon.stdout.log")} / ${join(home, "logs", "daemon.stderr.log")})`,
      pid: 77,
      state: "active",
    });
    const bootstrapIndex = calls.findIndex((value) => value.startsWith("bootstrap "));
    const evictionPrints = calls.slice(0, bootstrapIndex).filter((value) => value === "print gui/501/opentag");
    expect(bootstrapIndex).toBeGreaterThan(0);
    expect(evictionPrints).toHaveLength(3);
    const plist = await readFile(join(userHome, "Library", "LaunchAgents", "opentag.plist"), "utf8");
    expect(plist).toContain("/Users/test/.local/bin");
    expect(plist).not.toContain("relative");
  });

  it("treats launchctl bootout no such process as an already unloaded service", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-");
    const home = join(userHome, ".opentag");
    const calls: string[] = [];
    let loaded = false;
    const runner = fakeRunner((_, args) => {
      calls.push(args.join(" "));
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") {
        return loaded ? result(0, "state = running\npid = 77", "") : result(113, "", "Could not find service");
      }
      if (args[0] === "bootout") return result(3, "", "Boot-out failed: 3: No such process");
      if (args[0] === "bootstrap") loaded = true;
      return result(0, "", "");
    });
    const backend = createLaunchdBackend({
      activationDelayMs: 0,
      evictionDelayMs: 0,
      home,
      invocation: { args: [], program: "/usr/local/bin/opentag" },
      runner,
      serviceId: "opentag",
      sleep: async () => undefined,
      uid: 501,
      userHome,
    });

    await expect(backend.installAndStart()).resolves.toMatchObject({ pid: 77, state: "active" });
    expect(calls).toContain("bootout gui/501/opentag");
    expect(calls).toContain(`bootstrap gui/501 ${join(userHome, "Library", "LaunchAgents", "opentag.plist")}`);
  });

  it.each(["installAndStart", "start", "restart"] as const)(
    "waits for launchd to leave xpcproxy after %s",
    async (mutation) => {
      const userHome = await temporaryDirectory("opentag-launchd-");
      const home = join(userHome, ".opentag");
      const invocation = { args: [], program: "/usr/local/bin/opentag" };
      if (mutation !== "installAndStart") await writeLaunchdDefinitions({ home, invocation, userHome });
      let loaded = mutation === "restart";
      let activationChecks = 0;
      let activating = false;
      const wait = vi.fn(async () => undefined);
      const runner = fakeRunner((_, args) => {
        if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
        if (args[0] === "print") {
          if (!loaded) return result(113, "", "Could not find service");
          if (activating && activationChecks < 2) {
            activationChecks += 1;
            return result(0, "state = xpcproxy", "");
          }
          return result(0, "state = running\npid = 91", "");
        }
        if (args[0] === "bootout") {
          loaded = false;
          return result(0, "", "");
        }
        if (args[0] === "bootstrap" || args[0] === "kickstart") {
          activating = true;
          loaded = true;
        }
        return result(0, "", "");
      });
      const backend = createLaunchdBackend({
        activationAttempts: 3,
        activationDelayMs: 0,
        evictionDelayMs: 0,
        home,
        invocation,
        runner,
        serviceId: "opentag",
        sleep: wait,
        uid: 501,
        userHome,
      });

      await expect(backend[mutation]()).resolves.toMatchObject({ pid: 91, state: "active" });
      expect(wait).toHaveBeenCalledTimes(2);
    },
  );

  it("fails activation with the last launchd state after a bounded wait", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-");
    const home = join(userHome, ".opentag");
    const invocation = { args: [], program: "/usr/local/bin/opentag" };
    await writeLaunchdDefinitions({ home, invocation, userHome });
    let loaded = false;
    const runner = fakeRunner((_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") {
        return loaded ? result(0, "state = xpcproxy", "") : result(113, "", "Could not find service");
      }
      if (args[0] === "bootstrap") loaded = true;
      return result(0, "", "");
    });
    const backend = createLaunchdBackend({
      activationAttempts: 2,
      activationDelayMs: 0,
      home,
      invocation,
      runner,
      serviceId: "opentag",
      sleep: async () => undefined,
      uid: 501,
      userHome,
    });

    await expect(backend.start()).rejects.toThrow(
      "last state: inactive (LaunchAgent is loaded but process state is xpcproxy)",
    );
  });

  it("fails activation immediately when launchctl status times out", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-");
    const home = join(userHome, ".opentag");
    let loaded = false;
    let activationChecks = 0;
    const wait = vi.fn(async () => undefined);
    const runner = fakeRunner((_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") {
        if (!loaded) return result(113, "", "Could not find service");
        activationChecks += 1;
        return { code: null, stderr: "", stdout: "", timedOut: true };
      }
      if (args[0] === "bootout") return result(3, "", "Boot-out failed: 3: No such process");
      if (args[0] === "bootstrap") loaded = true;
      return result(0, "", "");
    });
    const backend = createLaunchdBackend({
      activationAttempts: 50,
      activationDelayMs: 100,
      evictionDelayMs: 0,
      home,
      invocation: { args: [], program: "/usr/local/bin/opentag" },
      runner,
      serviceId: "opentag",
      sleep: wait,
      uid: 501,
      userHome,
    });

    await expect(backend.installAndStart()).rejects.toThrow("launchd activation status check timed out");
    expect(activationChecks).toBe(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("reports a loaded waiting LaunchAgent without a PID as inactive", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-");
    const home = join(userHome, ".opentag");
    const invocation = { args: [], program: "/usr/local/bin/opentag" };
    await writeLaunchdDefinitions({ home, invocation, userHome });
    const runner = fakeRunner((_, args) =>
      args[0] === "print" ? result(0, "state = waiting", "") : result(0, "", ""),
    );
    const backend = createLaunchdBackend({
      home,
      invocation,
      runner,
      serviceId: "opentag",
      uid: 501,
      userHome,
    });

    await expect(backend.status()).resolves.toMatchObject({
      detail: "LaunchAgent is loaded but process state is waiting",
      state: "inactive",
    });
  });

  it("kickstarts a loaded inactive LaunchAgent instead of bootstrapping it", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-");
    const home = join(userHome, ".opentag");
    const invocation = { args: [], program: "/usr/local/bin/opentag" };
    await writeLaunchdDefinitions({ home, invocation, userHome });
    let running = false;
    const runner = fakeRunner((_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") {
        return running ? result(0, "state = running\npid = 91", "") : result(0, "state = waiting", "");
      }
      if (args[0] === "kickstart") running = true;
      return result(0, "", "");
    });
    const backend = createLaunchdBackend({
      home,
      invocation,
      runner,
      serviceId: "opentag",
      uid: 501,
      userHome,
    });

    await expect(backend.start()).resolves.toMatchObject({ pid: 91, state: "active" });
    expect(runner.run).toHaveBeenCalledWith("launchctl", ["kickstart", "-k", "gui/501/opentag"], expect.any(Object));
    expect(runner.run).not.toHaveBeenCalledWith(
      "launchctl",
      ["bootstrap", "gui/501", expect.any(String)],
      expect.any(Object),
    );
  });

  it("surfaces a loaded inactive LaunchAgent kickstart failure", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-");
    const home = join(userHome, ".opentag");
    const invocation = { args: [], program: "/usr/local/bin/opentag" };
    await writeLaunchdDefinitions({ home, invocation, userHome });
    const runner = fakeRunner((_, args) => {
      if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
      if (args[0] === "print") return result(0, "state = waiting", "");
      if (args[0] === "kickstart") return result(1, "", "kickstart denied");
      return result(0, "", "");
    });
    const backend = createLaunchdBackend({
      home,
      invocation,
      runner,
      serviceId: "opentag",
      uid: 501,
      userHome,
    });

    await expect(backend.start()).rejects.toThrow("kickstart denied");
    expect(runner.run).not.toHaveBeenCalledWith(
      "launchctl",
      ["bootstrap", "gui/501", expect.any(String)],
      expect.any(Object),
    );
  });

  it("does not delete definitions when bootout fails unexpectedly", async () => {
    const userHome = await temporaryDirectory("opentag-launchd-");
    const home = join(userHome, ".opentag");
    const plist = join(userHome, "Library", "LaunchAgents", "opentag.plist");
    await writeFileWithParents(plist, "definition");
    const runner = fakeRunner((_, args) =>
      args[0] === "bootout" ? result(1, "", "permission denied") : result(0, "", ""),
    );
    const backend = createLaunchdBackend({
      home,
      invocation: { args: [], program: "/usr/local/bin/opentag" },
      runner,
      serviceId: "opentag",
      uid: 501,
      userHome,
    });
    await expect(backend.uninstall()).rejects.toThrow("permission denied");
    expect(await readFile(plist, "utf8")).toBe("definition");
  });

  it.each(["installAndStart", "stop"] as const)(
    "refuses %s when launchd retains a loaded target without a plist",
    async (mutation) => {
      const userHome = await temporaryDirectory("opentag-launchd-");
      const home = join(userHome, ".opentag");
      const invocation = { args: [], program: "/usr/local/bin/opentag" };
      await writeMachineCredential(home);
      const runner = fakeRunner((_, args) => {
        if (args[0] === "print" && args[1] === "gui/501") return result(0, "domain", "");
        if (args[0] === "print") return result(0, "state = waiting", "");
        return result(0, "", "");
      });
      const manager = await createDaemonServiceManager({
        home,
        invocation,
        platform: "darwin",
        runner,
        uid: 501,
        userHome,
      });

      await expect(manager[mutation]()).rejects.toThrow("does not expose a verifiable OPENTAG_HOME");
      expect(runner.run).not.toHaveBeenCalledWith(
        "launchctl",
        expect.arrayContaining([expect.stringMatching(/^(?:bootstrap|bootout|enable|kickstart)$/u)]),
        expect.any(Object),
      );
    },
  );
});

function result(code: number, stdout: string, stderr: string): CommandResult {
  return { code, stderr, stdout, timedOut: false };
}

async function writeMachineCredential(home: string): Promise<void> {
  await writeMachineCredentialsAtomically(
    {
      version: 3,
      computer: {
        computerId: crypto.randomUUID(),
        installationId: crypto.randomUUID(),
        machineToken: `otmc_${crypto.randomUUID()}.${"a".repeat(43)}`,
        serverUrl: "https://example.com",
      },
    },
    home,
  );
}

function fakeRunner(handler: (program: string, args: readonly string[]) => CommandResult = () => result(0, "", "")) {
  return {
    run: vi.fn(async (program: string, args: readonly string[]) => handler(program, args)),
  } satisfies ServiceRunner;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(path);
  return path;
}

async function writeFileWithParents(path: string, content: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeLaunchdDefinitions(options: {
  home: string;
  invocation: { args: string[]; program: string };
  userHome: string;
}): Promise<void> {
  const wrapperPath = join(options.home, "state", "service", "opentag");
  await writeFileWithParents(wrapperPath, renderLaunchdWrapper(options.invocation));
  await writeFileWithParents(
    join(options.userHome, "Library", "LaunchAgents", "opentag.plist"),
    renderLaunchdPlist({
      home: options.home,
      label: "opentag",
      path: buildServicePath(options.invocation, "darwin"),
      stderrPath: join(options.home, "logs", "daemon.stderr.log"),
      stdoutPath: join(options.home, "logs", "daemon.stdout.log"),
      wrapperPath,
    }),
  );
}

async function createUnknownSystemdOwnerFixture(options: { releaseOwnerOnStop?: boolean } = {}) {
  const userHome = await temporaryDirectory("opentag-systemd-");
  const home = await temporaryDirectory("opentag-systemd-home-");
  const unitPath = join(userHome, ".config", "systemd", "user", `${channelConfig.serviceId}.service`);
  const invocation = { args: [], program: "/usr/bin/opentag" };
  await writeFileWithParents(
    unitPath,
    renderSystemdUnit({
      home,
      invocation,
      path: buildServicePath(invocation, "linux"),
      serviceId: channelConfig.serviceId,
    }),
  );
  const owner = await acquireDaemonOwner(home, "instance");
  let active = true;
  const runner = {
    run: vi.fn(async (_program: string, args: readonly string[]) => {
      if (args.includes("is-active")) return active ? result(0, "active", "") : result(3, "inactive", "");
      if (args.includes("MainPID")) return { code: null, stderr: "", stdout: "", timedOut: true };
      if (args.includes("stop")) {
        active = false;
        if (options.releaseOwnerOnStop) await owner.release();
      }
      return result(0, "", "");
    }),
  } satisfies ServiceRunner;
  const manager = await createDaemonServiceManager({
    home,
    invocation,
    platform: "linux",
    runner,
    uid: 1000,
    userHome,
    username: "test",
  });
  return { manager, owner, runner };
}
