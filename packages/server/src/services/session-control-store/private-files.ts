import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SessionControlStoreError } from "./types.js";

const MAX_RECORD_BYTES = 8192;
export function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Root must be a Server-owned private persistent volume, never a Sandbox mount or agent home. */
export async function ensureControlDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new SessionControlStoreError("unsafe_storage");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new SessionControlStoreError("unsafe_storage");
  // Reject symlinks in ancestors as well: a safe leaf cannot rescue an attacker-controlled root.
  let ancestor = dirname(path);
  while (ancestor !== dirname(ancestor)) {
    const parent = await lstat(ancestor);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new SessionControlStoreError("unsafe_storage");
    ancestor = dirname(ancestor);
  }
}

export async function readControlFile(path: string): Promise<string | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > MAX_RECORD_BYTES ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new SessionControlStoreError("unsafe_storage");
    return await file.readFile("utf8");
  } catch (error) {
    if (isFileError(error, "ENOENT")) return undefined;
    if (isFileError(error, "ELOOP")) throw new SessionControlStoreError("unsafe_storage");
    if (error instanceof SessionControlStoreError) throw error;
    throw new SessionControlStoreError("unavailable");
  } finally {
    await file?.close();
  }
}

/** Immutable commit: fsync content, atomically link without replacement, then fsync the directory. */
export async function createControlFile(path: string, content: string): Promise<boolean> {
  if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new SessionControlStoreError("capacity");
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } catch (error) {
    if (isFileError(error, "EEXIST")) return false;
    throw new SessionControlStoreError("unavailable");
  } finally {
    await unlink(temporary);
  }
}

export async function controlRecords(directory: string, suffix: string, limit: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > limit * 3) throw new SessionControlStoreError("capacity");
  const records = entries.filter((entry) => entry.name.endsWith(suffix));
  if (records.length > limit || records.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new SessionControlStoreError("unsafe_storage");
  }
  return records.map((entry) => entry.name).sort();
}
