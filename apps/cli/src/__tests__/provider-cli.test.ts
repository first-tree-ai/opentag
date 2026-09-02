import { PROVIDER_CLI_CATALOG } from "@opentag/client";
import { Command, CommanderError } from "commander";
import { describe, expect, it } from "vitest";
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

  it("maps lark to feishu and aggregates failures across providers", async () => {
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
    expect(result.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    const document = JSON.parse(stderr.join("")) as {
      ok: boolean;
      error: { code: string };
      result: {
        results: Array<{ provider: string; ok: boolean }>;
        nextActions: Array<{ provider: string; command: string; reason: string }>;
      };
    };
    expect(document.ok).toBe(false);
    expect(document.error.code).toBe("PROVIDER_CLI_SETUP_INCOMPLETE");
    expect(document.result.results).toHaveLength(2);
    expect(document.result.results[0]?.provider).toBe("feishu");
    expect(document.result.results[0]?.ok).toBe(true);
    expect(document.result.results[1]?.provider).toBe("slack");
    expect(document.result.results[1]?.ok).toBe(false);
    expect(document.result.nextActions).toEqual([
      expect.objectContaining({
        provider: "slack",
        command: expect.stringContaining("provider-cli ensure --provider slack"),
      }),
    ]);
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
  it("reports absent providers with exit code 1", async () => {
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
    expect(result.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    const document = JSON.parse(stderr.join("")) as {
      error: { code: string };
      result: { results: Record<string, unknown>[]; nextActions: unknown[] };
    };
    expect(document.error.code).toBe("PROVIDER_CLI_NOT_READY");
    expect(document.result.results[0]?.provider).toBe("slack");
    expect(document.result.results[0]?.state).toBe("absent");
    expect(document.result.results[0]?.readiness).toBe("install");
    expect(document.result.nextActions).toEqual([
      expect.objectContaining({ command: expect.stringContaining("provider-cli ensure --provider slack") }),
    ]);
  });
});
