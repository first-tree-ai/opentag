import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ContextTreePackage,
  prepareContextTreeHome,
  resolveContextTreeHome,
  resolveContextTreePackage,
  resolveOpenTagHome,
} from "@opentag/client";
import {
  CONTEXT_TREE_CONFIG_SCHEMA_VERSION,
  type ContextTreeConfig,
  ContextTreeConfigSchema,
  type ContextTreeTarget,
} from "@opentag/shared";

export class ContextTreeUsageError extends Error {
  override readonly name = "ContextTreeUsageError";
}

export interface ContextTreeCommandDeps {
  /** OPENTAG_HOME override for OpenTag preparation diagnostics. */
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly contextTreePackage?: ContextTreePackage;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

export function writeStdout(deps: ContextTreeCommandDeps, chunk: string): void {
  (deps.stdout ?? ((value: string) => process.stdout.write(value)))(chunk);
}

export function writeStderr(deps: ContextTreeCommandDeps, chunk: string): void {
  (deps.stderr ?? ((value: string) => process.stderr.write(value)))(chunk);
}

export function resolveHome(deps: ContextTreeCommandDeps): string {
  return deps.home ? resolve(deps.home) : resolveOpenTagHome(deps.env ?? process.env);
}

export function resolveContextTreeAssets(deps: ContextTreeCommandDeps = {}): ContextTreePackage | undefined {
  return deps.contextTreePackage ?? resolveContextTreePackage();
}

export async function readContextTreeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContextTreeConfig | undefined> {
  let content: string;
  try {
    content = await readFile(resolveContextTreeHome(env).configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return ContextTreeConfigSchema.parse(JSON.parse(content));
}

export async function writeContextTreeConfig(env: NodeJS.ProcessEnv, target: ContextTreeTarget): Promise<string> {
  const configPath = resolveContextTreeHome(env).configFile;
  const config = ContextTreeConfigSchema.parse({ schemaVersion: CONTEXT_TREE_CONFIG_SCHEMA_VERSION, target });
  await prepareContextTreeHome(env);
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
  return configPath;
}
