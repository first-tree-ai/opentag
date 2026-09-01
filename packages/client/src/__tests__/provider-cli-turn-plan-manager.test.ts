import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveProviderCliHomeNamespace,
  deriveProviderCliSessionKey,
  MAX_PROVIDER_CLI_TURN_PLAN_BYTES,
  ProviderCliTurnPlanError,
  ProviderCliTurnPlanManager,
  parseProviderCliTurnPlan,
  readProviderCliTurnPlan,
  resolveProviderCliAccountLayout,
  writeProviderCliSelection,
} from "../index.js";
import { makeTempDir } from "./fixtures/provider-cli.js";
import {
  installTurnTarget,
  makePrivateSlackConfigDir,
  makeTurnPlanHarness,
  providerCliTurnRunnerInvocation,
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

describe("ProviderCliTurnPlanManager prepare", () => {
  it("publishes an external plan under home then session isolation with private modes", async () => {
    const { accountHome, openTagHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const sessionId = "session-1";
    const prepared = await manager.prepare({ provider: "feishu", sessionId, runId: "run-1" });

    expect(prepared.homeNamespace).toBe(deriveProviderCliHomeNamespace(openTagHome));
    expect(prepared.sessionDir).toBe(
      join(layout.plans, prepared.homeNamespace, deriveProviderCliSessionKey(sessionId)),
    );
    expect(prepared.sessionDir.includes(sessionId)).toBe(false);
    expect(prepared.plan).toMatchObject({
      schemaVersion: 1,
      provider: "feishu",
      command: "lark-cli",
      selectionKind: "external",
      selectionVersion: "1.0.92",
      selectionGeneration: 1,
      targetPath: target,
      homeNamespace: prepared.homeNamespace,
      sessionId,
      runId: "run-1",
    });
    expect((await stat(prepared.planPath)).mode & 0o777).toBe(0o600);
    expect((await stat(prepared.launcherPath)).mode & 0o777).toBe(0o700);
    expect((await stat(prepared.sessionDir)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(prepared.sessionDir))).mode & 0o777).toBe(0o700);
    expect((await stat(layout.plans)).mode & 0o777).toBe(0o700);
    const launcher = await readFile(prepared.launcherPath, "utf8");
    expect(launcher.startsWith("#!/bin/sh\n# opentag-provider-cli-turn-launcher: v1 provider=feishu\n")).toBe(true);
    expect(launcher).toContain(providerCliTurnRunnerInvocation()[0]);
    expect(launcher).not.toContain("# opentag-provider-cli-launcher: v1");
  });

  it("publishes a managed plan with artifact identity", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"), "slack");
    const artifactId = await writeManagedTurnSelection(layout, "slack", target, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(accountHome);
    const prepared = await manager.prepare({
      provider: "slack",
      sessionId: "s-1",
      runId: "r-1",
      configDir,
    });
    expect(prepared.plan.selectionKind).toBe("managed");
    expect(prepared.plan.command).toBe("slack");
    expect(prepared.plan.provider === "slack" && prepared.plan.configDir).toBe(configDir);
    if (prepared.plan.selectionKind === "managed") {
      expect(prepared.plan.artifactId).toBe(artifactId);
    }
    expect(prepared.launcherPath.endsWith("/slack")).toBe(true);
  });

  it("freezes the caller Slack config dir and refuses a Feishu config dir", async () => {
    const slack = await trackedHarness();
    const slackTarget = await installTurnTarget(join(slack.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(slack.layout, "slack", slackTarget, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(slack.accountHome);
    const prepared = await slack.manager.prepare({
      provider: "slack",
      sessionId: "s-1",
      runId: "run-1",
      configDir,
    });
    expect(prepared.plan.provider === "slack" && prepared.plan.configDir).toBe(configDir);
    const replacement = await makePrivateSlackConfigDir(slack.accountHome, "other-config");
    const again = await slack.manager.prepare({
      provider: "slack",
      sessionId: "s-1",
      runId: "run-1",
      configDir: replacement,
    });
    expect(again.plan.provider === "slack" && again.plan.configDir).toBe(configDir);

    await expect(slack.manager.prepare({ provider: "slack", sessionId: "s-2", runId: "run-2" })).rejects.toMatchObject({
      code: "plan_invalid",
    });
    await expect(
      slack.manager.prepare({
        provider: "slack",
        sessionId: "s-2",
        runId: "run-2",
        configDir: `${configDir}/../escape`,
      }),
    ).rejects.toMatchObject({ code: "unsafe" });

    const feishu = await trackedHarness();
    const feishuTarget = await installTurnTarget(join(feishu.accountHome, "bin"));
    await writeExternalTurnSelection(feishu.layout, "feishu", feishuTarget);
    await expect(
      feishu.manager.prepare({
        provider: "feishu",
        sessionId: "s-1",
        runId: "run-1",
        configDir,
      }),
    ).rejects.toMatchObject({ code: "plan_invalid" });
  });

  it("hashes path-traversal Session and Run identities into the session key", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const sessionId = "../../escape-home";
    const prepared = await manager.prepare({
      provider: "feishu",
      sessionId,
      runId: "../run/../../other",
    });
    expect(prepared.sessionDir.startsWith(join(layout.plans, prepared.homeNamespace))).toBe(true);
    expect(prepared.sessionDir).not.toContain("escape-home");
    expect(prepared.sessionDir).not.toContain("..");
    expect(prepared.plan.sessionId).toBe(sessionId);
  });

  it("is idempotent for the same Run and refuses a different active Run", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const first = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-a" });
    const again = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-a" });
    expect(again.plan.fingerprint).toBe(first.plan.fingerprint);
    await expect(manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-b" })).rejects.toMatchObject({
      code: "active_run_conflict",
    });
  });

  it("keeps the published plan when selection generation and fingerprint later change", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const original = await installTurnTarget(join(accountHome, "bin"), "lark-cli");
    await writeExternalTurnSelection(layout, "feishu", original, "1.0.91");
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const replacement = await installTurnTarget(join(accountHome, "other"), "lark-cli");
    await writeExternalTurnSelection(layout, "feishu", replacement, "1.0.92");
    const again = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    expect(again.plan.targetPath).toBe(original);
    expect(again.plan.selectionVersion).toBe("1.0.91");
    expect(again.plan.selectionGeneration).toBe(1);
    expect(again.plan.fingerprint).toBe(prepared.plan.fingerprint);
  });

  it("fails closed when the selected target is missing, a symlink path, or a non-regular file", async () => {
    const missing = await trackedHarness();
    const missingTarget = await installTurnTarget(join(missing.accountHome, "bin"));
    await writeExternalTurnSelection(missing.layout, "feishu", missingTarget);
    await rm(missingTarget);
    await expect(
      missing.manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "target_invalid" });

    const linked = await trackedHarness();
    const real = await installTurnTarget(join(linked.accountHome, "bin"));
    const symlinkPath = join(linked.accountHome, "link", "lark-cli");
    await mkdir(dirname(symlinkPath), { recursive: true });
    await symlink(real, symlinkPath);
    await writeProviderCliSelection(
      linked.layout,
      "feishu",
      {
        kind: "external",
        executablePath: symlinkPath,
        fingerprint: `v1:${"ab".repeat(32)}`,
        trust: "compatible-unverified",
        version: "1.0.92",
      },
      undefined,
    );
    await expect(
      linked.manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "artifact_drifted" });

    const directory = await trackedHarness();
    const directoryTarget = join(directory.accountHome, "not-a-file");
    await mkdir(directoryTarget);
    await writeProviderCliSelection(
      directory.layout,
      "feishu",
      {
        kind: "external",
        executablePath: directoryTarget,
        fingerprint: `v1:${"cd".repeat(32)}`,
        trust: "compatible-unverified",
        version: "1.0.92",
      },
      undefined,
    );
    await expect(
      directory.manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "unsafe" });
  });

  it("fails closed on missing or malformed selection", async () => {
    const { manager } = await trackedHarness();
    await expect(manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" })).rejects.toMatchObject({
      code: "selection_missing",
    });
    const { accountHome, layout, manager: manager2 } = await trackedHarness();
    await mkdir(join(layout.state), { recursive: true, mode: 0o700 });
    await writeFile(join(layout.state, "feishu.json"), "{not-json", { mode: 0o600 });
    await expect(manager2.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" })).rejects.toBeInstanceOf(
      ProviderCliTurnPlanError,
    );
    expect(accountHome).toBeTruthy();
  });

  it("refuses to publish a Run plan when daemon readiness accepted a different selection", async () => {
    const base = await makeTurnPlanHarness();
    tempDirs.push(base.accountHome, base.openTagHome);
    const target = await installTurnTarget(join(base.accountHome, "bin"));
    const record = await writeExternalTurnSelection(base.layout, "feishu", target);
    const manager = new ProviderCliTurnPlanManager({
      accountHome: base.accountHome,
      openTagHome: base.openTagHome,
      readySelection: async () => ({
        fingerprint: record.selection.fingerprint,
        generation: record.generation + 1,
        path: target,
        version: record.selection.version,
      }),
      runnerInvocation: providerCliTurnRunnerInvocation(),
    });

    await expect(manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" })).rejects.toMatchObject({
      code: "selection_invalid",
    });
  });

  it("rejects empty, oversized, or control-character identities", async () => {
    const { manager } = await trackedHarness();
    await expect(manager.prepare({ provider: "feishu", sessionId: "", runId: "run-1" })).rejects.toMatchObject({
      code: "invalid_identity",
    });
    await expect(manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run\nid" })).rejects.toMatchObject({
      code: "invalid_identity",
    });
  });

  it("prepares the same Run concurrently without creating a second plan", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const [left, right] = await Promise.all([
      manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" }),
      manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" }),
    ]);
    expect(left.plan.runId).toBe("run-1");
    expect(right.plan.runId).toBe("run-1");
    expect(left.plan.fingerprint).toBe(right.plan.fingerprint);
  });

  it("allows only one of two concurrent different Runs to become active", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const results = await Promise.allSettled([
      manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" }),
      manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-2" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toMatchObject({ code: "active_run_conflict" });
  });
});

describe("ProviderCliTurnPlanManager isolation and cleanup", () => {
  it("maps symlink aliases of the same OpenTag Home to one namespace", async () => {
    const { accountHome, openTagHome, manager } = await trackedHarness();
    const alias = join(accountHome, "opentag-home-alias");
    await symlink(openTagHome, alias);
    const aliased = new ProviderCliTurnPlanManager({
      accountHome,
      openTagHome: alias,
      runnerInvocation: providerCliTurnRunnerInvocation(),
    });

    expect(aliased.homeNamespace).toBe(manager.homeNamespace);
    expect(() => deriveProviderCliHomeNamespace("relative-home")).toThrow(ProviderCliTurnPlanError);
  });

  it("isolates Sessions and OpenTag Homes under one account", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const sessionA = await manager.prepare({ provider: "feishu", sessionId: "session-a", runId: "run-a" });
    const sessionB = await manager.prepare({ provider: "feishu", sessionId: "session-b", runId: "run-b" });
    expect(sessionA.sessionDir).not.toBe(sessionB.sessionDir);

    const otherHome = await makeTempDir("opentag-turn-plan-home-b-");
    tempDirs.push(otherHome);
    const other = new ProviderCliTurnPlanManager({
      accountHome,
      openTagHome: otherHome,
      runnerInvocation: providerCliTurnRunnerInvocation(),
    });
    const otherPrepared = await other.prepare({ provider: "feishu", sessionId: "session-a", runId: "run-a" });
    expect(otherPrepared.homeNamespace).not.toBe(sessionA.homeNamespace);
    expect(otherPrepared.sessionDir).not.toBe(sessionA.sessionDir);
  });

  it("cleanup removes only the matching Run", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    await expect(manager.cleanup({ provider: "feishu", sessionId: "s-1", runId: "run-other" })).rejects.toMatchObject({
      code: "run_mismatch",
    });
    expect((await lstat(prepared.planPath)).isFile()).toBe(true);
    await manager.cleanup({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    await expect(stat(prepared.planPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(prepared.sessionDir)).isDirectory()).toBe(true);

    const next = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-2" });
    expect((await stat(next.planPath)).isFile()).toBe(true);
    expect(next.plan.runId).toBe("run-2");
  });

  it("cleanup after abort removes the plan but keeps a fail-closed PATH sentinel", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-abort", runId: "run-abort" });
    await manager.cleanup({ provider: "feishu", sessionId: "s-abort", runId: "run-abort" });
    expect((await stat(prepared.launcherPath)).isFile()).toBe(true);
    await expect(readProviderCliTurnPlan(prepared.planPath)).resolves.toBeUndefined();
  });

  it("crash recovery clears this Home namespace only", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const keptHome = await makeTempDir("opentag-turn-plan-home-keep-");
    tempDirs.push(keptHome);
    const other = new ProviderCliTurnPlanManager({
      accountHome,
      openTagHome: keptHome,
      runnerInvocation: providerCliTurnRunnerInvocation(),
    });
    const local = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const foreign = await other.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    await manager.recover();
    await expect(stat(local.planPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(foreign.planPath)).isFile()).toBe(true);
    expect(foreign.homeNamespace).not.toBe(local.homeNamespace);
  });

  it("crash recovery refuses a symlinked plans root", async () => {
    const { layout, manager } = await trackedHarness();
    const outside = await makeTempDir("opentag-turn-plan-outside-");
    tempDirs.push(outside);
    await mkdir(layout.root, { recursive: true, mode: 0o700 });
    await symlink(outside, layout.plans);

    await expect(manager.recover()).rejects.toMatchObject({ code: "unsafe" });
    expect((await stat(outside)).isDirectory()).toBe(true);
  });
});

describe("Provider CLI Turn plan schema", () => {
  it("rejects unknown schema, provider mismatch, oversize, symlink, and non-regular plans", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });

    await writeFile(prepared.planPath, `${JSON.stringify({ schemaVersion: 2, provider: "feishu" })}\n`, {
      mode: 0o600,
    });
    await expect(readProviderCliTurnPlan(prepared.planPath)).rejects.toMatchObject({ code: "plan_invalid" });

    const valid = {
      schemaVersion: 1,
      provider: "slack",
      command: "lark-cli",
      selectionKind: "external",
      selectionVersion: "1.0.92",
      selectionGeneration: 1,
      targetPath: target,
      fingerprint: prepared.plan.fingerprint,
      homeNamespace: prepared.homeNamespace,
      sessionId: "s-1",
      runId: "run-1",
    };
    expect(() => parseProviderCliTurnPlan(valid)).toThrow(ProviderCliTurnPlanError);

    await writeFile(prepared.planPath, `${"x".repeat(MAX_PROVIDER_CLI_TURN_PLAN_BYTES + 8)}\n`, { mode: 0o600 });
    await expect(readProviderCliTurnPlan(prepared.planPath)).rejects.toMatchObject({ code: "too_large" });

    await rm(prepared.planPath);
    await symlink(target, prepared.planPath);
    await expect(readProviderCliTurnPlan(prepared.planPath)).rejects.toMatchObject({ code: "unsafe" });

    await rm(prepared.planPath);
    await mkdir(prepared.planPath);
    await expect(readProviderCliTurnPlan(prepared.planPath)).rejects.toMatchObject({ code: "unsafe" });
  });

  it("accepts only the exact Slack and Feishu plan keys", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const configDir = await makePrivateSlackConfigDir(accountHome);
    const feishuExternal = {
      schemaVersion: 1 as const,
      provider: "feishu" as const,
      command: "lark-cli" as const,
      selectionKind: "external" as const,
      selectionVersion: "1.0.92",
      selectionGeneration: 1,
      targetPath: target,
      fingerprint: prepared.plan.fingerprint,
      homeNamespace: prepared.homeNamespace,
      sessionId: "s-1",
      runId: "run-1",
    };
    expect(parseProviderCliTurnPlan(feishuExternal).provider).toBe("feishu");
    expect(() => parseProviderCliTurnPlan({ ...feishuExternal, configDir })).toThrow(ProviderCliTurnPlanError);
    expect(() => parseProviderCliTurnPlan({ ...feishuExternal, extra: true })).toThrow(ProviderCliTurnPlanError);

    const slackExternal = {
      ...feishuExternal,
      provider: "slack" as const,
      command: "slack" as const,
      selectionVersion: "4.7.0",
      configDir,
    };
    expect(parseProviderCliTurnPlan(slackExternal)).toMatchObject({ provider: "slack", configDir });
    const slackWithoutConfig = { ...feishuExternal, provider: "slack" as const, command: "slack" as const };
    expect(() => parseProviderCliTurnPlan(slackWithoutConfig)).toThrow(ProviderCliTurnPlanError);
    expect(() => parseProviderCliTurnPlan({ ...slackExternal, extra: true })).toThrow(ProviderCliTurnPlanError);
    expect(() => parseProviderCliTurnPlan({ ...slackExternal, artifactId: "unexpected" })).toThrow(
      ProviderCliTurnPlanError,
    );

    const slackManaged = {
      ...slackExternal,
      selectionKind: "managed" as const,
      artifactId: "4.7.0/test-platform/aa".padEnd(64, "a"),
    };
    expect(parseProviderCliTurnPlan(slackManaged).selectionKind).toBe("managed");
    expect(() => parseProviderCliTurnPlan({ ...slackExternal, selectionKind: "managed" })).toThrow(
      ProviderCliTurnPlanError,
    );
  });

  it("fails closed when the plan file is unreadable", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    await chmod(prepared.planPath, 0o000);
    try {
      await expect(readProviderCliTurnPlan(prepared.planPath)).rejects.toBeDefined();
    } finally {
      await chmod(prepared.planPath, 0o600);
    }
  });

  it("does not rewrite the account-global launcher v1 marker", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    await expect(stat(join(layout.bin, "lark-cli"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("resolveProviderCliAccountLayout plans root", () => {
  it("keeps Turn plans on the reserved account-global plans directory", async () => {
    const accountHome = await makeTempDir("opentag-turn-plan-layout-");
    tempDirs.push(accountHome);
    const layout = resolveProviderCliAccountLayout(accountHome);
    expect(layout.plans).toBe(join(layout.root, "plans"));
  });
});
