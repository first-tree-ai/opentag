import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { ensurePrivateDirectory } from "@opentag/client";
import { parseSemVer } from "@opentag/shared";
import { CLI_VERSION } from "../../../build-info.js";
import { buildChildEnvironment } from "../../command/environment.js";
import { detectInstallMode, type InstallMode } from "../../update/install-mode.js";
import { resolveDaemonPaths } from "../paths.js";
import {
  acquireProcessFileLease,
  ProcessLeaseBusyError,
  ProcessLeaseMalformedError,
  ProcessLeaseUnverifiableError,
} from "../process-lease.js";
import {
  CliInvocationError,
  type CommandResult,
  DaemonServiceError,
  type DaemonServiceErrorCode,
  type ResolvedCliInvocation,
  type ServiceRunner,
} from "./types.js";

const COMMAND_TIMEOUT_MS = 15_000;

interface ServiceOperationRecord {
  operationId: string;
  pid: number;
  processStartId: string;
  startedAt: string;
}

export interface ServiceOperationLease {
  release(): Promise<void>;
}

export interface ServiceIdentity {
  launchdLabel: string;
  launchdPlistName: string;
  launchdWrapperName: string;
  systemdUnitName: string;
}

export const defaultServiceRunner: ServiceRunner = {
  async run(program, args, options) {
    const resolvedProgram = await resolveServiceManagerExecutable(program);
    return new Promise<CommandResult>((complete) => {
      execFile(
        resolvedProgram,
        [...args],
        {
          encoding: "utf8",
          env: options.env ?? buildChildEnvironment(process.env),
          maxBuffer: 1024 * 1024,
          timeout: options.timeoutMs,
        },
        (error, stdout, stderr) => {
          const commandError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          complete({
            code: error ? (typeof commandError.code === "number" ? commandError.code : null) : 0,
            stderr: String(stderr ?? "").trim(),
            stdout: String(stdout ?? "").trim(),
            timedOut: Boolean(error && commandError.killed && commandError.signal),
          });
        },
      );
    });
  },
};

const SERVICE_MANAGER_LOCATIONS = {
  darwin: {
    launchctl: ["/bin/launchctl"],
  },
  linux: {
    loginctl: ["/run/current-system/systemd/bin/loginctl", "/usr/bin/loginctl", "/bin/loginctl"],
    systemctl: ["/run/current-system/systemd/bin/systemctl", "/usr/bin/systemctl", "/bin/systemctl"],
  },
} as const;

export async function resolveServiceManagerExecutable(
  program: string,
  platform: NodeJS.Platform = process.platform,
  dependencies: {
    access?: (path: string, mode: number) => Promise<void>;
    stat?: (path: string) => Promise<{ isFile(): boolean }>;
  } = {},
): Promise<string> {
  const platformLocations =
    platform === "darwin"
      ? SERVICE_MANAGER_LOCATIONS.darwin
      : platform === "linux"
        ? SERVICE_MANAGER_LOCATIONS.linux
        : undefined;
  const managerName = isAbsolute(program) ? basename(program) : program;
  if (!platformLocations || !(managerName in platformLocations)) {
    throw new DaemonServiceError(
      "MANAGER_UNAVAILABLE",
      `The ${program} service manager is not governed on ${platform}`,
    );
  }
  const candidates = platformLocations[managerName as keyof typeof platformLocations] as readonly string[];
  const allowedCandidates = isAbsolute(program) ? candidates.filter((candidate) => candidate === program) : candidates;
  if (allowedCandidates.length === 0) {
    throw new DaemonServiceError("MANAGER_UNAVAILABLE", `The service manager path is not supported: ${program}`);
  }
  const checkAccess = dependencies.access ?? access;
  const checkStat = dependencies.stat ?? stat;
  for (const candidate of allowedCandidates) {
    try {
      if (!(await checkStat(candidate)).isFile()) continue;
      await checkAccess(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the reviewed absolute location list only.
    }
  }
  throw new DaemonServiceError(
    "MANAGER_UNAVAILABLE",
    `The ${program} service manager is unavailable at supported system locations`,
  );
}

export function deriveServiceIdentity(serviceId: string): ServiceIdentity {
  return {
    launchdLabel: serviceId,
    launchdPlistName: `${serviceId}.plist`,
    launchdWrapperName: serviceId,
    systemdUnitName: `${serviceId}.service`,
  };
}

export async function resolveCliInvocation(options: {
  argv?: readonly string[];
  binName: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}): Promise<ResolvedCliInvocation> {
  const environment = options.env ?? process.env;
  const script = (options.argv ?? process.argv)[1];
  if (!script) throw invocationFailure("cli", "", "entry script is missing");
  const program = options.execPath ?? process.execPath;
  if (!isAbsolute(program)) throw invocationFailure("node", program, "path must be absolute");
  const scriptPath = isAbsolute(script) ? script : resolve(options.cwd ?? process.cwd(), script);
  const node = await resolveCliFile(program, constants.X_OK, "node");
  const entry = await resolveCliFile(scriptPath, constants.R_OK, "cli");
  if (environment.OPENTAG_INSTALL_MODE !== "portable") {
    return { args: [entry], program: await stableNodeInvocation(node, program, environment.PATH) };
  }
  const install = detectInstallMode(environment);
  if (install.mode !== "portable") {
    throw invocationFailure("portable", environment.OPENTAG_PORTABLE_ROOT ?? "", "installation paths are incomplete");
  }
  return resolvePortableInvocation(install, options.binName, node, entry);
}

function invocationFailure(
  kind: "node" | "cli" | "portable",
  path: string,
  reason: string,
  cause?: unknown,
  installedVersion?: string,
): CliInvocationError {
  const label =
    kind === "node" ? "Node.js executable" : kind === "cli" ? "CLI entry script" : "portable CLI installation";
  return new CliInvocationError(
    `The ${label} ${reason}: ${path}`,
    { kind, path, reason, runningVersion: CLI_VERSION, ...(installedVersion ? { installedVersion } : {}) },
    { cause },
  );
}

async function resolveCliFile(path: string, mode: number, kind: "node" | "cli" | "portable"): Promise<string> {
  try {
    const target = await realpath(path);
    if (!(await stat(target)).isFile()) throw new Error("Not a regular file");
    await access(target, mode);
    return target;
  } catch (cause) {
    throw invocationFailure(kind, path, "is unavailable", cause);
  }
}

async function stableNodeInvocation(node: string, program: string, sourcePath?: string): Promise<string> {
  const keg = node.match(/^(.*)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/);
  const candidates = [
    program,
    ...(sourcePath
      ?.split(delimiter)
      .filter(isAbsolute)
      .map((directory) => join(directory, "node")) ?? []),
    ...(keg ? [join(keg[1] ?? "", "opt", keg[2] ?? "", "bin/node")] : []),
  ];
  for (const candidate of candidates) {
    if (candidate === node || /\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin\/node$/.test(candidate)) continue;
    try {
      if ((await realpath(candidate)) !== node) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // An absent alias cannot replace the verified running executable.
    }
  }
  return node;
}

function isPortablePayload(value: unknown, binName: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const metadata = value as Record<string, unknown>;
  return (
    metadata.installMode === "portable" && metadata.binName === binName && metadata.appEntry === "app/cli/index.mjs"
  );
}

async function resolvePortableInvocation(
  install: Extract<InstallMode, { mode: "portable" }>,
  binName: string,
  node: string,
  entry: string,
): Promise<ResolvedCliInvocation> {
  const current = join(install.root, "current");
  const launcher = join(install.binDir, binName);
  let installedVersion: string | undefined;
  let reason = "is not activated or is unavailable; install the Portable artifact before starting its daemon";
  try {
    const metadata = JSON.parse(await readFile(join(current, "INSTALL.json"), "utf8"));
    installedVersion =
      typeof metadata?.version === "string" && parseSemVer(metadata.version) ? metadata.version : undefined;
    reason = "payload does not match this installation and channel";
    const versions = await realpath(join(install.root, "versions"));
    if (!isPortablePayload(metadata, binName)) throw new Error(reason);
    const currentNode = await resolveCliFile(join(current, "node/bin/node"), constants.X_OK, "portable");
    const currentEntry = await resolveCliFile(join(current, "app/cli/index.mjs"), constants.R_OK, "portable");
    for (const [path, suffix] of [
      [node, "node/bin/node"],
      [entry, "app/cli/index.mjs"],
      [currentNode, "node/bin/node"],
      [currentEntry, "app/cli/index.mjs"],
    ] as const) {
      const payload = dirname(dirname(dirname(path)));
      if (dirname(payload) !== versions || path !== join(payload, suffix)) throw new Error(reason);
      const identity = JSON.parse(await readFile(join(payload, "INSTALL.json"), "utf8"));
      if (!isPortablePayload(identity, binName)) throw new Error(reason);
    }
    reason = "launcher is unavailable or targets another installation";
    await resolveCliFile(launcher, constants.X_OK, "portable");
    const lines = (await readFile(launcher, "utf8")).split(/\r?\n/);
    for (const [name, value] of [
      ["root", current],
      ["bin_dir", install.binDir],
    ] as const) {
      const assignments = lines.filter((line) => line.startsWith(`${name}=`));
      if (assignments.length !== 1 || assignments[0] !== `${name}=${quotePosix(value)}`) throw new Error(reason);
    }
  } catch (cause) {
    throw invocationFailure("portable", launcher, reason, cause, installedVersion);
  }
  return { args: [], program: launcher };
}

export function buildServicePath(
  invocation: ResolvedCliInvocation,
  platform: "darwin" | "linux",
  sourcePath?: string,
): string {
  const base =
    platform === "darwin"
      ? ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]
      : ["/usr/local/bin", "/usr/bin", "/bin"];
  const inherited = (sourcePath ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry));
  return [...new Set([dirname(invocation.program), dirname(process.execPath), ...inherited, ...base])].join(delimiter);
}

export function invocationArguments(invocation: ResolvedCliInvocation): string[] {
  return [invocation.program, ...invocation.args, "daemon", "service-run"];
}

export function quoteSystemdToken(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")}"`;
}

export function quoteSystemdEnvironment(name: string, value: string): string {
  return `Environment=${quoteSystemdToken(`${name}=${value}`)}`;
}

export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function writeFileAtomically(
  path: string,
  content: string,
  mode: number,
  directoryMode = 0o700,
  containmentRoot?: string,
): Promise<void> {
  const parent = dirname(path);
  if (containmentRoot) {
    await ensurePrivateDirectory(containmentRoot, parent);
  } else {
    await mkdir(parent, { recursive: true, mode: directoryMode });
  }
  const temporaryPath = join(parent, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new DaemonServiceError("CONFIGURATION", `Expected a regular file at ${path}`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function runRequired(
  runner: ServiceRunner,
  program: string,
  args: readonly string[],
  operation: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const result = await runner.run(program, args, { timeoutMs });
  if (result.code === 0 && !result.timedOut) return result;
  const detail = result.timedOut
    ? `timed out after ${timeoutMs}ms`
    : result.stderr || `exited with code ${result.code}`;
  throw new DaemonServiceError("OPERATION_FAILED", `${operation} failed: ${detail}`);
}

export async function acquireServiceOperationLease(home: string): Promise<ServiceOperationLease> {
  const paths = resolveDaemonPaths(home);
  return acquireMappedOperationLease(
    paths.home,
    paths.serviceState,
    basename(paths.serviceOperation),
    "Another daemon service operation",
  );
}

export async function acquireServiceTargetLease(
  channelDefaultHome: string,
  serviceId: string,
): Promise<ServiceOperationLease> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(serviceId)) {
    throw new DaemonServiceError("CONFIGURATION", "The daemon service ID is invalid");
  }
  const paths = resolveDaemonPaths(channelDefaultHome);
  return acquireMappedOperationLease(
    paths.home,
    paths.serviceState,
    basename(paths.serviceTargetOperation),
    `Another ${serviceId} service-target operation`,
  );
}

async function acquireMappedOperationLease(
  root: string,
  directory: string,
  fileName: string,
  busyLabel: string,
): Promise<ServiceOperationLease> {
  try {
    const lease = await acquireProcessFileLease<ServiceOperationRecord>(directory, {
      createRecord: (processStartId) => ({
        operationId: randomUUID(),
        pid: process.pid,
        processStartId,
        startedAt: new Date().toISOString(),
      }),
      fileName,
      getId: (record) => record.operationId,
      parseRecord: parseServiceOperation,
      rootDirectory: root,
    });
    return { release: lease.release };
  } catch (error) {
    if (error instanceof ProcessLeaseBusyError) {
      throw new DaemonServiceError("BUSY", `${busyLabel} is already running (pid ${error.pid})`, {
        cause: error,
      });
    }
    if (error instanceof ProcessLeaseMalformedError) {
      throw new DaemonServiceError("CONFIGURATION", error.message, { cause: error });
    }
    if (error instanceof ProcessLeaseUnverifiableError) {
      throw new DaemonServiceError("CONFIGURATION", error.message, { cause: error });
    }
    throw error;
  }
}

export function serviceError(code: DaemonServiceErrorCode, message: string, cause?: unknown): DaemonServiceError {
  return new DaemonServiceError(code, message, cause === undefined ? undefined : { cause });
}

export function isManagerNotLoaded(result: CommandResult): boolean {
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    result.code !== 0 &&
    (detail.includes("not loaded") ||
      detail.includes("could not find service") ||
      detail.includes("not found") ||
      detail.includes("no such process"))
  );
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function preflightHomeDirectory(home: string): Promise<void> {
  if (!isAbsolute(home)) {
    throw new DaemonServiceError("CONFIGURATION", "The openTag home path must be absolute");
  }
  let current = home;
  for (;;) {
    try {
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new DaemonServiceError(
          "CONFIGURATION",
          `The openTag home must resolve beneath a real directory: ${current}`,
        );
      }
      await access(current, constants.W_OK | constants.X_OK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof DaemonServiceError) throw error;
        throw new DaemonServiceError("CONFIGURATION", `The openTag home is not writable: ${home}`, { cause: error });
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new DaemonServiceError("CONFIGURATION", `Cannot find a writable parent for the openTag home: ${home}`);
      }
      current = parent;
    }
  }
}

export async function canonicalizeServiceHome(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new DaemonServiceError("CONFIGURATION", "The openTag home path must be absolute");
  }
  const missingSegments: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const canonicalParent = await realpath(current);
      return resolve(canonicalParent, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DaemonServiceError("CONFIGURATION", `Cannot canonicalize the openTag home path: ${path}`, {
          cause: error,
        });
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new DaemonServiceError("CONFIGURATION", `Cannot canonicalize the openTag home path: ${path}`);
      }
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((complete) => setTimeout(complete, milliseconds));
}

function parseServiceOperation(value: unknown): ServiceOperationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The service operation lease is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.operationId !== "string" ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.processStartId !== "string" ||
    record.processStartId.length === 0 ||
    typeof record.startedAt !== "string"
  ) {
    throw new Error("The service operation lease is malformed");
  }
  return record as unknown as ServiceOperationRecord;
}
