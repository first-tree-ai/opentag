import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PI_CONFIG_WHITELIST = Object.freeze(["auth.json", "models.json", "settings.json"]);
export const PI_SAFE_SETTINGS_KEYS = Object.freeze(["defaultProvider", "defaultModel", "defaultThinkingLevel"]);

function fail(message: string): never {
  throw new Error(message);
}

function isInside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix !== "" && !isAbsolute(suffix) && !suffix.startsWith("..");
}

/** Reject any symlink directory between the canonical root and the path. */
async function assertNoSymlinkAncestors(root: string, filePath: string): Promise<void> {
  let current = dirname(filePath);
  for (;;) {
    const suffix = relative(root, current);
    if (suffix === "") return;
    if (isAbsolute(suffix) || suffix.startsWith("..")) fail(`path is not inside the selected directory: ${filePath}`);
    if ((await lstat(current)).isSymbolicLink()) fail(`refusing symlink ancestor directory: ${current}`);
    current = dirname(current);
  }
}

async function assertSafeFile(root: string, filePath: string): Promise<void> {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink()) fail(`refusing to copy symlink Pi config: ${filePath}`);
  if (!stats.isFile()) fail(`Pi config path is not a file: ${filePath}`);
  await assertNoSymlinkAncestors(root, filePath);
  const canonical = await realpath(filePath);
  if (!isInside(root, canonical) && canonical !== root) fail(`Pi config escapes the selected directory: ${filePath}`);
}

function filterProviderObject(value: unknown, providers: ReadonlySet<string>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const filtered: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (providers.has(key)) filtered[key] = entry;
  }
  return filtered;
}

function filterModelsDocument(value: unknown, providers: ReadonlySet<string>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("models.json must be a JSON object");
  const record = value as Record<string, unknown>;
  // Construct output from recognized top-level fields only; unknown fields are dropped, never forwarded.
  const filtered: Record<string, unknown> = {};
  if (record.models !== undefined) {
    if (!Array.isArray(record.models)) fail("models.json has a malformed models field");
    filtered.models = record.models.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        providers.has(String((entry as { provider?: unknown }).provider ?? "")),
    );
  }
  if (record.providers !== undefined) {
    if (typeof record.providers !== "object" || record.providers === null || Array.isArray(record.providers)) {
      fail("models.json has a malformed providers field");
    }
    filtered.providers = filterProviderObject(record.providers, providers);
  }
  return filtered;
}

function filterSettingsDocument(value: unknown, providers: ReadonlySet<string>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const key of PI_SAFE_SETTINGS_KEYS) {
    if (record[key] !== undefined) filtered[key] = record[key];
  }
  if (typeof filtered.defaultProvider === "string" && !providers.has(filtered.defaultProvider)) {
    fail(`settings defaultProvider ${filtered.defaultProvider} is outside the provider filter`);
  }
  return filtered;
}

function filterDocument(name: string, raw: string, providers: ReadonlySet<string>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Filename only: Node parse errors can quote raw source fragments, and the source may be a credential.
    fail(`${name} is not valid JSON`);
  }
  const next =
    name === "auth.json"
      ? filterProviderObject(parsed, providers)
      : name === "settings.json"
        ? filterSettingsDocument(parsed, providers)
        : filterModelsDocument(parsed, providers);
  assertNoShellCommandIndirection(name, next);
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** Pi supports `"!command"` credential indirection; the Runner never executes host shell commands. */
function assertNoShellCommandIndirection(name: string, value: unknown): void {
  if (typeof value === "string") {
    if (value.startsWith("!")) fail(`${name} uses a shell-command credential indirection (!); refusing to copy`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoShellCommandIndirection(name, entry);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) assertNoShellCommandIndirection(name, entry);
  }
}

async function copyWhitelistFile(
  sourceCanonical: string,
  destination: string,
  name: string,
  providers: ReadonlySet<string>,
): Promise<void> {
  const from = join(sourceCanonical, name);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(from);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) fail(`refusing to copy symlink Pi config: ${from}`);
  if (!stats.isFile()) fail(`Pi config path is not a file: ${from}`);
  await assertSafeFile(sourceCanonical, from);
  const text = filterDocument(name, await readFile(from, "utf8"), providers);
  const to = join(destination, name);
  await writeFile(to, text, { encoding: "utf8", mode: 0o600 });
  await chmod(to, 0o600);
}

export interface CopyIsolatedPiConfigOptions {
  readonly destination: string;
  readonly providers: readonly string[];
  readonly source: string;
}

export async function removeIsolatedPiConfig(destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
}

/**
 * Copies the whitelisted Pi config documents into a FRESH destination the Runner owns. The
 * destination must not exist yet (a preexisting directory, file, or symlink — including a
 * symlinked ancestor — is rejected, so a planted `auth.json` link can never redirect writes),
 * must not physically overlap the source, and partial copies are removed on any error.
 */
export async function copyIsolatedPiConfig(options: CopyIsolatedPiConfigOptions): Promise<string> {
  if (!isAbsolute(options.source) || !isAbsolute(options.destination)) {
    fail("Pi config source and destination must be absolute");
  }
  if (!options.providers?.length) fail("Pi config copy requires an explicit provider filter");
  const sourceRoot = resolve(options.source);
  const destination = resolve(options.destination);
  const sourceStats = await lstat(sourceRoot);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) fail("Pi config source must be a real directory");
  const sourceCanonical = await realpath(sourceRoot);
  const parent = dirname(destination);
  let parentStats: Awaited<ReturnType<typeof lstat>>;
  try {
    parentStats = await lstat(parent);
  } catch {
    fail("Pi config destination parent must be an existing real directory");
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    fail("Pi config destination parent must be an existing real directory");
  }
  try {
    await lstat(destination);
    fail("Pi config destination must be fresh; refusing to reuse an existing path");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const canonicalParent = await realpath(parent);
  const canonicalDestination = join(canonicalParent, destination.slice(parent.length + 1));
  if (
    canonicalDestination === sourceCanonical ||
    isInside(sourceCanonical, canonicalDestination) ||
    isInside(canonicalDestination, sourceCanonical)
  ) {
    fail("Pi config destination physically overlaps the source directory");
  }
  await mkdir(destination, { mode: 0o700 });
  await chmod(destination, 0o700);
  const providers = new Set(options.providers);
  try {
    for (const name of PI_CONFIG_WHITELIST) {
      await copyWhitelistFile(sourceCanonical, destination, name, providers);
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return destination;
}
