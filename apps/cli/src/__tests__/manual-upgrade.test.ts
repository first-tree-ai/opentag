import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonServiceReconcileResult } from "../core/daemon/reconcile-service.js";
import { runUpgrade } from "../core/update/manual-upgrade.js";
import { readUpdaterState, writeUpdaterState } from "../core/update/updater-state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-upgrade-home-"));
  directories.push(home);
  return home;
}

function packument(version: string) {
  return { "dist-tags": { latest: version } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
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

describe("manual upgrade", () => {
  it("refuses the dev channel", async () => {
    const result = await runUpgrade({ channel: "dev", home: await tempHome() });
    expect(result).toMatchObject({ exitCode: 1, status: "error" });
    expect(result.message).toContain("staging and production");
  });

  it("checks the exact channel target without installing (npm-global)", async () => {
    const runNpm = vi.fn();
    const fetchFn = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://registry.npmjs.org/open-tag-staging");
      return jsonResponse(packument("0.0.3"));
    }) as typeof fetch;
    const result = await runUpgrade({
      channel: "staging",
      check: true,
      home: await tempHome(),
      environment: {},
      fetchFn,
      runNpm,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      status: "available",
      targetVersion: "0.0.3",
      installMode: "npm-global",
    });
    expect(runNpm).not.toHaveBeenCalled();
  });

  it("reports channel-target lookup and validation failures without installing", async () => {
    const cases: Array<{
      fetchFn: typeof fetch;
      installMode?: { mode: "portable"; root: string; binDir: string };
      message: string;
    }> = [
      {
        fetchFn: (async () => jsonResponse({ channel: "prod", version: "0.0.3" })) as typeof fetch,
        installMode: { mode: "portable", root: "/portable/root", binDir: "/portable/bin" },
        message: "belongs to another channel",
      },
      {
        fetchFn: (async () => jsonResponse({ "dist-tags": [] })) as typeof fetch,
        message: "missing or invalid",
      },
      {
        fetchFn: (async () => jsonResponse(packument("not-semver"))) as typeof fetch,
        message: "missing or invalid",
      },
      {
        fetchFn: (async () => {
          throw "network offline";
        }) as typeof fetch,
        message: "network offline",
      },
      {
        fetchFn: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
        message: "HTTP 503",
      },
      {
        fetchFn: (async () => new Response("{")) as typeof fetch,
        message: "not valid JSON",
      },
    ];
    const runNpm = vi.fn();

    for (const testCase of cases) {
      const result = await runUpgrade({
        channel: "staging",
        home: await tempHome(),
        environment: {},
        fetchFn: testCase.fetchFn,
        runNpm,
        ...(testCase.installMode ? { installMode: testCase.installMode } : {}),
      });
      expect(result).toMatchObject({ exitCode: 1, status: "error" });
      expect(result.message).toContain(testCase.message);
    }
    expect(runNpm).not.toHaveBeenCalled();
  });

  it("installs the exact channel target through npm and refreshes the service (npm-global)", async () => {
    const home = await tempHome();
    const npmArgs: string[][] = [];
    const reconcileService = vi.fn(async () => readyReconcile);
    const fetchFn = (async () => jsonResponse(packument("0.0.3"))) as typeof fetch;
    const result = await runUpgrade({
      channel: "staging",
      home,
      environment: {},
      fetchFn,
      runNpm: async (args) => {
        npmArgs.push([...args]);
      },
      reconcileService,
      now: () => 1_700_000_000_000,
    });
    expect(result).toMatchObject({ exitCode: 0, status: "installed", targetVersion: "0.0.3", serviceRefresh: "ready" });
    expect(npmArgs).toEqual([["install", "-g", "open-tag-staging@0.0.3"]]);
    expect(reconcileService).toHaveBeenCalledOnce();

    // The install is recorded so the daemon's automatic updater never re-attempts it.
    const state = await readUpdaterState(home);
    expect(state).toMatchObject({ status: "ok" });
    if (state.status !== "ok") throw new Error("state missing");
    expect(state.state.state).toBe("installed");
    expect(state.state.attempts["0.0.3"]).toMatchObject({ result: "installed" });
  });

  it("installs an exact npm target that differs only by SemVer build metadata", async () => {
    const runNpm = vi.fn(async () => undefined);
    const result = await runUpgrade({
      channel: "staging",
      currentVersion: "1.2.3+build.1",
      home: await tempHome(),
      environment: {},
      fetchFn: (async () => jsonResponse(packument("1.2.3+build.2"))) as typeof fetch,
      runNpm,
      reconcileService: async () => readyReconcile,
    });

    expect(result).toMatchObject({ exitCode: 0, status: "installed", targetVersion: "1.2.3+build.2" });
    expect(runNpm).toHaveBeenCalledWith(["install", "-g", "open-tag-staging@1.2.3+build.2"]);
  });

  it("never installs automatically and reports ahead/up-to-date without work", async () => {
    const runNpm = vi.fn();
    for (const [latest, status] of [
      ["0.0.2", "up-to-date"],
      ["0.0.1", "ahead"],
    ] as const) {
      const result = await runUpgrade({
        channel: "staging",
        home: await tempHome(),
        environment: {},
        fetchFn: (async () => jsonResponse(packument(latest))) as typeof fetch,
        runNpm,
      });
      expect(result).toMatchObject({ exitCode: 0, status, targetVersion: latest });
    }
    expect(runNpm).not.toHaveBeenCalled();
  });

  it("repairs a blocked current target and retries service reconciliation without reinstalling", async () => {
    const home = await tempHome();
    await writeUpdaterState(home, {
      schemaVersion: 1,
      currentVersion: "0.0.2",
      state: "blocked",
      target: "0.0.2",
      attempts: {
        "0.0.2": {
          target: "0.0.2",
          startedAt: "2026-08-31T00:00:00.000Z",
          finishedAt: "2026-08-31T00:00:01.000Z",
          result: "failed",
          failureReason: "service refresh failed",
        },
      },
    });
    const runNpm = vi.fn();
    const reconcileService = vi.fn(async () => readyReconcile);
    const result = await runUpgrade({
      channel: "staging",
      home,
      environment: {},
      fetchFn: (async () => jsonResponse(packument("0.0.2"))) as typeof fetch,
      runNpm,
      reconcileService,
    });

    expect(result).toMatchObject({ exitCode: 0, status: "installed", targetVersion: "0.0.2" });
    expect(runNpm).not.toHaveBeenCalled();
    expect(reconcileService).toHaveBeenCalledOnce();
    const state = await readUpdaterState(home);
    if (state.status !== "ok") throw new Error("state missing");
    expect(state.state).toMatchObject({ state: "installed", target: "0.0.2" });
    expect(state.state.attempts["0.0.2"]).toMatchObject({ result: "installed" });
  });

  it("resolves the portable channel pointer and installs through the portable layout", async () => {
    const home = await tempHome();
    const installed: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://download.opentag.build/releases/staging/latest.json");
      return jsonResponse({ channel: "staging", version: "0.0.3-staging.1.1" });
    }) as typeof fetch;
    const result = await runUpgrade({
      channel: "staging",
      home,
      environment: {},
      installMode: { mode: "portable", root: "/portable/root", binDir: "/portable/bin" },
      fetchFn,
      installPortable: async (target) => {
        installed.push(target);
      },
      reconcileService: async () => readyReconcile,
    });
    expect(result).toMatchObject({ exitCode: 0, status: "installed", installMode: "portable" });
    expect(installed).toEqual(["0.0.3-staging.1.1"]);
  });

  it("surfaces a deferred service refresh without failing the upgrade", async () => {
    const result = await runUpgrade({
      channel: "staging",
      home: await tempHome(),
      environment: {},
      fetchFn: (async () => jsonResponse(packument("0.0.3"))) as typeof fetch,
      runNpm: async () => undefined,
      reconcileService: async () => ({
        reason: "credentials-missing",
        service: readyReconcile.service,
        status: "deferred",
      }),
    });
    expect(result).toMatchObject({ exitCode: 0, status: "installed", serviceRefresh: "deferred" });
  });

  it("fails visibly when npm or the service refresh fails", async () => {
    const failedInstall = await runUpgrade({
      channel: "staging",
      home: await tempHome(),
      environment: {},
      fetchFn: (async () => jsonResponse(packument("0.0.3"))) as typeof fetch,
      runNpm: async () => {
        throw new Error("npm registry unreachable");
      },
    });
    expect(failedInstall).toMatchObject({ exitCode: 1, status: "error" });
    expect(failedInstall.message).toContain("npm registry unreachable");

    const failedRefreshHome = await tempHome();
    const failedRefresh = await runUpgrade({
      channel: "staging",
      home: failedRefreshHome,
      environment: {},
      fetchFn: (async () => jsonResponse(packument("0.0.3"))) as typeof fetch,
      runNpm: async () => undefined,
      reconcileService: async () => {
        throw new Error("systemd unavailable");
      },
    });
    expect(failedRefresh).toMatchObject({ exitCode: 1, status: "installed", serviceRefresh: "failed" });
    expect(failedRefresh.message).toContain("systemd unavailable");
    const failedState = await readUpdaterState(failedRefreshHome);
    if (failedState.status !== "ok") throw new Error("state missing");
    expect(failedState.state).toMatchObject({ state: "blocked", target: "0.0.3" });
    expect(failedState.state.attempts["0.0.3"]).toMatchObject({
      result: "failed",
      failureReason: "systemd unavailable",
    });
  });

  it("reports both service-refresh and blocked-state persistence failures", async () => {
    const home = await tempHome();
    const writeState = vi
      .fn<typeof writeUpdaterState>()
      .mockImplementationOnce(writeUpdaterState)
      .mockRejectedValueOnce(new Error("state disk unavailable"));
    const result = await runUpgrade({
      channel: "staging",
      home,
      environment: {},
      fetchFn: (async () => jsonResponse(packument("0.0.3"))) as typeof fetch,
      runNpm: async () => undefined,
      reconcileService: async () => {
        throw new Error("systemd unavailable");
      },
      writeState,
    });

    expect(result).toMatchObject({ exitCode: 1, status: "installed", serviceRefresh: "failed" });
    expect(result.message).toContain("systemd unavailable");
    expect(result.message).toContain("state disk unavailable");
    expect(writeState).toHaveBeenCalledTimes(2);
  });

  it("reports a durable-state write failure after the target is installed", async () => {
    const writeState = vi.fn<typeof writeUpdaterState>().mockRejectedValue(new Error("state disk unavailable"));
    const reconcileService = vi.fn(async () => readyReconcile);
    const result = await runUpgrade({
      channel: "staging",
      home: await tempHome(),
      environment: {},
      fetchFn: (async () => jsonResponse(packument("0.0.3"))) as typeof fetch,
      runNpm: async () => undefined,
      reconcileService,
      writeState,
    });

    expect(result).toMatchObject({ exitCode: 1, status: "error", targetVersion: "0.0.3" });
    expect(result.message).toContain("Installed 0.0.3 but could not record the upgrade state");
    expect(result.message).toContain("state disk unavailable");
    expect(reconcileService).not.toHaveBeenCalled();
  });

  it("repairs invalid updater state by recording the manual install", async () => {
    const home = await tempHome();
    const { resolveDaemonPaths } = await import("../core/daemon/paths.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.daemonState, { recursive: true, mode: 0o700 });
    await writeFile(join(paths.daemonState, "updater.json"), "{{{", { mode: 0o600 });

    const result = await runUpgrade({
      channel: "staging",
      home,
      environment: {},
      fetchFn: (async () => jsonResponse(packument("0.0.3"))) as typeof fetch,
      runNpm: async () => undefined,
      reconcileService: async () => readyReconcile,
    });
    expect(result.exitCode).toBe(0);
    const state = await readUpdaterState(home);
    if (state.status !== "ok") throw new Error("state missing");
    expect(state.state.attempts["0.0.3"]).toMatchObject({ result: "installed" });
  });
});
