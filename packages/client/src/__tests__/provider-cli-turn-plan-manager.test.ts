import { chmod, lstat, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeFileIdentity,
  computeTargetFingerprint,
  deriveProviderCliHomeNamespace,
  deriveProviderCliRunKey,
  deriveProviderCliSessionKey,
  MAX_PROVIDER_CLI_TURN_PLAN_BYTES,
  type ProviderCliTurnPlan,
  ProviderCliTurnPlanError,
  ProviderCliTurnPlanManager,
  parseProviderCliTurnPlan,
  readProviderCliTurnPlan,
  resolveProviderCliAccountLayout,
  writeProviderCliSelection,
} from "../index.js";
import {
  collectOutgoingReplyReceipts,
  writeOutgoingReplyReceipt,
} from "../runtime/provider-cli/outgoing-reply-store.js";
import * as turnPlanStorage from "../runtime/provider-cli/turn-plan.js";
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

/** Copy an existing plan document verbatim into another Session directory. */
async function seedPlanCopy(sessionDir: string, content: string): Promise<void> {
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(dirname(sessionDir), 0o700);
  await chmod(sessionDir, 0o700);
  await writeFile(join(sessionDir, "plan.json"), content, { mode: 0o600 });
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
    expect(prepared.plan.captureOutgoingReplies).toBeUndefined();
  });

  it("opts in to Feishu outgoing reply capture and rejects Slack capture", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const captured = await manager.prepare({
      provider: "feishu",
      sessionId: "s-cap",
      runId: "run-cap",
      captureOutgoingReplies: true,
    });
    expect(captured.plan.captureOutgoingReplies).toBe(true);
    await expect(manager.prepare({ provider: "feishu", sessionId: "s-cap", runId: "run-cap" })).rejects.toMatchObject({
      code: "active_run_conflict",
    });
    const slackTarget = await installTurnTarget(join(accountHome, "bin-slack"), "slack");
    await writeExternalTurnSelection(layout, "slack", slackTarget, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(accountHome);
    await expect(
      manager.prepare({
        provider: "slack",
        sessionId: "s-slack",
        runId: "run-slack",
        configDir,
        captureOutgoingReplies: true,
      }),
    ).rejects.toMatchObject({ code: "plan_invalid" });
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

  it("does not publish a plan when the caller aborts while waiting for readiness", async () => {
    const base = await makeTurnPlanHarness();
    tempDirs.push(base.accountHome, base.openTagHome);
    const target = await installTurnTarget(join(base.accountHome, "bin"));
    const record = await writeExternalTurnSelection(base.layout, "feishu", target);
    const ready = {
      fingerprint: record.selection.fingerprint,
      generation: record.generation,
      path: target,
      version: record.selection.version,
    };
    let settleReady!: (value: typeof ready) => void;
    const readySelection = vi.fn((_provider: "feishu" | "slack", signal?: AbortSignal) => {
      return new Promise<typeof ready>((resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          reject(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        settleReady = (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
      });
    });
    const manager = new ProviderCliTurnPlanManager({
      accountHome: base.accountHome,
      openTagHome: base.openTagHome,
      readySelection,
      runnerInvocation: providerCliTurnRunnerInvocation(),
    });
    const abort = new AbortController();
    const preparing = manager.prepare(
      { provider: "feishu", sessionId: "s-abort-wait", runId: "run-abort-wait" },
      abort.signal,
    );
    await vi.waitFor(() => expect(readySelection).toHaveBeenCalledOnce());
    expect(readySelection).toHaveBeenCalledWith("feishu", abort.signal);
    abort.abort("turn_timeout");
    await expect(preparing).rejects.toSatisfy(
      (error) => error === "turn_timeout" || (error instanceof Error && error.name === "AbortError"),
    );
    settleReady(ready);
    await Promise.resolve();
    await expect(
      readProviderCliTurnPlan(join(manager.sessionDir("s-abort-wait"), "plan.json")),
    ).resolves.toBeUndefined();
  });

  it("discards this Run's plan when abort races exclusive publication", async () => {
    const base = await makeTurnPlanHarness();
    tempDirs.push(base.accountHome, base.openTagHome);
    const target = await installTurnTarget(join(base.accountHome, "bin"));
    const record = await writeExternalTurnSelection(base.layout, "feishu", target);
    const abort = new AbortController();
    const manager = new ProviderCliTurnPlanManager({
      accountHome: base.accountHome,
      openTagHome: base.openTagHome,
      readySelection: async () => ({
        fingerprint: record.selection.fingerprint,
        generation: record.generation,
        path: target,
        version: record.selection.version,
      }),
      runnerInvocation: providerCliTurnRunnerInvocation(),
    });
    let didPublish!: () => void;
    const published = new Promise<void>((resolve) => {
      didPublish = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = turnPlanStorage.publishProviderCliTurnPlanExclusive;
    const publishing = vi
      .spyOn(turnPlanStorage, "publishProviderCliTurnPlanExclusive")
      .mockImplementationOnce(async (path, plan) => {
        const result = await publish(path, plan);
        expect(await readProviderCliTurnPlan(path)).toMatchObject({ runId: "run-late-publish" });
        didPublish();
        await released;
        return result;
      });
    try {
      const first = manager.prepare(
        { provider: "feishu", sessionId: "s-late-publish", runId: "run-late-publish" },
        abort.signal,
      );
      const rejected = expect(first).rejects.toBe("turn_timeout");
      await published;
      abort.abort("turn_timeout");
      const next = manager.prepare({ provider: "feishu", sessionId: "s-late-publish", runId: "run-next" });
      release();
      await rejected;
      const prepared = await next;
      expect(await readProviderCliTurnPlan(prepared.planPath)).toMatchObject({ runId: "run-next" });
    } finally {
      release();
      publishing.mockRestore();
    }
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

  it("publishes Slack proxy plans and reports the account layout", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"), "slack");
    const artifactId = await writeManagedTurnSelection(layout, "slack", target, "4.7.0");
    const configDir = await makePrivateSlackConfigDir(accountHome);
    const environmentManifest = join(accountHome, "environment.json");
    expect(manager.layout).toEqual(layout);

    const managed = await manager.prepare({
      provider: "slack",
      sessionId: "s-managed-proxy",
      runId: "run-1",
      configDir,
      environmentManifest,
      slackApiHost: "https://127.0.0.1:9",
    });
    expect(managed.plan).toMatchObject({
      selectionKind: "managed",
      artifactId,
      environmentManifest,
      slackApiHost: "https://127.0.0.1:9",
    });

    await writeExternalTurnSelection(layout, "slack", target, "4.7.0");
    const external = await manager.prepare({
      provider: "slack",
      sessionId: "s-external-proxy",
      runId: "run-1",
      configDir,
      slackApiHost: "https://127.0.0.1:9",
    });
    expect(external.plan).toMatchObject({
      selectionKind: "external",
      slackApiHost: "https://127.0.0.1:9",
    });
  });

  it("rejects non-canonical proxy, identity, and capture inputs before publishing", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const rejected = async (override: Record<string, unknown>) =>
      await manager.prepare({ provider: "feishu", sessionId: "s-proxy", runId: "run-1", ...override });

    await expect(rejected({ runId: "x".repeat(5000) })).rejects.toMatchObject({ code: "invalid_identity" });
    await expect(rejected({ environmentManifest: "relative/manifest.json" })).rejects.toMatchObject({
      code: "plan_invalid",
    });
    await expect(rejected({ environmentManifest: "{{ .. }}" })).rejects.toMatchObject({ code: "plan_invalid" });
    await expect(rejected({ slackApiHost: "https://127.0.0.1:9" })).rejects.toMatchObject({
      code: "plan_invalid",
    });
    await expect(rejected({ captureOutgoingReplies: "yes" as unknown as boolean })).rejects.toMatchObject({
      code: "plan_invalid",
    });

    const slack = await trackedHarness();
    const slackTarget = await installTurnTarget(join(slack.accountHome, "bin"), "slack");
    await writeExternalTurnSelection(slack.layout, "slack", slackTarget, "4.7.0");
    await expect(
      slack.manager.prepare({
        provider: "slack",
        sessionId: "s-proxy",
        runId: "run-1",
        configDir: await makePrivateSlackConfigDir(slack.accountHome),
        slackApiHost: "http://127.0.0.1:9",
      }),
    ).rejects.toMatchObject({ code: "plan_invalid" });
  });

  it("fails closed on a drifted managed fingerprint and on unpublished exclusivity races", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    const identity = await computeFileIdentity(target);
    await writeProviderCliSelection(
      layout,
      "feishu",
      {
        kind: "managed",
        artifactId: `1.0.92/test-platform/${"bb".repeat(32)}`,
        version: "1.0.92",
        targetPath: identity.path,
        fingerprint: computeTargetFingerprint(identity, "1.0.92", "aa".repeat(32)),
      },
      undefined,
    );
    await expect(manager.prepare({ provider: "feishu", sessionId: "s-drift", runId: "run-1" })).rejects.toMatchObject({
      code: "artifact_drifted",
    });

    await writeExternalTurnSelection(layout, "feishu", target);
    const racing = vi.spyOn(turnPlanStorage, "publishProviderCliTurnPlanExclusive").mockResolvedValueOnce("exists");
    try {
      await expect(manager.prepare({ provider: "feishu", sessionId: "s-race", runId: "run-1" })).rejects.toMatchObject({
        code: "plan_invalid",
      });
    } finally {
      racing.mockRestore();
    }

    const failing = vi
      .spyOn(turnPlanStorage, "publishProviderCliTurnPlanExclusive")
      .mockRejectedValueOnce(Object.assign(new Error("link is not permitted"), { code: "EPERM" }));
    try {
      await expect(manager.prepare({ provider: "feishu", sessionId: "s-link", runId: "run-1" })).rejects.toMatchObject({
        message: "link is not permitted",
      });
    } finally {
      failing.mockRestore();
    }
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

  it("crash recovery preserves outgoing receipt evidence and still drops the plan", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const local = await manager.prepare({ provider: "feishu", sessionId: "s-keep", runId: "run-keep" });
    await writeOutgoingReplyReceipt({
      plansRoot: layout.plans,
      sessionDir: local.sessionDir,
      runId: "run-keep",
      receipt: {
        recordedAt: "2026-09-08T08:00:00.000Z",
        sequenceHint: 1,
        kind: "send",
        messageId: "om_kept",
        chatId: "oc_chat",
        contentStatus: "unavailable",
        content: { msgType: "unknown", unavailable: "content_read_failed" },
      },
    });
    await manager.recover();
    await expect(stat(local.planPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(local.sessionDir)).isDirectory()).toBe(true);
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: local.sessionDir,
      runId: "run-keep",
      waitMs: 0,
    });
    expect(collected.receipts.map((receipt) => receipt.messageId)).toEqual(["om_kept"]);
  });

  it("treats a missing nested outgoing-replies directory as absent evidence", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const local = await manager.prepare({ provider: "feishu", sessionId: "s-empty", runId: "run-empty" });
    await mkdir(join(local.sessionDir, "runs", deriveProviderCliRunKey("run-empty")), {
      recursive: true,
      mode: 0o700,
    });
    await manager.recover();
    await expect(stat(local.sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an uninspectable nested outgoing-replies directory", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const local = await manager.prepare({ provider: "feishu", sessionId: "s-lock", runId: "run-lock" });
    const nested = join(local.sessionDir, "runs", deriveProviderCliRunKey("run-lock"), "outgoing-replies");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await chmod(nested, 0o000);
    try {
      await manager.recover();
      await expect(stat(local.planPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(local.sessionDir)).isDirectory()).toBe(true);
    } finally {
      await chmod(nested, 0o700).catch(() => undefined);
    }
  });

  it("sweeps inspectable abandoned receipt runs during recovery", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const local = await manager.prepare({ provider: "feishu", sessionId: "s-old", runId: "run-old" });
    await writeOutgoingReplyReceipt({
      plansRoot: layout.plans,
      sessionDir: local.sessionDir,
      runId: "run-old",
      receipt: {
        recordedAt: "2026-09-01T08:00:00.000Z",
        sequenceHint: 1,
        kind: "send",
        messageId: "om_old",
        chatId: "oc_chat",
        contentStatus: "unavailable",
        content: { msgType: "unknown", unavailable: "content_read_failed" },
      },
    });
    const aged = Date.now() / 1000 - 8 * 24 * 60 * 60;
    const runDir = join(local.sessionDir, "runs", deriveProviderCliRunKey("run-old"));
    await utimes(runDir, aged, aged);
    await utimes(join(runDir, "outgoing-replies"), aged, aged);
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(join(runDir, "outgoing-replies"))) {
      await utimes(join(runDir, "outgoing-replies", name), aged, aged);
    }
    await manager.recover();
    await expect(stat(local.sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("sweeps abandoned runs while preserving an existing active plan=%s", async (active) => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const local = await manager.prepare({ provider: "feishu", sessionId: "s-next", runId: "run-old" });
    await writeOutgoingReplyReceipt({
      plansRoot: layout.plans,
      sessionDir: local.sessionDir,
      runId: "run-old",
      receipt: {
        recordedAt: "2026-09-01T08:00:00.000Z",
        sequenceHint: 1,
        kind: "send",
        messageId: "om_old",
        chatId: "oc_chat",
        contentStatus: "unavailable",
        content: { msgType: "unknown", unavailable: "content_read_failed" },
      },
    });
    if (!active) await manager.cleanup({ provider: "feishu", sessionId: "s-next", runId: "run-old" });
    const aged = Date.now() / 1000 - 8 * 24 * 60 * 60;
    const runDir = join(local.sessionDir, "runs", deriveProviderCliRunKey("run-old"));
    await utimes(runDir, aged, aged);
    await utimes(join(runDir, "outgoing-replies"), aged, aged);
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(join(runDir, "outgoing-replies"))) {
      await utimes(join(runDir, "outgoing-replies", name), aged, aged);
    }
    const preparing = manager.prepare({ provider: "feishu", sessionId: "s-next", runId: "run-new" });
    if (active) await expect(preparing).rejects.toMatchObject({ code: "active_run_conflict" });
    else await preparing;
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: local.sessionDir,
      runId: "run-old",
      waitMs: 0,
    });
    expect(collected.receipts).toHaveLength(active ? 1 : 0);
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

  it("cleanup fails closed on absent, unmatched, unparseable, and unreadable Session plans", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    await expect(
      manager.cleanup({ provider: "feishu", sessionId: "s-absent", runId: "run-1" }),
    ).resolves.toBeUndefined();

    const source = await manager.prepare({ provider: "feishu", sessionId: "s-source", runId: "run-source" });
    const document = await readFile(source.planPath, "utf8");

    const empty = manager.sessionDir("s-emptied");
    await mkdir(empty, { recursive: true, mode: 0o700 });
    await chmod(dirname(empty), 0o700);
    await chmod(empty, 0o700);
    await expect(
      manager.cleanup({ provider: "feishu", sessionId: "s-emptied", runId: "run-1" }),
    ).resolves.toBeUndefined();

    await seedPlanCopy(manager.sessionDir("s-other-session"), document);
    await expect(
      manager.cleanup({ provider: "feishu", sessionId: "s-other-session", runId: "run-source" }),
    ).rejects.toMatchObject({ code: "session_mismatch" });
    await expect(
      manager.cleanup({ provider: "slack", sessionId: "s-source", runId: "run-source" }),
    ).rejects.toMatchObject({ code: "provider_mismatch" });

    await seedPlanCopy(manager.sessionDir("s-corrupt"), "{not-json");
    await expect(manager.cleanup({ provider: "feishu", sessionId: "s-corrupt", runId: "run-1" })).rejects.toMatchObject(
      { code: "plan_invalid" },
    );

    const locked = manager.sessionDir("s-locked");
    await mkdir(locked, { recursive: true, mode: 0o700 });
    await chmod(dirname(locked), 0o700);
    await chmod(locked, 0o000);
    try {
      await expect(
        manager.cleanup({ provider: "feishu", sessionId: "s-locked", runId: "run-1" }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(locked, 0o700).catch(() => undefined);
    }
  });

  it("crash recovery skips foreign entries and refuses an unreadable Home directory", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-foreign", runId: "run-1" });
    const homeDir = dirname(prepared.sessionDir);
    await writeFile(join(homeDir, "stray.txt"), "not a session\n", { mode: 0o600 });
    const linkName = `s-${"ab".repeat(20)}`;
    await symlink(prepared.sessionDir, join(homeDir, linkName));

    await manager.recover();
    await expect(stat(prepared.sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(homeDir, "stray.txt"))).isFile()).toBe(true);
    expect((await lstat(join(homeDir, linkName))).isSymbolicLink()).toBe(true);

    const unreadable = await trackedHarness();
    const unreadableTarget = await installTurnTarget(join(unreadable.accountHome, "bin"));
    await writeExternalTurnSelection(unreadable.layout, "feishu", unreadableTarget);
    const blocked = await unreadable.manager.prepare({ provider: "feishu", sessionId: "s-blocked", runId: "run-1" });
    await chmod(dirname(blocked.sessionDir), 0o000);
    try {
      await expect(unreadable.manager.recover()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(dirname(blocked.sessionDir), 0o700).catch(() => undefined);
    }
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
    expect(parseProviderCliTurnPlan({ ...feishuExternal, captureOutgoingReplies: true }).captureOutgoingReplies).toBe(
      true,
    );
    expect(
      parseProviderCliTurnPlan({ ...feishuExternal, captureOutgoingReplies: false }).captureOutgoingReplies,
    ).toBeUndefined();
    expect(() => parseProviderCliTurnPlan({ ...feishuExternal, captureOutgoingReplies: "yes" })).toThrow(
      ProviderCliTurnPlanError,
    );
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
    expect(
      parseProviderCliTurnPlan({ ...slackExternal, captureOutgoingReplies: false }).captureOutgoingReplies,
    ).toBeUndefined();
    expect(() => parseProviderCliTurnPlan({ ...slackExternal, captureOutgoingReplies: true })).toThrow(
      ProviderCliTurnPlanError,
    );
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

  it("rejects malformed plan identity, generation, selection, and proxy fields", async () => {
    const base = {
      schemaVersion: 1,
      provider: "feishu",
      command: "lark-cli",
      selectionKind: "external",
      selectionVersion: "1.0.92",
      selectionGeneration: 1,
      targetPath: "/opt/opentag/bin/lark-cli",
      fingerprint: `v1:${"ab".repeat(32)}`,
      homeNamespace: `h-${"cd".repeat(20)}`,
      sessionId: "s-1",
      runId: "run-1",
    };
    const slack = {
      ...base,
      provider: "slack",
      command: "slack",
      configDir: "/opt/opentag/slack-config",
    };
    const rejects = (record: Record<string, unknown>) => () => parseProviderCliTurnPlan(record);

    expect(parseProviderCliTurnPlan(base).provider).toBe("feishu");
    expect(parseProviderCliTurnPlan(slack).provider).toBe("slack");
    expect(rejects({ ...base, provider: "github" })).toThrow(ProviderCliTurnPlanError);
    expect(rejects({ ...base, command: "slack" })).toThrow(ProviderCliTurnPlanError);
    for (const selectionGeneration of ["1", 1.5, 0, -1]) {
      expect(rejects({ ...base, selectionGeneration })).toThrow(ProviderCliTurnPlanError);
    }

    for (const override of [
      { selectionVersion: "" },
      { selectionVersion: "not-semver" },
      { targetPath: "" },
      { targetPath: "relative/lark-cli" },
      { fingerprint: "v1:nope" },
      { homeNamespace: 42 },
      { homeNamespace: "not-a-namespace" },
      { sessionId: "" },
      { runId: "" },
      { runId: "x".repeat(5000) },
      { selectionKind: "unknown" },
    ]) {
      expect(rejects({ ...base, ...override })).toThrow(ProviderCliTurnPlanError);
    }

    expect(
      parseProviderCliTurnPlan({ ...base, selectionKind: "managed", artifactId: "1.0.92/test-platform/aa" }),
    ).toMatchObject({ selectionKind: "managed" });
    expect(rejects({ ...base, selectionKind: "managed" })).toThrow(ProviderCliTurnPlanError);
    expect(rejects({ ...base, selectionKind: "managed", artifactId: "" })).toThrow(ProviderCliTurnPlanError);
    expect(rejects({ ...base, artifactId: "unexpected" })).toThrow(ProviderCliTurnPlanError);
    expect(rejects({ ...slack, selectionKind: "unknown" })).toThrow(ProviderCliTurnPlanError);
    expect(rejects({ ...slack, selectionKind: "managed" })).toThrow(ProviderCliTurnPlanError);

    expect(parseProviderCliTurnPlan({ ...base, captureOutgoingReplies: true })).toMatchObject({
      captureOutgoingReplies: true,
    });
    expect(parseProviderCliTurnPlan({ ...base, captureOutgoingReplies: false })).not.toHaveProperty(
      "captureOutgoingReplies",
    );
    expect(rejects({ ...base, captureOutgoingReplies: "true" })).toThrow(ProviderCliTurnPlanError);

    for (const environmentManifest of [42, "relative/manifest.json", "{{ .. }}"]) {
      expect(rejects({ ...base, environmentManifest })).toThrow(ProviderCliTurnPlanError);
    }
    const manifests = ["/opt/opentag/manifest.json"];
    const feishuManaged = {
      ...base,
      selectionKind: "managed",
      artifactId: "1.0.92/test-platform/aa",
    };
    expect(parseProviderCliTurnPlan({ ...base, environmentManifest: manifests[0] })).toMatchObject({
      environmentManifest: manifests[0],
    });
    expect(parseProviderCliTurnPlan(feishuManaged)).toMatchObject({ selectionKind: "managed" });
    expect(parseProviderCliTurnPlan({ ...feishuManaged, environmentManifest: manifests[0] })).toMatchObject({
      environmentManifest: manifests[0],
    });

    for (const slackApiHost of [42, "https://example.com", "http://127.0.0.1:9"]) {
      expect(rejects({ ...slack, slackApiHost })).toThrow(ProviderCliTurnPlanError);
    }
    const apiHost = "https://127.0.0.1:9123";
    const slackManaged = {
      ...slack,
      selectionKind: "managed",
      artifactId: "4.7.0/test-platform/aa",
    };
    expect(parseProviderCliTurnPlan({ ...slack, slackApiHost: apiHost })).toMatchObject({ slackApiHost: apiHost });
    expect(parseProviderCliTurnPlan(slackManaged)).toMatchObject({ selectionKind: "managed" });
    expect(parseProviderCliTurnPlan({ ...slackManaged, slackApiHost: apiHost })).toMatchObject({
      slackApiHost: apiHost,
    });

    expect(rejects({ ...slack, configDir: 42 })).toThrow(ProviderCliTurnPlanError);
    expect(rejects({ ...base, configDir: "/opt/opentag/slack-config" })).toThrow(ProviderCliTurnPlanError);
  });

  it("fails closed on an unreadable, unparseable, oversized, or non-private plan file", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });

    await writeFile(prepared.planPath, "{not-json}", { mode: 0o600 });
    await expect(readProviderCliTurnPlan(prepared.planPath)).rejects.toMatchObject({ code: "plan_invalid" });

    await chmod(prepared.planPath, 0o644);
    await expect(readProviderCliTurnPlan(prepared.planPath)).rejects.toMatchObject({ code: "unsafe" });
    await chmod(prepared.planPath, 0o600);

    const blocked = join(accountHome, "blocked-plans");
    await mkdir(blocked, { recursive: true, mode: 0o700 });
    await writeFile(join(blocked, "plan.json"), "{}\n", { mode: 0o600 });
    await chmod(blocked, 0o000);
    try {
      await expect(readProviderCliTurnPlan(join(blocked, "plan.json"))).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(blocked, 0o700).catch(() => undefined);
    }

    const publishRoot = await makeTempDir("opentag-turn-plan-publish-");
    tempDirs.push(publishRoot);
    await mkdir(publishRoot, { recursive: true, mode: 0o700 });
    await chmod(publishRoot, 0o700);
    const planPath = join(publishRoot, "plan.json");
    const writable = { ...prepared.plan } as ProviderCliTurnPlan;
    await expect(turnPlanStorage.publishProviderCliTurnPlanExclusive(planPath, writable)).resolves.toBe("created");
    await expect(turnPlanStorage.publishProviderCliTurnPlanExclusive(planPath, writable)).resolves.toBe("exists");

    const oversized = {
      ...writable,
      targetPath: `/${"a".repeat(MAX_PROVIDER_CLI_TURN_PLAN_BYTES)}`,
    } as ProviderCliTurnPlan;
    await expect(turnPlanStorage.publishProviderCliTurnPlanExclusive(planPath, oversized)).rejects.toMatchObject({
      code: "too_large",
    });

    expect(() => turnPlanStorage.assertPlanWithinRoot(publishRoot, join(publishRoot, "..", "escape"))).toThrow(
      ProviderCliTurnPlanError,
    );
    expect(() => deriveProviderCliHomeNamespace(join(publishRoot, "missing-home"))).toThrow(ProviderCliTurnPlanError);
    expect(() =>
      turnPlanStorage.providerCliPlanSessionDir(
        resolveProviderCliAccountLayout(publishRoot),
        deriveProviderCliHomeNamespace(publishRoot),
        "not-a-session-key",
      ),
    ).toThrow(ProviderCliTurnPlanError);
    expect(turnPlanStorage.planCapturesOutgoingReplies(writable)).toBe(false);
  });

  it("rejects a relative OpenTag Home and tolerates an absent Session directory", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    expect(
      () =>
        new ProviderCliTurnPlanManager({
          accountHome: "/opt/opentag-account",
          openTagHome: "relative-opentag-home",
          runnerInvocation: providerCliTurnRunnerInvocation(),
        }),
    ).toThrow(ProviderCliTurnPlanError);

    await expect(
      manager.cleanup({ provider: "feishu", sessionId: "s-absent", runId: "run-1" }),
    ).resolves.toBeUndefined();
    await expect(manager.recover()).resolves.toBeUndefined();
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
