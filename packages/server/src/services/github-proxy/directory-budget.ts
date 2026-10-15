import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GitPublicationError } from "./git-packets.js";

export async function assertDirectoryBudget(path: string, maximum: number): Promise<void> {
  let total = 0;
  const pending = [path];
  while (pending.length) {
    const directory = pending.pop() as string;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else {
        total += (await lstat(child)).size;
        if (total > maximum) throw new GitPublicationError("resource_limit");
      }
    }
  }
}
