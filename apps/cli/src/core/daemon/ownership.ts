import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export interface DaemonOwner {
  home: string;
  instanceId: string;
  ownerId: string;
  pid: number;
  startedAt: string;
}

export interface DaemonOwnerLease {
  owner: DaemonOwner;
  release(): Promise<void>;
}

const OWNER_FILE_NAME = "daemon-owner.json";

export async function acquireDaemonOwner(home: string, instanceId: string): Promise<DaemonOwnerLease> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const homeStatus = await lstat(home);
  if (!homeStatus.isDirectory() || homeStatus.isSymbolicLink()) {
    throw new Error("The OpenTag home must be a real directory");
  }
  const path = join(home, OWNER_FILE_NAME);
  const owner: DaemonOwner = {
    home,
    instanceId,
    ownerId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = parseOwner(await readFile(path, "utf8"));
      if (isProcessAlive(existing.pid)) {
        throw new Error(`An OpenTag daemon is already running for this home (pid ${existing.pid})`);
      }
      await rename(path, `${path}.stale.${existing.ownerId}`);
    }
  }

  return {
    owner,
    release: async () => {
      try {
        const current = parseOwner(await readFile(path, "utf8"));
        if (current.ownerId === owner.ownerId) await rm(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function parseOwner(content: string): DaemonOwner {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("The daemon owner record is malformed; refusing automatic recovery");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The daemon owner record is malformed; refusing automatic recovery");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.home !== "string" ||
    typeof record.instanceId !== "string" ||
    typeof record.ownerId !== "string" ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    typeof record.startedAt !== "string"
  ) {
    throw new Error("The daemon owner record is malformed; refusing automatic recovery");
  }
  return record as unknown as DaemonOwner;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
