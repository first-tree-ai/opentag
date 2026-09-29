import { SKILL_MANIFEST_FILE } from "./skill.js";

/**
 * Skill directory discovery for remote Skill sources, as a pure function over a path listing.
 *
 * A remote source is fetched as a file listing (a Git tree, or the member list of a downloaded
 * archive) rather than as a working tree, so discovery can be expressed without touching the file
 * system: the input is every file path in the source, the output is the directories that hold a
 * `SKILL.md`. That keeps the rules exhaustively testable and lets the Server and any future CLI
 * consumer share one implementation.
 *
 * The rules mirror the open skills ecosystem (skills.sh):
 *
 * - The search root itself is a Skill when it holds a `SKILL.md`.
 * - Otherwise the known container directories are scanned in a fixed priority order.
 * - The root is scanned one level deep; container directories are scanned three levels deep, which
 *   covers flat (`skills/<name>/SKILL.md`) and one- or two-level catalog layouts.
 * - A `SKILL.md` found at a shallower level shadows anything nested below it.
 * - Directories declared by a Claude Code plugin manifest are added as containers.
 * - When the standard locations yield nothing, the whole search root is walked recursively.
 *
 * Two upstream behaviours are deliberately not reproduced here:
 *
 * - `skills-lock.json` suppression of "installed project skills" is local CLI state and has no
 *   meaning for a Server-side install.
 * - Duplicate Skill *names* are resolved by the caller after reading the manifests. This function
 *   reports directories only, in discovery order, so the caller can still report the duplicates.
 */

/**
 * Directories searched for Skill containers, in priority order.
 *
 * Copied from the ecosystem's documented discovery list. The list is data rather than a rule, and
 * `skill-discovery.test.ts` checks it against a checked-in expected list so an accidental edit is
 * caught.
 */
export const SKILL_CONTAINER_DIRECTORIES: readonly string[] = Object.freeze([
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".aider-desk/skills",
  ".agents/skills",
  "data/skills",
  ".autohand/skills",
  ".augment/skills",
  ".bob/skills",
  ".claude/skills",
  ".codeartsdoer/skills",
  ".codebuddy/skills",
  ".codemaker/skills",
  ".codestudio/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".devin/skills",
  "agent/skills",
  ".forge/skills",
  ".fx/skills",
  ".goose/skills",
  ".grok/skills",
  ".hermes/skills",
  ".inferencesh/skills",
  ".jazz/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kimchi/skills",
  ".kiro/skills",
  ".kode/skills",
  ".lingma/skills",
  ".mcpjam/skills",
  ".minimax/skills",
  ".vibe/skills",
  ".moxby/skills",
  ".mux/skills",
  ".openhands/skills",
  ".ona/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".reasonix/skills",
  ".rovodev/skills",
  ".roo/skills",
  ".tabnine/agent/skills",
  ".terramind/skills",
  ".tinycloud/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
]);

/** Container directories are scanned this many directory levels below themselves. */
export const SKILL_CONTAINER_DEPTH = 3;
/** The recursive fallback walk is bounded to this many directory levels. */
export const SKILL_DISCOVERY_FALLBACK_DEPTH = 5;

/**
 * Directory names never descended into. `node_modules` and `.git` can hold thousands of entries in
 * a snapshot, and build outputs can hold a stale copy of the repository's own Skills.
 */
const SKIPPED_DIRECTORY_NAMES: readonly string[] = Object.freeze([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
]);

/** One directory node of the path listing, built once so discovery is linear in the path count. */
interface DirectoryNode {
  readonly children: Map<string, DirectoryNode>;
  hasManifest: boolean;
}

function createNode(): DirectoryNode {
  return { children: new Map(), hasManifest: false };
}

/** Normalizes a source-relative path: forward slashes, no `./` prefix, no empty or `..` segment. */
export function normalizeSourcePath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "" || normalized.startsWith("/")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === ".." || segment === ".")) return undefined;
  return segments.join("/");
}

/**
 * Builds the directory tree of a file listing in one pass.
 *
 * The tree is what makes discovery linear: without it, "which children does this directory have"
 * would rescan the whole listing once per directory.
 */
export function buildSkillDirectoryTree(paths: readonly string[]): DirectoryNode {
  const root = createNode();
  for (const raw of paths) {
    const path = normalizeSourcePath(raw);
    if (path === undefined) continue;
    const segments = path.split("/");
    const fileName = segments.pop();
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createNode();
        node.children.set(segment, child);
      }
      node = child;
    }
    if (fileName === SKILL_MANIFEST_FILE) node.hasManifest = true;
  }
  return root;
}

function nodeAt(root: DirectoryNode, path: string): DirectoryNode | undefined {
  if (path === "") return root;
  let node = root;
  for (const segment of path.split("/")) {
    const child = node.children.get(segment);
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
}

function joinPath(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * Checks each child of `node` for a manifest, then descends while the depth allows.
 *
 * A child that holds a manifest is claimed and never descended into, which is the shadowing rule.
 * Children are visited in sorted order so the result does not depend on the order of the input
 * listing.
 */
function walkContainers(
  node: DirectoryNode,
  maxDepth: number,
  depth: number,
  prefix: string,
  collected: string[],
): void {
  for (const name of [...node.children.keys()].sort()) {
    if (SKIPPED_DIRECTORY_NAMES.includes(name)) continue;
    const child = node.children.get(name);
    if (child === undefined) continue;
    const path = joinPath(prefix, name);
    if (child.hasManifest) {
      collected.push(path);
      continue;
    }
    if (depth < maxDepth) walkContainers(child, maxDepth, depth + 1, path, collected);
  }
}

/** The recursive fallback: every directory that holds a manifest, parents before their children. */
function walkAll(node: DirectoryNode, maxDepth: number, depth: number, prefix: string, collected: string[]): void {
  for (const name of [...node.children.keys()].sort()) {
    const child = node.children.get(name);
    if (child === undefined || SKIPPED_DIRECTORY_NAMES.includes(name)) continue;
    const path = joinPath(prefix, name);
    if (child.hasManifest) collected.push(path);
    if (depth < maxDepth) walkAll(child, maxDepth, depth + 1, path, collected);
  }
}

export interface DiscoverSkillDirectoriesInput {
  /** Every file path in the source, relative to the source root. */
  paths: readonly string[];
  /** Restricts the search to this directory of the source. */
  subpath?: string;
  /** Containers declared by a plugin manifest, each scanned one level deep. */
  declaredContainers?: readonly string[];
}

export interface DiscoveredSkillDirectory {
  /** Source-relative directory that holds a `SKILL.md`. */
  path: string;
}

/**
 * The Skill directories in a source listing, in discovery order.
 *
 * The search root short-circuits everything below it: if the root (or the subpath) holds a
 * `SKILL.md`, that single Skill is the result, because the repository is then describing itself as
 * one Skill rather than as a catalog.
 */
export function discoverSkillDirectories(input: DiscoverSkillDirectoriesInput): DiscoveredSkillDirectory[] {
  const root = buildSkillDirectoryTree(input.paths);
  const base = input.subpath === undefined ? "" : (normalizeSourcePath(input.subpath) ?? "");
  const baseNode = nodeAt(root, base);
  if (baseNode === undefined) return [];
  if (baseNode.hasManifest) return [{ path: base }];

  const collected: string[] = [];
  walkContainers(baseNode, 1, 1, base, collected);
  for (const container of SKILL_CONTAINER_DIRECTORIES) {
    const containerNode = nodeAt(baseNode, container);
    if (containerNode === undefined) continue;
    walkContainers(containerNode, SKILL_CONTAINER_DEPTH, 1, joinPath(base, container), collected);
  }
  for (const declared of input.declaredContainers ?? []) {
    const declaredPath = normalizeSourcePath(declared);
    if (declaredPath === undefined) continue;
    const declaredNode = nodeAt(baseNode, declaredPath);
    if (declaredNode === undefined) continue;
    walkContainers(declaredNode, 1, 1, joinPath(base, declaredPath), collected);
  }
  if (collected.length === 0) {
    walkAll(baseNode, SKILL_DISCOVERY_FALLBACK_DEPTH, 1, base, collected);
  }
  const unique = [...new Set(collected)];
  return unique.map((path) => ({ path }));
}

/** The directory's last segment, the display name for a Skill whose manifest is unusable. */
export function skillNameFromDirectory(directoryPath: string): string {
  const segments = directoryPath.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? directoryPath;
}

type ManifestObject = Record<string, unknown>;

function manifestObject(value: unknown): ManifestObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ManifestObject;
}

function parseJsonObject(text: string | undefined): ManifestObject | undefined {
  if (text === undefined) return undefined;
  try {
    return manifestObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * A path from a manifest: the path without a `./` prefix, `undefined` when the field is absent, and
 * `null` when it is present but unusable — an object (a remote plugin source), an absolute path, or
 * anything containing `..`. The two failure modes differ: an absent optional field is fine, an
 * unusable one drops the entry that carries it.
 */
function optionalRelativePath(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const relative = value.replace(/^\.\//, "");
  if (relative === "" || relative.startsWith("/") || relative.includes("..")) return null;
  return relative;
}

/**
 * The containers to scan for one plugin: the parent of every `./`-relative declared Skill (so the
 * one-level walk over it finds the Skill itself), plus the plugin's conventional `skills` directory.
 */
function pluginSkillContainers(entry: ManifestObject, pluginBase: string): string[] {
  const containers: string[] = [];
  const skills = Array.isArray(entry.skills) ? entry.skills : [];
  for (const skillPath of skills) {
    const relative = optionalRelativePath(skillPath);
    if (relative === undefined || relative === null) continue;
    const normalized = normalizeSourcePath(joinPath(pluginBase, relative));
    if (normalized === undefined) continue;
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent !== "") containers.push(parent);
  }
  containers.push(joinPath(pluginBase, "skills"));
  return containers;
}

/** Every plugin in a `.claude-plugin/marketplace.json` catalog, resolved against its plugin root. */
function marketplaceContainers(text: string | undefined): string[] {
  const marketplace = parseJsonObject(text);
  if (marketplace === undefined) return [];
  const root = optionalRelativePath(manifestObject(marketplace.metadata)?.pluginRoot);
  // A malformed plugin root is not a root: the ecosystem skips the whole catalog rather than
  // resolving its plugins against the repository root.
  if (root === null) return [];
  const containers: string[] = [];
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  for (const value of plugins) {
    const plugin = manifestObject(value);
    if (plugin === undefined) continue;
    const source = optionalRelativePath(plugin.source);
    if (source === null) continue;
    const pluginBase = [root, source].filter((segment) => segment !== undefined && segment !== "").join("/");
    containers.push(...pluginSkillContainers(plugin, pluginBase));
  }
  return containers;
}

/** The single plugin a `.claude-plugin/plugin.json` describes, resolved against the source root. */
function rootPluginContainers(text: string | undefined): string[] {
  const plugin = parseJsonObject(text);
  return plugin === undefined ? [] : pluginSkillContainers(plugin, "");
}

/**
 * Containers declared by a Claude Code plugin manifest, derived from the raw manifest documents.
 *
 * Both documents are read from the source root: `.claude-plugin/marketplace.json` (a catalog of
 * plugins, each with an optional `source` and `skills`) and `.claude-plugin/plugin.json` (a single
 * plugin). A declared path names a Skill directory, so its parent becomes the container to scan, and
 * each plugin's conventional `skills` directory is always added. Remote plugin sources, paths that
 * are not `./`-relative, and a malformed plugin root are ignored exactly as the ecosystem ignores
 * them, and no returned path can escape the source root.
 */
export function declaredSkillContainers(input: { marketplace?: string; plugin?: string }): string[] {
  const containers = [...marketplaceContainers(input.marketplace), ...rootPluginContainers(input.plugin)];
  const normalized = containers
    .map((container) => normalizeSourcePath(container))
    .filter((container): container is string => container !== undefined);
  return [...new Set(normalized)];
}
