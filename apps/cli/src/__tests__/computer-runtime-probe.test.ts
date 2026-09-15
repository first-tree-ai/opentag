import { access, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import * as runtime from "../core/computer/runtime-probe.js";
import { probeRuntimeComponent, resolveRuntimeProbeEnvironment } from "../core/computer/runtime-probe.js";

const homes: string[] = [];
const previousExitCode = process.exitCode;
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function isolatedHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "opentag-f3-probe-")));
  homes.push(home);
  return home;
}

function mockFactories(
  probe = vi.fn(async (_input: { signal?: AbortSignal }) => ({ ready: true, issues: [], version: "1.0.0" })),
) {
  const codex = vi
    .spyOn(client, "resolvedCodexFactory")
    .mockReturnValue({ probe } as unknown as ReturnType<typeof client.resolvedCodexFactory>);
  const claude = vi
    .spyOn(client, "resolvedClaudeCodeFactory")
    .mockReturnValue({ probe } as unknown as ReturnType<typeof client.resolvedClaudeCodeFactory>);
  const pi = vi
    .spyOn(client, "resolvedPiFactory")
    .mockReturnValue({ probe } as unknown as ReturnType<typeof client.resolvedPiFactory>);
  const grokBot = vi
    .spyOn(client, "resolvedGrokBotFactory")
    .mockReturnValue({ probe } as unknown as ReturnType<typeof client.resolvedGrokBotFactory>);
  return { codex, claude, pi, grokBot, probe };
}

describe("selected Runtime full-probe adapter", () => {
  it.each([
    ["artifact_missing", "never"],
    ["credential_missing", "never"],
    ["version_incompatible", "never"],
    ["configuration_invalid", "never"],
    ["temporarily_unavailable", "backoff"],
    ["runtime_probe_failed", "backoff"],
  ] as const)("reports standalone %s as %s retryability", async (code, retryability) => {
    const observed = new Date().toISOString();
    const component =
      code === "runtime_probe_failed"
        ? runtime.runtimeComponentFromProbeFailure("codex", new Error("Runtime probe timed out"), observed)
        : runtime.runtimeComponentFromProbeResult(
            "codex",
            { ready: false, issues: [{ code, message: "probe failed" }] },
            observed,
          );
    vi.spyOn(runtime, "probeRuntimeComponent").mockResolvedValue(component);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await createProgram().parseAsync([
      "node",
      "opentag",
      "computer",
      "runtime-inspect",
      "--provider",
      "codex",
      "--json",
    ]);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { retryability },
      result: { diagnosticCode: code, verifyAction: { command: expect.stringContaining("runtime-inspect") } },
    });
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });
  it.each(["codex", "claude-code", "pi", "grok-bot"] as const)(
    "reuses only the %s factory and does not create a Runtime Home or install anything",
    async (provider) => {
      const home = await isolatedHome();
      const { codex, claude, pi, grokBot, probe } = mockFactories();
      const ensure = vi.spyOn(client.ProviderCliManager.prototype, "ensure");
      const result = await probeRuntimeComponent({ provider, environment: { HOME: home, PATH: "/test/bin" } });
      expect(result).toMatchObject({ id: `runtime:${provider}`, status: "ready", blocking: false });
      expect(codex).toHaveBeenCalledTimes(provider === "codex" ? 1 : 0);
      expect(claude).toHaveBeenCalledTimes(provider === "claude-code" ? 1 : 0);
      expect(pi).toHaveBeenCalledTimes(provider === "pi" ? 1 : 0);
      expect(grokBot).toHaveBeenCalledTimes(provider === "grok-bot" ? 1 : 0);
      expect(probe).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
      expect(ensure).not.toHaveBeenCalled();
      await expect(access(join(home, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(home, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(home, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(home, ".grok-bot"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("canonicalizes custom and default symlinked Claude homes just like the daemon", async () => {
    const home = await isolatedHome();
    const target = join(home, "claude-real");
    await mkdir(target);
    await symlink(target, join(home, ".claude"));
    const defaultEnvironment = await resolveRuntimeProbeEnvironment("claude-code", {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    });
    expect(defaultEnvironment.home).toBe(target);
    expect(defaultEnvironment.environment.CLAUDE_CONFIG_DIR).toBeUndefined();
    const custom = join(home, "custom");
    const customEnvironment = await resolveRuntimeProbeEnvironment("claude-code", {
      HOME: home,
      CLAUDE_CONFIG_DIR: custom,
    });
    expect(customEnvironment.home).toBe(custom);
    expect(customEnvironment.environment.CLAUDE_CONFIG_DIR).toBe(custom);
  });

  it("preserves exact custom Pi home through the daemon's canonical environment filter", async () => {
    const home = await isolatedHome();
    const custom = join(home, "pi-config");
    const environment = await resolveRuntimeProbeEnvironment("pi", {
      HOME: home,
      PI_CODING_AGENT_DIR: custom,
      OPENTAG_SERVER_URL: "https://private.example",
    });
    expect(environment.home).toBe(custom);
    expect(environment.environment.PI_CODING_AGENT_DIR).toBe(custom);
    expect(environment.environment.OPENTAG_SERVER_URL).toBeUndefined();
  });

  it("preserves exact custom Codex home through the daemon's canonical environment filter", async () => {
    const home = await isolatedHome();
    const custom = join(home, "codex-config");
    const environment = await resolveRuntimeProbeEnvironment("codex", {
      HOME: home,
      CODEX_HOME: custom,
      OPENTAG_SERVER_URL: "https://private.example",
    });
    expect(environment.home).toBe(custom);
    expect(environment.environment.CODEX_HOME).toBe(custom);
    expect(environment.environment.OPENTAG_SERVER_URL).toBeUndefined();
  });

  it("bounds even a non-settling probe, aborts owned work, and returns a repairable failure", async () => {
    const home = await isolatedHome();
    const { probe } = mockFactories(vi.fn(() => new Promise<never>(() => {})));
    const result = await probeRuntimeComponent({ provider: "codex", environment: { HOME: home }, timeoutMs: 100 });
    expect(result).toMatchObject({ status: "unavailable", blocking: true, diagnosticCode: "runtime_probe_failed" });
    expect(probe.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(result.verifyAction?.command).toContain("runtime-inspect --provider codex");
  });

  it("honors caller cancellation before any selected factory starts", async () => {
    const { codex, claude, pi } = mockFactories();
    await expect(
      probeRuntimeComponent({ provider: "codex", signal: AbortSignal.abort(new Error("cancelled")) }),
    ).rejects.toThrow("cancelled");
    expect(codex).not.toHaveBeenCalled();
    expect(claude).not.toHaveBeenCalled();
    expect(pi).not.toHaveBeenCalled();
  });

  it("makes the emitted verify command a real full-probe command with no implicit Runtime", async () => {
    const { codex, claude, pi } = mockFactories();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await createProgram().parseAsync([
      "node",
      "opentag",
      "computer",
      "runtime-inspect",
      "--provider",
      "claude-code",
      "--json",
    ]);
    expect(claude).toHaveBeenCalledOnce();
    expect(codex).not.toHaveBeenCalled();
    expect(pi).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      result: { id: "runtime:claude-code", status: "ready" },
    });
    await createProgram().parseAsync(["node", "opentag", "computer", "runtime-inspect", "--provider", "all", "--json"]);
    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledOnce();
    expect(claude).toHaveBeenCalledOnce();
  });
});
