import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export interface ProcessLeaseRecord {
  pid: number;
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
  createRecord(): T;
  fileName: string;
  getId(record: T): string;
  isProcessAlive?: (pid: number) => boolean;
  parseRecord(value: unknown): T;
}

export class ProcessLeaseBusyError extends Error {
  override readonly name = "ProcessLeaseBusyError";

  constructor(readonly pid: number) {
    super(`A live process already owns this operation (pid ${pid})`);
  }
}

export class ProcessLeaseMalformedError extends Error {
  override readonly name = "ProcessLeaseMalformedError";
}

export async function acquireProcessFileLease<T extends ProcessLeaseRecord>(
  home: string,
  options: ProcessLeaseOptions<T>,
): Promise<ProcessFileLease<T>> {
  await ensurePrivateDirectory(home);
  const path = join(home, options.fileName);
  const record = options.createRecord();
  const isAlive = options.isProcessAlive ?? isProcessAlive;

  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readProcessLease(path, options.parseRecord);
      if (isAlive(existing.pid)) throw new ProcessLeaseBusyError(existing.pid);
      await rename(path, `${path}.stale.${options.getId(existing)}.${randomUUID()}`);
    }
  }

  return {
    path,
    record,
    release: async () => {
      let current: T;
      try {
        current = await readProcessLease(path, options.parseRecord);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (options.getId(current) !== options.getId(record)) return;
      await rm(path);
    },
  };
}

export async function inspectProcessFileLease<T extends ProcessLeaseRecord>(
  home: string,
  options: Omit<ProcessLeaseOptions<T>, "createRecord">,
): Promise<ProcessLeaseInspection<T>> {
  const path = join(home, options.fileName);
  let record: T;
  try {
    record = await readProcessLease(path, options.parseRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    throw error;
  }
  return { record, state: (options.isProcessAlive ?? isProcessAlive)(record.pid) ? "live" : "stale" };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("The OpenTag home must be a real directory");
  }
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
