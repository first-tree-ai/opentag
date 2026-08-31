import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeProviderCliTurnPlan,
  PROVIDER_CLI_CATALOG,
  ProviderCliTurnPlanError,
  parseProviderCliTurnRunnerArgv,
  runProviderCliTurnRunner,
} from "../index.js";
import {
  installTurnTarget,
  makePrivateSlackConfigDir,
  makeTurnPlanHarness,
  runTurnLauncher,
  writeExternalTurnSelection,
  writeManagedTurnSelection,
} from "./fixtures/provider-cli-turn-plan.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function trackedHarness() {
  const harness = await makeTurnPlanHarness();
  tempDirs.push(harness.accountHome, harness.openTagHome);
  return harness;
}

describe("parseProviderCliTurnRunnerArgv", () => {
  it("captures user argv after the fence, including spaces and unicode", () => {
    const parsed = parseProviderCliTurnRunnerArgv([
      "--plan",
      "/tmp/plan.json",
      "--provider",
      "feishu",
      "--run-id",
      "run-1",
      "--",
      "im",
      "send",
      "hello world",
      "你好",
      'a"b',
      "$HOME",
    ]);
    expect(parsed).toEqual({
      planPath: "/tmp/plan.json",
      provider: "feishu",
      runId: "run-1",
      userArgv: ["im", "send", "hello world", "你好", 'a"b', "$HOME"],
    });
  });

  it("rejects unknown flags, relative plan paths, and provider mismatches", () => {
    expect(() => parseProviderCliTurnRunnerArgv(["--plan", "/tmp/plan.json", "--"])).toThrow(ProviderCliTurnPlanError);
    expect(() =>
      parseProviderCliTurnRunnerArgv(["--plan", "relative.json", "--provider", "feishu", "--run-id", "r", "--"]),
    ).toThrow(ProviderCliTurnPlanError);
    expect(() =>
      parseProviderCliTurnRunnerArgv(["--plan", "/tmp/plan.json", "--provider", "other", "--run-id", "r", "--"]),
    ).toThrow(ProviderCliTurnPlanError);
  });
});

describe("executeProviderCliTurnPlan", () => {
  it("does not consult PATH or the current selection and applies catalog env only for managed targets", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeManagedTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const replacement = await installTurnTarget(join(accountHome, "other"));
    await writeExternalTurnSelection(layout, "feishu", replacement, "1.0.93");

    const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const code = await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "send"],
      env: { PATH: "/definitely-not-used" },
      plansRoot: layout.plans,
      spawnTarget: async (file, args, options) => {
        calls.push({ file, args, env: options.env });
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({
        file: target,
        args: ["im", "send"],
      }),
    ]);
    expect(calls[0]?.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER).toBe("1");
    expect(calls[0]?.env.PATH).toBe("/definitely-not-used");
    expect(calls[0]?.file).not.toBe(replacement);
  });

  it("prepends exactly --skip-update --config-dir for managed and external Slack without duplicating catalog args", async () => {
    const slackEntry = PROVIDER_CLI_CATALOG.find((entry) => entry.provider === "slack");
    if (!slackEntry) throw new Error("Slack catalog entry is required");
    const extraCatalog = [{ ...slackEntry, managedArguments: ["--skip-update", "--extra-managed"] }];
    for (const kind of ["managed", "external"] as const) {
      const { accountHome, layout, manager } = await trackedHarness();
      const target = await installTurnTarget(join(accountHome, "bin"), "slack");
      if (kind === "managed") await writeManagedTurnSelection(layout, "slack", target, "4.7.0");
      else await writeExternalTurnSelection(layout, "slack", target, "4.7.0");
      const configDir = await makePrivateSlackConfigDir(accountHome);
      const prepared = await manager.prepare({
        provider: "slack",
        sessionId: "s-1",
        runId: "run-1",
        configDir,
      });
      const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
      await executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "slack",
        runId: "run-1",
        argv: ["api", "chat.postMessage"],
        env: { PATH: "/definitely-not-used" },
        catalog: extraCatalog,
        plansRoot: layout.plans,
        spawnTarget: async (_file, args, options) => {
          calls.push({ args, env: options.env });
          return 0;
        },
      });
      expect(calls[0]?.args).toEqual(["--skip-update", "--config-dir", configDir, "api", "chat.postMessage"]);
      expect(calls[0]?.args.filter((arg) => arg === "--skip-update")).toEqual(["--skip-update"]);
      expect(calls[0]?.args).not.toContain("--extra-managed");
      expect(calls[0]?.env.PATH).toBe("/definitely-not-used");
      expect(calls[0]?.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER).toBeUndefined();
    }
  });

  it("rejects a Slack config dir that is world-readable, a symlink, or missing", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"), "slack");
    await writeExternalTurnSelection(layout, "slack", target, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(accountHome);
    const prepared = await manager.prepare({
      provider: "slack",
      sessionId: "s-1",
      runId: "run-1",
      configDir,
    });

    await chmod(configDir, 0o755);
    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "slack",
        runId: "run-1",
        argv: ["api", "auth.test"],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "unsafe" });
    await chmod(configDir, 0o700);

    await chmod(configDir, 0o500);
    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "slack",
        runId: "run-1",
        argv: ["api", "auth.test"],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "unsafe" });
    await chmod(configDir, 0o700);

    await rm(configDir, { recursive: true, force: true });
    const realDir = await makePrivateSlackConfigDir(accountHome, "real-slack-config");
    await symlink(realDir, configDir);
    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "slack",
        runId: "run-1",
        argv: ["api", "auth.test"],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "unsafe" });
    await rm(configDir, { force: true });
    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "slack",
        runId: "run-1",
        argv: ["api", "auth.test"],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "unsafe" });
  });

  it("rejects Slack argv that tries to override OpenTag-managed authority flags", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"), "slack");
    await writeExternalTurnSelection(layout, "slack", target, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(accountHome);
    const prepared = await manager.prepare({
      provider: "slack",
      sessionId: "s-1",
      runId: "run-1",
      configDir,
    });

    for (const override of [
      "--token",
      "--app=x",
      "--team",
      "-wT123",
      "--workspace=T123",
      "--config-dir",
      "--skip-update",
    ]) {
      await expect(
        executeProviderCliTurnPlan({
          planPath: prepared.planPath,
          provider: "slack",
          runId: "run-1",
          argv: ["api", "auth.test", override],
          plansRoot: layout.plans,
          spawnTarget: async () => 0,
        }),
      ).rejects.toMatchObject({ code: "unsafe" });
    }
  });

  it("honors the frozen Slack config dir when HOME is unwritable", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"), "slack");
    await writeExternalTurnSelection(layout, "slack", target, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(accountHome);
    const prepared = await manager.prepare({
      provider: "slack",
      sessionId: "s-1",
      runId: "run-1",
      configDir,
    });
    const unwritableHome = join(accountHome, "unwritable-home");
    await mkdir(unwritableHome, { recursive: true, mode: 0o500 });
    await chmod(unwritableHome, 0o500);
    try {
      const result = await runTurnLauncher(prepared.launcherPath, ["api", "chat.postMessage"], {
        env: { ...process.env, HOME: unwritableHome },
      });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as { argv: string[] };
      expect(payload.argv).toEqual(["--skip-update", "--config-dir", configDir, "api", "chat.postMessage"]);
    } finally {
      await chmod(unwritableHome, 0o700);
    }
  });

  it("fails closed on provider or run fence mismatch and on target drift", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });

    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "slack",
        runId: "run-1",
        argv: [],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "provider_mismatch" });
    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-other",
        argv: [],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "run_mismatch" });

    await writeFile(target, `${await readFile(target, "utf8")}\n# drifted\n`);
    await chmod(target, 0o755);
    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-1",
        argv: [],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "artifact_drifted" });
  });

  it("rejects plans outside the derived account root or Session namespace", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });

    const misplaced = join(layout.plans, "plan.json");
    await writeFile(misplaced, `${JSON.stringify(prepared.plan)}\n`, { mode: 0o600 });
    await expect(
      executeProviderCliTurnPlan({
        planPath: misplaced,
        provider: "feishu",
        runId: "run-1",
        argv: [],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "unsafe" });

    await writeFile(prepared.planPath, `${JSON.stringify({ ...prepared.plan, sessionId: "different-session" })}\n`, {
      mode: 0o600,
    });
    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-1",
        argv: [],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "session_mismatch" });
  });

  it("rejects a plan that is readable by another account", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    await chmod(prepared.planPath, 0o644);

    await expect(
      executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-1",
        argv: [],
        plansRoot: layout.plans,
        spawnTarget: async () => 0,
      }),
    ).rejects.toMatchObject({ code: "unsafe" });
  });

  it("returns 1 from the CLI entry without throwing when the fence fails", async () => {
    const code = await runProviderCliTurnRunner([
      "--plan",
      "/tmp/missing-plan.json",
      "--provider",
      "feishu",
      "--run-id",
      "run-1",
      "--",
    ]);
    expect(code).toBe(1);
  });
});

describe("private Turn launcher subprocess", () => {
  it("forwards argv, stdin, stdout, stderr, and exit code without a shell", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const result = await runTurnLauncher(
      prepared.launcherPath,
      ["im", "send", "hello world", "你好", 'a"b', "$(pwd)", "*"],
      { input: "from-stdin" },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("target-stderr");
    const payload = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    expect(payload.argv).toEqual(["im", "send", "hello world", "你好", 'a"b', "$(pwd)", "*"]);
    expect(payload.stdin).toBe("from-stdin");
  });

  it("propagates the target exit code", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const result = await runTurnLauncher(prepared.launcherPath, [], {
      env: { ...process.env, OPENTAG_TEST_TARGET_EXIT: "7" },
    });
    expect(result.code).toBe(7);
  });

  it("forwards SIGTERM and SIGINT to the target", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });

    async function signalRun(signal: NodeJS.Signals, expected: string): Promise<void> {
      const child = spawn(prepared.launcherPath, [], {
        env: { ...process.env, OPENTAG_TEST_TARGET_MODE: "sleep" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });
      await expect.poll(() => stderr.includes("ready"), { timeout: 5_000 }).toBe(true);
      child.kill(signal);
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (value) => resolve(value ?? 1));
      });
      expect(stderr).toContain(expected);
      expect([130, 143]).toContain(code);
    }

    await signalRun("SIGTERM", "got SIGTERM");
    await signalRun("SIGINT", "got SIGINT");
  }, 15_000);
});
