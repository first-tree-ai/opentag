import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { ensurePrivateDirectory } from "@opentag/client";
import { resolveDaemonPaths } from "../paths.js";
import {
  acquireProcessFileLease,
  ProcessLeaseBusyError,
  ProcessLeaseMalformedError,
  ProcessLeaseUnverifiableError,
} from "../process-lease.js";
import {
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
    // Resolution happens here rather than in the backends because this is where a name becomes a
    // running process. A service manager reached through the caller's PATH would let an executable
    // placed earlier there decide what OpenTag believes about its own daemon.
    const resolved = await resolveServiceManagerCommand(program);
    if (!resolved) {
      return {
        code: null,
        stderr: `${program} was not found at a known system location`,
        stdout: "",
        timedOut: false,
      };
    }
    return new Promise<CommandResult>((complete) => {
      execFile(
        resolved,
        [...args],
        {
          encoding: "utf8",
          env: options.env,
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

/**
 * Absolute locations for the service managers OpenTag drives.
 *
 * A service manager is an authority about the installed service, so it must not be reachable through
 * the caller's `PATH`: an executable placed earlier there would decide what OpenTag believes about
 * its own daemon. Resolution is by absolute path only, and an unresolvable manager fails closed
 * rather than falling back to a name lookup.
 *
 * The inherited environment is deliberately left alone. `systemctl --user` needs the session
 * variables that address the user manager, so stripping them would break the call rather than
 * secure it; the executable is what had to stop being the caller's choice.
 */
const SERVICE_MANAGER_PATHS: Readonly<Record<"launchctl" | "systemctl", readonly string[]>> = {
  launchctl: ["/bin/launchctl", "/usr/bin/launchctl"],
  systemctl: ["/usr/bin/systemctl", "/bin/systemctl"],
};

async function resolveServiceManagerCommand(program: string): Promise<string | undefined> {
  if (isAbsolute(program)) return program;
  const candidates = SERVICE_MANAGER_PATHS[program as "launchctl" | "systemctl"];
  if (!candidates) return undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known location.
    }
  }
  return undefined;
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
  const bin = await findExecutable(options.binName, environment.PATH);
  if (bin) return { args: [], program: await realpath(bin).catch(() => bin) };

  const argv = options.argv ?? process.argv;
  const script = argv[1];
  if (!script) {
    throw new DaemonServiceError("CONFIGURATION", "Cannot resolve the OpenTag CLI entry script");
  }
  const program = options.execPath ?? process.execPath;
  if (!isAbsolute(program)) {
    throw new DaemonServiceError("CONFIGURATION", "The Node.js executable path must be absolute");
  }
  const scriptPath = isAbsolute(script) ? script : resolve(options.cwd ?? process.cwd(), script);
  return {
    args: [await realpath(scriptPath).catch(() => scriptPath)],
    program: await realpath(program).catch(() => program),
  };
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
    throw new DaemonServiceError("CONFIGURATION", "The OpenTag home path must be absolute");
  }
  let current = home;
  for (;;) {
    try {
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new DaemonServiceError(
          "CONFIGURATION",
          `The OpenTag home must resolve beneath a real directory: ${current}`,
        );
      }
      await access(current, constants.W_OK | constants.X_OK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof DaemonServiceError) throw error;
        throw new DaemonServiceError("CONFIGURATION", `The OpenTag home is not writable: ${home}`, { cause: error });
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new DaemonServiceError("CONFIGURATION", `Cannot find a writable parent for the OpenTag home: ${home}`);
      }
      current = parent;
    }
  }
}

export async function canonicalizeServiceHome(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new DaemonServiceError("CONFIGURATION", "The OpenTag home path must be absolute");
  }
  const missingSegments: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const canonicalParent = await realpath(current);
      return resolve(canonicalParent, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DaemonServiceError("CONFIGURATION", `Cannot canonicalize the OpenTag home path: ${path}`, {
          cause: error,
        });
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new DaemonServiceError("CONFIGURATION", `Cannot canonicalize the OpenTag home path: ${path}`);
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

async function findExecutable(binName: string, pathValue: string | undefined): Promise<string | undefined> {
  for (const directory of pathValue?.split(delimiter).filter(Boolean) ?? []) {
    const candidate = join(directory, binName);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}
