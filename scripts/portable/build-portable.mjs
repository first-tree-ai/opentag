#!/usr/bin/env node

/**
 * Builds the OpenTag portable distribution: a self-contained tarball per platform that carries the
 * bundled CLI together with its own Node.js runtime, plus the release metadata and installer that
 * the public download endpoint serves.
 *
 * The script never rewrites package identity. `scripts/prepare-cli-release.mjs` owns that rewrite for
 * every channel, and this builder only verifies that the already-built CLI reports the identity the
 * requested channel and version demand, so a stale `apps/cli/dist` can never be shipped.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { CHANNEL_CONFIG } from "../channel-config.mjs";
import { parseStableVersion, parseStagingVersion } from "../release-versions.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const CLI_ROOT = join(REPO_ROOT, "apps", "cli");
const EXACT_NODE_VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const PORTABLE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
export const PORTABLE_CHANNELS = ["prod", "staging"];
export const MANIFEST_SCHEMA_VERSION = 1;
export const APP_ENTRY = "app/cli/index.mjs";
export const DEFAULT_DOWNLOAD_BASE_URL = "https://download.opentag.build/releases";
export const NODE_VERSION_FILE = join(SCRIPT_DIR, "node-version.txt");
export const INSTALLER_TEMPLATE_FILE = join(SCRIPT_DIR, "install.sh");

function fail(message) {
  throw new Error(message);
}

export function normalizeNodeVersion(version) {
  const trimmed = typeof version === "string" ? version.trim() : "";
  if (!EXACT_NODE_VERSION_PATTERN.test(trimmed)) {
    fail(`portable releases require an exact Node.js version like v24.19.0, got "${version ?? ""}"`);
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function readDefaultNodeVersion(path = NODE_VERSION_FILE) {
  return normalizeNodeVersion(readFileSync(path, "utf8"));
}

export function getPortableChannelConfig(channel) {
  if (!PORTABLE_CHANNELS.includes(channel)) {
    fail(`--channel must be one of ${PORTABLE_CHANNELS.join(", ")}, got "${channel ?? ""}"`);
  }
  return CHANNEL_CONFIG[channel];
}

/**
 * Portable versions follow the npm channel coordinates exactly, so a portable release can never
 * describe a version the npm release path would reject.
 */
export function validateChannelVersion(channel, version) {
  if (channel === "prod") {
    parseStableVersion(version, "production portable version");
    return;
  }
  if (channel === "staging") {
    parseStagingVersion(version, "staging portable version");
    return;
  }
  fail(`--channel must be one of ${PORTABLE_CHANNELS.join(", ")}, got "${channel ?? ""}"`);
}

export function parsePlatform(platform) {
  if (!PORTABLE_PLATFORMS.includes(platform)) {
    fail(`unsupported portable platform: "${platform ?? ""}"`);
  }
  const [os, arch] = platform.split("-");
  return { arch, os };
}

export function hostPlatform(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const architecture = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  return os && architecture ? `${os}-${architecture}` : null;
}

export function artifactFileName({ packageName, version, platform }) {
  parsePlatform(platform);
  return `${packageName}-${version}-${platform}.tar.gz`;
}

/**
 * The channel segment is appended by every URL builder, so a base URL that already carries it would
 * silently publish to `.../prod/prod/...`.
 */
export function normalizeDownloadBaseUrl(value) {
  const trimmed = (value ?? "").replace(/\/+$/, "");
  if (!trimmed) fail("--download-base-url is required");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail(`--download-base-url must be a valid URL, got "${value}"`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    fail(`--download-base-url must use https, got "${value}"`);
  }
  const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (PORTABLE_CHANNELS.includes(lastSegment)) {
    fail(`--download-base-url must not include the channel segment, got "${value}"`);
  }
  return trimmed;
}

export function artifactDownloadUrl({ downloadBaseUrl, channel, version, fileName }) {
  return `${normalizeDownloadBaseUrl(downloadBaseUrl)}/${channel}/${version}/${fileName}`;
}

export function manifestDownloadUrl({ downloadBaseUrl, channel, version }) {
  return `${normalizeDownloadBaseUrl(downloadBaseUrl)}/${channel}/${version}/manifest.json`;
}

export function normalizeGeneratedAt(value) {
  if (typeof value !== "string" || value.trim() === "") fail("--generated-at requires a timestamp value");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(`--generated-at must be a valid timestamp, got "${value}"`);
  return date.toISOString();
}

/**
 * The portable app ships the bundled CLI verbatim, with no `node_modules` beside it. A runtime
 * dependency would therefore resolve to nothing at all on an installed machine, so it must fail the
 * build instead of producing an artifact that only breaks once a user runs it.
 */
export function assertBundledCliHasNoRuntimeDependencies(sourcePackage) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const names = Object.keys(sourcePackage[field] ?? {});
    if (names.length > 0) {
      fail(
        `apps/cli declares ${field} (${names.join(", ")}), but the portable app ships without node_modules. ` +
          "Bundle the dependency into the CLI build, or extend the portable builder to install and ship it.",
      );
    }
  }
}

export function portableAppPackageJson({ channelConfig, version, sourcePackage }) {
  return {
    name: channelConfig.packageName,
    version,
    type: "module",
    description: sourcePackage.description,
    license: sourcePackage.license,
    repository: sourcePackage.repository,
    engines: sourcePackage.engines,
    bin: { [channelConfig.binName]: "./cli/index.mjs" },
  };
}

export function buildPortableMetadata({ channel, channelConfig, version, gitSha, nodeVersion, generatedAt }) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    channel,
    version,
    gitSha,
    nodeVersion,
    packageName: channelConfig.packageName,
    binName: channelConfig.binName,
    serviceId: channelConfig.serviceId,
    generatedAt: normalizeGeneratedAt(generatedAt),
  };
}

export function buildPortableReleaseMetadata(options) {
  const metadata = buildPortableMetadata(options);
  return {
    manifest: { ...metadata, assets: options.assets },
    latest: {
      ...metadata,
      manifestUrl: manifestDownloadUrl({
        downloadBaseUrl: options.downloadBaseUrl,
        channel: options.channel,
        version: options.version,
      }),
      assets: options.assets,
    },
  };
}

/**
 * Renders the channel-specific installer that the public endpoint serves. The in-repo template keeps
 * generic fallbacks so it stays runnable during development; the published copy pins the channel and
 * base URL it was released with, so `curl | sh` never depends on the caller's environment.
 */
export function renderInstallerForChannel(
  channel,
  downloadBaseUrl,
  source = readFileSync(INSTALLER_TEMPLATE_FILE, "utf8"),
) {
  if (!PORTABLE_CHANNELS.includes(channel)) fail(`unsupported installer channel: "${channel ?? ""}"`);
  const channelPattern = /PORTABLE_CHANNEL="\$\{OPENTAG_PORTABLE_CHANNEL:-[^}]*\}"/;
  if (!channelPattern.test(source)) fail("installer template is missing the portable channel fallback");
  const baseUrlPattern = /DOWNLOAD_BASE_URL="\$\{OPENTAG_PORTABLE_DOWNLOAD_BASE_URL:-[^}]*\}"/;
  if (!baseUrlPattern.test(source)) fail("installer template is missing the portable download base URL fallback");

  const normalized = normalizeDownloadBaseUrl(downloadBaseUrl);
  return source
    .replace(channelPattern, () => `PORTABLE_CHANNEL="\${OPENTAG_PORTABLE_CHANNEL:-${channel}}"`)
    .replace(baseUrlPattern, () => `DOWNLOAD_BASE_URL="\${OPENTAG_PORTABLE_DOWNLOAD_BASE_URL:-${normalized}}"`);
}

/**
 * The shim inside the tarball resolves its own artifact root, so the same bytes work from any
 * extraction path. Channel identity lives in the file name, not in the script.
 */
export function portableArtifactShim(appEntry = APP_ENTRY) {
  return `#!/bin/sh
set -eu
root=$(CDPATH= cd -L "$(dirname "$0")/.." && pwd -L)
bin_dir=$(CDPATH= cd -L "$(dirname "$0")" && pwd -L)
export OPENTAG_INSTALL_MODE=portable
export OPENTAG_PORTABLE_ROOT="$root"
export OPENTAG_PORTABLE_BIN_DIR="$bin_dir"
exec "$root/node/bin/node" "$root/${appEntry}" "$@"
`;
}

// Tar headers must not record the build machine's uid/gid/user names: they would make the shipped
// bytes depend on which account ran the build, and the flag spelling differs between GNU tar (CI)
// and the bsdtar that ships with macOS.
export function tarOwnershipArgs(tarFlavor) {
  if (tarFlavor === "gnu") return ["--owner=0", "--group=0", "--numeric-owner"];
  if (tarFlavor === "bsd") return ["--uid", "0", "--gid", "0", "--uname", "", "--gname", ""];
  return fail(`unsupported tar flavor: "${tarFlavor ?? ""}"`);
}

export function portableTarCreateArgs({ tarballPath, sourceDir, fileListPath = null, tarFlavor = "gnu" }) {
  const args = ["--no-recursion", "--no-xattrs", ...tarOwnershipArgs(tarFlavor), "-cf", tarballPath, "-C", sourceDir];
  if (fileListPath) args.push("-T", fileListPath);
  else args.push(".");
  return args;
}

export function detectTarFlavor() {
  const result = run("tar", ["--version"], { stdio: "pipe" });
  return result.stdout.includes("GNU tar") ? "gnu" : "bsd";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} exited with ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function listArchiveEntries(root, relativeDir = "") {
  const entries = await readdir(join(root, relativeDir), { withFileTypes: true });
  const paths = [];
  for (const name of entries.map((entry) => entry.name).sort()) {
    const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
    paths.push(`./${relativePath}`);
    if (lstatSync(join(root, relativePath)).isDirectory()) {
      paths.push(...(await listArchiveEntries(root, relativePath)));
    }
  }
  return paths;
}

async function normalizeArchiveTimes(path, timestamp) {
  const status = lstatSync(path);
  if (status.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await normalizeArchiveTimes(join(path, entry.name), timestamp);
    }
  }
  if (status.isSymbolicLink()) lutimesSync(path, timestamp, timestamp);
  else utimesSync(path, timestamp, timestamp);
}

/**
 * Produces a tarball whose bytes depend only on the release inputs. Uploads use a create-only
 * precondition, so a resumed release must be able to re-upload byte-identical objects instead of
 * failing closed against the copy an earlier attempt already published.
 */
export async function writeDeterministicTarGz({ sourceDir, tarballPath, generatedAt }) {
  const timestamp = new Date(normalizeGeneratedAt(generatedAt));
  await normalizeArchiveTimes(sourceDir, timestamp);

  const workDir = await mkdtemp(join(tmpdir(), "opentag-portable-tar-"));
  try {
    const fileListPath = join(workDir, "files.txt");
    const tarPath = join(workDir, "payload.tar");
    const entries = [".", ...(await listArchiveEntries(sourceDir))];
    await writeFile(fileListPath, `${entries.join("\n")}\n`);
    run("tar", portableTarCreateArgs({ fileListPath, sourceDir, tarballPath: tarPath, tarFlavor: detectTarFlavor() }), {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    writeFileSync(tarballPath, gzipSync(readFileSync(tarPath), { mtime: 0 }));
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

function assertInputBuildExists() {
  const missing = [
    join(CLI_ROOT, "dist", "cli", "index.mjs"),
    join(CLI_ROOT, "dist", "index.mjs"),
    join(CLI_ROOT, "package.json"),
    join(CLI_ROOT, "LICENSE"),
    join(CLI_ROOT, "README.md"),
    join(CLI_ROOT, "THIRD_PARTY_NOTICES"),
  ].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    fail(`portable build inputs are missing; run "pnpm --dir apps/cli build" first:\n${missing.join("\n")}`);
  }
}

/**
 * Verifies the assembled app by running it, rather than by inspecting bundle text. The CLI derives
 * its program name from the compiled channel and its version from the packed manifest, so this is a
 * direct check that the requested coordinates match the bytes about to be shipped.
 */
export function assertBuiltCliIdentity({ appDir, channelConfig, version }) {
  const home = join(appDir, ".identity-check-home");
  const env = { ...process.env, OPENTAG_HOME: home };
  try {
    const versionOutput = run(process.execPath, [join(appDir, "cli", "index.mjs"), "--version"], {
      env,
      stdio: "pipe",
    }).stdout.trim();
    if (versionOutput !== version) {
      fail(
        `built CLI reports version ${versionOutput}, expected ${version}. ` +
          'Run "node scripts/prepare-cli-release.mjs" and rebuild apps/cli before building the portable release.',
      );
    }
    const helpOutput = run(process.execPath, [join(appDir, "cli", "index.mjs"), "--help"], {
      env,
      stdio: "pipe",
    }).stdout;
    if (!new RegExp(`^Usage: ${channelConfig.binName}\\b`, "m").test(helpOutput)) {
      fail(
        `built CLI does not present itself as ${channelConfig.binName}. ` +
          'Run "node scripts/prepare-cli-release.mjs --channel <channel> --version <version>" and rebuild apps/cli.',
      );
    }
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

/**
 * Assembles the channel- and version-specific app tree once, so every platform artifact ships
 * byte-identical application code and only differs in its embedded Node.js runtime.
 */
async function createAppTemplate({ channelConfig, version }) {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-app-"));
  const appDir = join(root, "app");
  const sourcePackage = readJson(join(CLI_ROOT, "package.json"));
  assertBundledCliHasNoRuntimeDependencies(sourcePackage);

  // The runtime only loads ESM chunks; declaration files, source maps, and build info would triple
  // the download for bytes no installed CLI ever reads.
  cpSync(join(CLI_ROOT, "dist"), appDir, {
    recursive: true,
    filter: (source) => lstatSync(source).isDirectory() || source.endsWith(".mjs"),
  });
  cpSync(join(CLI_ROOT, "LICENSE"), join(appDir, "LICENSE"));
  cpSync(join(CLI_ROOT, "README.md"), join(appDir, "README.md"));
  cpSync(join(CLI_ROOT, "THIRD_PARTY_NOTICES"), join(appDir, "THIRD_PARTY_NOTICES"));
  writeJson(join(appDir, "package.json"), portableAppPackageJson({ channelConfig, sourcePackage, version }));
  assertBuiltCliIdentity({ appDir, channelConfig, version });
  return { appDir, root };
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) fail(`failed to download ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

/**
 * Fetches the official Node.js build for one platform and checks it against the release's own
 * SHASUMS256.txt before it can become part of a shipped artifact.
 */
async function downloadNodeRuntime({ nodeVersion, platform, destDir, cacheDir }) {
  parsePlatform(platform);
  const fileName = `node-${nodeVersion}-${platform}.tar.gz`;
  const distBase = `https://nodejs.org/dist/${nodeVersion}`;
  const expected = (await downloadText(`${distBase}/SHASUMS256.txt`))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === fileName)?.[0];
  if (!expected) fail(`official SHASUMS256.txt for ${nodeVersion} does not list ${fileName}`);

  const tarball = join(cacheDir, fileName);
  if (!existsSync(tarball)) {
    const response = await fetch(`${distBase}/${fileName}`);
    if (!response.ok) fail(`failed to download ${fileName}: ${response.status} ${response.statusText}`);
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256File(tarball);
  if (actual !== expected) {
    rmSync(tarball, { force: true });
    fail(`Node.js tarball checksum mismatch for ${fileName}: expected ${expected}, got ${actual}`);
  }

  const extractDir = await mkdtemp(join(tmpdir(), "opentag-portable-node-"));
  try {
    run("tar", ["-xzf", tarball, "-C", extractDir]);
    const nodeBinary = join(extractDir, fileName.replace(/\.tar\.gz$/, ""), "bin", "node");
    if (!existsSync(nodeBinary)) fail(`Node.js tarball did not contain bin/node: ${fileName}`);
    mkdirSync(join(destDir, "bin"), { recursive: true });
    cpSync(nodeBinary, join(destDir, "bin", "node"));
  } finally {
    await rm(extractDir, { force: true, recursive: true });
  }
}

async function buildPlatformArtifact(options) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "opentag-portable-root-"));
  try {
    cpSync(options.appTemplateDir, join(artifactRoot, "app"), { recursive: true });
    await downloadNodeRuntime({
      cacheDir: options.nodeCacheDir,
      destDir: join(artifactRoot, "node"),
      nodeVersion: options.nodeVersion,
      platform: options.platform,
    });
    mkdirSync(join(artifactRoot, "bin"), { recursive: true });
    writeFileSync(join(artifactRoot, "bin", options.channelConfig.binName), portableArtifactShim(), {
      mode: 0o755,
    });
    writeFileSync(join(artifactRoot, "VERSION"), `${options.version}\n`);
    writeJson(join(artifactRoot, "INSTALL.json"), {
      ...buildPortableMetadata(options),
      platform: options.platform,
      installMode: "portable",
      appEntry: APP_ENTRY,
    });

    const fileName = artifactFileName({
      packageName: options.channelConfig.packageName,
      platform: options.platform,
      version: options.version,
    });
    const tarballPath = join(options.versionDir, fileName);
    await writeDeterministicTarGz({ generatedAt: options.generatedAt, sourceDir: artifactRoot, tarballPath });
    return {
      platform: options.platform,
      fileName,
      url: artifactDownloadUrl({
        channel: options.channel,
        downloadBaseUrl: options.downloadBaseUrl,
        fileName,
        version: options.version,
      }),
      sha256: sha256File(tarballPath),
      size: statSync(tarballPath).size,
    };
  } finally {
    await rm(artifactRoot, { force: true, recursive: true });
  }
}

export async function buildPortableDistribution(rawOptions) {
  const channelConfig = getPortableChannelConfig(rawOptions.channel);
  const options = {
    ...rawOptions,
    downloadBaseUrl: normalizeDownloadBaseUrl(rawOptions.downloadBaseUrl),
    generatedAt: normalizeGeneratedAt(rawOptions.generatedAt ?? new Date().toISOString()),
    nodeVersion: normalizeNodeVersion(rawOptions.nodeVersion),
    outDir: resolve(rawOptions.outDir),
  };
  validateChannelVersion(options.channel, options.version);
  if (!options.gitSha) fail("--git-sha is required");
  assertInputBuildExists();

  const channelDir = join(options.outDir, options.channel);
  const versionDir = join(channelDir, options.version);
  rmSync(versionDir, { force: true, recursive: true });
  mkdirSync(versionDir, { recursive: true });

  const nodeCacheDir = process.env.OPENTAG_PORTABLE_NODE_CACHE_DIR
    ? resolve(process.env.OPENTAG_PORTABLE_NODE_CACHE_DIR)
    : join(options.outDir, ".cache", "node");
  mkdirSync(nodeCacheDir, { recursive: true });

  const appTemplate = await createAppTemplate({ channelConfig, version: options.version });
  try {
    const assets = [];
    for (const platform of options.platforms) {
      console.log(
        `[portable] building ${options.channel} ${options.version} ${platform} on Node ${options.nodeVersion}`,
      );
      assets.push(
        await buildPlatformArtifact({
          appTemplateDir: appTemplate.appDir,
          channel: options.channel,
          channelConfig,
          downloadBaseUrl: options.downloadBaseUrl,
          generatedAt: options.generatedAt,
          gitSha: options.gitSha,
          nodeCacheDir,
          nodeVersion: options.nodeVersion,
          platform,
          version: options.version,
          versionDir,
        }),
      );
    }

    const { manifest, latest } = buildPortableReleaseMetadata({
      assets,
      channel: options.channel,
      channelConfig,
      downloadBaseUrl: options.downloadBaseUrl,
      generatedAt: options.generatedAt,
      gitSha: options.gitSha,
      nodeVersion: options.nodeVersion,
      version: options.version,
    });
    writeJson(join(versionDir, "manifest.json"), manifest);
    writeJson(join(channelDir, "latest.json"), latest);
    writeFileSync(
      join(versionDir, "SHA256SUMS"),
      `${assets.map((asset) => `${asset.sha256}  ${asset.fileName}`).join("\n")}\n`,
    );
    writeFileSync(join(channelDir, "install.sh"), renderInstallerForChannel(options.channel, options.downloadBaseUrl), {
      mode: 0o755,
    });

    console.log(`[portable] wrote ${relative(REPO_ROOT, channelDir)}`);
    return { channelDir, latest, manifest, versionDir };
  } finally {
    await rm(appTemplate.root, { force: true, recursive: true });
  }
}

function printHelp() {
  console.log(`Usage: node scripts/portable/build-portable.mjs --channel prod|staging --version <version> --git-sha <sha> --out-dir <path> [options]

Options:
  --node-version <version>      Exact Node.js runtime version. Defaults to scripts/portable/node-version.txt.
  --download-base-url <url>     Public release base URL without the channel segment. Defaults to ${DEFAULT_DOWNLOAD_BASE_URL}.
  --generated-at <timestamp>    Release timestamp. Defaults to the current time.
  --platform <platform>         Repeatable: ${PORTABLE_PLATFORMS.join(", ")}
  --help                        Show this help.

The builder expects an existing apps/cli/dist build that already carries the target channel identity.`);
}

export function parseArgs(argv) {
  const options = {
    channel: null,
    downloadBaseUrl: process.env.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL || DEFAULT_DOWNLOAD_BASE_URL,
    generatedAt: null,
    gitSha: null,
    nodeVersion: readDefaultNodeVersion(),
    outDir: null,
    platforms: [],
    version: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--channel") options.channel = next();
    else if (arg === "--version") options.version = next();
    else if (arg === "--git-sha") options.gitSha = next();
    else if (arg === "--node-version") options.nodeVersion = next();
    else if (arg === "--download-base-url") options.downloadBaseUrl = next();
    else if (arg === "--generated-at") options.generatedAt = next();
    else if (arg === "--out-dir") options.outDir = next();
    else if (arg === "--platform") options.platforms.push(next());
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!options.outDir) fail("--out-dir is required");
  if (!options.version) fail("--version is required");
  getPortableChannelConfig(options.channel);
  validateChannelVersion(options.channel, options.version);
  options.platforms = options.platforms.length > 0 ? options.platforms : [...PORTABLE_PLATFORMS];
  for (const platform of options.platforms) parsePlatform(platform);
  return options;
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  buildPortableDistribution(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[portable] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
