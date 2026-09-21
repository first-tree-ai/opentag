import { chmod, mkdir, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveProviderCliRunKey,
  executeProviderCliTurnPlan,
  MAX_PROVIDER_CLI_EXECUTABLE_BYTES,
  parseProviderCliTurnRunnerArgv,
  resolveProviderCliTurnRunnerInvocation,
  runProviderCliTurnRunner,
} from "../index.js";
import { isProviderCliTurnRunnerMain, mergeEnvironmentManifest } from "../runtime/provider-cli/turn-runner.js";
import {
  installTurnTarget,
  makePrivateSlackConfigDir,
  makeTurnPlanHarness,
  writeExternalTurnSelection,
  writeManagedTurnSelection,
} from "./fixtures/provider-cli-turn-plan.js";

// Real child-process Turn cases need headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function trackedHarness() {
  const harness = await makeTurnPlanHarness();
  tempDirs.push(harness.accountHome, harness.openTagHome);
  return harness;
}

/** Prepare an external feishu plan whose target lives under the account home. */
async function preparedFeishuTurn(options: { captureOutgoingReplies?: boolean } = {}) {
  const harness = await trackedHarness();
  const target = await installTurnTarget(join(harness.accountHome, "bin"));
  await writeExternalTurnSelection(harness.layout, "feishu", target);
  const prepared = await harness.manager.prepare({
    provider: "feishu",
    sessionId: "s-1",
    runId: "run-1",
    ...options,
  });
  return { ...harness, target, prepared };
}

function execute(
  prepared: { planPath: string },
  plansRoot: string,
  overrides: Partial<Parameters<typeof executeProviderCliTurnPlan>[0]> = {},
) {
  return executeProviderCliTurnPlan({
    planPath: prepared.planPath,
    provider: "feishu",
    runId: "run-1",
    argv: [],
    plansRoot,
    spawnTarget: async () => 0,
    ...overrides,
  });
}

describe("parseProviderCliTurnRunnerArgv", () => {
  it("rejects an empty run identifier", () => {
    expect(() =>
      parseProviderCliTurnRunnerArgv(["--plan", "/tmp/plan.json", "--provider", "feishu", "--run-id", "", "--"]),
    ).toThrow(expect.objectContaining({ code: "run_mismatch" }));
  });

  it("accepts a fence with no user argv", () => {
    expect(
      parseProviderCliTurnRunnerArgv(["--plan", "/tmp/plan.json", "--provider", "slack", "--run-id", "r-1", "--"]),
    ).toEqual({ planPath: "/tmp/plan.json", provider: "slack", runId: "r-1", userArgv: [] });
  });
});

describe("executeProviderCliTurnPlan plan location", () => {
  it("fails closed when the plan file is gone but its Session directory remains", async () => {
    const { layout, prepared } = await preparedFeishuTurn();
    await rm(prepared.planPath);
    await expect(execute(prepared, layout.plans)).rejects.toMatchObject({ code: "plan_missing" });
  });

  it("fails closed when the Session directory is gone", async () => {
    const { layout, prepared } = await preparedFeishuTurn();
    await rm(prepared.sessionDir, { recursive: true, force: true });
    await expect(execute(prepared, layout.plans)).rejects.toMatchObject({ code: "plan_missing" });
  });

  it("rejects a plan whose Home namespace differs from its directory", async () => {
    const { layout, prepared } = await preparedFeishuTurn();
    const foreign = { ...prepared.plan, homeNamespace: `h-${"0".repeat(40)}` };
    await writeFile(prepared.planPath, `${JSON.stringify(foreign)}\n`, { mode: 0o600 });
    await expect(execute(prepared, layout.plans)).rejects.toMatchObject({ code: "home_mismatch" });
  });

  it("rejects plan directories that other accounts can inspect", async () => {
    const { layout, prepared } = await preparedFeishuTurn();
    const homeDir = join(layout.plans, prepared.homeNamespace);
    await chmod(homeDir, 0o750);
    try {
      await expect(execute(prepared, layout.plans)).rejects.toMatchObject({
        code: "unsafe",
        message: "Provider CLI Turn plan directories must be private and owned by the daemon account",
      });
    } finally {
      await chmod(homeDir, 0o700);
    }
  });
});

describe("executeProviderCliTurnPlan target verification", () => {
  it("reports a missing target as drift", async () => {
    const { layout, prepared, target } = await preparedFeishuTurn();
    await rm(target);
    await expect(execute(prepared, layout.plans)).rejects.toMatchObject({ code: "artifact_drifted" });
  });

  it("refuses a target that is no longer a regular file", async () => {
    const { layout, prepared, target } = await preparedFeishuTurn();
    await rm(target);
    await mkdir(target);
    await expect(execute(prepared, layout.plans)).rejects.toMatchObject({ code: "unsafe" });
  });

  it("refuses a target that grew past the executable size bound", async () => {
    const { layout, prepared, target } = await preparedFeishuTurn();
    // A sparse file reports the oversized length without occupying disk.
    await truncate(target, MAX_PROVIDER_CLI_EXECUTABLE_BYTES + 1);
    await expect(execute(prepared, layout.plans)).rejects.toMatchObject({ code: "too_large" });
  });

  it("reports a target that cannot be re-read as drift", async () => {
    const { layout, prepared, target } = await preparedFeishuTurn();
    await chmod(target, 0o000);
    try {
      await expect(execute(prepared, layout.plans)).rejects.toMatchObject({
        code: "artifact_drifted",
        message: expect.stringContaining("EACCES"),
      });
    } finally {
      await chmod(target, 0o755);
    }
  });

  it("reports a target whose canonical path moved as drift even when its bytes match", async () => {
    const { layout, prepared, target } = await preparedFeishuTurn();
    const moved = join(dirname(target), "lark-cli-real");
    await rename(target, moved);
    await symlink(moved, target);
    await expect(execute(prepared, layout.plans)).rejects.toMatchObject({
      code: "artifact_drifted",
      message: "Provider CLI Turn target path drifted",
    });
  });

  it("verifies a managed target against its artifact digest", async () => {
    const harness = await trackedHarness();
    const target = await installTurnTarget(join(harness.accountHome, "bin"));
    await writeManagedTurnSelection(harness.layout, "feishu", target);
    const prepared = await harness.manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const spawnTarget = vi.fn(async () => 3);
    await expect(execute(prepared, harness.layout.plans, { spawnTarget })).resolves.toBe(3);
    expect(spawnTarget).toHaveBeenCalledWith(
      target,
      expect.any(Array),
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });
});

describe("executeProviderCliTurnPlan spawning without an injected spawner", () => {
  it("maps a spawn failure of an inherited-stdio Turn to runner_failed", async () => {
    const { layout, prepared, target } = await preparedFeishuTurn();
    await chmod(target, 0o600);
    await expect(
      execute(prepared, layout.plans, { argv: ["im", "send"], spawnTarget: undefined }),
    ).rejects.toMatchObject({ code: "runner_failed", message: expect.stringContaining("EACCES") });
  });

  it("maps a spawn failure of a captured outgoing-reply Turn to runner_failed", async () => {
    const { layout, prepared, target } = await preparedFeishuTurn({ captureOutgoingReplies: true });
    await chmod(target, 0o600);
    await expect(
      execute(prepared, layout.plans, {
        argv: ["im", "+messages-send", "--text", "hello"],
        spawnTarget: undefined,
      }),
    ).rejects.toMatchObject({ code: "runner_failed", message: expect.stringContaining("EACCES") });
  });

  it("reports the failure on stderr and returns 1 from the CLI entry", async () => {
    const { layout, prepared, target } = await preparedFeishuTurn();
    await chmod(target, 0o600);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runProviderCliTurnRunner(
      ["--plan", prepared.planPath, "--provider", "feishu", "--run-id", "run-1", "--", "im", "send"],
      { plansRoot: layout.plans },
    );
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });
});

describe("executeProviderCliTurnPlan Slack config directory", () => {
  it("rethrows unexpected inspection failures instead of masking them", async () => {
    const harness = await trackedHarness();
    const nest = join(harness.accountHome, "nest");
    const configDir = await makePrivateSlackConfigDir(nest, "cfg");
    const target = await installTurnTarget(join(harness.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(harness.layout, "slack", target, "4.7.0");
    const prepared = await harness.manager.prepare({ provider: "slack", sessionId: "s-1", runId: "run-1", configDir });
    await rm(nest, { recursive: true, force: true });
    await writeFile(nest, "", { mode: 0o600 });
    await expect(
      execute(prepared, harness.layout.plans, { provider: "slack", argv: ["api", "auth.test"] }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("rejects a config directory reached through a symlinked parent", async () => {
    const harness = await trackedHarness();
    const realParent = join(harness.accountHome, "real-parent");
    await makePrivateSlackConfigDir(realParent, "cfg");
    const linkParent = join(harness.accountHome, "link-parent");
    await symlink(realParent, linkParent);
    const configDir = join(linkParent, "cfg");
    const target = await installTurnTarget(join(harness.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(harness.layout, "slack", target, "4.7.0");
    const prepared = await harness.manager.prepare({ provider: "slack", sessionId: "s-1", runId: "run-1", configDir });
    await expect(
      execute(prepared, harness.layout.plans, { provider: "slack", argv: ["api", "auth.test"] }),
    ).rejects.toMatchObject({ code: "unsafe", message: "Slack config directory must not traverse a symlink" });
  });

  it("passes a canonical private config directory through", async () => {
    const harness = await trackedHarness();
    const configDir = await makePrivateSlackConfigDir(harness.accountHome);
    const target = await installTurnTarget(join(harness.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(harness.layout, "slack", target, "4.7.0");
    const prepared = await harness.manager.prepare({ provider: "slack", sessionId: "s-1", runId: "run-1", configDir });
    const spawned: (readonly string[])[] = [];
    await expect(
      execute(prepared, harness.layout.plans, {
        provider: "slack",
        argv: ["api", "auth.test"],
        spawnTarget: async (_file, args) => {
          spawned.push(args);
          return 0;
        },
      }),
    ).resolves.toBe(0);
    expect(spawned).toEqual([["--skip-update", "--config-dir", configDir, "api", "auth.test"]]);
  });

  it("pins the loopback API host that the runtime proxy published", async () => {
    const harness = await trackedHarness();
    const configDir = await makePrivateSlackConfigDir(harness.accountHome);
    const target = await installTurnTarget(join(harness.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(harness.layout, "slack", target, "4.7.0");
    const prepared = await harness.manager.prepare({
      provider: "slack",
      sessionId: "s-1",
      runId: "run-1",
      configDir,
      slackApiHost: "https://127.0.0.1:18443",
    });
    const spawned: (readonly string[])[] = [];
    await expect(
      execute(prepared, harness.layout.plans, {
        provider: "slack",
        argv: ["api", "auth.test"],
        spawnTarget: async (_file, args) => {
          spawned.push(args);
          return 0;
        },
      }),
    ).resolves.toBe(0);
    expect(spawned).toEqual([
      ["--skip-update", "--config-dir", configDir, "--apihost", "https://127.0.0.1:18443", "api", "auth.test"],
    ]);
  });
});

describe("executeProviderCliTurnPlan environment manifest", () => {
  it("merges the execution manifest into the CLI environment and derives the provider proxy variables", async () => {
    const harness = await trackedHarness();
    const target = await installTurnTarget(join(harness.accountHome, "bin"));
    await writeExternalTurnSelection(harness.layout, "feishu", target);
    const caPath = join(harness.accountHome, "proxy-ca.pem");
    const manifestPath = join(harness.accountHome, "execution-environment.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        executionId: "exec-1",
        environment: {
          OPENTAG_PROVIDER_PROXY_URL: "http://127.0.0.1:43119",
          OPENTAG_PROVIDER_CA_PATH: caPath,
          EXECUTION_ONLY: "manifest",
          STALE: null,
        },
      })}\n`,
      { mode: 0o600 },
    );
    const prepared = await harness.manager.prepare({
      provider: "feishu",
      sessionId: "s-1",
      runId: "run-1",
      environmentManifest: manifestPath,
    });
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    await expect(
      execute(prepared, harness.layout.plans, {
        env: { PATH: "/definitely-not-used", STALE: "ambient", AMBIENT_ONLY: "ambient" },
        spawnTarget: async (_file, _args, options) => {
          spawnedEnv = options.env;
          return 5;
        },
      }),
    ).resolves.toBe(5);
    expect(spawnedEnv?.EXECUTION_ONLY).toBe("manifest");
    expect(spawnedEnv?.AMBIENT_ONLY).toBe("ambient");
    expect(spawnedEnv?.STALE).toBeUndefined();
    expect(spawnedEnv?.HTTPS_PROXY).toBe("http://127.0.0.1:43119");
    expect(spawnedEnv?.SSL_CERT_FILE).toBe(caPath);
  });

  it("fails closed on a manifest that is unreadable, oversized, unparseable, or malformed", async () => {
    const { accountHome } = await trackedHarness();
    const manifestPath = join(accountHome, "execution-environment.json");
    const write = (content: string) => writeFile(manifestPath, content, { mode: 0o600 });

    await rm(manifestPath, { force: true });
    await expect(mergeEnvironmentManifest({}, manifestPath)).rejects.toMatchObject({ code: "plan_missing" });

    await write(`${JSON.stringify({ filler: "x".repeat(17 * 1024) })}\n`);
    await expect(mergeEnvironmentManifest({}, manifestPath)).rejects.toMatchObject({
      code: "plan_invalid",
      message: expect.stringContaining("too large"),
    });

    await write("{not json\n");
    await expect(mergeEnvironmentManifest({}, manifestPath)).rejects.toMatchObject({
      code: "plan_invalid",
      message: expect.stringContaining("invalid"),
    });

    const malformed = [
      "[]",
      "null",
      "7",
      JSON.stringify({ schemaVersion: 2, executionId: "e", environment: {} }),
      JSON.stringify({ schemaVersion: 1 }),
      JSON.stringify({ schemaVersion: 1, executionId: "", environment: {} }),
      JSON.stringify({ schemaVersion: 1, executionId: "e" }),
      JSON.stringify({ schemaVersion: 1, executionId: "e", environment: [] }),
      JSON.stringify({ schemaVersion: 1, executionId: "e", environment: { "A=B": "v" } }),
      JSON.stringify({ schemaVersion: 1, executionId: "e", environment: { A: 7 } }),
      JSON.stringify({ schemaVersion: 1, executionId: "e", environment: { A: "x\u0000y" } }),
    ];
    for (const content of malformed) {
      await write(`${content}\n`);
      await expect(mergeEnvironmentManifest({}, manifestPath)).rejects.toMatchObject({ code: "plan_invalid" });
    }

    await rm(manifestPath, { force: true });
    await mkdir(manifestPath);
    await expect(mergeEnvironmentManifest({}, manifestPath)).rejects.toMatchObject({ name: "RuntimeStorageError" });
  });
});

describe("executeProviderCliTurnPlan outgoing reply capture", () => {
  it("runs the captured Turn end to end and records the reply receipt", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      sessionId: "s-1",
      runId: "run-1",
      captureOutgoingReplies: true,
    });
    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-1",
        argv: ["im", "+messages-send", "--text", "hello"],
        env: { ...process.env, OPENTAG_TEST_TARGET_MODE: "lark-cli" },
        plansRoot: layout.plans,
      }),
    ).resolves.toBe(0);
    const receipts = await readdir(
      join(prepared.sessionDir, "runs", deriveProviderCliRunKey("run-1"), "outgoing-replies"),
    );
    expect(receipts).toHaveLength(1);
  });
});

describe("executeProviderCliTurnPlan environment ownership", () => {
  it("skips the daemon-account ownership check when the platform has no uid", async () => {
    const harness = await trackedHarness();
    const configDir = await makePrivateSlackConfigDir(harness.accountHome);
    const target = await installTurnTarget(join(harness.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(harness.layout, "slack", target, "4.7.0");
    const prepared = await harness.manager.prepare({
      provider: "slack",
      sessionId: "s-1",
      runId: "run-1",
      configDir,
    });
    const getuid = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true, writable: true });
    try {
      await expect(
        execute(prepared, harness.layout.plans, { provider: "slack", argv: ["api", "auth.test"] }),
      ).resolves.toBe(0);
    } finally {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true, writable: true });
    }
  });
});

describe("runner entry helpers", () => {
  it("points the invocation at the current Node binary and the runner module", () => {
    const [execPath, module] = resolveProviderCliTurnRunnerInvocation();
    expect(execPath).toBe(process.execPath);
    expect(module).toMatch(/turn-runner\.ts$/);
  });

  it("detects the main module only when argv[1] resolves to the same file URL", () => {
    const script = resolve("/opt/opentag/turn-runner.js");
    const url = pathToFileURL(script).href;
    expect(isProviderCliTurnRunnerMain(url, script)).toBe(true);
    expect(isProviderCliTurnRunnerMain(url, "/opt/opentag/other.js")).toBe(false);
    expect(isProviderCliTurnRunnerMain(url, undefined)).toBe(false);
    expect(isProviderCliTurnRunnerMain(url, "")).toBe(false);
    expect(isProviderCliTurnRunnerMain(url, 42 as unknown as string)).toBe(false);
  });
});
