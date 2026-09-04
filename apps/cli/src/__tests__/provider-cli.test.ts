import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  PROVIDER_CLI_CATALOG,
  PROVIDER_CLI_LOCK_BUSY_RETRY_DELAY_MS,
  type ProviderCliCatalogEntry,
  providerCliLockFilePath,
  resolveProviderCliAccountLayout,
} from "@opentag/client";
import { StructuredErrorSchema } from "@opentag/shared";
import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";

// Real child-process CLI cases need headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import { registerProviderCliCommand } from "../commands/provider-cli.js";
import { runProviderCliEnsure } from "../core/provider-cli/ensure.js";
import { runProviderCliInspect } from "../core/provider-cli/inspect.js";
import { renderProviderCliHumanValue } from "../core/provider-cli/shared.js";
import { makeManagedFixture, makeTempDir, writeFakeCli } from "./provider-cli-fixtures.js";

describe("provider-cli command surface", () => {
  it("escapes control characters in human-facing values", () => {
    expect(renderProviderCliHumanValue("/tmp/evil\n\u001b[31m")).toBe("/tmp/evil\\u000a\\u001b[31m");
  });

  it("registers inspect and ensure with the documented flags", () => {
    const program = new Command().name("opentag");
    registerProviderCliCommand(program);
    const providerCli = program.commands.find((command) => command.name() === "provider-cli");
    expect(providerCli).toBeDefined();
    const names = providerCli?.commands.map((command) => command.name());
    expect(names).toEqual(["inspect", "ensure"]);

    const ensure = providerCli?.commands.find((command) => command.name() === "ensure");
    const flags = ensure?.options.map((option) => option.long);
    expect(flags).toEqual(["--provider", "--managed-only", "--no-path-update", "--dry-run", "--json"]);
  });

  it("exits 2 on an unknown --provider value", async () => {
    const stderr: string[] = [];
    const result = await runProviderCliEnsure({
      provider: "bogus",
      accountHome: "/nonexistent",
      stderr: (chunk) => stderr.push(chunk),
      stdout: () => undefined,
    });
    expect(result.exitCode).toBe(2);
    expect(stderr.join("")).toContain("Unknown provider");
  });

  it("returns a structured validation error for an unknown provider in JSON mode", async () => {
    const stderr: string[] = [];
    const result = await runProviderCliEnsure({
      provider: "bogus",
      json: true,
      accountHome: "/nonexistent",
      stderr: (chunk) => stderr.push(chunk),
      stdout: () => undefined,
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      ok: false,
      error: { code: "INVALID_PROVIDER", category: "validation", retryability: "never" },
      result: { results: [], nextActions: [] },
    });
  });

  it("exits 2 on commander usage errors and 0 on help", async () => {
    const parse = async (argv: string[]): Promise<CommanderError | undefined> => {
      const program = new Command().name("opentag");
      registerProviderCliCommand(program);
      program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
      try {
        await program.parseAsync(argv);
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(CommanderError);
        return error as CommanderError;
      }
    };
    const usage = await parse(["node", "opentag", "provider-cli", "ensure", "--provider", "lark", "--bogus"]);
    expect(usage?.exitCode).toBe(2);
    const help = await parse(["node", "opentag", "provider-cli", "--help"]);
    expect(help?.exitCode).toBe(0);
    const subcommandHelp = await parse(["node", "opentag", "provider-cli", "ensure", "--help"]);
    expect(subcommandHelp?.exitCode).toBe(0);
  });
});

describe("runProviderCliEnsure", () => {
  it("emits exactly one JSON document to stdout in --json mode", async () => {
    const accountHome = await makeTempDir("opentag-cli-");
    const bin = `${accountHome}/tools`;
    await writeFakeCli(bin, "feishu", "1.0.92");
    const stdout: string[] = [];
    const result = await runProviderCliEnsure({
      provider: "lark",
      json: true,
      accountHome,
      env: { PATH: bin },
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    const document = JSON.parse(stdout[0] ?? "") as { ok: boolean; result: { results: Record<string, unknown>[] } };
    expect(document.ok).toBe(true);
    expect(document.result.results[0]?.provider).toBe("feishu");
    expect(document.result.results[0]?.action).toBe("selected-existing");
    expect(document.result.results[0]?.readiness).toBe("ready");
    // No ANSI or phase chatter leaked into the document stream.
    expect(stdout[0]).not.toContain("[lark]");
    expect(stdout[0]).not.toContain("\u001b");
  });

  it("prints bounded phase lines in human mode", async () => {
    const accountHome = await makeTempDir("opentag-cli-");
    const bin = `${accountHome}/tools`;
    await writeFakeCli(bin, "feishu", "1.0.92");
    const stdout: string[] = [];
    const result = await runProviderCliEnsure({
      provider: "lark",
      accountHome,
      env: { PATH: bin },
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    const text = stdout.join("");
    expect(text).toContain("[lark] detect: 1 eligible candidate(s), 0 ignored");
    expect(text).toContain("[lark] select: 1.0.92 external");
    expect(text).toContain("[lark] verify: ready");
    expect(text).toContain("[lark] ready: selected-existing");
  });

  it("maps lark to feishu and reports an auto-repairable partial failure as retryable", async () => {
    const accountHome = await makeTempDir("opentag-cli-");
    const bin = `${accountHome}/tools`;
    await writeFakeCli(bin, "feishu", "1.0.92");
    // slack has no candidate and its fixture catalog points at a dead loopback port:
    // the managed install fails deterministically without any external network.
    const slackFixture = await makeManagedFixture("slack", "4.7.0");
    await slackFixture.close();
    const feishuEntry = PROVIDER_CLI_CATALOG.find((entry) => entry.provider === "feishu");
    expect(feishuEntry).toBeDefined();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runProviderCliEnsure({
      provider: "all",
      json: true,
      accountHome,
      env: { PATH: bin },
      catalog: feishuEntry ? [feishuEntry, ...slackFixture.catalog] : slackFixture.catalog,
      fetcher: slackFixture.fetcher,
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });
    expect(result.exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    const document = JSON.parse(stderr.join("")) as {
      ok: boolean;
      error: { code: string };
      result: {
        results: Array<{ provider: string; ok: boolean }>;
        nextActions: Array<{ provider: string; command: string; reason: string }>;
      };
    };
    // A failed install is a dependency that is currently unavailable: exit 3 via the shared
    // policy. install_incomplete has a rerun nextAction, so the envelope must agree that one
    // immediate retry is safe rather than claiming the opposite.
    expect(StructuredErrorSchema.safeParse(document.error).success).toBe(true);
    expect(document.ok).toBe(false);
    expect(document.error).toEqual({
      code: "PROVIDER_CLI_SETUP_INCOMPLETE",
      category: "dependency",
      retryability: "immediate",
      phase: "provider",
      message: "One or more Provider CLIs need attention.",
    });
    expect(document.result.results).toHaveLength(2);
    expect(document.result.results[0]?.provider).toBe("feishu");
    expect(document.result.results[0]?.ok).toBe(true);
    expect(document.result.results[1]?.provider).toBe("slack");
    expect(document.result.results[1]?.ok).toBe(false);
    expect(document.result.nextActions).toEqual([
      expect.objectContaining({
        provider: "slack",
        command: expect.stringContaining("provider-cli ensure --provider slack"),
        reason: "install_incomplete",
      }),
    ]);
  });

  it("reports a manual partial failure as never retryable with no repair next action", async () => {
    const accountHome = await makeTempDir("opentag-cli-");
    const bin = `${accountHome}/tools`;
    await writeFakeCli(bin, "feishu", "1.0.92");
    const feishuEntry = PROVIDER_CLI_CATALOG.find((entry) => entry.provider === "feishu");
    const slackEntry = PROVIDER_CLI_CATALOG.find((entry) => entry.provider === "slack");
    if (!feishuEntry || !slackEntry) throw new Error("catalog entries missing");
    // slack's catalog offers no artifact for this platform: ensure fails as unsupported_platform
    // without any download, and no amount of rerunning ensure can change that.
    const slackWithoutArtifact: ProviderCliCatalogEntry = { ...slackEntry, artifacts: [] };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runProviderCliEnsure({
      provider: "all",
      json: true,
      accountHome,
      env: { PATH: bin },
      catalog: [feishuEntry, slackWithoutArtifact],
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });
    expect(result.exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    const document = JSON.parse(stderr.join("")) as {
      ok: boolean;
      error: { code: string };
      result: {
        results: Array<{ provider: string; ok: boolean; diagnostic?: { code: string } }>;
        nextActions: Array<{ provider: string; command: string; reason: string }>;
      };
    };
    expect(StructuredErrorSchema.safeParse(document.error).success).toBe(true);
    expect(document.ok).toBe(false);
    expect(document.error).toEqual({
      code: "PROVIDER_CLI_SETUP_INCOMPLETE",
      category: "dependency",
      retryability: "never",
      phase: "provider",
      message: "One or more Provider CLIs need attention.",
    });
    expect(document.result.results).toEqual([
      expect.objectContaining({ provider: "feishu", ok: true }),
      expect.objectContaining({
        provider: "slack",
        ok: false,
        diagnostic: expect.objectContaining({ code: "unsupported_platform" }),
      }),
    ]);
    expect(document.result.nextActions).toEqual([]);
  });

  it("classifies a lock-held partial failure as retryable with backoff and exit 3", async () => {
    const accountHome = await makeTempDir("opentag-cli-");
    const bin = `${accountHome}/tools`;
    await writeFakeCli(bin, "feishu", "1.0.92");
    // The foreground targeted connect holds the slack provider lock while it installs; the
    // live holder PID plus an instant retry wait make the contention deterministic.
    const layout = resolveProviderCliAccountLayout(accountHome);
    await mkdir(layout.state, { recursive: true });
    await writeFile(providerCliLockFilePath(layout, "slack"), JSON.stringify({ pid: process.pid, token: "held" }), {
      mode: 0o600,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runProviderCliEnsure({
      provider: "all",
      json: true,
      accountHome,
      env: { PATH: bin },
      sleep: () => Promise.resolve(),
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });
    expect(result.exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    const document = JSON.parse(stderr.join("")) as {
      ok: boolean;
      error: { code: string };
      result: {
        results: Array<{ provider: string; ok: boolean; diagnostic?: { code: string } }>;
        nextActions: Array<{ provider: string; command: string; reason: string }>;
      };
    };
    expect(StructuredErrorSchema.safeParse(document.error).success).toBe(true);
    expect(document.ok).toBe(false);
    expect(document.error).toEqual({
      code: "PROVIDER_CLI_SETUP_INCOMPLETE",
      category: "unavailable",
      retryability: "backoff",
      phase: "provider",
      message: "One or more Provider CLIs need attention.",
    });
    expect(document.result.results).toEqual([
      expect.objectContaining({ provider: "feishu", ok: true }),
      expect.objectContaining({
        provider: "slack",
        ok: false,
        diagnostic: expect.objectContaining({ code: "operation_in_progress" }),
      }),
    ]);
    expect(document.result.nextActions).toEqual([
      expect.objectContaining({
        provider: "slack",
        command: expect.stringContaining("provider-cli ensure --provider slack"),
        reason: "operation_in_progress",
      }),
    ]);
  });

  it("waits for a daemon-held lock and returns the completed Provider state", async () => {
    const accountHome = await makeTempDir("opentag-cli-");
    const bin = `${accountHome}/tools`;
    const layout = resolveProviderCliAccountLayout(accountHome);
    const lockPath = providerCliLockFilePath(layout, "slack");
    await mkdir(layout.state, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "daemon-install" }), { mode: 0o600 });
    let terminalWaits = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runProviderCliEnsure({
      provider: "slack",
      json: true,
      accountHome,
      env: { PATH: bin },
      sleep: async (ms) => {
        if (ms !== PROVIDER_CLI_LOCK_BUSY_RETRY_DELAY_MS || terminalWaits > 0) return;
        terminalWaits += 1;
        // Model the daemon completing the same install while the foreground command waits.
        await writeFakeCli(bin, "slack", "4.7.0");
        await rm(lockPath, { force: true });
      },
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(terminalWaits).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.results).toEqual([
      expect.objectContaining({ provider: "slack", ok: true, readiness: "ready", action: "selected-existing" }),
    ]);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      result: { results: [{ provider: "slack", ok: true, readiness: "ready" }], nextActions: [] },
    });
  });

  it("managed install via fixture catalog writes the launcher and shim", async () => {
    const fixture = await makeManagedFixture("feishu", "1.0.92");
    try {
      const accountHome = await makeTempDir("opentag-cli-");
      const stdout: string[] = [];
      const result = await runProviderCliEnsure({
        provider: "lark",
        json: true,
        accountHome,
        env: { PATH: "" },
        catalog: fixture.catalog,
        fetcher: fixture.fetcher,
        stdout: (chunk) => stdout.push(chunk),
        stderr: () => undefined,
      });
      expect(result.exitCode).toBe(0);
      const document = JSON.parse(stdout.join("")) as { result: { results: Record<string, unknown>[] } };
      expect(document.result.results[0]?.action).toBe("installed-managed");
      expect(document.result.results[0]?.readiness).toBe("ready");
    } finally {
      await fixture.close();
    }
  });
});

describe("runProviderCliInspect", () => {
  it("reports absent providers with the aggregate contract and exit 3", async () => {
    const accountHome = await makeTempDir("opentag-cli-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runProviderCliInspect({
      provider: "slack",
      json: true,
      accountHome,
      env: { PATH: "" },
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });
    expect(result.exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    const document = JSON.parse(stderr.join("")) as {
      ok: boolean;
      error: { code: string };
      result: { results: Record<string, unknown>[]; nextActions: unknown[] };
    };
    // not_installed has a rerun-ensure next action, so the envelope agrees it is retryable.
    expect(StructuredErrorSchema.safeParse(document.error).success).toBe(true);
    expect(document.ok).toBe(false);
    expect(document.error).toEqual({
      code: "PROVIDER_CLI_NOT_READY",
      category: "dependency",
      retryability: "immediate",
      phase: "provider",
      message: "One or more Provider CLIs need attention.",
    });
    expect(document.result.results[0]?.provider).toBe("slack");
    expect(document.result.results[0]?.state).toBe("absent");
    expect(document.result.results[0]?.readiness).toBe("install");
    expect(document.result.nextActions).toEqual([
      expect.objectContaining({ command: expect.stringContaining("provider-cli ensure --provider slack") }),
    ]);
  });

  it("reports an unrepairable inspection as never retryable with no next action", async () => {
    const accountHome = await makeTempDir("opentag-cli-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runProviderCliInspect({
      provider: "slack",
      json: true,
      accountHome,
      env: { PATH: "" },
      platform: "win32",
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });
    expect(result.exitCode).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    const document = JSON.parse(stderr.join("")) as {
      ok: boolean;
      error: { code: string };
      result: { results: Array<{ diagnostic?: { code: string } }>; nextActions: unknown[] };
    };
    expect(StructuredErrorSchema.safeParse(document.error).success).toBe(true);
    expect(document.ok).toBe(false);
    expect(document.error).toEqual({
      code: "PROVIDER_CLI_NOT_READY",
      category: "dependency",
      retryability: "never",
      phase: "provider",
      message: "One or more Provider CLIs need attention.",
    });
    expect(document.result.results[0]?.diagnostic?.code).toBe("unsupported_platform");
    expect(document.result.nextActions).toEqual([]);
  });
});
