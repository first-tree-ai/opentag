import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GitPublicationError } from "./git-packets.js";

export async function assertDirectoryBudget(path: string, maximum: number): Promise<void> {
  let total = 0;
  const pending = [path];
  while (pending.length) {
    const directory = pending.pop() as string;
    const entries =
      directory === path
        ? await readdir(directory, { withFileTypes: true })
        : ((await readIfPresent(() => readdir(directory, { withFileTypes: true }))) ?? []);
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else {
        total += (await readIfPresent(() => lstat(child)))?.size ?? 0;
        if (total > maximum) throw new GitPublicationError("resource_limit");
      }
    }
  }
}

/** Git may remove transient files and directories between enumeration and inspection. */
async function readIfPresent<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
