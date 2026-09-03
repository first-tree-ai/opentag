import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  probeIntegrationCliInstallations,
  ServerHealthConfigurationError,
  ServerHealthHttpError,
  ServerHealthNetworkError,
  ServerHealthResponseError,
  ServerHealthTimeoutError,
} from "@opentag/client";
import { StructuredErrorSchema } from "@opentag/shared";
import { Command, type CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDoctorCommand } from "../commands/doctor.js";
import { channelConfig } from "../core/channel/config.js";
import type { DoctorResult } from "../core/diagnostics/doctor.js";
import * as doctorCore from "../core/diagnostics/doctor.js";
import {
  type DoctorCheck,
  type DoctorOptions,
  renderDoctorReport,
  resolveDoctorTarget,
  runDoctor,
} from "../core/diagnostics/doctor.js";

const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const otherComputerId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const serverUrl = "https://server.example";
const secretToken = "otmc_NEVER_PRINT_THIS_SECRET";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe("doctor command target", () => {
  it("presents doctor results in text and JSON modes", async () => {
    const program = new Command().name("opentag");
    registerDoctorCommand(program);
    const run = vi
      .spyOn(doctorCore, "runDoctor")
      .mockResolvedValue({ exitCode: 0, message: "healthy", checks: [] } as unknown as DoctorResult);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["node", "opentag", "doctor"]);
      await program.parseAsync(["node", "opentag", "doctor", "--json"]);
      expect(stdout).toHaveBeenCalledWith("healthy\n");
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"ok":true'));
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      run.mockRestore();
    }
  });

  it("presents an unhealthy doctor report as a failure envelope in JSON mode", async () => {
    const program = new Command().name("opentag");
    registerDoctorCommand(program);
    const report = {
      exitCode: 1,
      message: "OpenTag Doctor\n\nSummary\n  1 blocking baseline check(s) failed for this OpenTag Home.",
      target: { home: "/tmp/opentag-doctor" },
      checks: [
        {
          code: "daemon.service",
          scope: "daemon-service",
          status: "fail",
          blocking: true,
          label: "Daemon service",
          detail: "inactive",
        },
      ],
      nextActions: [],
      providerCliSetup: "unknown",
      notEvaluated: [],
    } as unknown as DoctorResult;
    const run = vi.spyOn(doctorCore, "runDoctor").mockResolvedValue(report);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["node", "opentag", "doctor", "--json"]);
      expect(process.exitCode).toBe(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledTimes(1);
      const document = JSON.parse(String(stderr.mock.calls[0]?.[0])) as {
        ok: boolean;
        error: unknown;
        result: { exitCode: number; providerCliSetup: string; checks: unknown[] };
      };
      expect(StructuredErrorSchema.safeParse(document.error).success).toBe(true);
      expect(document.ok).toBe(false);
      // An unhealthy report is a configuration failure; the shared policy maps that to the
      // operational-failure exit, so the envelope and the process exit agree.
      expect(document.error).toEqual({
        code: "DOCTOR_UNHEALTHY",
        category: "configuration",
        retryability: "never",
        phase: "unknown",
        message: "1 blocking baseline check(s) failed for this OpenTag Home.",
      });
      // The full report stays attached as the bounded partial result, checks included.
      expect(document.result.exitCode).toBe(1);
      expect(document.result.providerCliSetup).toBe("unknown");
      expect(document.result.checks).toHaveLength(1);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
      run.mockRestore();
    }
  });

  it("presents unexpected doctor failures through the shared structured error path", async () => {
    const program = new Command().name("opentag");
    registerDoctorCommand(program);
    const run = vi.spyOn(doctorCore, "runDoctor").mockRejectedValue(new Error("doctor unavailable"));
    const previousExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    try {
      await program.parseAsync(["node", "opentag", "doctor"]);
      expect(process.exitCode).toBe(3);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("INTERNAL_ERROR: doctor unavailable"));
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
      run.mockRestore();
    }
  });

  it("does not accept a caller-selected Server URL", async () => {
    const program = new Command().name("opentag").exitOverride();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    registerDoctorCommand(program);

    await expect(
      program.parseAsync(["node", "opentag", "doctor", "--server-url", "https://other.example"]),
    ).rejects.toMatchObject({
      code: "commander.unknownOption",
    } satisfies Partial<CommanderError>);
  });

  it("uses the canonical OPENTAG_HOME and ignores OPENTAG_SERVER_URL", async () => {
    const home = await createHome();
    const healthChecker = vi.fn().mockResolvedValue({ service: "opentag-server", status: "ok" } as const);
    const result = await runHealthyDoctor(home, {
      env: { OPENTAG_HOME: join(home, ".", "nested", ".."), OPENTAG_SERVER_URL: "https://ignored.example" },
      healthChecker,
    });

    expect(result.target).toMatchObject({ home: resolve(home), homeSource: "environment" });
    expect(result.message).toContain(`OpenTag Home: ${resolve(home)} (environment)`);
    expect(result.message).not.toContain("ignored.example");
    expect(healthChecker).toHaveBeenCalledTimes(1);
    expect(healthChecker).toHaveBeenCalledWith(serverUrl);
  });

  it("reports an explicitly selected default path as environment-sourced", () => {
    expect(
      resolveDoctorTarget({
        arch: "arm64",
        channel: "stable",
        cliVersion: "0.1.0",
        environment: { OPENTAG_HOME: channelConfig.defaultHome },
        nodeVersion: "v24.0.0",
        platform: "darwin",
      }),
    ).toMatchObject({ home: resolve(channelConfig.defaultHome), homeSource: "environment" });
  });

  it("reports the channel default when OPENTAG_HOME is absent", () => {
    expect(
      resolveDoctorTarget({
        arch: "arm64",
        channel: "stable",
        cliVersion: "0.1.0",
        environment: {},
        nodeVersion: "v24.0.0",
        platform: "darwin",
      }),
    ).toMatchObject({ home: resolve(channelConfig.defaultHome), homeSource: "channel-default" });
  });
});

describe("doctor local configuration", () => {
  it("rejects an unsupported credential version", async () => {
    const home = await createHome({
      rawCredentials: {
        version: 99,
        computer: boundComputer("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4"),
      },
    });
    const healthChecker = vi.fn();

    const result = await runHealthyDoctor(home, { healthChecker });

    expect(check(result.checks, "local.credentials")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "local.binding")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "server.health")).toMatchObject({ status: "skipped" });
    expect(healthChecker).not.toHaveBeenCalled();
  });

  it("fails a missing identity, skips Server health, and continues independent checks", async () => {
    const home = await createHome({ identity: undefined });
    const inspectDaemonService = vi.fn().mockResolvedValue(activeService(home));
    const healthChecker = vi.fn();
    const runtimeDetector = vi.fn().mockResolvedValue(installedCodex());

    const result = await runDoctor({
      env: { OPENTAG_HOME: home },
      healthChecker,
      inspectDaemonService,
      runtimeDetector,
    });

    expect(check(result.checks, "local.identity")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "server.health")).toMatchObject({
      blocking: true,
      detail: expect.stringMatching(/no connected Server/i),
      status: "skipped",
    });
    expect(check(result.checks, "daemon.service")).toMatchObject({ status: "pass" });
    expect(check(result.checks, "runtime.any-installed")).toMatchObject({ status: "pass" });
    expect(inspectDaemonService).toHaveBeenCalledTimes(1);
    expect(runtimeDetector).toHaveBeenCalledTimes(1);
    expect(healthChecker).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });

  it("does not silently discard a malformed credential or disclose its token", async () => {
    const home = await createHome({
      rawCredentials: {
        version: 3,
        computer: {
          computerId,
          installationId: "not-a-uuid",
          machineToken: secretToken,
          serverUrl,
        },
      },
    });
    const healthChecker = vi.fn();

    const result = await runHealthyDoctor(home, { healthChecker });

    expect(check(result.checks, "local.credentials")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "server.health")).toMatchObject({ status: "skipped" });
    expect(healthChecker).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.message).not.toContain(secretToken);
    expect(JSON.stringify(result)).not.toContain(secretToken);
  });

  it("fails closed for an unsafe symlinked config directory", async () => {
    const home = await createHome();
    const external = await mkdtemp(join(tmpdir(), "opentag-doctor-external-"));
    homes.push(external);
    await rm(join(home, "config"), { force: true, recursive: true });
    await mkdir(join(external, "config"), { mode: 0o700 });
    await symlink(join(external, "config"), join(home, "config"), "dir");
    const healthChecker = vi.fn();

    const result = await runHealthyDoctor(home, { healthChecker });

    expect(check(result.checks, "local.identity")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "local.credentials")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "server.health")).toMatchObject({ status: "skipped" });
    expect(healthChecker).not.toHaveBeenCalled();
  });

  it("rejects a credential for a different Server without contacting either Server", async () => {
    const home = await createHome({
      credential: boundComputer("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4", {
        serverUrl: "https://other.example",
      }),
    });
    const healthChecker = vi.fn();

    const result = await runHealthyDoctor(home, { healthChecker });

    expect(check(result.checks, "local.binding")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "server.health")).toMatchObject({ status: "skipped" });
    expect(healthChecker).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });

  it("rejects a credential whose Computer differs from the local identity", async () => {
    const home = await createHome({
      credential: boundComputer("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4", { computerId: otherComputerId }),
    });

    const result = await runHealthyDoctor(home);

    expect(check(result.checks, "local.binding")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "server.health")).toMatchObject({ status: "skipped" });
    expect(result.exitCode).toBe(1);
  });
});

describe("doctor daemon service", () => {
  it("passes only an active, current service for this OpenTag Home", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home);

    expect(check(result.checks, "daemon.service")).toMatchObject({ blocking: true, status: "pass" });
  });

  it.each([
    ["inactive", { state: "inactive" as const }],
    ["drifted", { drifted: true }],
    ["unknown", { state: "unknown" as const }],
    ["different Home", { configuredHome: "/different/opentag-home" }],
    ["unverifiable Home", { configuredHome: undefined }],
    ["not installed", { state: "not-installed" as const }],
    ["malformed owner", { runtimeOwner: { consistency: "malformed" as const } }],
    ["unverified owner", { runtimeOwner: { consistency: "unverified" as const } }],
  ])("fails closed for a %s service observation", async (_label, override) => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      inspectDaemonService: vi.fn().mockResolvedValue({ ...activeService(home), ...override }),
    });

    expect(check(result.checks, "daemon.service")).toMatchObject({
      blocking: true,
      status: "state" in override && override.state === "unknown" ? "unknown" : "fail",
    });
    expect(result.exitCode).toBe(1);
  });

  it("treats a service inspection error as blocking unknown", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      inspectDaemonService: vi.fn().mockRejectedValue(new Error("manager unavailable")),
    });

    expect(check(result.checks, "daemon.service")).toMatchObject({ blocking: true, status: "unknown" });
    expect(result.exitCode).toBe(1);
  });

  it("classifies local inspection and runtime detector failures as unknown", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      inspectLocalConfiguration: vi.fn().mockRejectedValue(new Error("private local details")),
      runtimeDetector: vi.fn().mockRejectedValue(new Error("runtime detector details")),
    });

    expect(check(result.checks, "local.identity")).toMatchObject({ status: "unknown", blocking: true });
    expect(check(result.checks, "local.credentials")).toMatchObject({ status: "unknown", blocking: true });
    expect(check(result.checks, "local.binding")).toMatchObject({ status: "unknown", blocking: true });
    expect(check(result.checks, "runtime.any-installed")).toMatchObject({ status: "unknown", blocking: true });
    expect(check(result.checks, "runtime.codex.installation")).toMatchObject({ status: "unknown" });
    expect(result.message).toContain("private local details");
    expect(result.exitCode).toBe(1);
  });

  it("uses default daemon and runtime detectors for a supported report shape", async () => {
    const home = await createHome();
    const result = await runDoctor({
      arch: "arm64",
      channel: "stable",
      cliVersion: "0.1.0",
      env: { OPENTAG_HOME: home },
      healthChecker: vi.fn().mockResolvedValue({ service: "opentag-server", status: "ok" } as const),
      nodeVersion: "v24.0.0",
      platform: "freebsd",
    });

    expect(check(result.checks, "daemon.service")).toMatchObject({ status: "unknown", blocking: true });
    expect(check(result.checks, "runtime.any-installed")).toBeDefined();
  });
});

describe("doctor Server health", () => {
  it("reports the connected Server public health endpoint without claiming higher-layer readiness", async () => {
    const home = await createHome();
    const healthChecker = vi.fn().mockResolvedValue({ service: "opentag-server", status: "ok" } as const);
    const result = await runHealthyDoctor(home, { healthChecker });

    expect(check(result.checks, "server.health")).toMatchObject({
      blocking: true,
      detail: expect.stringContaining(serverUrl),
      status: "pass",
    });
    expect(result.message).toContain("Server health endpoint");
    expect(result.message).not.toMatch(/WebSocket.*(?:pass|ready|reachable)/iu);
    expect(result.message).not.toMatch(/handoff.*ready/iu);
  });

  it("classifies a bounded Server timeout as a blocking failure", async () => {
    const home = await createHome();
    const healthChecker = vi.fn().mockRejectedValue(new ServerHealthTimeoutError("timed out after 5000 ms"));
    const result = await runHealthyDoctor(home, { healthChecker });

    expect(healthChecker).toHaveBeenCalledWith(serverUrl);
    expect(check(result.checks, "server.health")).toMatchObject({
      blocking: true,
      detail: expect.stringMatching(/timed out|timeout/i),
      status: "fail",
    });
    expect(result.exitCode).toBe(1);
  });

  it.each([
    [new ServerHealthConfigurationError("bad URL"), /invalid connected Server URL/iu],
    [new ServerHealthNetworkError("network down"), /could not reach/iu],
    [new ServerHealthHttpError(503), /HTTP 503/iu],
    [new ServerHealthResponseError("bad response"), /invalid health response/iu],
    [new Error("unexpected health error"), /health status could not be determined/iu],
  ])("classifies %s without exposing implementation details", async (error, detail) => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, { healthChecker: vi.fn().mockRejectedValue(error) });
    expect(check(result.checks, "server.health")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(detail),
    });
  });
});

describe("doctor Agent Runtime CLI observations", () => {
  it.each([
    ["Codex", installedCodex()],
    [
      "Claude Code",
      [
        { displayName: "Codex CLI", provider: "codex", status: "not-installed" as const },
        {
          displayName: "Claude Code CLI",
          path: "/usr/local/bin/claude",
          provider: "claude-code",
          source: "well-known",
          status: "installed" as const,
        },
      ],
    ],
  ])("passes the aggregate when only %s is installed", async (_label, detection) => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      runtimeDetector: vi.fn().mockResolvedValue(detection),
    });

    expect(check(result.checks, "runtime.any-installed")).toMatchObject({ blocking: true, status: "pass" });
    const providerChecks = [
      check(result.checks, "runtime.codex.installation"),
      check(result.checks, "runtime.claude-code.installation"),
    ];
    expect(providerChecks).toContainEqual(expect.objectContaining({ blocking: false, status: "pass" }));
    expect(providerChecks).toContainEqual(expect.objectContaining({ blocking: false, status: "info" }));
    expect(result.exitCode).toBe(0);
  });

  it("fails the aggregate when neither supported Runtime is installed", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      runtimeDetector: vi.fn().mockResolvedValue([
        { displayName: "Codex CLI", provider: "codex", status: "not-installed" },
        { displayName: "Claude Code CLI", provider: "claude-code", status: "not-installed" },
      ]),
    });

    expect(check(result.checks, "runtime.any-installed")).toMatchObject({ blocking: true, status: "fail" });
    expect(result.exitCode).toBe(1);
  });

  it("keeps a discovered Provider when the other detector is unknown", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      runtimeDetector: vi.fn().mockResolvedValue([
        {
          displayName: "Codex CLI",
          path: "/usr/local/bin/codex",
          provider: "codex",
          source: "caller-path",
          status: "installed",
        },
        {
          detail: "filesystem inspection failed",
          displayName: "Claude Code CLI",
          provider: "claude-code",
          status: "unknown",
        },
      ]),
    });

    expect(check(result.checks, "runtime.any-installed")).toMatchObject({ blocking: true, status: "pass" });
    expect(check(result.checks, "runtime.codex.installation")).toMatchObject({
      detail: expect.stringContaining("caller-path"),
      observedFrom: "current CLI process environment",
      path: "/usr/local/bin/codex",
      status: "pass",
    });
    expect(check(result.checks, "runtime.claude-code.installation")).toMatchObject({ status: "unknown" });
    expect(result.message).toContain("/usr/local/bin/codex (caller-path)");
    expect(result.exitCode).toBe(0);
  });
});

describe("doctor IM Provider CLI observations", () => {
  it("reports installed Lark CLI and Slack CLI canonical paths without blocking", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      integrationCliDetector: vi.fn().mockResolvedValue([
        {
          cli: "feishu",
          displayName: "Lark CLI",
          path: "/usr/local/bin/lark-cli",
          source: "caller-path",
          status: "installed",
        },
        {
          cli: "slack",
          displayName: "Slack CLI",
          path: "/opt/homebrew/bin/slack",
          source: "well-known",
          status: "installed",
        },
      ]),
    });

    expect(check(result.checks, "provider-cli.feishu.installation")).toMatchObject({
      blocking: false,
      detail: "installed at /usr/local/bin/lark-cli (caller-path)",
      observedFrom: "current CLI process environment and operating-system account locations",
      path: "/usr/local/bin/lark-cli",
      status: "pass",
    });
    expect(check(result.checks, "provider-cli.slack.installation")).toMatchObject({
      blocking: false,
      detail: "installed at /opt/homebrew/bin/slack (well-known)",
      path: "/opt/homebrew/bin/slack",
      status: "pass",
    });
    expect(result.providerCliSetup).toBe("ready");
    expect(result.message).toContain("/usr/local/bin/lark-cli (caller-path)");
    expect(result.message).toContain("/opt/homebrew/bin/slack (well-known)");
    expect(result.exitCode).toBe(0);
  });

  it("reports a missing Integration CLI as non-blocking info", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home);

    expect(check(result.checks, "provider-cli.feishu.installation")).toMatchObject({
      blocking: false,
      detail: "not installed",
      status: "info",
    });
    expect(check(result.checks, "provider-cli.slack.installation")).toMatchObject({
      blocking: false,
      command: expect.stringContaining("provider-cli ensure --provider slack"),
      status: "info",
    });
    expect(result.nextActions).toContainEqual(
      expect.objectContaining({
        checkCode: "provider-cli.slack.installation",
        command: expect.stringContaining("provider-cli ensure --provider slack"),
        reason: "provider-cli.slack.installation",
      }),
    );
    expect(result.providerCliSetup).toBe("needs_attention");
    expect(result.message).toContain("At least one messaging CLI still needs attention.");
    expect(result.message).toContain("Lark CLI: not installed");
    expect(result.exitCode).toBe(0);
  });

  it("keeps Integration CLI unknown results non-blocking", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      integrationCliDetector: vi.fn().mockResolvedValue([
        {
          cli: "feishu",
          detail: "filesystem inspection failed",
          displayName: "Lark CLI",
          status: "unknown",
        },
        { cli: "slack", displayName: "Slack CLI", status: "not-installed" },
      ]),
    });

    expect(check(result.checks, "provider-cli.feishu.installation")).toMatchObject({
      blocking: false,
      status: "unknown",
    });
    expect(result.exitCode).toBe(0);
  });

  it("observes Integration CLIs through install-only discovery without executing them", async () => {
    const home = await createHome();
    const bin = join(home, "bin");
    await mkdir(bin);
    const sentinel = join(home, "executed");
    const lark = join(bin, "lark-cli");
    await writeFile(lark, `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`, { mode: 0o700 });
    const result = await runHealthyDoctor(home, {
      env: { HOME: home, OPENTAG_HOME: home, PATH: bin },
      integrationCliDetector: (request) =>
        probeIntegrationCliInstallations({
          candidateAllowed: () => true,
          desktopAppDirs: () => [],
          environment: request.environment,
          home,
          platform: "linux",
          wellKnownDirs: () => [],
        }),
      platform: "linux",
    });

    expect(check(result.checks, "provider-cli.feishu.installation")).toMatchObject({
      blocking: false,
      path: await realpath(lark),
      status: "pass",
    });
    await expect(realpath(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.exitCode).toBe(0);
  });

  it("does not add an Integration readiness or blocking contract when the detector fails", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      integrationCliDetector: vi.fn().mockRejectedValue(new Error("provider selection unavailable")),
    });

    expect(check(result.checks, "provider-cli.feishu.installation")).toMatchObject({
      blocking: false,
      status: "unknown",
    });
    expect(check(result.checks, "provider-cli.slack.installation")).toMatchObject({
      blocking: false,
      status: "unknown",
    });
    expect(result.checks.some((item) => item.code.startsWith("provider-cli.") && item.blocking)).toBe(false);
    expect(result.message).not.toMatch(/Integration (?:CLI )?ready/iu);
    expect(result.exitCode).toBe(0);
  });
});

describe("doctor report and exit contract", () => {
  it("renders fixed sections, sources, baseline wording, and the complete not-evaluated list", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home);
    const rendered = renderDoctorReport(result);
    const headings = [
      "Target",
      "Local configuration",
      "Daemon service",
      "Server",
      "Agent Runtime CLIs",
      "IM Provider CLIs",
      "Context Tree",
      "Summary",
      "Not evaluated",
    ];

    const headingOffsets = headings.map((heading) => rendered.indexOf(`\n${heading}\n`));
    expect(headingOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(headingOffsets).toEqual([...headingOffsets].sort((left, right) => left - right));
    expect(rendered).toContain("/usr/local/bin/codex (caller-path)");
    expect(rendered).toContain("Baseline checks passed for this OpenTag Home.");
    expect(rendered).not.toContain("All required checks passed");
    expect(rendered).not.toMatch(/OpenTag is ready|handoff is ready/iu);
    expect(result.notEvaluated).toEqual([
      "Agent Runtime authentication",
      "Agent Runtime version or protocol compatibility",
      "Agent Runtime visibility from the installed daemon environment",
      "machine-token authentication or WebSocket registration",
      "Integration CLI version compatibility, authentication, credentials, installation configuration, or network availability",
      "Integration CLI visibility from the installed daemon environment",
      "end-to-end Turn or handoff delivery",
    ]);
    expect(result.checks.map((item) => item.code)).toEqual([
      "target.home",
      "local.identity",
      "local.credentials",
      "local.binding",
      "daemon.service",
      "server.health",
      "runtime.any-installed",
      "runtime.codex.installation",
      "runtime.claude-code.installation",
      "provider-cli.feishu.installation",
      "provider-cli.slack.installation",
      "context-tree.target",
      "context-tree.tree",
    ]);
    for (const item of result.notEvaluated) expect(rendered).toContain(item);
    expect(result.exitCode).toBe(0);
  });

  it("never lets a Context Tree fault change the doctor exit code", async () => {
    const home = await createHome();
    const cases = [
      { configPath: resolve(home, "config", "context-tree.json"), tree: "unknown" as const },
      {
        configPath: resolve(home, "config", "context-tree.json"),
        target: "team-context-tree",
        tree: "invalid" as const,
        detail: "DIRTY_TREE",
      },
    ];

    for (const state of cases) {
      const result = await runHealthyDoctor(home, {
        inspectContextTreeState: vi.fn().mockResolvedValue(state),
      });
      // Context Tree is optional memory, so no check here may block.
      expect(result.checks.filter((check) => check.scope === "context-tree").every((check) => !check.blocking)).toBe(
        true,
      );
      expect(result.exitCode).toBe(0);
    }
  });

  it("tells an operator how to configure a Computer that has no Context Tree", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      inspectContextTreeState: vi.fn().mockResolvedValue({
        configPath: resolve(home, "config", "context-tree.json"),
        tree: "unknown" as const,
      }),
    });
    const target = result.checks.find((check) => check.code === "context-tree.target");

    expect(target).toMatchObject({ status: "info", blocking: false });
    expect(target?.remediation).toContain("context-tree connect");
    expect(renderDoctorReport(result)).toContain("no Context Tree is configured");
  });

  it("reports an uncloned GitHub target as expected rather than broken", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      inspectContextTreeState: vi.fn().mockResolvedValue({
        configPath: resolve(home, "config", "context-tree.json"),
        target: "acme/shared-context",
        tree: "not-cloned" as const,
      }),
    });

    expect(result.checks.find((check) => check.code === "context-tree.tree")).toMatchObject({
      status: "info",
      blocking: false,
    });
    expect(renderDoctorReport(result)).toContain("the first Agent Session clones it");
  });

  it("reports an unreadable Context Tree state as unknown without failing the run", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      inspectContextTreeState: vi.fn().mockRejectedValue(new Error("inspection exploded")),
    });

    expect(result.checks.find((check) => check.code === "context-tree.target")).toMatchObject({
      status: "unknown",
      blocking: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it("returns exit 1 for any blocking fail or unknown and reports the exact count", async () => {
    const home = await createHome();
    const result = await runHealthyDoctor(home, {
      inspectDaemonService: vi.fn().mockRejectedValue(new Error("unavailable")),
      runtimeDetector: vi.fn().mockResolvedValue([
        { displayName: "Codex CLI", provider: "codex", status: "not-installed" },
        { displayName: "Claude Code CLI", provider: "claude-code", status: "not-installed" },
      ]),
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("2 blocking baseline check(s) failed for this OpenTag Home.");
    expect(result.message).not.toContain("Baseline checks passed for this OpenTag Home.");
  });
});

function check(checks: DoctorCheck[], code: string): DoctorCheck {
  const result = checks.find((candidate) => candidate.code === code);
  expect(result, `missing doctor check ${code}`).toBeDefined();
  return result as DoctorCheck;
}

async function runHealthyDoctor(home: string, overrides: Partial<DoctorOptions> = {}) {
  return runDoctor({
    arch: "arm64",
    channel: "stable",
    cliVersion: "0.1.0",
    env: { OPENTAG_HOME: home },
    healthChecker: vi.fn().mockResolvedValue({ service: "opentag-server", status: "ok" } as const),
    inspectContextTreeState: vi.fn().mockResolvedValue(configuredContextTree(home)),
    inspectDaemonService: vi.fn().mockResolvedValue(activeService(home)),
    integrationCliDetector: vi.fn().mockResolvedValue(missingIntegrationClis()),
    nodeVersion: "v24.0.0",
    platform: "darwin",
    runtimeDetector: vi.fn().mockResolvedValue(installedCodex()),
    ...overrides,
  });
}

function configuredContextTree(home: string) {
  return {
    configPath: resolve(home, "config", "context-tree.json"),
    target: "team-context-tree",
    tree: "valid" as const,
  };
}

function activeService(home: string) {
  return {
    configuredHome: resolve(home),
    currentHome: resolve(home),
    definitionPath: "/Users/test/Library/LaunchAgents/ai.first-tree.opentag.plist",
    drifted: false,
    logHint: "/Users/test/Library/Logs/OpenTag/daemon.log",
    pid: 1234,
    platform: "launchd" as const,
    runtimeOwner: { consistency: "consistent" as const, pid: 1234 },
    serviceId: "opentag",
    state: "active" as const,
  };
}

function installedCodex() {
  return [
    {
      displayName: "Codex CLI",
      path: "/usr/local/bin/codex",
      provider: "codex" as const,
      source: "caller-path" as const,
      status: "installed" as const,
    },
    { displayName: "Claude Code CLI", provider: "claude-code" as const, status: "not-installed" as const },
  ];
}

function missingIntegrationClis() {
  return [
    { cli: "feishu" as const, displayName: "Lark CLI", status: "not-installed" as const },
    { cli: "slack" as const, displayName: "Slack CLI", status: "not-installed" as const },
  ];
}

interface EnrollmentOverrides {
  computerId?: string;
  serverUrl?: string;
}

function boundComputer(bindingComputerId: string, overrides: EnrollmentOverrides = {}) {
  return {
    computerId: bindingComputerId,
    installationId: overrides.computerId ?? computerId,
    machineToken: secretToken,
    serverUrl: overrides.serverUrl ?? serverUrl,
  };
}

interface CreateHomeOptions {
  credential?: ReturnType<typeof boundComputer>;
  identity?: { computerId: string; serverUrl: string; version: 2 } | undefined;
  rawCredentials?: unknown;
}

async function createHome(options: CreateHomeOptions = {}): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "opentag-doctor-")));
  homes.push(home);
  const config = join(home, "config");
  await mkdir(config, { mode: 0o700 });

  const identity = Object.hasOwn(options, "identity")
    ? options.identity
    : { computerId, serverUrl, version: 2 as const };
  if (identity !== undefined) {
    await writeFile(join(config, "computer.json"), `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  }

  const credentials =
    options.rawCredentials ??
    ({
      computer: options.credential ?? boundComputer("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4"),
      version: 3,
    } as const);
  await writeFile(join(config, "computer-credentials.json"), `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  return home;
}
