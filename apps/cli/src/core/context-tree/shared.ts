import { resolve } from "node:path";
import {
  type ContextTreePackage,
  prepareContextTreeHome,
  readDurableJson,
  resolveContextTreeHome,
  resolveContextTreePackage,
  resolveOpenTagHome,
  writeDurableJson,
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
  return readDurableJson(resolveContextTreeHome(env).configFile, (value) => ContextTreeConfigSchema.parse(value));
}

export async function writeContextTreeConfig(env: NodeJS.ProcessEnv, target: ContextTreeTarget): Promise<string> {
  const configPath = resolveContextTreeHome(env).configFile;
  const config = ContextTreeConfigSchema.parse({ schemaVersion: CONTEXT_TREE_CONFIG_SCHEMA_VERSION, target });
  await prepareContextTreeHome(env);
  // `writeDurableJson` refuses a symlinked destination and replaces atomically at 0600, which a
  // plain `writeFile` would follow through if a Session planted one first.
  await writeDurableJson(configPath, config);
  return configPath;
}
