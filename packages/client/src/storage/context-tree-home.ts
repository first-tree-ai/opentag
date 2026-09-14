import { realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Account storage shared with the standalone Context Tree CLI, independent of OPENTAG_HOME. */
export function resolveContextTreeHome(environment: NodeJS.ProcessEnv = process.env): {
  directory: string;
  configFile: string;
} {
  let home = resolve((process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || homedir());
  try {
    home = realpathSync(home);
  } catch {
    // Like the standalone CLI, retain the account path when it cannot be canonicalized.
  }
  const directory = join(home, ".context-tree");
  return { directory, configFile: join(directory, "opentag.json") };
}

export async function prepareContextTreeHome(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { directory } = resolveContextTreeHome(environment);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Context Tree managed directory must be a real directory: ${directory}`);
  }
  return directory;
}
