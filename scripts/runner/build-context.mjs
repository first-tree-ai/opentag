import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DENY_NAMES = new Set([
  ".env",
  ".git",
  ".npmrc",
  "node_modules",
  "dist",
  "coverage",
  "__tests__",
  "smoke",
  "fixtures",
]);

const CREDENTIAL_NAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  "auth.json",
  "credentials.json",
  "credentials",
  "id_rsa",
  "private-config-path.txt",
]);

export const RUNNER_CONTEXT_ALLOWLIST = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "LICENSE",
  "packages/shared/package.json",
  "packages/shared/tsconfig.json",
  "packages/shared/src",
  "packages/client/package.json",
  "packages/client/tsconfig.json",
  "packages/client/src",
  "packages/server/package.json",
  "apps/cli/package.json",
  "apps/cli/tsconfig.json",
  "apps/cli/src",
  "apps/web/package.json",
  "e2e/package.json",
  "scripts/portable/node-version.txt",
  "scripts/portable/runtime-dependencies.mjs",
  "scripts/prepare-cli-release.mjs",
  "scripts/release-versions.mjs",
  "scripts/channel-config.mjs",
  "scripts/runner",
]);

function fail(message) {
  throw new Error(message);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

/**
 * The version-controlled source files in the Git index, including intent-to-add entries.
 * Staging must fail safely when ownership cannot be established: silently falling back to a
 * recursive copy would smuggle ignored/untracked local files into a build labelled as a clean
 * source SHA (ignored files do not show up in `git status --porcelain`).
 */
export function listTrackedSourceFiles(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(
      `cannot establish source Git ownership for ${root} (git ls-files failed); refusing to stage the build context`,
    );
  }
  return new Set(result.stdout.split("\0").filter((entry) => entry.length > 0));
}

export function isInsideRoot(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === "" || (!isAbsolute(suffix) && !suffix.startsWith(`..${sep}`) && suffix !== "..");
}

/**
 * Reject any symlink between the canonical root and the path, inclusive of every
 * ancestor directory. lstat on the leaf alone follows symlinked ancestors, so a
 * symlinked directory inside the source tree would otherwise smuggle outside files
 * into the build context (review finding 19).
 */
function assertNoSymlinkAncestors(root, absolutePath) {
  let current = dirname(absolutePath);
  for (;;) {
    const suffix = relative(root, current);
    if (suffix === "") return;
    if (isAbsolute(suffix) || suffix.startsWith(`..${sep}`) || suffix === "..") {
      fail(`path is not inside the selected source tree: ${absolutePath}`);
    }
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      fail(`refusing symlink ancestor directory: ${toPosix(relative(root, current))}`);
    }
    current = dirname(current);
  }
}

/** Compare physical paths: the real target must live inside the canonical source root. */
function assertPhysicallyContained(canonicalRoot, absolutePath, allowRoot = false) {
  const real = realpathSync(absolutePath);
  if (!isInsideRoot(canonicalRoot, real) || (!allowRoot && real === canonicalRoot)) {
    fail(`path escapes the canonical source tree: ${absolutePath} -> ${real}`);
  }
  return real;
}

export function isCredentialPath(relativePath) {
  const posix = toPosix(relativePath);
  const base = posix.split("/").at(-1) ?? "";
  if (CREDENTIAL_NAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  return false;
}

function denied(relativePath) {
  const parts = toPosix(relativePath).split("/");
  if (parts.some((part) => DENY_NAMES.has(part) || part.startsWith(".env."))) return true;
  return isCredentialPath(relativePath);
}

function assertRegular(root, canonicalRoot, absolutePath) {
  const stats = lstatSync(absolutePath);
  if (stats.isSymbolicLink()) fail(`refusing to copy symlink: ${toPosix(relative(root, absolutePath))}`);
  if (!isInsideRoot(root, resolve(absolutePath))) fail(`path escapes the selected source tree: ${absolutePath}`);
  assertNoSymlinkAncestors(root, absolutePath);
  assertPhysicallyContained(canonicalRoot, absolutePath);
  return stats;
}

function copyFile(root, canonicalRoot, from, to, tracked) {
  const rel = toPosix(relative(root, from));
  if (denied(rel) || isCredentialPath(rel)) fail(`refusing to stage credential or denied path: ${rel}`);
  assertRegular(root, canonicalRoot, from);
  if (!tracked.has(rel)) return false;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  return true;
}

/** Deny/allow one directory entry before staging; credential and symlink checks stay first. */
function assertStageableEntry(childRel, entry, tracked) {
  if (entry.isSymbolicLink()) fail(`refusing to copy symlink: ${childRel}`);
  if (denied(childRel)) {
    if (isCredentialPath(childRel)) fail(`refusing to stage credential or denied path: ${childRel}`);
    return false;
  }
  // Ignored/untracked local files (logs, editor droppings) never enter the context; only
  // version-controlled files within the allowlist are staged.
  if (entry.isFile() && !tracked.has(childRel)) return false;
  return true;
}

function copyDirectory(root, canonicalRoot, from, to, tracked) {
  assertRegular(root, canonicalRoot, from);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const childFrom = join(from, entry.name);
    const childRel = toPosix(relative(root, childFrom));
    if (!assertStageableEntry(childRel, entry, tracked)) continue;
    const childTo = join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(root, canonicalRoot, childFrom, childTo, tracked);
    else if (entry.isFile()) copyFile(root, canonicalRoot, childFrom, childTo, tracked);
    else fail(`refusing to copy special file: ${childFrom}`);
  }
}

function assertDestination(root, canonicalRoot, dest) {
  if (dest === root || isInsideRoot(root, dest)) fail("build context destination must not be inside the source tree");
  if (existsSync(dest)) {
    if (lstatSync(dest).isSymbolicLink()) fail("build context destination must not be a symlink");
    if (readdirSync(dest).length > 0) fail("build context destination is not empty");
  }
  mkdirSync(dest, { recursive: true });
  const real = realpathSync(dest);
  if (real === canonicalRoot || isInsideRoot(canonicalRoot, real)) {
    fail("build context destination physically overlaps the canonical source tree");
  }
}

export function stageRunnerBuildContext({ sourceRoot, destination, allowlist = RUNNER_CONTEXT_ALLOWLIST, identity }) {
  const root = resolve(sourceRoot);
  const canonicalRoot = realpathSync(root);
  const dest = resolve(destination);
  assertDestination(root, canonicalRoot, dest);
  const tracked = listTrackedSourceFiles(root);
  for (const entry of allowlist) {
    const from = join(root, entry);
    const to = join(dest, entry);
    if (!existsSync(from)) fail(`allowlisted path is missing: ${entry}`);
    if (denied(entry) || isCredentialPath(entry)) fail(`allowlisted path is denied: ${entry}`);
    const stats = lstatSync(from);
    if (stats.isSymbolicLink()) fail(`allowlisted path is a symlink: ${entry}`);
    assertNoSymlinkAncestors(root, from);
    if (stats.isDirectory()) {
      copyDirectory(root, canonicalRoot, from, to, tracked);
    } else {
      // Allowlisted files are declared build inputs; they must be version-controlled.
      if (!tracked.has(toPosix(entry))) fail(`allowlisted path is not version-controlled: ${entry}`);
      copyFile(root, canonicalRoot, from, to, tracked);
    }
  }
  if (identity) writeFileSync(join(dest, "runner-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  return dest;
}

export function listStagedRelativeFiles(directory, root = directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`staged symlink is not allowed: ${path}`);
    if (entry.isDirectory()) listStagedRelativeFiles(path, root, files);
    else files.push(toPosix(relative(root, path)));
  }
  return files.sort();
}

export function readStagedIdentity(directory) {
  return JSON.parse(readFileSync(join(directory, "runner-identity.json"), "utf8"));
}
