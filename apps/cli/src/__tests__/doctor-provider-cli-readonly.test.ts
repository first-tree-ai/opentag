import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  computeFileIdentity,
  computeTargetFingerprint,
  ProviderCliManager,
  resolveProviderCliAccountLayout,
  writeProviderCliSelection,
} from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCTOR_NOT_EVALUATED, type DoctorCheck, runDoctor } from "../core/diagnostics/doctor.js";
import { runProviderCliInspect } from "../core/provider-cli/inspect.js";
import { fakeCliScript, makeTempDir, snapshotFileTree } from "./provider-cli-fixtures.js";

const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const serverUrl = "https://server.example";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe("doctor and inspect Provider CLI read-only contract", () => {
  it("leaves account-global files, hashes, and mtimes unchanged and never downloads, ensures, grants, or calls Provider APIs", async () => {
    const openTagHome = await createHome();
    const accountHome = await makeTempDir("opentag-doctor-account-");
    homes.push(accountHome);
    const tools = join(accountHome, "tools");
    const invocationLog = join(accountHome, "cli-invocations.log");
    await writeLoggingCli(tools, "feishu", "1.0.92", invocationLog);
    const target = join(tools, "lark-cli");
    const layout = resolveProviderCliAccountLayout(accountHome);
    await mkdir(layout.state, { recursive: true, mode: 0o700 });
    const identity = await computeFileIdentity(target);
    await writeProviderCliSelection(
      layout,
      "feishu",
      {
        kind: "external",
        executablePath: identity.path,
        fingerprint: computeTargetFingerprint(identity, "1.0.92"),
        trust: "catalog-verified",
        version: "1.0.92",
      },
      undefined,
    );
    await writeFile(invocationLog, "", { mode: 0o600 });

    const fetcher = vi.fn(async () => {
      throw new Error("doctor/inspect must not download Provider CLI artifacts");
    });
    const manager = new ProviderCliManager({
      accountHome,
      env: { PATH: tools },
      fetcher,
    });
    const ensure = vi.spyOn(manager, "ensure");
    const before = await snapshotFileTree(layout.root);

    const result = await runDoctor({
      arch: "arm64",
      channel: "stable",
      cliVersion: "0.1.0",
      env: { OPENTAG_HOME: openTagHome, PATH: tools },
      healthChecker: vi.fn().mockResolvedValue({ service: "opentag-server", status: "ok" } as const),
      inspectDaemonService: vi.fn().mockResolvedValue(activeService(openTagHome)),
      nodeVersion: "v24.0.0",
      platform: process.platform,
      runtimeDetector: vi.fn().mockResolvedValue(installedCodex()),
      providerCliInspector: async () => Promise.all([manager.inspect("feishu"), manager.inspect("slack")]),
    });

    expect(check(result.checks, "provider-cli.feishu.installation")).toMatchObject({
      blocking: false,
      status: "fail",
    });
    expect(check(result.checks, "provider-cli.slack.installation")).toMatchObject({
      blocking: false,
      status: "info",
    });
    expect(result.exitCode).toBe(0);
    expect(result.notEvaluated).toEqual(DOCTOR_NOT_EVALUATED);
    expect(result.message).toContain("Integration CLI credential validity and active-binding readiness");
    expect(result.message).not.toMatch(/auth\.test|validation grant|chat\.postMessage|im\.message/i);
    expect(result.message).toContain("Not evaluated");

    const inspect = await runProviderCliInspect({
      accountHome,
      env: { PATH: tools },
      fetcher,
      provider: "all",
      json: true,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(inspect.exitCode).toBe(1);
    expect(inspect.results.map((entry) => entry.provider)).toEqual(["feishu", "slack"]);

    expect(ensure).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await snapshotFileTree(layout.root)).toEqual(before);
    const invocations = await readFile(invocationLog, "utf8");
    expect(invocations).not.toMatch(/auth\.test|auth status|--verify|chat\.postMessage|im\.message/);
    expect(invocations).not.toContain("ensure");
  });
});

async function writeLoggingCli(directory: string, provider: "feishu" | "slack", version: string, logPath: string) {
  const quoted = `'${logPath.replaceAll("'", `'"'"'`)}'`;
  const body = fakeCliScript(provider, version).replace("#!/bin/sh\n", `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quoted}\n`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, provider === "feishu" ? "lark-cli" : "slack");
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
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
        computerId,
        machineToken: "otmc_NEVER_PRINT_THIS_SECRET",
        serverUrl,
        workspaceComputerId: "19eb4f37-2cc0-49d4-85e2-b9987f9c71a4",
      },
      version: 2,
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
