/**
 * Assembles and verifies the production dependency closure embedded in a portable app.
 *
 * The portable app ships the bundled CLI next to a physical `node_modules` tree so the runtime can
 * keep resolving `@first-tree-ai/context-tree` (its `package.json` through `createRequire`, its
 * bundled CLI, and its packaged skills and templates) on machines that have no package manager.
 * The closure is copied from the frozen pnpm install only - no fetch, no install, no lifecycle
 * scripts - and the flat output layout stays deterministic and closed: one real directory per
 * package, no symlinks, no native addons, and never two versions of the same package name.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const LIFECYCLE_SCRIPT_NAMES = ["preinstall", "install", "postinstall"];

/** The only runtime dependency the portable app may embed, mirroring the apps/cli dependency. */
const SUPPORTED_DIRECT_DEPENDENCY = "@first-tree-ai/context-tree";

export const DEPENDENCY_CLOSURE_FILE = "dependency-closure.json";
export const DEPENDENCY_CLOSURE_SCHEMA_VERSION = 1;
/** Packaged skill directories that the Context Tree CLI installs for agent hosts. */
export const CONTEXT_TREE_SKILL_DIRECTORIES = Object.freeze([
  "context-tree-connect",
  "context-tree-create",
  "context-tree-publish",
  "context-tree-read",
  "context-tree-setup",
  "context-tree-write",
]);
/** Templates, relative to `templates/`, that the Context Tree CLI scaffolds tree roots from. */
export const CONTEXT_TREE_TEMPLATE_FILES = Object.freeze(["AGENTS.md", "root-node.md", "validate-context-tree.yml"]);
/** The packaged CLI entry, relative to the installed package root. */
const CONTEXT_TREE_CLI_RELATIVE_PATH = "dist/cli/index.mjs";

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRegularFile(path) {
  return existsSync(path) && lstatSync(path).isFile();
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function byString(left, right) {
  return left.localeCompare(right);
}

function byEntryName(left, right) {
  return left.name.localeCompare(right.name);
}

function validatePackageName(name) {
  if (typeof name !== "string" || !PACKAGE_NAME_PATTERN.test(name)) {
    fail(`invalid package name: ${JSON.stringify(name)}`);
  }
}

/**
 * The top manifest of the portable source (and later of the shipped app) may only declare the
 * supported Context Tree dependency, pinned to an exact stable version. Anything else would need a
 * dependency shape the flat portable layout cannot express, so it fails closed here.
 */
export function readPortableDirectDependencyPins(packageManifest) {
  if (!isRecord(packageManifest)) {
    fail("package manifest must be an object");
  }
  const dependencies = packageManifest.dependencies;
  if (dependencies !== undefined && dependencies !== null && !isRecord(dependencies)) {
    fail("package manifest dependencies must be an object");
  }
  const names = Object.keys(dependencies ?? {});
  const unknown = names.filter((name) => name !== SUPPORTED_DIRECT_DEPENDENCY);
  if (unknown.length > 0) {
    fail(
      `unsupported runtime dependency "${unknown.join('", "')}": the portable app only embeds ${SUPPORTED_DIRECT_DEPENDENCY}`,
    );
  }
  for (const name of names) {
    const pin = dependencies[name];
    if (typeof pin !== "string" || !EXACT_VERSION_PATTERN.test(pin)) {
      fail(`runtime dependency ${name} must be pinned to an exact x.y.z version, got ${JSON.stringify(pin)}`);
    }
  }
  for (const field of ["optionalDependencies", "peerDependencies"]) {
    const value = packageManifest[field];
    if (value !== undefined && value !== null && (!isRecord(value) || Object.keys(value).length > 0)) {
      fail(`package manifest declares non-empty ${field}; the portable app cannot express it`);
    }
  }
  return names.sort().map((name) => ({ name, version: dependencies[name] }));
}

/** The exact `node_modules` directories Node walks when loading from `fromPath`. */
function nodeModulesLookupPaths(fromPath) {
  const paths = [];
  let directory = resolve(dirname(fromPath));
  for (;;) {
    paths.push(join(directory, "node_modules"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return paths;
}

function findInstallRoot(manifestPath) {
  for (const candidate of nodeModulesLookupPaths(manifestPath)) {
    const directory = dirname(candidate);
    if (existsSync(join(directory, "pnpm-lock.yaml"))) return realpathSync(directory);
  }
  return realpathSync(dirname(manifestPath));
}

function isInside(directory, path) {
  const suffix = relative(directory, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../");
}

/**
 * Resolves one installed package the way Node would load it from the referring manifest, and
 * canonicalizes its root. Only candidates inside the referring package's own install tree count:
 * machine-global paths (which `require.resolve.paths` appends last) must never answer for a
 * package the portable app would then fail to find on an installed machine.
 */
export function resolveInstalledDependencyPackage(
  fromManifestPath,
  name,
  installRoot = findInstallRoot(fromManifestPath),
) {
  fromManifestPath = realpathSync(fromManifestPath);
  validatePackageName(name);
  const lookupPaths = createRequire(fromManifestPath).resolve.paths(name) ?? [];
  const installPaths = new Set(nodeModulesLookupPaths(fromManifestPath));
  for (const nodeModulesDir of lookupPaths) {
    if (!installPaths.has(nodeModulesDir) || !isInside(installRoot, nodeModulesDir)) continue;
    const candidateRoot = join(nodeModulesDir, ...name.split("/"));
    if (!isRegularFile(join(candidateRoot, "package.json"))) continue;
    const root = realpathSync(candidateRoot);
    if (!isInside(installRoot, root)) {
      fail(`installed package ${name} resolves outside the frozen install root: ${root}`);
    }
    const manifest = readJsonFile(join(root, "package.json"));
    if (!isRecord(manifest) || manifest.name !== name) {
      fail(`installed package ${name} at ${root} does not carry its own name; reinstall and retry`);
    }
    return { name, root, manifest, manifestPath: join(root, "package.json") };
  }
  fail(
    `installed package ${name} could not be resolved from ${fromManifestPath}; ` +
      'run "pnpm install --frozen-lockfile" and rebuild apps/cli',
  );
}

function assertEmptyObjectField(manifest, field, what) {
  const value = manifest[field];
  if (value === undefined || value === null) return;
  if (!isRecord(value) || Object.keys(value).length > 0) {
    fail(`embedded package ${what} declares non-empty ${field}; the portable app cannot express it yet`);
  }
}

function assertNoPlatformConstraints(manifest, what) {
  for (const field of ["os", "cpu"]) {
    const value = manifest[field];
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      fail(`embedded package ${what} declares ${field} constraints; platform-specific packages are not yet supported`);
    }
  }
}

function assertNoLifecycleScripts(manifest, what, allowLifecycleScripts) {
  if (allowLifecycleScripts) return;
  const names = LIFECYCLE_SCRIPT_NAMES.filter((name) => typeof manifest.scripts?.[name] === "string");
  if (names.length > 0) {
    fail(
      `embedded package ${what} declares lifecycle scripts (${names.join(", ")}); ` +
        "the portable app never runs install scripts",
    );
  }
}

/**
 * Every embedded package must stay platform-neutral and inert. Optional-only peer metadata (an
 * empty `peerDependencies` plus a `peerDependenciesMeta` note, as in `debug`) is accepted: it
 * installs nothing and the package works without the peer.
 */
function validateEmbeddedPackageManifest(manifest, what, allowLifecycleScripts) {
  if (!isRecord(manifest) || typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    fail(`embedded package ${what} has an invalid package manifest`);
  }
  validatePackageName(manifest.name);
  if (!EXACT_VERSION_PATTERN.test(manifest.version)) {
    fail(`embedded package ${what} must have an exact stable version`);
  }
  if (manifest.dependencies !== undefined && !isRecord(manifest.dependencies)) {
    fail(`embedded package ${what} dependencies must be an object`);
  }
  for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
    validatePackageName(name);
    if (typeof specifier !== "string" || specifier.length === 0) {
      fail(`embedded package ${what} has an invalid dependency specifier for ${name}`);
    }
  }
  assertEmptyObjectField(manifest, "optionalDependencies", what);
  assertEmptyObjectField(manifest, "peerDependencies", what);
  assertEmptyObjectField(manifest, "bundledDependencies", what);
  assertEmptyObjectField(manifest, "bundleDependencies", what);
  const peerMeta = manifest.peerDependenciesMeta;
  if (peerMeta !== undefined && peerMeta !== null && !isRecord(peerMeta)) {
    fail(`embedded package ${what} has invalid peerDependenciesMeta`);
  }
  assertNoPlatformConstraints(manifest, what);
  assertNoLifecycleScripts(manifest, what, allowLifecycleScripts);
}

/**
 * Walks the installed dependency graph from the source manifest and records one canonical root per
 * package name. Same-name packages from different installed roots cannot be expressed in the flat
 * layout, so they fail closed instead of silently shipping one version for both referrers.
 */
export function collectRuntimeDependencyClosure({ sourceManifestPath }) {
  const direct = readPortableDirectDependencyPins(readJsonFile(sourceManifestPath));
  const installRoot = findInstallRoot(sourceManifestPath);
  const byName = new Map();
  const queue = direct.map((pin) => ({ from: sourceManifestPath, name: pin.name, pin }));
  while (queue.length > 0) {
    const job = queue.shift();
    const resolved = resolveInstalledDependencyPackage(job.from, job.name, installRoot);
    const recorded = byName.get(job.name);
    if (recorded !== undefined) {
      if (recorded.root !== resolved.root) {
        fail(
          `dependency ${job.name} resolves to ${resolved.root}, but the closure already embeds it from ` +
            `${recorded.root}; the flat portable layout cannot ship both versions`,
        );
      }
      continue;
    }
    const allowLifecycleScripts = direct.some((pin) => pin.name === job.name);
    validateEmbeddedPackageManifest(
      resolved.manifest,
      `${job.name}@${resolved.manifest.version}`,
      allowLifecycleScripts,
    );
    if (job.pin !== undefined && resolved.manifest.version !== job.pin.version) {
      fail(
        `installed package ${job.name} is version ${resolved.manifest.version}, but the source pins ` +
          `${job.pin.version}; run "pnpm install --frozen-lockfile" and rebuild`,
      );
    }
    byName.set(job.name, { name: job.name, root: resolved.root, version: resolved.manifest.version });
    for (const child of Object.keys(resolved.manifest.dependencies ?? {}).sort()) {
      queue.push({ from: resolved.manifestPath, name: child });
    }
  }
  const packages = [...byName.values()]
    .sort((left, right) => byString(left.name, right.name))
    .map(({ name, root, version }) => ({ name, root, version }));
  return { direct, packages };
}

/**
 * Every published file of one installed package, in deterministic pre-order. The package's own
 * nested `node_modules` (pnpm bin droppings) is never published content; a symlink inside the
 * package would export a host link, and a native addon cannot run on every platform, so both fail
 * closed instead.
 */
function publishedPackageFiles(packageEntry, relativeDirectory = "", shipped = false) {
  const files = [];
  const sourceDirectory = join(packageEntry.root, relativeDirectory);
  const entries = readdirSync(sourceDirectory, { withFileTypes: true }).sort(byEntryName);
  for (const entry of entries) {
    if (skipInstalledNodeModules(entry, packageEntry.name, shipped)) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      fail(`package ${packageEntry.name} publishes a symbolic link (${relativePath}); refusing to export host links`);
    }
    if (entry.isDirectory()) {
      files.push(...publishedPackageFiles(packageEntry, relativePath, shipped));
      continue;
    }
    if (!entry.isFile()) {
      fail(`package ${packageEntry.name} publishes a non-regular entry (${relativePath})`);
    }
    if (entry.name.endsWith(".node")) {
      fail(
        `package ${packageEntry.name} publishes a native addon (${relativePath}); native modules are not yet supported`,
      );
    }
    files.push(relativePath);
  }
  return files;
}

function skipInstalledNodeModules(entry, name, shipped) {
  if (entry.name !== "node_modules") return false;
  if (shipped) fail(`package ${name} ships a nested node_modules directory`);
  return true;
}

/**
 * Copies the collected closure into a fresh flat `node_modules` directory. The destination must
 * not exist: every `node_modules` directory in the output is assembler-owned.
 */
export function materializeRuntimeDependencyClosure({ sourceManifestPath, nodeModulesDir }) {
  const closure = collectRuntimeDependencyClosure({ sourceManifestPath });
  if (existsSync(nodeModulesDir)) {
    fail(`refusing to reuse an existing node_modules directory: ${nodeModulesDir}`);
  }
  if (closure.packages.length === 0) return closure;
  mkdirSync(nodeModulesDir, { recursive: true });
  for (const packageEntry of closure.packages) {
    const destinationRoot = join(nodeModulesDir, ...packageEntry.name.split("/"));
    mkdirSync(destinationRoot, { recursive: true });
    for (const relativePath of publishedPackageFiles(packageEntry)) {
      const destination = join(destinationRoot, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(packageEntry.root, relativePath), destination);
      chmodSync(destination, 0o644);
    }
  }
  return closure;
}

/**
 * Writes the persisted record of the embedded graph next to the app manifest. `direct` keeps the
 * truthful exact pins and `packages` names every embedded package, both sorted by name.
 */
export function writeDependencyClosureFile(appDir, closure) {
  const record = {
    schemaVersion: DEPENDENCY_CLOSURE_SCHEMA_VERSION,
    direct: closure.direct.map(({ name, version }) => ({ name, version })),
    packages: closure.packages.map(({ name, version }) => ({ name, version })),
  };
  writeFileSync(join(appDir, DEPENDENCY_CLOSURE_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

function parseDependencyRecords(value, field) {
  if (!Array.isArray(value)) fail(`${DEPENDENCY_CLOSURE_FILE} ${field} must be an array`);
  const names = new Set();
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") {
      fail(`${DEPENDENCY_CLOSURE_FILE} ${field} entries must carry name and version`);
    }
    validatePackageName(entry.name);
    if (names.has(entry.name)) fail(`${DEPENDENCY_CLOSURE_FILE} ${field} has duplicate package ${entry.name}`);
    names.add(entry.name);
    if (!EXACT_VERSION_PATTERN.test(entry.version)) {
      fail(`${DEPENDENCY_CLOSURE_FILE} ${field} version must be exact: ${entry.version}`);
    }
    return { name: entry.name, version: entry.version };
  });
}

function readDependencyClosureRecord(appDir) {
  const filePath = join(appDir, DEPENDENCY_CLOSURE_FILE);
  if (!isRegularFile(filePath)) fail(`portable app is missing ${DEPENDENCY_CLOSURE_FILE} or it is not a regular file`);
  const record = readJsonFile(filePath);
  if (!isRecord(record) || record.schemaVersion !== DEPENDENCY_CLOSURE_SCHEMA_VERSION) {
    fail(`${DEPENDENCY_CLOSURE_FILE} must carry schemaVersion ${DEPENDENCY_CLOSURE_SCHEMA_VERSION}`);
  }
  const direct = parseDependencyRecords(record.direct, "direct").sort((left, right) => byString(left.name, right.name));
  const packages = parseDependencyRecords(record.packages, "packages").sort((left, right) =>
    byString(left.name, right.name),
  );
  return { direct, packages };
}

/**
 * Top-level package names in a flat `node_modules` tree. Scoped packages live under their scope
 * directory; anything that is not a real directory fails closed, because every `node_modules`
 * directory in the output is assembler-owned.
 */
function listPhysicalPackageNames(nodeModulesDir) {
  const names = [];
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true }).sort(byEntryName)) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fail(`unexpected entry in the portable app node_modules: ${entry.name}`);
    }
    if (entry.name.startsWith("@")) {
      names.push(...listScopedPackageNames(nodeModulesDir, entry.name));
    } else {
      names.push(entry.name);
    }
  }
  return names.sort(byString);
}

function listScopedPackageNames(nodeModulesDir, scope) {
  const children = readdirSync(join(nodeModulesDir, scope), { withFileTypes: true }).sort(byEntryName);
  if (children.length === 0) fail(`unexpected empty scope in portable app node_modules: ${scope}`);
  return children.map((child) => {
    if (child.isSymbolicLink() || !child.isDirectory()) {
      fail(`unexpected entry in ${scope}: ${child.name}`);
    }
    return `${scope}/${child.name}`;
  });
}

/**
 * Verifies one assembled app's embedded dependency graph against its persisted closure record and
 * its shipped package manifests. Dependency-free apps keep the historic shape (no `node_modules`,
 * no closure file); apps that embed dependencies must be complete, closed, and inert.
 */
export function verifyPortableDependencyGraph(appDir) {
  const manifestPath = join(appDir, "package.json");
  if (!isRegularFile(manifestPath)) fail(`portable app is missing its regular package manifest: ${manifestPath}`);
  const directPins = readPortableDirectDependencyPins(readJsonFile(manifestPath));
  const nodeModulesDir = join(appDir, "node_modules");
  if (directPins.length === 0) {
    if (existsSync(nodeModulesDir)) {
      fail(`portable app ships node_modules without declaring runtime dependencies: ${nodeModulesDir}`);
    }
    if (existsSync(join(appDir, DEPENDENCY_CLOSURE_FILE))) {
      fail(`portable app ships ${DEPENDENCY_CLOSURE_FILE} without declaring runtime dependencies`);
    }
    return { packageCount: 0 };
  }
  const closure = readDependencyClosureRecord(appDir);
  if (JSON.stringify(closure.direct) !== JSON.stringify(directPins)) {
    fail("app package manifest dependencies do not match the recorded direct pins");
  }
  for (const pin of directPins) {
    if (!closure.packages.some((entry) => entry.name === pin.name && entry.version === pin.version)) {
      fail(`recorded dependency package ${pin.name} does not match the direct pin ${pin.version}`);
    }
  }
  if (!existsSync(nodeModulesDir) || !lstatSync(nodeModulesDir).isDirectory()) {
    fail(`portable app is missing its node_modules directory: ${nodeModulesDir}`);
  }
  verifyPhysicalPackages({ closure, directPins, nodeModulesDir });
  verifyShippedGraph({ closure, directPins, nodeModulesDir });
  assertContextTreeAssets(nodeModulesDir, directPins);
  return { packageCount: closure.packages.length };
}

function verifyPhysicalPackages({ closure, directPins, nodeModulesDir }) {
  const physicalNames = listPhysicalPackageNames(nodeModulesDir);
  const shippedNames = new Set(closure.packages.map((entry) => entry.name));
  for (const entry of closure.packages) {
    if (!physicalNames.includes(entry.name)) fail(`portable app is missing dependency package ${entry.name}`);
  }
  const extras = physicalNames.filter((name) => !shippedNames.has(name));
  if (extras.length > 0) fail(`portable app ships unreferenced dependency package(s): ${extras.join(", ")}`);
  for (const entry of closure.packages) {
    const packageDir = join(nodeModulesDir, ...entry.name.split("/"));
    publishedPackageFiles({ name: entry.name, root: packageDir }, "", true);
    const shippedManifest = readJsonFile(join(packageDir, "package.json"));
    const allowLifecycleScripts = directPins.some((pin) => pin.name === entry.name);
    validateEmbeddedPackageManifest(shippedManifest, `${entry.name}@${entry.version}`, allowLifecycleScripts);
    if (shippedManifest.name !== entry.name || shippedManifest.version !== entry.version) {
      fail(`dependency package ${entry.name}@${entry.version} does not match its shipped manifest`);
    }
  }
}

/** Re-walks the graph declared by the shipped manifests so a deleted or unreferenced package cannot ship. */
function verifyShippedGraph({ closure, directPins, nodeModulesDir }) {
  const shippedNames = new Set(closure.packages.map((entry) => entry.name));
  const reachable = new Set();
  const queue = directPins.map((pin) => pin.name);
  while (queue.length > 0) {
    const name = queue.shift();
    if (reachable.has(name)) continue;
    reachable.add(name);
    const manifest = readJsonFile(join(nodeModulesDir, ...name.split("/"), "package.json"));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (!shippedNames.has(dependency)) {
        fail(`dependency ${dependency} of ${name} is not part of the portable closure`);
      }
      queue.push(dependency);
    }
  }
  const unreferenced = [...shippedNames].filter((name) => !reachable.has(name)).sort(byString);
  if (unreferenced.length > 0) {
    fail(`portable app ships unreferenced dependency package(s): ${unreferenced.join(", ")}`);
  }
}

/** The packaged Context Tree files the runtime and its CLI need must all be present. */
function assertContextTreeAssets(nodeModulesDir, directPins) {
  if (!directPins.some((pin) => pin.name === SUPPORTED_DIRECT_DEPENDENCY)) return;
  const packageDir = join(nodeModulesDir, ...SUPPORTED_DIRECT_DEPENDENCY.split("/"));
  const assets = [
    CONTEXT_TREE_CLI_RELATIVE_PATH,
    ...CONTEXT_TREE_SKILL_DIRECTORIES.map((skill) => `skills/${skill}/SKILL.md`),
    ...CONTEXT_TREE_TEMPLATE_FILES.map((template) => `templates/${template}`),
  ];
  for (const asset of assets) {
    if (!isRegularFile(join(packageDir, asset))) {
      fail(`Context Tree package is missing packaged asset ${asset}; reinstall the frozen dependencies and rebuild`);
    }
  }
}

function runNode(nodePath, args, env, expectedStatus = 0) {
  const result = spawnSync(nodePath, args, {
    encoding: "utf8",
    env,
    cwd: env.HOME,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) fail(`${nodePath} failed to start: ${result.error.message}`);
  if (result.status !== expectedStatus) {
    fail(`${nodePath} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const DETACHED_RESOLUTION_SCRIPT = [
  'const { createRequire } = require("node:module");',
  'const { dirname, resolve } = require("node:path");',
  'const resolved = createRequire(resolve(process.argv[1])).resolve("@first-tree-ai/context-tree/package.json");',
  "console.log(dirname(resolved));",
].join("\n");

/**
 * Exercises the embedded Context Tree CLI exactly as an installed user would, from a relocated app
 * with an isolated `HOME` and no `NODE_PATH`. Only safe commands run (`--version`, `--help`,
 * `list`); resolution must come from the app's own `node_modules`, never from the build checkout.
 */
export function runContextTreeRuntimeProbe({ appDir, nodePath, homeDir, probeOpenTag = false }) {
  if (!existsSync(join(appDir, DEPENDENCY_CLOSURE_FILE))) return;
  const closure = readDependencyClosureRecord(appDir);
  const pinned = closure.direct.find((pin) => pin.name === SUPPORTED_DIRECT_DEPENDENCY);
  if (!pinned) return;
  const packageDir = join(appDir, "node_modules", ...SUPPORTED_DIRECT_DEPENDENCY.split("/"));
  const cliPath = join(packageDir, CONTEXT_TREE_CLI_RELATIVE_PATH);
  if (!isRegularFile(cliPath)) fail(`Context Tree CLI is missing from the app: ${cliPath}`);
  const cleanEnv = {
    HOME: homeDir,
    PATH: `${dirname(nodePath)}:/usr/bin:/bin`,
    LANG: "C",
    TERM: "dumb",
    OPENTAG_HOME: join(homeDir, "opentag"),
    CODEX_HOME: join(homeDir, ".codex"),
    CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
  };
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  const entryPath = join(appDir, "cli", "index.mjs");
  if (!isRegularFile(entryPath)) fail(`app entry is missing; cannot probe detached resolution: ${entryPath}`);
  const resolved = runNode(nodePath, ["-e", DETACHED_RESOLUTION_SCRIPT, entryPath], cleanEnv).stdout.trim();
  if (realpathSync(resolved) !== realpathSync(packageDir)) {
    fail(
      `Context Tree resolved from ${resolved} instead of the relocated app package at ${packageDir}; ` +
        "NODE_PATH or a build checkout must not answer for the app",
    );
  }

  const reportedVersion = runNode(nodePath, [cliPath, "--version"], cleanEnv).stdout.trim();
  if (reportedVersion !== pinned.version) {
    fail(`embedded Context Tree reports version ${reportedVersion}, expected ${pinned.version}`);
  }
  const helpOutput = runNode(nodePath, [cliPath, "--help"], cleanEnv).stdout;
  if (!helpOutput.includes("Usage: context-tree")) {
    fail("embedded Context Tree help does not identify the context-tree CLI");
  }
  let listing;
  try {
    listing = JSON.parse(runNode(nodePath, [cliPath, "list"], cleanEnv).stdout.trim());
  } catch {
    fail("embedded Context Tree list did not emit its JSON payload");
  }
  if (
    !isRecord(listing) ||
    listing.schemaVersion !== 1 ||
    !Array.isArray(listing.trees) ||
    listing.trees.length !== 0
  ) {
    fail("embedded Context Tree list did not report the expected empty tree listing");
  }
  if (probeOpenTag) {
    const target = "otqa-portable-nonexistent";
    const result = runNode(nodePath, [entryPath, "context-tree", "connect", target], cleanEnv, 1);
    if (!result.stderr.includes(`No managed Context Tree named "${target}" exists`)) {
      fail(`OpenTag could not use its embedded Context Tree runtime: ${result.stdout}\n${result.stderr}`);
    }
  }
  const leftovers = readdirSync(homeDir).filter((name) => name !== "." && name !== "..");
  if (leftovers.length > 0) fail(`embedded Context Tree wrote into its isolated home: ${leftovers.join(", ")}`);
}
