import type { ProviderCliInspection, ProviderCliProvider } from "@opentag/client";
import * as client from "@opentag/client";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProviderCliCommand } from "../commands/provider-cli.js";
import * as ensureModule from "../core/provider-cli/ensure.js";
import * as inspectModule from "../core/provider-cli/inspect.js";
import { runProviderCliInspect } from "../core/provider-cli/inspect.js";
import { writeStderr, writeStdout } from "../core/provider-cli/shared.js";

function inspection(provider: ProviderCliProvider, overrides: Partial<ProviderCliInspection>): ProviderCliInspection {
  return {
    provider,
    state: "ready",
    readiness: "ready",
    launcher: { path: `/home/user/.opentag/provider-cli/${provider}/launcher`, status: "valid" },
    globalCommand: { active: true },
    warnings: [],
    ...overrides,
  };
}

function stubInspections(byProvider: Partial<Record<ProviderCliProvider, ProviderCliInspection>>) {
  return vi
    .spyOn(client.ProviderCliManager.prototype, "inspect")
    .mockImplementation(async (provider: ProviderCliProvider) => {
      const result = byProvider[provider];
      if (!result) throw new Error(`unexpected provider ${provider}`);
      return result;
    });
}

async function inspectHuman(provider: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runProviderCliInspect({
    provider,
    accountHome: "/nonexistent",
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
  });
  return { result, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("runProviderCliInspect human output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a ready provider with a selection, active global command, and remediated warning on stdout", async () => {
    stubInspections({
      slack: inspection("slack", {
        selection: {
          kind: "managed",
          path: "/home/user/.opentag/provider-cli/slack/v1/slack",
          version: "1.2.3",
          trust: "catalog-verified",
          generation: 4,
        },
        globalCommand: { active: true, path: "/home/user/.local/bin/slack", resolvedPath: "/real/slack" },
        warnings: [{ code: "global_path_not_configured", remediation: "add ~/.local/bin to PATH" }],
      }),
    });
    const { result, stdout, stderr } = await inspectHuman("slack");
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.split("\n").filter(Boolean)).toEqual([
      "[slack] state: ready",
      "[slack] selection: managed 1.2.3 /home/user/.opentag/provider-cli/slack/v1/slack (catalog-verified)",
      "[slack] launcher: valid /home/user/.opentag/provider-cli/slack/launcher",
      "[slack] global-command: active /real/slack",
      "[slack] warning: global_path_not_configured — add ~/.local/bin to PATH",
    ]);
  });

  it("falls back from resolvedPath to path and then to a bare active marker", async () => {
    stubInspections({
      feishu: inspection("feishu", { globalCommand: { active: true, path: "/home/user/.local/bin/lark-cli" } }),
      slack: inspection("slack", { globalCommand: { active: true } }),
    });
    const { result, stdout } = await inspectHuman("all");
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("[lark] global-command: active /home/user/.local/bin/lark-cli\n");
    expect(stdout).toContain("[slack] global-command: active\n");
    expect(stdout).not.toContain("selection:");
  });

  it("reports not-ready providers on stderr with shadowing, warnings, diagnostics, and next actions", async () => {
    stubInspections({
      feishu: inspection("feishu", {
        state: "absent",
        readiness: "install",
        launcher: { path: "/home/user/.opentag/provider-cli/feishu/launcher", status: "missing" },
        globalCommand: { active: false, path: "/home/user/.local/bin/lark-cli", resolvedPath: "/usr/bin/lark-cli" },
        warnings: [{ code: "global_command_shadowed" }],
        diagnostic: { code: "not_installed", remediation: "run ensure" },
      }),
      slack: inspection("slack", {
        state: "unavailable",
        readiness: "unavailable",
        launcher: { path: "/home/user/.opentag/provider-cli/slack/launcher", status: "invalid" },
        globalCommand: { active: false },
        diagnostic: { code: "unsupported_platform" },
      }),
    });
    const { result, stdout, stderr } = await inspectHuman("all");
    expect(result.exitCode).toBe(3);
    expect(stdout).toBe("");
    expect(result.nextActions).toEqual([expect.objectContaining({ provider: "feishu", reason: "not_installed" })]);
    const lines = stderr.split("\n").filter(Boolean);
    expect(lines[0]).toBe("PROVIDER_CLI_NOT_READY: One or more Provider CLIs need attention.");
    expect(lines).toContain("[lark] state: absent");
    expect(lines).toContain("[lark] global-command: shadowed by /usr/bin/lark-cli");
    expect(lines).toContain("[lark] warning: global_command_shadowed");
    expect(lines).toContain("[lark] diagnostic: not_installed — run ensure");
    expect(lines.some((line) => line.startsWith("[lark] next: ") && line.includes("--provider lark"))).toBe(true);
    expect(lines).toContain("[slack] state: unavailable");
    expect(lines).toContain("[slack] global-command: inactive");
    expect(lines).toContain("[slack] diagnostic: unsupported_platform");
    expect(lines.some((line) => line.startsWith("[slack] next:"))).toBe(false);
  });

  it("writes to the process streams when no collectors are injected", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeStdout({}, "out\n");
    writeStderr({}, "err\n");
    expect(stdout).toHaveBeenCalledWith("out\n");
    expect(stderr).toHaveBeenCalledWith("err\n");
  });
});

describe("provider-cli command failure presentation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  async function runCommand(argv: readonly string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const program = new Command().name("opentag");
    registerProviderCliCommand(program, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });
    await program.parseAsync(["node", "opentag", "provider-cli", ...argv]);
    return { stdout: stdout.join(""), stderr: stderr.join("") };
  }

  it("presents an unexpected inspect failure as a JSON provider-phase envelope", async () => {
    vi.spyOn(inspectModule, "runProviderCliInspect").mockRejectedValue(new Error("inspect exploded"));
    const { stdout, stderr } = await runCommand(["inspect", "--provider", "slack", "--json"]);
    expect(stdout).toBe("");
    const document = JSON.parse(stderr) as { ok: boolean; error: { phase: string; message: string } };
    expect(document.ok).toBe(false);
    expect(document.error).toMatchObject({ phase: "provider", message: "inspect exploded" });
    expect(process.exitCode).not.toBe(0);
  });

  it("presents an unexpected ensure failure as a human error line", async () => {
    vi.spyOn(ensureModule, "runProviderCliEnsure").mockRejectedValue(new Error("ensure exploded"));
    const { stdout, stderr } = await runCommand(["ensure", "--provider", "lark"]);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^[A-Z_]+: ensure exploded\n$/u);
    expect(process.exitCode).not.toBe(0);
  });
});
