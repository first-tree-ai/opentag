import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonServiceError } from "./service/types.js";

export interface DaemonEnvironmentResult {
  appliedKeys: string[];
  diagnostics: string[];
  env: NodeJS.ProcessEnv;
}

export async function loadDaemonEnvironment(
  home: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<DaemonEnvironmentResult> {
  const path = join(home, "daemon.env");
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
      return { appliedKeys: [], diagnostics: [], env: { ...baseEnvironment } };
    }
    throw error;
  }

  const env = { ...baseEnvironment };
  const appliedKeys: string[] = [];
  const diagnostics: string[] = [];
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) {
      diagnostics.push(`Ignored malformed daemon.env line ${index + 1}`);
      continue;
    }
    const key = match[1];
    if (!key) {
      diagnostics.push(`Ignored malformed daemon.env line ${index + 1}`);
      continue;
    }
    const parsed = parseEnvironmentValue(match[2] ?? "");
    if (parsed === undefined) {
      diagnostics.push(`Ignored malformed daemon.env value for ${key} on line ${index + 1}`);
      continue;
    }
    if (env[key]) continue;
    env[key] = parsed;
    appliedKeys.push(key);
  }
  return { appliedKeys, diagnostics, env };
}

export async function applyDaemonEnvironment(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): Promise<DaemonEnvironmentResult> {
  const result = await loadDaemonEnvironment(home, environment);
  for (const [key, value] of Object.entries(result.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const diagnostic of result.diagnostics) log(diagnostic);
  if (result.appliedKeys.length > 0) log(`Applied daemon.env keys: ${result.appliedKeys.sort().join(", ")}`);
  return result;
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
