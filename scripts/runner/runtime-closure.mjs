#!/usr/bin/env node

/**
 * Assembles the production `node_modules` closure the bundled Runner client needs at runtime.
 *
 * The tsdown client bundle keeps its declared dependencies external, so the image must ship the
 * exact packages the frozen pnpm install resolved. The closure is copied from that frozen install
 * only — no fetch, no install, no lifecycle scripts — reusing the portable resolver so resolution
 * matches Node semantics. Every copied entry stays inside the install root; symlinks and native
 * addons fail closed.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveInstalledDependencyPackage } from "../portable/runtime-dependencies.mjs";

function fail(message) {
  throw new Error(message);
}

const SPECIFIER_PATTERN = /(?:from|import)\s*"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g;

function packageNameOf(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("/")) {
    return undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function scanFileSpecifiers(path, names) {
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(SPECIFIER_PATTERN)) {
    const name = packageNameOf(match[1] ?? match[2]);
    if (name) names.add(name);
  }
}

/** Bare package imports across every shipped ESM file; relative and builtin specifiers are ignored. */
export function scanBarePackageImports(directory) {
  const names = new Set();
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`dist contains a symlink: ${path}`);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.name.endsWith(".mjs")) {
        scanFileSpecifiers(path, names);
      }
    }
  }
  return [...names].sort();
}

/** Walks the installed graph from the scanned roots, one canonical root per package name. */
export function collectInstalledClosure({ fromManifestPath, roots }) {
  // A same-name package resolving to a different canonical root is never silently collapsed: the
  // later resolution is nested under the referring package (pnpm/Node semantics). A nested slot
  // under a nested referrer cannot be placed correctly and fails closed. Before anything is
  // copied, the COMPLETE planned layout is verified: every dependency edge of every placement
  // must resolve in the destination Node ancestor chain to exactly what the installed graph
  // selected — iteration-time checks cannot establish that for multiple placements of one
  // physical package (the multi-parent shadowing finding).
  const byName = new Map();
  const nested = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const manifestNames = new Map();
  const referrerName = (manifestPath) => {
    let name = manifestNames.get(manifestPath);
    if (name === undefined) {
      name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
      manifestNames.set(manifestPath, name);
    }
    return name;
  };
  const enqueueDeps = (queue, resolved) => {
    for (const dependency of Object.keys(resolved.manifest.dependencies ?? {}).sort()) {
      queue.push({ from: resolved.manifestPath, name: dependency });
    }
  };
  const recordEdge = (job, resolved) => {
    const key = `${job.from}${job.name}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from: job.from, name: job.name, resolved });
  };
  // One physical package can occupy several placements (e.g. c/a and d/a); keep them all.
  const registerPlacement = (entriesByManifest, entry) => {
    const placements = entriesByManifest.get(entry.manifestPath) ?? [];
    placements.push(entry);
    entriesByManifest.set(entry.manifestPath, placements);
  };
  // Returns true when the job was already covered; otherwise records it (top-level or nested).
  const recordJob = (job, queue, entriesByManifest) => {
    const resolved = resolveInstalledDependencyPackage(job.from, job.name);
    recordEdge(job, resolved);
    const recorded = byName.get(job.name);
    if (!recorded) {
      byName.set(job.name, resolved);
      registerPlacement(entriesByManifest, resolved);
      enqueueDeps(queue, resolved);
      return;
    }
    if (recorded.root === resolved.root && recorded.manifest.version === resolved.manifest.version) return;
    const referrer = entriesByManifest.get(job.from)?.[0];
    if (referrer?.parent) {
      // A nested slot under a nested referrer would land on the wrong top-level package and the
      // real referrer would silently resolve the top-level version instead. Fail closed.
      fail(
        `dependency ${job.name} needs a nested slot under nested referrer ${referrer.name} (${referrer.parent}/${referrer.name}), which the assembler cannot place correctly`,
      );
    }
    const parent = referrer?.name ?? referrerName(job.from);
    const slot = `${parent}/${job.name}`;
    const existing = nested.get(slot);
    if (existing && (existing.root !== resolved.root || existing.manifest.version !== resolved.manifest.version)) {
      fail(
        `dependency ${job.name} resolves to conflicting canonical packages for ${parent} (${existing.root}@${existing.manifest.version} vs ${resolved.root}@${resolved.manifest.version})`,
      );
    }
    if (existing) return;
    const entry = { ...resolved, parent };
    nested.set(slot, entry);
    registerPlacement(entriesByManifest, entry);
    enqueueDeps(queue, resolved);
  };
  const queue = roots.map((name) => ({ from: fromManifestPath, name }));
  const entriesByManifest = new Map();
  while (queue.length > 0) {
    recordJob(queue.shift(), queue, entriesByManifest);
  }
  const packages = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  const nestedPackages = [...nested.values()].sort((left, right) =>
    `${left.parent}/${left.name}`.localeCompare(`${right.parent}/${right.name}`),
  );
  verifyPlannedLayout(edges, packages, nestedPackages, entriesByManifest);
  return {
    packages,
    nestedPackages,
  };
}

/** What the destination ancestor chain selects for one edge at one placement in the plan. */
function plannedSelection(placement, edgeName, topLevel, slots) {
  const slotKey = placement.parent ? `${placement.parent}/${edgeName}` : `${placement.name}/${edgeName}`;
  return slots.get(slotKey) ?? topLevel.get(edgeName);
}

function assertFaithfulEdge(edge, placement, topLevel, slots) {
  const owner = placement.parent ? `${placement.parent}/${placement.name}` : placement.name;
  const selected = plannedSelection(placement, edge.name, topLevel, slots);
  if (!selected) fail(`assembled layout cannot resolve dependency ${edge.name} required by ${owner}`);
  if (selected.root !== edge.resolved.root || selected.manifest.version !== edge.resolved.manifest.version) {
    fail(
      `dependency ${edge.name} required by ${owner} resolves to ${selected.manifest.version} in the assembled layout, but the installed graph selected ${edge.resolved.manifest.version}; the assembler cannot represent this`,
    );
  }
}

/**
 * Final pre-copy verification: for every top-level AND nested placement, each dependency edge
 * must resolve in the destination ancestor chain (a top-level package first sees its own nested
 * slots, then top-level deps; a nested placement first sees its parent's sibling slots — deeper
 * nesting is unsupported — then top-level deps) to the same canonical root/version the installed
 * graph selected. Anything else is not faithfully representable and fails before copying.
 */
function verifyPlannedLayout(edges, packages, nestedPackages, entriesByManifest) {
  const topLevel = new Map(packages.map((entry) => [entry.name, entry]));
  const slots = new Map(nestedPackages.map((entry) => [`${entry.parent}/${entry.name}`, entry]));
  for (const edge of edges) {
    const placements = entriesByManifest.get(edge.from) ?? [];
    for (const placement of placements) {
      assertFaithfulEdge(edge, placement, topLevel, slots);
    }
  }
}

function copyEntry(from, to, what) {
  const stats = lstatSync(from);
  if (stats.isSymbolicLink()) fail(`package ${what} publishes a symlink: ${from}`);
  if (stats.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) copyEntry(join(from, entry), join(to, entry), what);
    return;
  }
  if (!stats.isFile()) fail(`package ${what} publishes a non-regular entry: ${from}`);
  if (from.endsWith(".node")) fail(`package ${what} publishes a native addon: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

/** Literal publish `files` entries only; glob patterns fall back to a full package copy. */
function literalFilesAllowlist(manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return undefined;
  if (manifest.files.some((entry) => typeof entry !== "string" || /[*?[{!]/.test(entry))) return undefined;
  return manifest.files;
}

/** Publish `files` entries must stay inside the package; traversal and absolute paths fail. */
function safeFilesEntry(entry, what) {
  const normalized = entry.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    fail(`package ${what} declares an unsafe publish files entry: ${entry}`);
  }
  return normalized;
}

/** npm always ships entry points, bins, and readme/license files, with or without `files`. */
function alwaysPublishedEntries(root, manifest) {
  const entries = new Set();
  for (const field of ["main", "module"]) {
    if (typeof manifest[field] === "string") entries.add(safeFilesEntry(manifest[field], manifest.name));
  }
  const bin = manifest.bin;
  if (typeof bin === "string") entries.add(safeFilesEntry(bin, manifest.name));
  else if (bin && typeof bin === "object") {
    for (const target of Object.values(bin)) {
      if (typeof target === "string") entries.add(safeFilesEntry(target, manifest.name));
    }
  }
  for (const entry of readdirSync(root)) {
    if (/^(readme|licen[cs]e|copying|notice)(\.|$)/i.test(entry)) entries.add(entry);
  }
  return entries;
}

/**
 * Copies one installed package honouring a literal publish `files` allowlist plus the entries npm
 * always ships (entry points, bins, license/readme); glob allowlists fall back to a full package
 * copy minus its nested node_modules. The destination must not already exist.
 */
export function copyInstalledPackage({ root, manifest, destination }) {
  if (existsSync(destination)) fail(`refusing to overwrite assembled package: ${destination}`);
  const files = literalFilesAllowlist(manifest);
  // Validate everything before creating any output so a rejection leaves no partial state.
  const selected = files
    ? new Set([
        ...files.map((entry) => safeFilesEntry(entry, manifest.name)),
        ...alwaysPublishedEntries(root, manifest),
      ])
    : undefined;
  mkdirSync(destination, { recursive: true });
  copyEntry(join(root, "package.json"), join(destination, "package.json"), manifest.name);
  if (selected) {
    // Publish semantics: entries that match nothing (semver's historic "lib/") are ignored.
    for (const entry of selected) {
      if (!existsSync(join(root, entry))) continue;
      copyEntry(join(root, entry), join(destination, entry), manifest.name);
    }
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "package.json") continue;
    copyEntry(join(root, entry.name), join(destination, entry.name), manifest.name);
  }
}

/**
 * Scans the built client dist, resolves every bare import against the frozen install, and copies
 * the full closure into `nodeModulesDir`. Workspace packages such as `@opentag/shared` resolve to
 * their real source roots through the same resolver and ship `package.json` + `files` only.
 */
export function assembleClientRuntimeClosure({ clientManifestPath, clientDistDir, nodeModulesDir, skip }) {
  const roots = scanBarePackageImports(clientDistDir).filter((name) => !(skip?.has(name) ?? false));
  const { packages, nestedPackages } = collectInstalledClosure({ fromManifestPath: clientManifestPath, roots });
  const topLevel = packages.filter((entry) => !(skip?.has(entry.name) ?? false));
  for (const entry of topLevel) {
    copyInstalledPackage({
      root: entry.root,
      manifest: entry.manifest,
      destination: join(nodeModulesDir, ...entry.name.split("/")),
    });
  }
  const nested = nestedPackages.filter((entry) => !(skip?.has(entry.name) ?? false));
  for (const entry of nested) {
    copyInstalledPackage({
      root: entry.root,
      manifest: entry.manifest,
      destination: join(nodeModulesDir, ...entry.parent.split("/"), "node_modules", ...entry.name.split("/")),
    });
  }
  writeFileSync(
    join(dirname(nodeModulesDir), "runtime-closure.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scanned: roots,
        packages: topLevel.map((entry) => ({ name: entry.name, version: entry.manifest.version })),
        nestedPackages: nested.map((entry) => ({
          name: entry.name,
          parent: entry.parent,
          version: entry.manifest.version,
        })),
      },
      null,
      2,
    )}\n`,
  );
  return [...topLevel, ...nested];
}
