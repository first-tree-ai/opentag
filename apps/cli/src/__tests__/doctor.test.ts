import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  type AgentRuntimeProbeResult,
  ServerHealthConfigurationError,
  ServerHealthNetworkError,
} from "@opentag/client";
import type { AgentRuntimeProvider, ImCliProvider } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import { type DoctorOptions, renderDoctorJson, resolveServerUrl, runDoctor } from "../core/diagnostics/doctor.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const READY: AgentRuntimeProbeResult = { issues: [], ready: true, version: "1.2.3" };
const NOT_INSTALLED: AgentRuntimeProbeResult = {
  issues: [{ code: "artifact_missing", message: "Codex CLI could not be executed" }],
  ready: false,
};
const NOT_SIGNED_IN: AgentRuntimeProbeResult = {
  issues: [{ code: "credential_missing", message: "Claude Code credentials were not found" }],
  ready: false,
  version: "1.2.3",
};

describe("resolveServerUrl", () => {
  it("prefers the command option over the environment", () => {
    expect(resolveServerUrl("http://cli.example", { OPENTAG_SERVER_URL: "http://env.example" })).toBe(
      "http://cli.example",
    );
  });

  it("uses the environment before the default", () => {
    expect(resolveServerUrl(undefined, { OPENTAG_SERVER_URL: "http://env.example" })).toBe("http://env.example");
    expect(resolveServerUrl(undefined, {})).toBe("http://127.0.0.1:8000");
  });
});

describe("runDoctor", () => {
  it("reports a computer that can run an Agent", async () => {
    const result = await runDoctor(await doctorOptions({}));

    expect(result.exitCode).toBe(0);
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["server", "ok"],
      ["runtime:codex", "ok"],
      ["runtime:claude-code", "ok"],
      ["im:feishu", "ok"],
      ["im:slack", "ok"],
    ]);
    expect(result.message).toContain("Codex CLI: ready (1.2.3)");
    expect(result.message).toContain("This computer is ready to run an OpenTag agent.");
  });

  it("accepts one ready Agent Runtime and one ready messaging CLI when the caller selects none", async () => {
    const result = await runDoctor(
      await doctorOptions({
        imStatuses: { feishu: "ready", slack: "install" },
        runtimeResults: { codex: READY, "claude-code": NOT_INSTALLED },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Claude Code CLI: not installed");
    expect(result.message).not.toContain("Fix 1/");
  });

  it("blocks when the caller selects a runtime that is not signed in", async () => {
    const result = await runDoctor(
      await doctorOptions({
        runtimeResults: { codex: READY, "claude-code": NOT_SIGNED_IN },
        runtimes: ["claude-code"],
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.checks.map((check) => check.id)).toEqual(["server", "runtime:claude-code", "im:feishu", "im:slack"]);
    expect(result.message).toContain("Claude Code CLI: installed (1.2.3) but not signed in");
    expect(result.message).toContain("Fix 1/1 — Sign in to Claude Code on this computer");
    expect(result.message).toContain("  claude auth login");
  });

  it("blocks and prints one fix per failure when no Agent Runtime and no messaging CLI is ready", async () => {
    const result = await runDoctor(
      await doctorOptions({
        imStatuses: { feishu: "install", slack: "unavailable" },
        runtimeResults: { codex: NOT_INSTALLED, "claude-code": NOT_SIGNED_IN },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("4 checks must be fixed");
    expect(result.message).toContain("Fix 1/4 — Install the Codex CLI");
    expect(result.message).toContain("  npm install -g @openai/codex");
    expect(result.message).toContain("Fix 2/4 — Sign in to Claude Code on this computer");
    expect(result.message).toContain("Fix 3/4 — Install the Feishu (Lark) CLI");
    expect(result.message).toContain("Fix 4/4 — Reinstall or upgrade the Slack CLI");
  });

  it("reports an unreachable server as a blocking check", async () => {
    const result = await runDoctor({
      ...(await doctorOptions({})),
      healthChecker: vi.fn().mockRejectedValue(new ServerHealthNetworkError("offline")),
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("network error: could not reach the OpenTag server at http://server.example");
    expect(result.message).toContain("Fix 1/1 — Check this computer's network access");
  });

  it("reports an invalid server URL as a configuration error", async () => {
    const result = await runDoctor({
      ...(await doctorOptions({})),
      healthChecker: vi.fn().mockRejectedValue(new ServerHealthConfigurationError("invalid URL")),
      serverUrl: "not-a-url",
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("configuration error: invalid OpenTag server URL not-a-url");
  });

  it("reports a probe failure without claiming readiness", async () => {
    const options = await doctorOptions({});
    const result = await runDoctor({
      ...options,
      runtimeProbe: vi.fn().mockRejectedValue(new Error("Codex Home identity changed")),
    });

    expect(result.exitCode).toBe(1);
    expect(result.checks.filter((check) => check.status === "error").map((check) => check.detail)).toEqual([
      "Codex Home identity changed",
      "Codex Home identity changed",
    ]);
  });

  it("surfaces an unreadable daemon environment because the daemon reads the same file", async () => {
    const options = await doctorOptions({});
    const paths = resolveDaemonPaths(options.home as string);
    await mkdir(paths.config, { mode: 0o700, recursive: true });
    await writeFile(paths.daemonEnvironment, "KEY=value\n", { mode: 0o600 });
    await chmod(paths.daemonEnvironment, 0o644);

    const result = await runDoctor(options);

    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "daemon-environment")?.detail).toContain("permissions");
  });

  it("renders machine-readable checks for an Agent that reads the output", async () => {
    const result = await runDoctor(
      await doctorOptions({ runtimeResults: { codex: NOT_INSTALLED, "claude-code": NOT_INSTALLED } }),
    );

    expect(JSON.parse(renderDoctorJson(result))).toMatchObject({
      checks: expect.arrayContaining([
        {
          detail: "not installed, or not on the PATH this computer runs OpenTag with",
          fix: {
            commands: ["npm install -g @openai/codex"],
            docsUrl: "https://developers.openai.com/codex/cli",
            summary: "Install the Codex CLI so that `codex` runs from this computer's PATH",
          },
          id: "runtime:codex",
          status: "install",
          title: "Codex CLI",
        },
      ]),
      ok: false,
    });
  });
});

async function doctorOptions(overrides: {
  imStatuses?: Partial<Record<ImCliProvider, "install" | "ready" | "unavailable">>;
  runtimeResults?: Partial<Record<AgentRuntimeProvider, AgentRuntimeProbeResult>>;
  runtimes?: readonly AgentRuntimeProvider[];
}): Promise<DoctorOptions> {
  return {
    env: {},
    healthChecker: vi.fn().mockResolvedValue({ service: "opentag-server", status: "ok" }),
    home: await temporaryDirectory("opentag-doctor-"),
    imProbe: async (provider) => overrides.imStatuses?.[provider] ?? "ready",
    runtimeProbe: async (provider) => overrides.runtimeResults?.[provider] ?? READY,
    serverUrl: "http://server.example",
    ...(overrides.runtimes ? { runtimes: overrides.runtimes } : {}),
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}
