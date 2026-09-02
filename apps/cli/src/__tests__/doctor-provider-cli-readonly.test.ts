import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCTOR_NOT_EVALUATED, type DoctorCheck, runDoctor } from "../core/diagnostics/doctor.js";
import { makeTempDir, snapshotFileTree } from "./provider-cli-fixtures.js";

const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const serverUrl = "https://server.example";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe("doctor Provider CLI install-only contract", () => {
  it("reports paths without executing CLIs or inspecting configuration, credentials, versions, or the network", async () => {
    const openTagHome = await createHome();
    const accountHome = await makeTempDir("opentag-doctor-account-");
    homes.push(accountHome);
    const tools = join(accountHome, "tools");
    const invocationLog = join(accountHome, "cli-invocations.log");
    const lark = await writeLoggingCli(tools, "lark-cli", invocationLog);
    const slack = await writeLoggingCli(tools, "slack", invocationLog);
    const providerState = join(accountHome, ".opentag", "provider-cli", "state");
    await mkdir(providerState, { recursive: true, mode: 0o700 });
    await writeFile(join(providerState, "feishu.json"), "not valid provider selection json\n", { mode: 0o600 });
    await writeFile(join(accountHome, "credentials.json"), '{"token":"must-not-be-read"}\n', { mode: 0o600 });
    await writeFile(invocationLog, "", { mode: 0o600 });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = await snapshotFileTree(accountHome);
    const result = await runDoctor({
      arch: "arm64",
      channel: "stable",
      cliVersion: "0.1.0",
      env: { HOME: accountHome, OPENTAG_HOME: openTagHome, PATH: tools },
      healthChecker: vi.fn().mockResolvedValue({ service: "opentag-server", status: "ok" } as const),
      inspectDaemonService: vi.fn().mockResolvedValue(activeService(openTagHome)),
      nodeVersion: "v24.0.0",
      platform: process.platform,
      runtimeDetector: vi.fn().mockResolvedValue(installedCodex()),
    });

    expect(check(result.checks, "provider-cli.feishu.installation")).toMatchObject({
      blocking: false,
      detail: `installed at ${await realpath(lark)} (caller-path)`,
      observedFrom: "current CLI process environment and operating-system account locations",
      path: await realpath(lark),
      status: "pass",
    });
    expect(check(result.checks, "provider-cli.slack.installation")).toMatchObject({
      blocking: false,
      detail: `installed at ${await realpath(slack)} (caller-path)`,
      path: await realpath(slack),
      status: "pass",
    });
    expect(result.exitCode).toBe(0);
    expect(result.notEvaluated).toEqual(DOCTOR_NOT_EVALUATED);
    expect(result.message).toContain("version compatibility, authentication, credentials, installation configuration");
    expect(result.message).not.toMatch(/auth\.test|validation grant|chat\.postMessage|im\.message/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readFile(invocationLog, "utf8")).toBe("");
    expect(await snapshotFileTree(accountHome)).toEqual(before);
  });
});

async function writeLoggingCli(directory: string, command: string, logPath: string): Promise<string> {
  const quoted = `'${logPath.replaceAll("'", `'"'"'`)}'`;
  await mkdir(directory, { recursive: true });
  const path = join(directory, command);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quoted}\n`, { mode: 0o755 });
  return path;
}

function check(checks: DoctorCheck[], code: string): DoctorCheck {
  const result = checks.find((candidate) => candidate.code === code);
  expect(result, `missing doctor check ${code}`).toBeDefined();
  return result as DoctorCheck;
}

async function createHome(): Promise<string> {
  const home = await realpath(await makeTempDir("opentag-doctor-home-"));
  homes.push(home);
  const config = join(home, "config");
  await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, "computer.json"), `${JSON.stringify({ computerId, serverUrl, version: 2 })}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(config, "computer-credentials.json"),
    `${JSON.stringify({
      computer: {
        computerId: "19eb4f37-2cc0-49d4-85e2-b9987f9c71a4",
        installationId: computerId,
        machineToken: "otmc_NEVER_PRINT_THIS_SECRET",
        serverUrl,
      },
      version: 3,
    })}\n`,
    { mode: 0o600 },
  );
  return home;
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
