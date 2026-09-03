import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class RuntimeStorageError extends Error {
  constructor(
    readonly code: "conflict" | "invalid" | "unsafe",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeStorageError";
  }
}

export async function ensurePrivateDirectory(root: string, target: string): Promise<string> {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  assertWithin(rootPath, targetPath);
  await ensureRootDirectory(rootPath);
  const suffix = relative(rootPath, targetPath);
  let current = rootPath;
  if (suffix) {
    for (const segment of suffix.split(sep)) {
      current = resolve(current, segment);
      await ensureOneDirectory(current);
    }
  }
  const canonicalRoot = await realpath(rootPath);
  const canonicalTarget = await realpath(targetPath);
  assertWithin(canonicalRoot, canonicalTarget);
  return canonicalTarget;
}

export async function validatePrivateDirectory(root: string, target: string): Promise<boolean> {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  assertWithin(rootPath, targetPath);
  const suffix = relative(rootPath, targetPath);
  let current = rootPath;
  for (const segment of suffix ? ["", ...suffix.split(sep)] : [""]) {
    if (segment) current = resolve(current, segment);
    try {
      await assertRealDirectory(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  const canonicalRoot = await realpath(rootPath);
  const canonicalTarget = await realpath(targetPath);
  assertWithin(canonicalRoot, canonicalTarget);
  return true;
}

export async function readSecureFile(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new RuntimeStorageError("unsafe", "Runtime storage files must be regular files");
    }
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
    const opened = await handle.stat();
    if (!opened.isFile()) throw new RuntimeStorageError("unsafe", "Runtime storage file changed during open");
    return await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readDurableJson<T>(path: string, validate: (value: unknown) => T): Promise<T | undefined> {
  const content = await readSecureFile(path);
  if (content === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new RuntimeStorageError("invalid", "Runtime storage contains invalid JSON");
  }
  try {
    return validate(parsed);
  } catch (error) {
    if (error instanceof RuntimeStorageError) throw error;
    throw new RuntimeStorageError("invalid", "Runtime storage contains data that does not match its schema");
  }
}

export async function writeDurableFile(path: string, content: string, mode = 0o600): Promise<void> {
  const parent = dirname(path);
  await assertRealDirectory(parent);
  await assertReplaceableFile(path);
  const temporary = resolve(parent, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, mode);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeDurableJson(path: string, value: unknown): Promise<void> {
  await writeDurableFile(path, `${JSON.stringify(value, undefined, 2)}\n`, 0o600);
}

export async function removeDurableFile(path: string): Promise<void> {
  await assertReplaceableFile(path);
  await rm(path);
  await syncDirectory(dirname(path));
}

export async function assertRealDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new RuntimeStorageError("unsafe", "Runtime storage directories must be real directories");
  }
}

export function assertWithin(root: string, target: string): void {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const suffix = relative(rootPath, targetPath);
  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;
  throw new RuntimeStorageError("unsafe", "Runtime storage path escaped its root");
}

async function ensureOneDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertRealDirectory(path);
  await chmod(path, 0o700);
}

async function ensureRootDirectory(root: string): Promise<void> {
  const missingSegments: string[] = [];
  let existing = root;
  for (;;) {
    try {
      await assertRealDirectory(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missingSegments.unshift(basename(existing));
      existing = parent;
    }
  }
  let current = existing;
  for (const segment of missingSegments) {
    current = resolve(current, segment);
    await ensureOneDirectory(current);
  }
  await ensureOneDirectory(root);
}

async function assertReplaceableFile(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new RuntimeStorageError("unsafe", "Runtime storage destination must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function syncDurableDirectory(path: string): Promise<void> {
  await syncDirectory(path);
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}
