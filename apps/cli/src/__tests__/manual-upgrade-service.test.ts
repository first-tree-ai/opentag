import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeMachineCredentialsAtomically } from "@opentag/client";
import { expect, it, vi } from "vitest";
import { reconcileDaemonService } from "../core/daemon/reconcile-service.js";
import { createDaemonServiceManager } from "../core/daemon/service/index.js";
import { quotePosix } from "../core/daemon/service/shared.js";
import type { ServiceRunner } from "../core/daemon/service/types.js";
import { runUpgrade } from "../core/update/manual-upgrade.js";
import { renderPortableShim } from "../core/update/portable-installer.js";
import { readUpdaterState } from "../core/update/updater-state.js";

vi.mock("../build-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../build-info.js")>()),
  CHANNEL: "staging",
  CLI_VERSION: "0.0.2",
}));

it("reconciles the actual service from the old Portable process after an upgrade switches current", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "opentag-upgrade-service-")));
  const home = join(base, "home");
  const userHome = join(base, "user");
  const root = join(base, "portable");
  const current = join(root, "current");
  const binDir = join(base, "bin");
  const launcher = join(binDir, "opentag-staging");
  const originalNode = process.execPath;
  const originalArgv = process.argv;
  const payload = async (version: string) => {
    const path = join(root, "versions", version);
    const node = join(path, "node/bin/node");
    const entry = join(path, "app/cli/index.mjs");
    await mkdir(dirname(node), { recursive: true });
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(node, `#!/bin/sh\nexec ${quotePosix(originalNode)} "$@"\n`, { mode: 0o755 });
    await writeFile(entry, `console.log(${JSON.stringify(version)});\n`);
    await writeFile(
      join(path, "INSTALL.json"),
      JSON.stringify({
        installMode: "portable",
        binName: "opentag-staging",
        appEntry: "app/cli/index.mjs",
        version,
      }),
    );
    return { path, node };
  };
  const runner: ServiceRunner = {
    run: vi.fn(async (_program, args) => ({
      code: 0,
      stderr: "",
      timedOut: false,
      stdout: args.includes("LoadState")
        ? "not-found"
        : args.includes("is-active")
          ? "active"
          : args.includes("MainPID")
            ? "321"
            : "",
    })),
  };
  try {
    const previous = await payload("0.0.2");
    await symlink(previous.path, current);
    await mkdir(binDir);
    await writeFile(launcher, renderPortableShim(current, binDir), { mode: 0o755 });
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
    const environment = {
      OPENTAG_INSTALL_MODE: "portable",
      OPENTAG_PORTABLE_ROOT: current,
      OPENTAG_PORTABLE_BIN_DIR: binDir,
    };
    Object.defineProperty(process, "execPath", { value: previous.node, configurable: true });
    process.argv = [previous.node, join(current, "app/cli/index.mjs")];
    const result = await runUpgrade({
      home,
      environment,
      fetchFn: (async () => new Response(JSON.stringify({ channel: "staging", version: "0.0.3" }))) as typeof fetch,
      installPortable: async (version) => {
        const next = await payload(version);
        expect(next.node).not.toBe(previous.node);
        await symlink(next.path, join(root, "next"));
        await rename(join(root, "next"), current);
      },
      reconcileService: () =>
        reconcileDaemonService({
          hasCredentials: async () => true,
          createManager: () =>
            createDaemonServiceManager({
              env: environment,
              home,
              userHome,
              platform: "linux",
              runner,
              uid: 1000,
              username: "test",
            }),
        }),
    });
    expect(result).toMatchObject({ exitCode: 0, status: "installed", serviceRefresh: "ready", targetVersion: "0.0.3" });
    expect(await readUpdaterState(home)).toMatchObject({
      status: "ok",
      state: { state: "installed", target: "0.0.3" },
    });
    const unit = await readFile(join(userHome, ".config/systemd/user/opentag-staging.service"), "utf8");
    expect(unit).toContain(`"${launcher}" "daemon" "service-run"`);
    expect(unit).not.toContain(`"${previous.node}" "${process.argv[1]}"`);
    expect((await promisify(execFile)(launcher, ["--version"])).stdout.trim()).toBe("0.0.3");
    expect(runner.run).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "start", "opentag-staging.service"],
      expect.any(Object),
    );
  } finally {
    Object.defineProperty(process, "execPath", { value: originalNode, configurable: true });
    process.argv = originalArgv;
    await rm(base, { recursive: true, force: true });
  }
});
