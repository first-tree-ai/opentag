import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerProviderCliCommand } from "../commands/provider-cli.js";
import type { ProviderCliCommandDeps } from "../core/provider-cli/shared.js";
import { makeManagedFixture, makeTempDir, writeFakeCli } from "./provider-cli-fixtures.js";

const execFileAsync = promisify(execFile);

/**
 * Local end-to-end coverage for `opentag provider-cli`: the real Commander surface,
 * real detection probes, a loopback fixture server for managed downloads, and a fresh
 * account root per run. No public network, no real provider binaries, no real home.
 */

interface Harness {
  readonly accountHome: string;
  readonly stdout: string[];
  readonly stderr: string[];
  run(argv: readonly string[], deps?: Partial<ProviderCliCommandDeps>): Promise<void>;
  exitCode(): number;
}

function firstResult<T>(document: string): T {
  const parsed = JSON.parse(document) as { ok: boolean; result: { results: T[] } };
  expect(parsed.ok).toBe(true);
  return parsed.result.results[0] as T;
}

function makeHarness(accountHome: string, baseDeps: Partial<ProviderCliCommandDeps>): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    accountHome,
    stdout,
    stderr,
    async run(argv, deps = {}) {
      const program = new Command().name("opentag");
      registerProviderCliCommand(program, {
        accountHome,
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
        ...baseDeps,
        ...deps,
      });
      process.exitCode = 0;
      await program.parseAsync(["node", "opentag", ...argv]);
    },
    exitCode() {
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    },
  };
}

afterEach(() => {
  process.exitCode = 0;
});

describe("provider-cli local E2E", () => {
  it("uses one stable stderr envelope for not-ready and invalid requests", async () => {
    const accountHome = await makeTempDir("opentag-e2e-");
    const harness = makeHarness(accountHome, { env: { PATH: "" } });

    await harness.run(["provider-cli", "inspect", "--provider", "lark", "--json"]);
    expect(harness.exitCode()).toBe(1);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toHaveLength(1);
    expect(JSON.parse(harness.stderr[0] ?? "")).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CLI_NOT_READY" },
      result: { results: [{ provider: "feishu" }], nextActions: expect.any(Array) },
    });

    harness.stderr.length = 0;
    await harness.run(["provider-cli", "inspect", "--provider", "teams", "--json"]);
    expect(harness.exitCode()).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(JSON.parse(harness.stderr[0] ?? "")).toMatchObject({
      ok: false,
      error: { code: "INVALID_PROVIDER" },
      result: { results: [], nextActions: [] },
    });
  });

  it("selects an external lark-cli, inspects it, and noops on rerun", async () => {
    const accountHome = await makeTempDir("opentag-e2e-");
    const tools = join(accountHome, "tools");
    await writeFakeCli(tools, "feishu", "1.0.92");
    const harness = makeHarness(accountHome, { env: { PATH: tools } });

    await harness.run(["provider-cli", "ensure", "--provider", "lark", "--json"]);
    expect(harness.exitCode()).toBe(0);
    expect(harness.stdout).toHaveLength(1); // one JSON document, nothing else
    const ensured = firstResult<Record<string, unknown>>(harness.stdout[0] ?? "");
    expect(ensured.action).toBe("selected-existing");

    harness.stdout.length = 0;
    await harness.run(["provider-cli", "inspect", "--provider", "lark", "--json"]);
    expect(harness.exitCode()).toBe(0);
    const inspected = firstResult<Record<string, unknown>>(harness.stdout.join(""));
    expect(inspected.state).toBe("ready");
    expect(inspected.readiness).toBe("ready");

    harness.stdout.length = 0;
    await harness.run(["provider-cli", "ensure", "--provider", "lark", "--json"]);
    expect(harness.exitCode()).toBe(0);
    expect(firstResult<Record<string, unknown>>(harness.stdout[0] ?? "").action).toBe("noop");

    // The human-facing shim executes the selected external target.
    const shim = join(accountHome, ".local", "bin", "lark-cli");
    const { stdout } = await execFileAsync(shim, ["--version"]);
    expect(stdout.trim()).toBe("lark-cli version 1.0.92");
  });

  it("installs the managed artifact when nothing compatible is on PATH", async () => {
    const fixture = await makeManagedFixture("feishu", "1.0.92");
    try {
      const accountHome = await makeTempDir("opentag-e2e-");
      const harness = makeHarness(accountHome, {
        env: { PATH: "" },
        catalog: fixture.catalog,
        fetcher: fixture.fetcher,
      });

      await harness.run(["provider-cli", "ensure", "--provider", "lark", "--json"]);
      expect(harness.exitCode()).toBe(0);
      const result = firstResult<{
        action: string;
        selected?: { path: string; trust: string };
      }>(harness.stdout.join(""));
      expect(result.action).toBe("installed-managed");
      expect(result.selected?.trust).toBe("catalog-verified");

      // Internal launcher and public shim both execute the managed target.
      const launcher = join(accountHome, ".opentag", "provider-cli", "bin", "lark-cli");
      expect((await stat(launcher)).mode & 0o111).not.toBe(0);
      const { stdout } = await execFileAsync(launcher, ["--version"]);
      expect(stdout.trim()).toBe("lark-cli version 1.0.92");
      const shim = join(accountHome, ".local", "bin", "lark-cli");
      expect((await readFile(shim, "utf8")).includes("opentag-provider-cli-shim")).toBe(true);
      const shimmed = await execFileAsync(shim, ["im", "--help"]);
      expect(shimmed.stdout.trim()).toBe("surface-ok");
    } finally {
      await fixture.close();
    }
  });

  it("reports shadowing when a foreign command wins PATH but stays ready", async () => {
    const fixture = await makeManagedFixture("feishu", "1.0.92");
    try {
      const accountHome = await makeTempDir("opentag-e2e-");
      const foreign = join(accountHome, "foreign");
      await writeFakeCli(foreign, "feishu", "1.0.92");
      const publicBin = join(accountHome, ".local", "bin");
      const env = { PATH: [foreign, publicBin].join(delimiter) };
      const harness = makeHarness(accountHome, { env, catalog: fixture.catalog, fetcher: fixture.fetcher });

      // The foreign CLI is a perfectly good candidate; it wins detection outright.
      await harness.run(["provider-cli", "ensure", "--provider", "lark", "--json"]);
      expect(harness.exitCode()).toBe(0);
      const selected = firstResult<{
        action: string;
        selected?: { source: string };
        warnings: Array<{ code: string }>;
      }>(harness.stdout.join(""));
      expect(selected.action).toBe("selected-existing");
      expect(selected.warnings.map((entry) => entry.code)).toContain("global_command_shadowed");

      // With --managed-only, the managed artifact installs despite the external CLI.
      harness.stdout.length = 0;
      await harness.run(["provider-cli", "ensure", "--provider", "lark", "--managed-only", "--json"]);
      const managed = firstResult<{ action: string; warnings: Array<{ code: string }> }>(harness.stdout.join(""));
      expect(managed.action).toBe("installed-managed");
      expect(managed.warnings.map((entry) => entry.code)).toContain("global_command_shadowed");
    } finally {
      await fixture.close();
    }
  });

  it("supports dry-run without touching the account root", async () => {
    const fixture = await makeManagedFixture("feishu", "1.0.92");
    try {
      const accountHome = await makeTempDir("opentag-e2e-");
      const harness = makeHarness(accountHome, {
        env: { PATH: "" },
        catalog: fixture.catalog,
        fetcher: fixture.fetcher,
      });
      await harness.run(["provider-cli", "ensure", "--provider", "lark", "--dry-run", "--json"]);
      expect(harness.exitCode()).toBe(0);
      const result = firstResult<Record<string, unknown>>(harness.stdout.join(""));
      expect(result.action).toBe("installed-managed");
      expect(result.dryRun).toBe(true);
      await expect(stat(join(accountHome, ".opentag"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.close();
    }
  });

  it("never prompts and keeps stdout to one document in non-TTY JSON mode", async () => {
    const fixture = await makeManagedFixture("slack", "4.7.0");
    try {
      const accountHome = await makeTempDir("opentag-e2e-");
      const harness = makeHarness(accountHome, {
        env: { PATH: "" },
        catalog: fixture.catalog,
        fetcher: fixture.fetcher,
      });
      await harness.run(["provider-cli", "ensure", "--provider", "slack", "--json"]);
      expect(harness.exitCode()).toBe(0);
      expect(harness.stdout).toHaveLength(1);
      const result = firstResult<{ action: string }>(harness.stdout[0] ?? "");
      expect(result.action).toBe("installed-managed");
      // The Slack launcher prepends the update-check suppression flag transparently.
      const launcher = join(accountHome, ".opentag", "provider-cli", "bin", "slack");
      const { stdout } = await execFileAsync(launcher, ["version"]);
      expect(stdout.trim()).toBe("Using slack v4.7.0");
    } finally {
      await fixture.close();
    }
  });
});
