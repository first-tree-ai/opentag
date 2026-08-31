import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChannelName } from "@opentag/shared";

/**
 * Portable installer for daemon-driven automatic upgrades and the manual upgrade command. Mirrors
 * scripts/portable/install.sh semantics exactly: channel metadata and SHA-256 verification from the
 * immutable version manifest (never the mutable channel pointer), immutable version directories, a
 * stable shim that resolves through `current`, and a single atomic `current` symlink switch as the
 * commit point. A version directory is never rewritten in place.
 */

export const DEFAULT_DOWNLOAD_BASE_URL = "https://download.opentag.build/releases";
const PORTABLE_APP_ENTRY = "app/cli/index.mjs";
const MANIFEST_SCHEMA_VERSION = 1;

export class PortableInstallError extends Error {
  override readonly name = "PortableInstallError";
}

export interface PortableManifestAsset {
  platform: string;
  fileName: string;
  url: string;
  sha256: string;
  size: number;
}

interface PortableManifest {
  channel: ChannelName;
  version: string;
  packageName: string;
  binName: string;
  assets: PortableManifestAsset[];
}

export interface PortableInstallOptions {
  channel: ChannelName;
  targetVersion: string;
  /** Portable install root (`OPENTAG_PORTABLE_ROOT`). */
  root: string;
  /** Stable shim directory (`OPENTAG_PORTABLE_BIN_DIR`). */
  binDir: string;
  binName: string;
  packageName: string;
  downloadBaseUrl?: string;
  /** Defaults to the detected `<os>-<arch>` portable platform. */
  platform?: string;
  fetchFn?: typeof fetch;
  /** Extraction hook; defaults to `tar -xzf`, the same tool the shell installer requires. */
  extractTarball?: (tarball: string, destination: string) => Promise<void>;
  /** Pre-commit payload smoke check; defaults to running the payload's embedded runtime. */
  runSmokeCheck?: (payloadDir: string, appEntry: string) => Promise<void>;
}

export interface PortableInstallResult {
  /** True when the target already was the live install and nothing was downloaded. */
  alreadyCurrent: boolean;
  versionDir: string;
}

const execFileAsync = promisify(execFile);

export function detectPortablePlatform(platform = process.platform, arch = process.arch): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const architecture = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!os || !architecture) {
    throw new PortableInstallError(`Portable upgrades are unsupported on ${platform}-${arch}`);
  }
  return `${os}-${architecture}`;
}

async function defaultExtractTarball(tarball: string, destination: string): Promise<void> {
  try {
    await execFileAsync("tar", ["-xzf", tarball, "-C", destination]);
  } catch (error) {
    throw new PortableInstallError(
      `Portable payload extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function defaultRunSmokeCheck(payloadDir: string, appEntry: string): Promise<void> {
  try {
    await execFileAsync(join(payloadDir, "node", "bin", "node"), [join(payloadDir, appEntry), "--version"]);
  } catch (error) {
    throw new PortableInstallError(
      `Portable payload failed the pre-commit runtime smoke check: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function renderPortableShim(currentLink: string, binDir: string): string {
  return `#!/bin/sh
set -eu
root=${shellSingleQuote(currentLink)}
bin_dir=${shellSingleQuote(binDir)}
export OPENTAG_INSTALL_MODE=portable
export OPENTAG_PORTABLE_ROOT="$root"
export OPENTAG_PORTABLE_BIN_DIR="$bin_dir"
exec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

interface InstallLayout {
  install: Record<string, unknown> | undefined;
  nodeExecutable: boolean;
  appEntryPresent: boolean;
  shimTargetsCurrent: boolean;
}

async function inspectCurrentInstall(
  root: string,
  binDir: string,
  binName: string,
): Promise<InstallLayout | undefined> {
  const currentLink = join(root, "current");
  let installRaw: string;
  try {
    if (!(await lstat(currentLink)).isSymbolicLink()) return undefined;
    installRaw = await readFile(join(currentLink, "INSTALL.json"), "utf8");
  } catch {
    return undefined;
  }
  let install: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(installRaw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) install = parsed as Record<string, unknown>;
  } catch {
    install = undefined;
  }
  const nodeExecutable = await isExecutable(join(currentLink, "node", "bin", "node"));
  const appEntry = typeof install?.appEntry === "string" ? install.appEntry : PORTABLE_APP_ENTRY;
  const appEntryPresent = await exists(join(currentLink, appEntry));
  let shimTargetsCurrent = false;
  try {
    const shim = await readFile(join(binDir, binName), "utf8");
    await access(join(binDir, binName), constants.X_OK);
    shimTargetsCurrent = shim.split("\n").includes(`root=${shellSingleQuote(currentLink)}`);
  } catch {
    shimTargetsCurrent = false;
  }
  return { install, nodeExecutable, appEntryPresent, shimTargetsCurrent };
}

/** Mirror of install.sh's portable_install_is_current: strict enough that yes means nothing to do. */
export async function portableInstallIsCurrent(
  root: string,
  binDir: string,
  binName: string,
  targetVersion: string,
  platform: string,
): Promise<boolean> {
  const current = await inspectCurrentInstall(root, binDir, binName);
  if (!current?.install) return false;
  const { install } = current;
  return (
    install.version === targetVersion &&
    install.platform === platform &&
    install.installMode === "portable" &&
    install.binName === binName &&
    current.nodeExecutable &&
    current.appEntryPresent &&
    current.shimTargetsCurrent
  );
}

interface PortableStagingLayout {
  currentLink: string;
  canonicalVersionDir: string;
  tempVersionDir: string;
  tarball: string;
  newLink: string;
  cleanup(): Promise<void>;
}

function selectPortableAsset(manifest: PortableManifest, platform: string): PortableManifestAsset {
  const asset = manifest.assets.find((candidate) => candidate.platform === platform);
  if (!asset) throw new PortableInstallError(`The portable release has no asset for ${platform}`);
  if (!/^https?:\/\//u.test(asset.url)) throw new PortableInstallError("The portable asset URL is not HTTP(S)");
  return asset;
}

async function prepareStagingLayout(options: PortableInstallOptions): Promise<PortableStagingLayout> {
  const currentLink = join(options.root, "current");
  const canonicalVersionDir = join(options.root, "versions", options.targetVersion);
  const tempRoot = join(options.root, ".tmp");
  await mkdir(join(options.root, "versions"), { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await mkdir(options.binDir, { recursive: true });

  const workId = `${options.targetVersion}.${process.pid}`;
  const tempVersionDir = join(tempRoot, workId);
  const tarball = join(tempRoot, `payload.${process.pid}.tar.gz`);
  const newLink = join(options.root, `.current.${process.pid}`);
  return {
    currentLink,
    canonicalVersionDir,
    tempVersionDir,
    tarball,
    newLink,
    cleanup: async () => {
      await rm(tempVersionDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(tarball, { force: true }).catch(() => undefined);
      await rm(newLink, { force: true }).catch(() => undefined);
    },
  };
}

async function downloadVerifiedPayload(fetchFn: typeof fetch, asset: PortableManifestAsset): Promise<Buffer> {
  const payload = await download(fetchFn, asset.url);
  if (payload.byteLength !== asset.size) {
    throw new PortableInstallError(
      `Portable payload size mismatch: expected ${asset.size}, received ${payload.byteLength}`,
    );
  }
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== asset.sha256) {
    throw new PortableInstallError(`Portable payload checksum mismatch: expected ${asset.sha256}, received ${digest}`);
  }
  return payload;
}

async function stagePortableVersion(options: {
  layout: PortableStagingLayout;
  manifest: PortableManifest;
  asset: PortableManifestAsset;
  platform: string;
  fetchFn: typeof fetch;
  extract(tarball: string, destination: string): Promise<void>;
  smoke(payloadDir: string, appEntry: string): Promise<void>;
}): Promise<void> {
  const { layout } = options;
  const payload = await downloadVerifiedPayload(options.fetchFn, options.asset);
  await writeFile(layout.tarball, payload);
  await rm(layout.tempVersionDir, { recursive: true, force: true });
  await mkdir(layout.tempVersionDir, { recursive: true });
  await options.extract(layout.tarball, layout.tempVersionDir);

  // Never write a version directory in place: `current` may resolve through it. When the target's
  // canonical directory already exists it is reused as-is, exactly like the shell installer.
  const existsCanonical = await exists(layout.canonicalVersionDir);
  const validationDir = existsCanonical ? layout.canonicalVersionDir : layout.tempVersionDir;
  await validateInstallMetadata(validationDir, options.manifest, options.platform);
  await options.smoke(validationDir, PORTABLE_APP_ENTRY);
  if (existsCanonical) return;

  try {
    await rename(layout.tempVersionDir, layout.canonicalVersionDir);
  } catch (error) {
    throw new PortableInstallError(
      `Could not move the portable payload into place: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function activatePortableVersion(options: PortableInstallOptions, layout: PortableStagingLayout): Promise<void> {
  // Prepare the stable shim while `current` still names the old version; the symlink switch below
  // is the single commit point, so a shim failure never reports success after activation.
  const shimPath = join(options.binDir, options.binName);
  const shimTemp = `${shimPath}.${process.pid}`;
  await writeFile(shimTemp, renderPortableShim(layout.currentLink, options.binDir), { mode: 0o755 });
  await rename(shimTemp, shimPath);

  await rm(layout.newLink, { force: true });
  await symlink(layout.canonicalVersionDir, layout.newLink);
  try {
    // rename(2) replaces the existing `current` symlink atomically; this is the commit point.
    await rename(layout.newLink, layout.currentLink);
  } catch (error) {
    throw new PortableInstallError(
      `Could not atomically switch the current portable version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function installPortableTarget(options: PortableInstallOptions): Promise<PortableInstallResult> {
  const base = (options.downloadBaseUrl ?? DEFAULT_DOWNLOAD_BASE_URL).replace(/\/+$/, "");
  const platform = options.platform ?? detectPortablePlatform();
  const fetchFn = options.fetchFn ?? fetch;
  const extract = options.extractTarball ?? defaultExtractTarball;
  const smoke = options.runSmokeCheck ?? defaultRunSmokeCheck;
  const canonicalVersionDir = join(options.root, "versions", options.targetVersion);

  if (await portableInstallIsCurrent(options.root, options.binDir, options.binName, options.targetVersion, platform)) {
    return { alreadyCurrent: true, versionDir: canonicalVersionDir };
  }

  const manifest = await fetchManifest(fetchFn, `${base}/${options.channel}/${options.targetVersion}/manifest.json`);
  assertManifest(manifest, options, platform);
  const asset = selectPortableAsset(manifest, platform);
  const layout = await prepareStagingLayout(options);

  try {
    await stagePortableVersion({ layout, manifest, asset, platform, fetchFn, extract, smoke });
    await activatePortableVersion(options, layout);
  } finally {
    await layout.cleanup();
  }
  return { alreadyCurrent: false, versionDir: canonicalVersionDir };
}

async function fetchManifest(fetchFn: typeof fetch, url: string): Promise<PortableManifest> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new PortableInstallError(
      `Portable release metadata could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new PortableInstallError(`Portable release metadata could not be downloaded (HTTP ${response.status})`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PortableInstallError("Portable release metadata is not valid JSON");
  }
  return parseManifest(body);
}

async function download(fetchFn: typeof fetch, url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    throw new PortableInstallError(
      `Portable payload could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new PortableInstallError(`Portable payload could not be downloaded (HTTP ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseManifest(body: unknown): PortableManifest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PortableInstallError("Portable release metadata is malformed");
  }
  const record = body as Record<string, unknown>;
  const assetsValue = record.assets;
  if (!Array.isArray(assetsValue)) throw new PortableInstallError("Portable release metadata has no assets");
  const assets: PortableManifestAsset[] = assetsValue.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PortableInstallError("Portable release metadata has a malformed asset");
    }
    const asset = entry as Record<string, unknown>;
    if (
      typeof asset.platform !== "string" ||
      typeof asset.fileName !== "string" ||
      typeof asset.url !== "string" ||
      typeof asset.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
      typeof asset.size !== "number" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1
    ) {
      throw new PortableInstallError("Portable release metadata has a malformed asset");
    }
    return {
      platform: asset.platform,
      fileName: asset.fileName,
      url: asset.url,
      sha256: asset.sha256,
      size: asset.size,
    };
  });
  if (
    record.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    typeof record.channel !== "string" ||
    typeof record.version !== "string" ||
    typeof record.packageName !== "string" ||
    typeof record.binName !== "string"
  ) {
    throw new PortableInstallError("Portable release metadata is malformed");
  }
  return {
    channel: record.channel as ChannelName,
    version: record.version,
    packageName: record.packageName,
    binName: record.binName,
    assets,
  };
}

function assertManifest(manifest: PortableManifest, options: PortableInstallOptions, platform: string): void {
  if (manifest.version !== options.targetVersion) {
    throw new PortableInstallError("Portable release metadata version does not match the upgrade target");
  }
  if (manifest.channel !== options.channel) {
    throw new PortableInstallError("Portable release metadata belongs to another channel");
  }
  if (manifest.packageName !== options.packageName || manifest.binName !== options.binName) {
    throw new PortableInstallError("Portable release metadata identity does not match this channel");
  }
  if (!platform) throw new PortableInstallError("The portable platform could not be determined");
}

async function validateInstallMetadata(
  payloadDir: string,
  manifest: PortableManifest,
  platform: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(payloadDir, "INSTALL.json"), "utf8");
  } catch {
    throw new PortableInstallError("The portable payload is missing INSTALL.json");
  }
  let install: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("malformed");
    install = parsed as Record<string, unknown>;
  } catch {
    throw new PortableInstallError("The portable payload INSTALL.json is malformed");
  }
  if (install.version !== manifest.version) {
    throw new PortableInstallError("INSTALL.json version does not match the downloaded metadata");
  }
  if (install.packageName !== manifest.packageName || install.binName !== manifest.binName) {
    throw new PortableInstallError("INSTALL.json identity does not match the downloaded metadata");
  }
  if (install.platform !== platform) {
    throw new PortableInstallError("INSTALL.json platform does not match the current platform");
  }
  if (install.installMode !== "portable") {
    throw new PortableInstallError("INSTALL.json does not describe a portable install");
  }
  if (install.appEntry !== PORTABLE_APP_ENTRY) {
    throw new PortableInstallError("INSTALL.json appEntry is unsupported");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
