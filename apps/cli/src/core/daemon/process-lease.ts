import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory, validatePrivateDirectory } from "@opentag/client";

export interface ProcessLeaseRecord {
  pid: number;
  processStartId: string;
  startedAt: string;
}

export interface ProcessFileLease<T extends ProcessLeaseRecord> {
  path: string;
  record: T;
  release(): Promise<void>;
}

export type ProcessLeaseInspection<T extends ProcessLeaseRecord> =
  | { state: "missing" }
  | { record: T; state: "live" | "stale" };

export interface ProcessLeaseOptions<T extends ProcessLeaseRecord> {
  createRecord(processStartId: string): T;
  fileName: string;
  getProcessIdentity?: (pid: number) => Promise<ProcessIdentityInspection>;
  getId(record: T): string;
  parseRecord(value: unknown): T;
  rootDirectory?: string;
}

export type ProcessIdentityInspection = { id: string; state: "identified" } | { state: "gone" | "unverifiable" };

export class ProcessLeaseBusyError extends Error {
  override readonly name = "ProcessLeaseBusyError";

  constructor(readonly pid: number) {
    super(`A live process already owns this operation (pid ${pid})`);
  }
}

export class ProcessLeaseMalformedError extends Error {
  override readonly name = "ProcessLeaseMalformedError";
}

export class ProcessLeaseUnverifiableError extends Error {
  override readonly name = "ProcessLeaseUnverifiableError";
}

export async function acquireProcessFileLease<T extends ProcessLeaseRecord>(
  home: string,
  options: ProcessLeaseOptions<T>,
): Promise<ProcessFileLease<T>> {
  await ensurePrivateDirectory(options.rootDirectory ?? home, home);
  const path = join(home, options.fileName);
  const getProcessIdentity = options.getProcessIdentity ?? inspectProcessIdentity;
  const currentIdentity = await getProcessIdentity(process.pid);
  if (currentIdentity.state !== "identified") {
    throw new ProcessLeaseUnverifiableError(
      "Cannot determine the current process start identity; refusing acquisition",
    );
  }
  const guard = await acquireLeaseMutationGuard(home, options.fileName, getProcessIdentity, currentIdentity.id);
  try {
    let existing: T | undefined;
    try {
      existing = await readProcessLease(path, options.parseRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      const identity = await getProcessIdentity(existing.pid);
      if (identity.state === "unverifiable") {
        throw new ProcessLeaseUnverifiableError(
          `Cannot verify whether process ${existing.pid} still owns ${options.fileName}; refusing takeover`,
        );
      }
      if (identity.state === "identified" && identity.id === existing.processStartId) {
        throw new ProcessLeaseBusyError(existing.pid);
      }
      await rename(path, `${path}.stale.${options.getId(existing)}.${randomUUID()}`);
    }
    const record = options.createRecord(currentIdentity.id);
    await createLeaseFile(path, record);
    return leaseFor(path, record, options.getId, options.parseRecord);
  } finally {
    await guard.release();
  }
}

export async function inspectProcessFileLease<T extends ProcessLeaseRecord>(
  home: string,
  options: Omit<ProcessLeaseOptions<T>, "createRecord">,
): Promise<ProcessLeaseInspection<T>> {
  if (!(await validatePrivateDirectory(options.rootDirectory ?? home, home))) return { state: "missing" };
  const path = join(home, options.fileName);
  let record: T;
  try {
    record = await readProcessLease(path, options.parseRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    throw error;
  }
  const identity = await (options.getProcessIdentity ?? inspectProcessIdentity)(record.pid);
  if (identity.state === "unverifiable") {
    throw new ProcessLeaseUnverifiableError(
      `Cannot verify whether process ${record.pid} still owns ${options.fileName}`,
    );
  }
  const live = identity.state === "identified" && identity.id === record.processStartId;
  return { record, state: live ? "live" : "stale" };
}

interface LeaseMutationGuard extends ProcessLeaseRecord {
  guardId: string;
}

async function acquireLeaseMutationGuard(
  home: string,
  fileName: string,
  getProcessIdentity: (pid: number) => Promise<ProcessIdentityInspection>,
  processStartId: string,
): Promise<ProcessFileLease<LeaseMutationGuard>> {
  const path = join(home, `.${fileName}.acquire`);
  const record: LeaseMutationGuard = {
    guardId: randomUUID(),
    pid: process.pid,
    processStartId,
    startedAt: new Date().toISOString(),
  };
  try {
    await createLeaseFile(path, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readProcessLease(path, parseMutationGuard);
    const currentIdentity = await getProcessIdentity(existing.pid);
    if (currentIdentity.state === "unverifiable") {
      throw new ProcessLeaseUnverifiableError(
        `Cannot verify the process holding the acquisition guard at ${path}; refusing takeover`,
      );
    }
    if (currentIdentity.state === "identified" && currentIdentity.id === existing.processStartId) {
      throw new ProcessLeaseBusyError(existing.pid);
    }
    throw new ProcessLeaseMalformedError(
      `A stale process lease acquisition guard remains at ${path}; refusing unsafe automatic recovery`,
    );
  }
  return leaseFor(path, record, (value) => value.guardId, parseMutationGuard);
}

async function createLeaseFile<T>(path: string, record: T): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

function leaseFor<T extends ProcessLeaseRecord>(
  path: string,
  record: T,
  getId: (record: T) => string,
  parseRecord: (value: unknown) => T,
): ProcessFileLease<T> {
  return {
    path,
    record,
    release: async () => {
      let current: T;
      try {
        current = await readProcessLease(path, parseRecord);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (getId(current) !== getId(record)) return;
      await rm(path);
    },
  };
}

async function readProcessLease<T extends ProcessLeaseRecord>(
  path: string,
  parseRecord: (value: unknown) => T,
): Promise<T> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new ProcessLeaseMalformedError("The process lease must be a real regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new ProcessLeaseMalformedError("The process lease record is malformed", { cause: error });
  }
  try {
    return parseRecord(value);
  } catch (error) {
    if (error instanceof ProcessLeaseMalformedError) throw error;
    throw new ProcessLeaseMalformedError("The process lease record is malformed", { cause: error });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseMutationGuard(value: unknown): LeaseMutationGuard {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProcessLeaseMalformedError("The process lease acquisition guard is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.guardId !== "string" ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.processStartId !== "string" ||
    record.processStartId.length === 0 ||
    typeof record.startedAt !== "string"
  ) {
    throw new ProcessLeaseMalformedError("The process lease acquisition guard is malformed");
  }
  return record as unknown as LeaseMutationGuard;
}

async function inspectProcessIdentity(pid: number): Promise<ProcessIdentityInspection> {
  if (!isProcessAlive(pid)) return { state: "gone" };
  if (process.platform === "linux") {
    try {
      const [stat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      return startTicks
        ? { id: `linux:${bootId.trim()}:${startTicks}`, state: "identified" }
        : { state: "unverifiable" };
    } catch {
      return isProcessAlive(pid) ? { state: "unverifiable" } : { state: "gone" };
    }
  }
  if (process.platform === "darwin") {
    return inspectDarwinProcessIdentity(pid);
  }
  return pid === process.pid
    ? { id: `self:${Math.floor(performance.timeOrigin)}`, state: "identified" }
    : { state: "unverifiable" };
}

export async function inspectDarwinProcessIdentity(pid: number): Promise<ProcessIdentityInspection> {
  return new Promise((resolveIdentity) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
        timeout: 5_000,
      },
      (error, stdout) => {
        const startedAt = String(stdout ?? "").trim();
        if (!error && startedAt) {
          resolveIdentity({ id: `darwin:${startedAt}`, state: "identified" });
          return;
        }
        resolveIdentity(isProcessAlive(pid) ? { state: "unverifiable" } : { state: "gone" });
      },
    );
  });
}
