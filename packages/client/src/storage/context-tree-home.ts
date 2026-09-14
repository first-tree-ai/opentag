import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensureOneDirectory, RuntimeStorageError } from "./durable-file.js";

/** The OS account home, canonicalized where possible. Shared with the standalone Context Tree CLI. */
export function resolveAccountHome(environment: NodeJS.ProcessEnv = process.env): string {
  let home = resolve((process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || homedir());
  try {
    home = realpathSync(home);
  } catch {
    // Like the standalone CLI, retain the account path when it cannot be canonicalized.
  }
  return home;
}

/** Account storage shared with the standalone Context Tree CLI, independent of OPENTAG_HOME. */
export function resolveContextTreeHome(environment: NodeJS.ProcessEnv = process.env): {
  directory: string;
  configFile: string;
} {
  const directory = join(resolveAccountHome(environment), ".context-tree");
  return { directory, configFile: join(directory, "opentag.json") };
}

export async function prepareContextTreeHome(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { directory } = resolveContextTreeHome(environment);
  try {
    // `ensureOneDirectory` also tightens an existing directory to 0700, which a bare `mkdir` cannot.
    await ensureOneDirectory(directory);
  } catch (error) {
    if (error instanceof RuntimeStorageError) {
      throw new RuntimeStorageError("unsafe", `Context Tree managed directory must be a real directory: ${directory}`);
    }
    throw error;
  }
  return directory;
}
