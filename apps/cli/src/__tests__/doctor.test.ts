import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  type AgentRuntimeProbeResult,
  ServerHealthConfigurationError,
  ServerHealthNetworkError,
} from "@opentag/client";
import {
  AGENT_RUNTIME_PROVIDERS,
  type AgentRuntimeProvider,
  IM_CLI_PROVIDERS,
  type ImCliProvider,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import type { DaemonServiceManager } from "../core/daemon/service/index.js";
import { renderLaunchdPlist } from "../core/daemon/service/launchd.js";
import { renderSystemdUnit } from "../core/daemon/service/systemd.js";
import type { DaemonServiceState } from "../core/daemon/service/types.js";
import { checkAgentRuntimes, checkImClis } from "../core/diagnostics/checks.js";
import {
  type DoctorOptions,
  renderDoctorJson,
  resolveServerUrl,
  runDoctor,
  serviceProcessEnvironment,
} from "../core/diagnostics/doctor.js";
import { readDaemonServiceEnvironment } from "../core/diagnostics/service-environment.js";

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
      ["daemon-service", "ok"],
      ["runtime:codex", "ok"],
      ["runtime:claude-code", "ok"],
      ["im:feishu", "ok"],
      ["im:slack", "ok"],
    ]);
    expect(result.message).toContain("Codex CLI: ready (1.2.3)");
    expect(result.message).toContain("run an OpenTag agent on Codex or Claude Code");
    expect(result.message).toContain("delivering through Feishu or Slack");
    expect(result.message).toContain("It does not know which of those");
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
    expect(result.message).toContain("run an OpenTag agent on Codex,");
    expect(result.message).toContain("delivering through Feishu.");
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
    expect(result.checks.map((check) => check.id)).toEqual([
      "server",
      "daemon-service",
      "runtime:claude-code",
      "im:feishu",
      "im:slack",
    ]);
    expect(result.message).toContain("Claude Code CLI: installed (1.2.3) but not signed in");
    expect(result.message).toContain("Fix 1/1 — Sign in to Claude Code on this computer");
    expect(result.message).toContain("  claude auth login");
    expect(result.message).toContain("first-tree-ai/opentag#236");
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
    expect(result.message).toContain("Fix 4/4 — Repair the Slack CLI");
    // A CLI that is installed but unresponsive must not be told to reinstall.
    expect(result.message).not.toContain("npm install -g @larksuite/cli\n  Note: OpenTag needs it");
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
          detail: "not installed, or not on this shell's PATH",
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

describe("serviceProcessEnvironment", () => {
  const account = { homedir: "/Users/tester", shell: "/bin/zsh", username: "tester" };

  it("drops shell-only credentials and provider overrides the service never receives", () => {
    const environment = serviceProcessEnvironment(
      {
        ANTHROPIC_API_KEY: "shell-only",
        CLAUDE_CODE_OAUTH_TOKEN: "shell-only",
        CLAUDE_CONFIG_DIR: "/shell/claude",
        CODEX_HOME: "/shell/codex",
        PATH: "/shell/bin",
        TMPDIR: "/tmp/user",
      },
      {
        environment: { OPENTAG_HOME: "/Users/tester/.opentag", OPENTAG_SERVICE_MODE: "1", PATH: "/service/bin" },
        platform: "launchd",
      },
      account,
    );

    // A launchd job receives the account's own variables plus exactly what its definition declares.
    expect(environment).toEqual({
      HOME: "/Users/tester",
      LOGNAME: "tester",
      OPENTAG_HOME: "/Users/tester/.opentag",
      OPENTAG_SERVICE_MODE: "1",
      PATH: "/service/bin",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp/user",
      USER: "tester",
    });
  });

  it("takes the account identity from the operating system, not the invoking shell", () => {
    const environment = serviceProcessEnvironment(
      // A shell can export any HOME; the service manager still starts the job from the account.
      { HOME: "/tmp/pretend-home", USER: "someone-else" },
      { environment: { PATH: "/service/bin" }, platform: "launchd" },
      account,
    );

    expect(environment).toMatchObject({ HOME: "/Users/tester", USER: "tester" });
  });

  it("gives a systemd unit its own manager variables", () => {
    const environment = serviceProcessEnvironment(
      { TMPDIR: "/tmp/user", XDG_RUNTIME_DIR: "/run/user/1000" },
      { environment: { PATH: "/service/bin" }, platform: "systemd" },
      { homedir: "/home/tester", shell: null, username: "tester" },
    );

    expect(environment).toEqual({
      HOME: "/home/tester",
      LOGNAME: "tester",
      PATH: "/service/bin",
      USER: "tester",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });
});

describe("readDaemonServiceEnvironment", () => {
  it("reads the PATH out of a systemd unit", async () => {
    const home = await temporaryDirectory("opentag-service-systemd-");
    const definitionPath = resolve(home, "opentag.service");
    await writeFile(
      definitionPath,
      renderSystemdUnit({
        home,
        invocation: { args: [], program: "/usr/local/bin/opentag" },
        path: "/opt/tools/bin:/usr/bin",
        serviceId: "opentag-test",
      }),
      "utf8",
    );

    await expect(
      readDaemonServiceEnvironment({
        home,
        manager: statusManager({ definitionPath, platform: "systemd", state: "active" }),
        platform: "linux",
      }),
    ).resolves.toEqual({
      definitionPath,
      environment: { OPENTAG_HOME: home, OPENTAG_SERVICE_MODE: "1", PATH: "/opt/tools/bin:/usr/bin" },
      kind: "installed",
      path: "/opt/tools/bin:/usr/bin",
      platform: "systemd",
      serviceHome: home,
      state: "active",
    });
  });

  it("fails closed when an installed definition declares no PATH", async () => {
    const home = await temporaryDirectory("opentag-service-broken-");
    const definitionPath = resolve(home, "opentag.plist");
    await writeFile(definitionPath, "<plist><dict></dict></plist>\n", "utf8");

    await expect(
      readDaemonServiceEnvironment({
        home,
        manager: statusManager({ definitionPath, platform: "launchd", state: "active" }),
        platform: "darwin",
      }),
    ).resolves.toEqual({
      definitionPath,
      kind: "unreadable",
      reason: "the installed service definition declares no PATH",
    });
  });

  it("reports an unsupported platform instead of guessing", async () => {
    await expect(readDaemonServiceEnvironment({ platform: "win32" })).resolves.toEqual({
      kind: "unsupported",
      platform: "win32",
    });
  });
});

describe("daemon service environment", () => {
  it("refuses to call a computer ready when no daemon service is installed", async () => {
    const result = await runDoctor(await doctorOptions({ service: "not-installed" }));

    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "daemon-service")).toMatchObject({
      detail: "not installed, so nothing runs Agents or publishes readiness from this computer",
      status: "install",
    });
    expect(result.message).toContain("Install the OpenTag daemon service");
    expect(result.message).not.toContain("can run an OpenTag agent on");
    expect(result.message).toContain("CLI checks used this shell's PATH");
  });

  it("blocks on an installed service that is not running", async () => {
    const result = await runDoctor(await doctorOptions({ service: { state: "inactive" } }));

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("installed but inactive, so nothing runs Agents");
    expect(result.message).toContain("daemon restart");
  });

  it("names the definition its CLI checks came from", async () => {
    const result = await runDoctor(await doctorOptions({}));

    expect(result.exitCode).toBe(0);
    expect(result.checks.find((check) => check.id === "daemon-service")?.detail).toBe(
      "active; checks below use the PATH it runs with",
    );
    expect(result.message).toMatch(/CLI checks used the PATH declared by .*opentag\.plist/u);
  });

  it("refuses a service that belongs to another OpenTag home", async () => {
    const other = await temporaryDirectory("opentag-doctor-other-home-");
    const options = await doctorOptions({ service: { home: other } });

    const result = await runDoctor(options);

    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "daemon-service")).toMatchObject({
      detail: `active for another OpenTag home (${other}), not ${options.home as string}`,
      status: "error",
    });
    expect(result.message).not.toContain("can run an OpenTag agent on");
  });

  it("keeps shell-only credentials and provider overrides out of what it probes with", async () => {
    const captured: NodeJS.ProcessEnv[] = [];
    const options = await doctorOptions({
      // A launchd job never sees these; only the operator's shell has them.
      env: { ANTHROPIC_API_KEY: "shell-only", CLAUDE_CONFIG_DIR: "/shell/claude", PATH: "/shell/bin" },
      service: { path: "/service/bin" },
    });

    const result = await runDoctor({
      ...options,
      runtimeProbe: async (provider, _signal, environment) => {
        captured.push(environment);
        return provider === "codex" ? READY : NOT_INSTALLED;
      },
    });

    expect(captured).toHaveLength(2);
    for (const environment of captured) {
      expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
      expect(environment.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(environment.PATH).toBe("/service/bin");
    }
    // The shell PATH stays available for the divergence diagnosis, never for probing.
    expect(result.checks.find((check) => check.id === "runtime:codex")?.status).toBe("ok");
  });

  it("explains a CLI the operator can run but the daemon cannot", async () => {
    const shell = await temporaryDirectory("opentag-doctor-shell-path-");
    await writeFile(resolve(shell, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = await runDoctor(
      await doctorOptions({
        env: { PATH: shell },
        runtimeResults: { codex: NOT_INSTALLED, "claude-code": NOT_INSTALLED },
        service: { path: "/usr/bin:/bin" },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "runtime:codex")).toMatchObject({
      detail: "on this shell's PATH, but not on the PATH the daemon service runs with",
    });
    expect(result.message).toContain("Give the daemon the same PATH this shell has");
    expect(result.message).toContain("daemon install");
    // One cause, one instruction: a second diverging CLI must not repeat the same fix.
    expect(result.message.match(/Give the daemon the same PATH/gu)).toHaveLength(1);
    // The runtime the shell cannot resolve either keeps the ordinary install fix.
    expect(result.message).toContain("Install the Claude Code CLI");
  });
});

describe("default probe wiring", () => {
  it("resolves the real provider factories and messaging commands without touching the computer", async () => {
    const home = await temporaryDirectory("opentag-doctor-wiring-");
    // An empty PATH is the honest "nothing is installed" case: it exercises the real factories and
    // the real messaging CLI commands without spawning anything.
    const environment = { HOME: home, PATH: "" };

    const [runtimeChecks, imChecks] = await Promise.all([
      checkAgentRuntimes({ clientVersion: "0.0.0-test", environment, providers: AGENT_RUNTIME_PROVIDERS }),
      checkImClis({ environment, providers: IM_CLI_PROVIDERS }),
    ]);

    expect([...runtimeChecks, ...imChecks].map((check) => [check.id, check.status])).toEqual([
      ["runtime:codex", "install"],
      ["runtime:claude-code", "install"],
      ["im:feishu", "install"],
      ["im:slack", "install"],
    ]);
    // Observing a Computer must not create the provider homes the report is about.
    await expect(stat(resolve(home, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(home, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an installed messaging CLI that answers the probe", async () => {
    const home = await temporaryDirectory("opentag-doctor-lark-");
    const lark = resolve(home, "lark-cli");
    await writeFile(
      lark,
      '#!/bin/sh\nif [ "$1" = "--version" ] || { [ "$1" = "im" ] && [ "$2" = "--help" ]; }; then exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    );

    const checks = await checkImClis({ environment: { PATH: home }, providers: ["feishu"] });

    expect(checks).toEqual([{ detail: "ready", id: "im:feishu", status: "ok", title: "Feishu CLI (lark-cli)" }]);
  });
});

async function doctorOptions(overrides: {
  env?: NodeJS.ProcessEnv;
  imStatuses?: Partial<Record<ImCliProvider, "install" | "ready" | "unavailable">>;
  runtimeResults?: Partial<Record<AgentRuntimeProvider, AgentRuntimeProbeResult>>;
  runtimes?: readonly AgentRuntimeProvider[];
  service?: { home?: string; path?: string; state?: DaemonServiceState } | "not-installed";
}): Promise<DoctorOptions> {
  const home = await temporaryDirectory("opentag-doctor-");
  return {
    env: overrides.env ?? {},
    healthChecker: vi.fn().mockResolvedValue({ service: "opentag-server", status: "ok" }),
    home,
    imProbe: async (provider) => overrides.imStatuses?.[provider] ?? "ready",
    platform: "darwin",
    runtimeProbe: async (provider) => overrides.runtimeResults?.[provider] ?? READY,
    serverUrl: "http://server.example",
    serviceManager: await fakeServiceManager(home, overrides.service),
    ...(overrides.runtimes ? { runtimes: overrides.runtimes } : {}),
  };
}

function statusManager(info: {
  definitionPath: string;
  platform: "launchd" | "systemd";
  state: DaemonServiceState;
}): DaemonServiceManager {
  return {
    status: async () => ({
      currentHome: "/unused",
      definitionPath: info.definitionPath,
      logHint: "/unused",
      platform: info.platform,
      serviceId: "opentag-test",
      state: info.state,
    }),
  } as unknown as DaemonServiceManager;
}

/** Stands in for launchd: a real plist on disk, so the PATH parser is exercised for real. */
async function fakeServiceManager(
  home: string,
  service: { home?: string; path?: string; state?: DaemonServiceState } | "not-installed" = {},
): Promise<DaemonServiceManager> {
  const definitionPath = resolve(home, "opentag.plist");
  const state: DaemonServiceState = service === "not-installed" ? "not-installed" : (service.state ?? "active");
  const serviceHome = service === "not-installed" ? home : (service.home ?? home);
  if (service !== "not-installed") {
    await writeFile(
      definitionPath,
      renderLaunchdPlist({
        home: serviceHome,
        label: "opentag-test",
        path: service.path ?? "/usr/bin:/bin",
        stderrPath: resolve(home, "err.log"),
        stdoutPath: resolve(home, "out.log"),
        wrapperPath: resolve(home, "wrapper"),
      }),
      "utf8",
    );
  }
  const info = {
    configuredHome: serviceHome,
    currentHome: home,
    definitionPath,
    logHint: resolve(home, "logs"),
    platform: "launchd",
    serviceId: "opentag-test",
    state,
  } as const;
  const unsupported = () => Promise.reject(new Error("not used by doctor"));
  return {
    installAndStart: unsupported,
    preflight: unsupported,
    restart: unsupported,
    start: unsupported,
    status: async () => info,
    stop: unsupported,
    uninstall: unsupported,
  } as unknown as DaemonServiceManager;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}
