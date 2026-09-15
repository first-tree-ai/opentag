import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { RUNNER_DEEPSEEK_PROVIDER, runRunnerAcceptance } from "./acceptance.js";
import { parseRunnerCliArgv } from "./args.js";
import { copyIsolatedPiConfig } from "./config.js";
import { parseRunnerIdentity } from "./identity.js";
import { expectedFromIdentity, probeRunnerTools, runnerToolsReady } from "./probe.js";
import { redactAcceptanceRecord } from "./redact.js";
import { registerRunnerSignalCleanup } from "./signals.js";
import { assembleContextTreeSkills } from "./skills.js";
import type { RunnerAcceptanceReport, RunnerCliInvocation, RunnerIdentity } from "./types.js";

export interface RunnerCliIo {
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr: { write(chunk: string): void };
  readonly stdout: { write(chunk: string): void };
}

const IDENTITY_CANDIDATES = ["/opt/opentag/identity.json", "identity.json"];

async function loadIdentity(cwd: string): Promise<RunnerIdentity | undefined> {
  for (const candidate of IDENTITY_CANDIDATES) {
    const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    try {
      return parseRunnerIdentity(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
  }
  return undefined;
}

function writeJson(io: RunnerCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(redactAcceptanceRecord(value))}\n`);
}

function writeText(io: RunnerCliIo, value: string): void {
  io.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

async function runIdentity(invocation: RunnerCliInvocation, io: RunnerCliIo, cwd: string): Promise<number> {
  const identity = await loadIdentity(cwd);
  if (!identity) {
    io.stderr.write("runner identity file is missing\n");
    return 1;
  }
  if (invocation.json) writeJson(io, identity);
  else writeText(io, `${identity.version} ${identity.sourceSha}${identity.sourceDirty ? " dirty" : ""}`);
  return 0;
}

async function runProbe(invocation: RunnerCliInvocation, io: RunnerCliIo, cwd: string): Promise<number> {
  const identity = await loadIdentity(cwd);
  const probes = await probeRunnerTools({
    env: io.env,
    ...(identity ? { expected: expectedFromIdentity(identity) } : {}),
  });
  if (invocation.json) writeJson(io, probes);
  else {
    for (const probe of probes) {
      writeText(io, `${probe.ok ? "ok" : "FAIL"} ${probe.name}${probe.detail ? ` ${probe.detail}` : ""}`);
    }
  }
  return runnerToolsReady(probes) ? 0 : 1;
}

async function runSkills(invocation: RunnerCliInvocation, io: RunnerCliIo): Promise<number> {
  const assembled = await assembleContextTreeSkills();
  if (invocation.json)
    writeJson(io, { skills: assembled.skills.map((skill) => skill.name), skillsPath: assembled.skillsPath });
  else writeText(io, assembled.skills.map((skill) => skill.name).join("\n"));
  return 0;
}

function checkSupportedProvider(invocation: RunnerCliInvocation, io: RunnerCliIo): number | undefined {
  if (invocation.provider !== undefined && invocation.provider !== RUNNER_DEEPSEEK_PROVIDER) {
    io.stderr.write(
      `unsupported provider for real acceptance: ${invocation.provider} (only ${RUNNER_DEEPSEEK_PROVIDER} is currently supported)\n`,
    );
    return 2;
  }
  return undefined;
}

function writeAcceptReport(invocation: RunnerCliInvocation, io: RunnerCliIo, report: RunnerAcceptanceReport): void {
  if (invocation.json) {
    writeJson(io, report);
    return;
  }
  for (const item of report.events) {
    writeText(io, `${item.status} ${item.name}${item.detail ? ` ${item.detail}` : ""}`);
  }
  writeText(io, `offline=${report.offline} model=${report.model}`);
}

async function acceptPiHome(invocation: RunnerCliInvocation, runtimeHome: string, scratch: string): Promise<string> {
  if (invocation.piConfigDir && invocation.provider) {
    return copyIsolatedPiConfig({
      destination: join(scratch, "pi-config"),
      source: invocation.piConfigDir,
      providers: [invocation.provider],
    });
  }
  return resolve(runtimeHome, ".pi", "agent");
}

async function runAccept(invocation: RunnerCliInvocation, io: RunnerCliIo, cwd: string): Promise<number> {
  const unsupported = checkSupportedProvider(invocation, io);
  if (unsupported !== undefined) return unsupported;
  const workspace = invocation.workspace ?? resolve(cwd, "workspace");
  const runtimeHome = io.env?.HOME ?? resolve(cwd, "home");
  // Everything disposable lives in a fresh owned scratch directory: copied config, sessions,
  // and partial state are removed on success, error, and signal paths.
  const scratch = await mkdtemp(join(tmpdir(), "opentag-runner-accept-"));
  const cleanupScratch = async () => {
    await rm(scratch, { recursive: true, force: true });
  };
  registerRunnerSignalCleanup(cleanupScratch);
  try {
    const identity = await loadIdentity(cwd);
    const report = await runRunnerAcceptance({
      mode: invocation.mode,
      piHome: await acceptPiHome(invocation, runtimeHome, scratch),
      runtimeHome,
      path: io.env?.PATH,
      sessionDirectory: join(scratch, "sessions"),
      workspace,
      ...(identity ? { identity } : {}),
    });
    writeAcceptReport(invocation, io, report);
    return report.failed ? 1 : 0;
  } finally {
    registerRunnerSignalCleanup(undefined);
    await cleanupScratch();
  }
}

const COMMANDS = {
  identity: runIdentity,
  probe: runProbe,
  skills: runSkills,
  accept: runAccept,
} as const;

export async function runRunnerCli(argv: readonly string[], io: RunnerCliIo, cwd = process.cwd()): Promise<number> {
  const parsed = parseRunnerCliArgv(argv);
  if (!parsed.ok) {
    io.stderr.write(parsed.error);
    return parsed.exitCode;
  }
  try {
    const command = COMMANDS[parsed.invocation.command];
    return await command(parsed.invocation, io, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${redactAcceptanceRecord(message)}\n`);
    return 1;
  }
}
