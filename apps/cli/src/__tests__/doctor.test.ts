import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ServerHealthTimeoutError } from "@opentag/client";
import { Command, type CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDoctorCommand } from "../commands/doctor.js";
import { channelConfig } from "../core/channel/config.js";
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
  it("accepts multiple enrollments for the same Computer and canonical Server", async () => {
    const home = await createHome({
      enrollments: [
        enrollment("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4"),
        enrollment("e8ffbc17-a769-42c2-9214-76f28b7d2a42"),
      ],
    });

    const result = await runHealthyDoctor(home);

    expect(check(result.checks, "local.identity")).toMatchObject({ blocking: true, status: "pass" });
    expect(check(result.checks, "local.enrollments")).toMatchObject({ blocking: true, status: "pass" });
    expect(check(result.checks, "local.binding")).toMatchObject({
      blocking: true,
      detail: expect.stringMatching(/2 enrollment/),
      status: "pass",
    });
  });

  it("rejects duplicate enrollment identifiers instead of accepting a partial projection", async () => {
    const duplicateId = "19eb4f37-2cc0-49d4-85e2-b9987f9c71a4";
    const home = await createHome({ enrollments: [enrollment(duplicateId), enrollment(duplicateId)] });
    const healthChecker = vi.fn();

    const result = await runHealthyDoctor(home, { healthChecker });

    expect(check(result.checks, "local.enrollments")).toMatchObject({ blocking: true, status: "fail" });
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
      detail: expect.stringMatching(/no authoritative enrolled Server/i),
      status: "skipped",
    });
    expect(check(result.checks, "daemon.service")).toMatchObject({ status: "pass" });
    expect(check(result.checks, "runtime.any-installed")).toMatchObject({ status: "pass" });
    expect(inspectDaemonService).toHaveBeenCalledTimes(1);
    expect(runtimeDetector).toHaveBeenCalledTimes(1);
    expect(healthChecker).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });

  it("does not silently discard a malformed enrollment or disclose its token", async () => {
    const home = await createHome({
      rawCredentials: {
        version: 1,
        enrollments: [
          enrollment("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4"),
          {
            computerId,
            machineToken: secretToken,
            serverUrl,
            workspaceComputerId: "not-a-uuid",
          },
        ],
      },
    });
    const healthChecker = vi.fn();

    const result = await runHealthyDoctor(home, { healthChecker });

    expect(check(result.checks, "local.enrollments")).toMatchObject({ blocking: true, status: "fail" });
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
    expect(check(result.checks, "local.enrollments")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "server.health")).toMatchObject({ status: "skipped" });
    expect(healthChecker).not.toHaveBeenCalled();
  });

  it("rejects enrollments for different Servers without contacting either Server", async () => {
    const home = await createHome({
      enrollments: [
        enrollment("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4"),
        enrollment("e8ffbc17-a769-42c2-9214-76f28b7d2a42", { serverUrl: "https://other.example" }),
      ],
    });
    const healthChecker = vi.fn();

    const result = await runHealthyDoctor(home, { healthChecker });

    expect(check(result.checks, "local.binding")).toMatchObject({ blocking: true, status: "fail" });
    expect(check(result.checks, "server.health")).toMatchObject({ status: "skipped" });
    expect(healthChecker).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });

  it("rejects an enrollment whose Computer differs from the local identity", async () => {
    const home = await createHome({
      enrollments: [enrollment("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4", { computerId: otherComputerId })],
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
});

describe("doctor Server health", () => {
  it("reports the enrolled Server public health endpoint without claiming higher-layer readiness", async () => {
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
      "Integration CLI availability or authentication",
      "end-to-end Turn or handoff delivery",
    ]);
    expect(result.checks.map((item) => item.code)).toEqual([
      "target.home",
      "local.identity",
      "local.enrollments",
      "local.binding",
      "daemon.service",
      "server.health",
      "runtime.any-installed",
      "runtime.codex.installation",
      "runtime.claude-code.installation",
    ]);
    for (const item of result.notEvaluated) expect(rendered).toContain(item);
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
    inspectDaemonService: vi.fn().mockResolvedValue(activeService(home)),
    nodeVersion: "v24.0.0",
    platform: "darwin",
    runtimeDetector: vi.fn().mockResolvedValue(installedCodex()),
    ...overrides,
  });
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

interface EnrollmentOverrides {
  computerId?: string;
  serverUrl?: string;
}

function enrollment(workspaceComputerId: string, overrides: EnrollmentOverrides = {}) {
  return {
    computerId: overrides.computerId ?? computerId,
    machineToken: secretToken,
    serverUrl: overrides.serverUrl ?? serverUrl,
    workspaceComputerId,
  };
}

interface CreateHomeOptions {
  enrollments?: ReturnType<typeof enrollment>[];
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
      enrollments: options.enrollments ?? [enrollment("19eb4f37-2cc0-49d4-85e2-b9987f9c71a4")],
      version: 1,
    } as const);
  await writeFile(join(config, "computer-credentials.json"), `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  return home;
}
