import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ContextTreePackage, resolveContextTreePackage, resolveOpenTagHome } from "@opentag/client";
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
  /** OPENTAG_HOME override; tests inject an isolated home. */
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

export function contextTreeConfigPath(home: string): string {
  return join(home, "config", "context-tree.json");
}

export async function readContextTreeConfig(home: string): Promise<ContextTreeConfig | undefined> {
  let content: string;
  try {
    content = await readFile(contextTreeConfigPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return ContextTreeConfigSchema.parse(JSON.parse(content));
}

export async function writeContextTreeConfig(home: string, target: ContextTreeTarget): Promise<string> {
  const configPath = contextTreeConfigPath(home);
  const config = ContextTreeConfigSchema.parse({ schemaVersion: CONTEXT_TREE_CONFIG_SCHEMA_VERSION, target });
  await mkdir(dirname(configPath), { mode: 0o700, recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return configPath;
}
