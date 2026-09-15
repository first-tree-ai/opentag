import { describe, expect, it } from "vitest";
import { parseRunnerCliArgv, runnerCliUsage } from "../runner/args.js";

describe("runner CLI argv", () => {
  it("requires a command and exits nonzero without hanging", () => {
    const missing = parseRunnerCliArgv([]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.exitCode).toBe(2);
      expect(missing.error).toMatch(/missing command/);
    }
    const unknown = parseRunnerCliArgv(["serve"]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/unknown command/);
  });

  it("parses offline probe and rejects real accept without a config directory", () => {
    expect(parseRunnerCliArgv(["probe", "--json"])).toEqual({
      ok: true,
      invocation: { command: "probe", json: true, mode: "offline" },
    });
    const real = parseRunnerCliArgv(["accept", "--mode", "real"]);
    expect(real.ok).toBe(false);
    if (!real.ok) expect(real.error).toMatch(/--pi-config-dir/);
    const noProvider = parseRunnerCliArgv(["accept", "--mode", "real", "--pi-config-dir", "/tmp/pi"]);
    expect(noProvider.ok).toBe(false);
    if (!noProvider.ok) expect(noProvider.error).toMatch(/--provider/);
  });

  it("rejects unknown options and missing option values", () => {
    expect(parseRunnerCliArgv(["probe", "--wat"])).toMatchObject({ ok: false });
    expect(parseRunnerCliArgv(["probe", "--mode"])).toMatchObject({ ok: false });
    expect(parseRunnerCliArgv(["accept", "--mode", "cloud"])).toMatchObject({ ok: false });
  });

  it("exposes usage text and rejects a help flag after the command", () => {
    expect(runnerCliUsage()).toMatch(/Usage: opentag-runner/);
    const help = parseRunnerCliArgv(["probe", "--help"]);
    expect(help.ok).toBe(false);
    if (!help.ok) expect(help.error).toMatch(/unexpected help flag/);
  });

  it("parses a complete real accept invocation and rejects unsupported providers", () => {
    expect(
      parseRunnerCliArgv([
        "accept",
        "--mode",
        "real",
        "--pi-config-dir",
        "/tmp/pi",
        "--provider",
        "deepseek",
        "--workspace",
        "/tmp/ws",
        "--json",
      ]),
    ).toEqual({
      ok: true,
      invocation: {
        command: "accept",
        json: true,
        mode: "real",
        piConfigDir: "/tmp/pi",
        provider: "deepseek",
        workspace: "/tmp/ws",
      },
    });
    const unsupported = parseRunnerCliArgv([
      "accept",
      "--mode",
      "real",
      "--pi-config-dir",
      "/tmp/pi",
      "--provider",
      "openai",
    ]);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error).toMatch(/unsupported provider for real acceptance: openai/);
  });
});
