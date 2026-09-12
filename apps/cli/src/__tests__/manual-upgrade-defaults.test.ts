import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonServiceReconcileResult } from "../core/daemon/reconcile-service.js";

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));
const installerMocks = vi.hoisted(() => ({ installPortableTarget: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: childProcessMocks.execFile,
}));

vi.mock("../core/update/portable-installer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/update/portable-installer.js")>()),
  installPortableTarget: installerMocks.installPortableTarget,
}));

import { runUpgrade } from "../core/update/manual-upgrade.js";

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-upgrade-defaults-"));
  directories.push(home);
  return home;
}

const readyReconcile: DaemonServiceReconcileResult = {
  action: "restarted",
  service: {
    currentHome: "/tmp/home",
    definitionPath: "/tmp/unit",
    logHint: "journal",
    platform: "systemd",
    serviceId: "opentag-staging",
    state: "active",
  },
  status: "ready",
};

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function execFileCalls(): Array<[string, string[]]> {
  return childProcessMocks.execFile.mock.calls.map((call) => [String(call[0]), [...(call[1] as string[])]]);
}

describe("manual upgrade default runners", () => {
  it("runs npm install -g through the default npm runner", async () => {
    childProcessMocks.execFile.mockImplementation((_file: string, _args: string[], callback: ExecFileCallback) => {
      callback(null, "", "");
    });
    const result = await runUpgrade({
      channel: "staging",
      currentVersion: "0.0.2",
      home: await tempHome(),
      environment: {},
      fetchFn: (async () => new Response(JSON.stringify({ "dist-tags": { latest: "0.0.3" } }))) as typeof fetch,
      reconcileService: async () => readyReconcile,
    });
    expect(result).toMatchObject({ exitCode: 0, status: "installed", installMode: "npm-global" });
    expect(execFileCalls()).toEqual([["npm", ["install", "-g", "open-tag-staging@0.0.3"]]]);
  });

  it("surfaces a default npm runner failure as an upgrade error", async () => {
    childProcessMocks.execFile.mockImplementation((_file: string, _args: string[], callback: ExecFileCallback) => {
      callback(new Error("npm exited with code 1"), "", "");
    });
    const result = await runUpgrade({
      channel: "staging",
      currentVersion: "0.0.2",
      home: await tempHome(),
      environment: {},
      fetchFn: (async () => new Response(JSON.stringify({ "dist-tags": { latest: "0.0.3" } }))) as typeof fetch,
      reconcileService: async () => readyReconcile,
    });
    expect(result).toMatchObject({ exitCode: 1, status: "error" });
    expect(result.message).toContain("npm install -g open-tag-staging@0.0.3 failed: npm exited with code 1");
  });

  it("installs through the real portable installer with the channel layout", async () => {
    installerMocks.installPortableTarget.mockResolvedValue({ alreadyCurrent: false, versionDir: "/portable/v" });
    const result = await runUpgrade({
      channel: "staging",
      currentVersion: "0.0.2",
      home: await tempHome(),
      environment: {},
      installMode: { mode: "portable", root: "/portable/root", binDir: "/portable/bin" },
      fetchFn: (async () =>
        new Response(JSON.stringify({ channel: "staging", version: "0.0.3-staging.1.1" }))) as typeof fetch,
      reconcileService: async () => readyReconcile,
    });
    expect(result).toMatchObject({ exitCode: 0, status: "installed", installMode: "portable" });
    expect(installerMocks.installPortableTarget).toHaveBeenCalledExactlyOnceWith({
      channel: "staging",
      targetVersion: "0.0.3-staging.1.1",
      root: "/portable/root",
      binDir: "/portable/bin",
      binName: "opentag-staging",
      packageName: "open-tag-staging",
    });
  });

  it("forwards the download base override and the installer's cleanup failure", async () => {
    installerMocks.installPortableTarget.mockResolvedValue({
      alreadyCurrent: false,
      versionDir: "/portable/v",
      cleanupFailure: "Portable staging cleanup failed",
    });
    const result = await runUpgrade({
      channel: "staging",
      currentVersion: "0.0.2",
      home: await tempHome(),
      environment: { OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: "https://mirror.test/releases/" },
      installMode: { mode: "portable", root: "/portable/root", binDir: "/portable/bin" },
      fetchFn: (async (url: string | URL | Request) => {
        expect(String(url)).toBe("https://mirror.test/releases/staging/latest.json");
        return new Response(JSON.stringify({ channel: "staging", version: "0.0.3-staging.1.1" }));
      }) as typeof fetch,
      reconcileService: async () => readyReconcile,
    });
    expect(result).toMatchObject({ exitCode: 0, status: "installed" });
    expect(result.message).toContain("warning: Portable staging cleanup failed");
    expect(installerMocks.installPortableTarget).toHaveBeenCalledWith(
      expect.objectContaining({ downloadBaseUrl: "https://mirror.test/releases/" }),
    );
  });
});
