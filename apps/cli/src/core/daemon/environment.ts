import { lstat, readFile } from "node:fs/promises";
import { validatePrivateDirectory } from "@opentag/client";
import { buildChildEnvironment } from "../command/environment.js";
import { resolveDaemonPaths } from "./paths.js";
import { DaemonServiceError } from "./service/types.js";

export interface DaemonEnvironmentResult {
  appliedKeys: string[];
  diagnostics: string[];
  env: NodeJS.ProcessEnv;
  malformedLineNumbers: number[];
}

export async function loadDaemonEnvironment(
  home: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<DaemonEnvironmentResult> {
  const paths = resolveDaemonPaths(home);
  if (!(await validatePrivateDirectory(paths.home, paths.config))) {
    return { appliedKeys: [], diagnostics: [], env: { ...baseEnvironment }, malformedLineNumbers: [] };
  }
  const path = paths.daemonEnvironment;
  let content: string;
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new DaemonServiceError("CONFIGURATION", "daemon.env must be a real regular file");
    }
    if ((status.mode & 0o077) !== 0) {
      throw new DaemonServiceError("CONFIGURATION", "daemon.env permissions must not allow group or other access");
    }
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { appliedKeys: [], diagnostics: [], env: { ...baseEnvironment }, malformedLineNumbers: [] };
    }
    throw error;
  }

  const env = { ...baseEnvironment };
  const appliedKeys: string[] = [];
  const diagnostics: string[] = [];
  const malformedLineNumbers: number[] = [];
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) {
      diagnostics.push(`Ignored malformed daemon.env line ${index + 1}`);
      malformedLineNumbers.push(index + 1);
      continue;
    }
    const key = match[1];
    if (!key) {
      diagnostics.push(`Ignored malformed daemon.env line ${index + 1}`);
      malformedLineNumbers.push(index + 1);
      continue;
    }
    const parsed = parseEnvironmentValue(match[2] ?? "");
    if (parsed === undefined) {
      diagnostics.push(`Ignored malformed daemon.env line ${index + 1}`);
      malformedLineNumbers.push(index + 1);
      continue;
    }
    if (env[key]) continue;
    env[key] = parsed;
    appliedKeys.push(key);
  }
  return { appliedKeys, diagnostics, env, malformedLineNumbers };
}

export async function applyDaemonEnvironment(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DaemonEnvironmentResult> {
  return loadDaemonEnvironment(home, environment);
}

/** Build the daemon child environment as a detached object. */
export function buildDaemonChildEnvironment(result: DaemonEnvironmentResult): NodeJS.ProcessEnv {
  return buildChildEnvironment(result.env);
}

function parseEnvironmentValue(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) return undefined;
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) return undefined;
    return value.slice(1, -1).replace(/\\([\\"nrt])/gu, (_, escaped: string) => {
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      return escaped;
    });
  }
  if (value.includes("'") || value.includes('"')) return undefined;
  return value;
}
