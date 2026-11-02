import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, inflateSync } from "node:zlib";
import { type Pack, type Headers as TarHeaders, extract as tarExtract, pack as tarPack } from "tar-stream";

/**
 * Streams the complete workspace, including Git and Pi state. Callers must stop every writer
 * before creation or restoration. Trusted journal/credentials must remain outside this tree.
 *
 * Untrusted members and the complete symlink graph are checked before installing a restore;
 * hard links, special files, escaping paths, and nonempty destinations fail closed. Ownership
 * is never restored and special permission bits are stripped. Limits bound archive processing,
 * but tmpfs files and the workload still share memory, so they do not guarantee against OOM.
 */

export interface WorkspaceArchiveInfo {
  /** Exact compressed archive length in bytes. */
  readonly bytes: number;
  /** Lowercase hex SHA-256 over the compressed archive bytes. */
  readonly sha256: string;
  /** Base64 MD5 over the compressed archive bytes (GCS data integrity). */
  readonly md5: string;
}

export const WORKSPACE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const WORKSPACE_MAX_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_MAX_ENTRIES = 50_000;

/**
 * Injectable ceilings for tests. Production callers use the module constants; every limit
 * must be a positive integer. The decompressed-stream ceiling is derived, not injectable.
 */
export interface WorkspaceArchiveLimits {
  readonly maxArchiveBytes?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}

export type WorkspaceArchiveErrorCode =
  | "invalid-workspace"
  | "invalid-destination"
  | "invalid-limits"
  | "invalid-expected"
  | "invalid-archive"
  | "unsafe-archive-path"
  | "unsafe-entry"
  | "unsupported-entry"
  | "unsafe-member"
  | "unsupported-member"
  | "duplicate-member"
  | "destination-not-empty"
  | "too-many-entries"
  | "workspace-too-large"
  | "archive-too-large"
  | "decompression-limit"
  | "workspace-changed"
  | "size-mismatch"
  | "hash-mismatch"
  | "io-failed";

export class WorkspaceArchiveError extends Error {
  readonly code: WorkspaceArchiveErrorCode;

  constructor(code: WorkspaceArchiveErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceArchiveError";
    this.code = code;
  }
}

interface ResolvedLimits {
  readonly maxArchiveBytes: number;
  readonly maxBytes: number;
  readonly maxEntries: number;
  /** Backstop over the raw tar stream: payload plus bounded per-entry tar framing. */
  readonly maxDecompressedBytes: number;
}

const TAR_ENTRY_OVERHEAD_BYTES = 4096;
const TAR_STREAM_SLACK_BYTES = 64 * 1024;
const MEMBER_NAME_MAX_BYTES = 1024;
const MESSAGE_DETAIL_MAX_CHARS = 160;
/** Same ceiling as Linux MAXSYMLINKS; a cycle or longer chain fails closed. */
const MAX_LINK_HOPS = 40;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MD5_BASE64 = /^[A-Za-z0-9+/]{22}==$/;

function bounded(detail: string): string {
  return detail.length <= MESSAGE_DETAIL_MAX_CHARS ? detail : `${detail.slice(0, MESSAGE_DETAIL_MAX_CHARS)}...`;
}

function fail(code: WorkspaceArchiveErrorCode, message: string): never {
  throw new WorkspaceArchiveError(code, message);
}

function toArchiveError(error: unknown, code: WorkspaceArchiveErrorCode, context: string): WorkspaceArchiveError {
  if (error instanceof WorkspaceArchiveError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new WorkspaceArchiveError(code, `${context}: ${bounded(detail)}`);
}

function resolveLimits(limits: WorkspaceArchiveLimits | undefined): ResolvedLimits {
  const maxArchiveBytes = limits?.maxArchiveBytes ?? WORKSPACE_ARCHIVE_MAX_BYTES;
  const maxBytes = limits?.maxBytes ?? WORKSPACE_MAX_BYTES;
  const maxEntries = limits?.maxEntries ?? WORKSPACE_MAX_ENTRIES;
  for (const [label, value] of [
    ["maxArchiveBytes", maxArchiveBytes],
    ["maxBytes", maxBytes],
    ["maxEntries", maxEntries],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      fail("invalid-limits", `${label} must be a positive integer`);
    }
  }
  return {
    maxArchiveBytes,
    maxBytes,
    maxEntries,
    maxDecompressedBytes: maxBytes + maxEntries * TAR_ENTRY_OVERHEAD_BYTES + TAR_STREAM_SLACK_BYTES,
  };
}

/**
 * Canonical absolute path: resolves the deepest existing ancestor (handling symlinked
 * ancestors such as /var on macOS) and re-appends the not-yet-existing tail lexically.
 */
async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw toArchiveError(error, "io-failed", "Cannot canonicalize an archive path component");
      }
      const parent = dirname(current);
      if (parent === current) {
        throw toArchiveError(error, "io-failed", "Cannot canonicalize an archive path component");
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** The archive must not be the workspace itself or live beneath it (canonical comparison). */
async function assertArchiveOutsideWorkspace(workspacePath: string, archivePath: string): Promise<void> {
  const [workspaceCanonical, archiveCanonical] = await Promise.all([
    canonicalPath(workspacePath),
    canonicalPath(archivePath),
  ]);
  const suffix = relative(workspaceCanonical, archiveCanonical);
  const outside = suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix);
  if (!outside) {
    fail("unsafe-archive-path", "Archive path must be outside the workspace");
  }
}

async function assertRealWorkspaceRoot(workspacePath: string): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(workspacePath);
  } catch (error) {
    throw toArchiveError(error, "invalid-workspace", "Workspace root is not accessible");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("invalid-workspace", "Workspace root must be a real directory, not a symlink");
  }
}

/**
 * Normalizes an archive member name to a root-relative POSIX path, rejecting anything that is
 * absolute, ambiguous, or escapes the root. Returns "" for the root pseudo-entry ("./", ".").
 */
function normalizeMemberName(rawName: string | undefined): string {
  if (typeof rawName !== "string" || rawName.length === 0 || Buffer.byteLength(rawName) > MEMBER_NAME_MAX_BYTES) {
    fail("unsafe-member", "Archive member name is missing or oversized");
  }
  if (rawName.includes("\0")) {
    fail("unsafe-member", "Archive member name contains a NUL byte");
  }
  if (rawName.startsWith("/") || /^[A-Za-z]:[\\/]?/.test(rawName) || rawName.includes("\\")) {
    fail("unsafe-member", `Archive member name is absolute or ambiguous: ${bounded(rawName)}`);
  }
  const segments: string[] = [];
  for (const segment of rawName.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      fail("unsafe-member", `Archive member escapes the workspace root: ${bounded(rawName)}`);
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Form check for a symlink target: relative, non-empty, and unambiguous. Containment is NOT
 * decided here — only full-graph resolution (assertLinksContained) can decide that.
 */
function assertLinkTargetForm(target: string, code: "unsafe-entry" | "unsafe-member", memberName: string): void {
  if (target.length === 0 || Buffer.byteLength(target) > MEMBER_NAME_MAX_BYTES || target.includes("\0")) {
    fail(code, `Link target is missing or oversized at ${bounded(memberName)}`);
  }
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]?/.test(target) || target.includes("\\")) {
    fail(code, `Link target is absolute or ambiguous at ${bounded(memberName)}`);
  }
}

/** Strips setuid/setgid/sticky and any non-permission bits; never trusts high mode bits. */
function sanitizeMode(mode: number | undefined, fallback: number): number {
  if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0) return fallback;
  return mode & 0o777;
}

async function drain(stream: Readable): Promise<void> {
  for await (const chunk of stream) {
    void chunk;
  }
}

type NamespaceKind = "file" | "directory" | "symlink";

interface NamespaceEntry {
  readonly kind: NamespaceKind;
  /** Raw link target; only for symlink entries. */
  readonly target?: string;
}

/**
 * Resolves one symlink target with kernel path-component semantics against the recorded
 * namespace: the directory stack only ever holds REAL directories, a symlink component
 * substitutes its target in place (bounded hops catch cycles), and `..` past the root is an
 * escape. A component that is a file or missing makes traversal fail (ENOTDIR/ENOENT) — such
 * a link is broken and cannot escape, so only its final component may be non-directory.
 * Targets are never resolved to file contents; this is namespace metadata only.
 */
function assertTargetContained(
  namespace: ReadonlyMap<string, NamespaceEntry>,
  startDir: readonly string[],
  target: string,
  code: "unsafe-entry" | "unsafe-member",
  linkName: string,
): void {
  const dirStack = [...startDir];
  let components = target.split("/");
  let hops = 0;
  let index = 0;
  while (index < components.length) {
    const component = components[index];
    index += 1;
    if (!component || component === ".") continue;
    if (component === "..") {
      if (dirStack.length === 0) {
        fail(code, `Link target escapes the workspace root at ${bounded(linkName)}`);
      }
      dirStack.pop();
      continue;
    }
    const candidate = [...dirStack, component].join("/");
    const found = namespace.get(candidate);
    if (found?.kind === "symlink") {
      hops += 1;
      // Kernel semantics: the substituted target resolves from the link's own directory.
      components = [...boundedLinkComponents(found.target ?? "", hops, code, linkName), ...components.slice(index)];
      index = 0;
      continue;
    }
    if (found?.kind === "directory") {
      dirStack.push(component);
      continue;
    }
    // File or missing entry: traversal through a non-directory fails (ENOTDIR/ENOENT), so
    // the link is broken and inert — it cannot escape; only its final component is usable.
    return;
  }
}

function boundedLinkComponents(
  target: string,
  hops: number,
  code: "unsafe-entry" | "unsafe-member",
  name: string,
): string[] {
  if (hops > MAX_LINK_HOPS) fail(code, `Link chain exceeds the ${MAX_LINK_HOPS} hop ceiling at ${bounded(name)}`);
  return target.split("/");
}

/** Validates every recorded symlink against the complete entry graph. */
function assertLinksContained(
  namespace: ReadonlyMap<string, NamespaceEntry>,
  code: "unsafe-entry" | "unsafe-member",
): void {
  for (const [name, entry] of namespace) {
    if (entry.kind !== "symlink") continue;
    assertTargetContained(namespace, name.split("/").slice(0, -1), entry.target ?? "", code, name);
  }
}

/** Counts and hashes every compressed byte flowing through; fails closed on overflow. */
function attachCompressedMeter(
  stream: PassThrough,
  limit: number,
  hashes: { readonly sha256: ReturnType<typeof createHash>; readonly md5: ReturnType<typeof createHash> },
): { readonly readCount: () => number } {
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    hashes.sha256.update(chunk);
    hashes.md5.update(chunk);
    if (bytes > limit) {
      stream.destroy(
        new WorkspaceArchiveError("archive-too-large", `Compressed archive exceeds the ${limit} byte ceiling`),
      );
    }
  });
  return { readCount: () => bytes };
}

interface WalkRecord {
  readonly rel: string;
  readonly kind: NamespaceKind;
  /** File payload size; 0 for directories and symlinks. */
  readonly size: number;
  readonly mode: number;
  readonly mtime: Date;
  /** Raw link target; only for symlink records. */
  readonly target?: string;
}

interface WorkspaceScan {
  /** Deterministic breadth-first order; parents always precede their children. */
  readonly records: readonly WalkRecord[];
  readonly namespace: ReadonlyMap<string, NamespaceEntry>;
}

/**
 * Pass 1: metadata-only walk (lstat everywhere, symlink targets read but never followed).
 * Enforces entry/payload ceilings, rejects non-portable names, non-regular entries, and every
 * hard-linked regular file — an external hard link's bytes may be a parent secret.
 */
interface ScanState {
  bytes: number;
}

/** Scans one entry; returns its record plus the child directory to enqueue, if any. */
async function scanWorkspaceEntry(
  workspacePath: string,
  dirRel: string,
  name: string,
  limits: ResolvedLimits,
  state: ScanState,
): Promise<{ readonly record: WalkRecord; readonly childDir?: string }> {
  const rel = dirRel === "" ? name : `${dirRel}/${name}`;
  // Member names obey the same rules enforced on restore, so a workspace that archives
  // successfully always restores successfully (NUL is impossible from readdir).
  if (name.includes("\\") || /^[A-Za-z]:/.test(rel) || Buffer.byteLength(rel) > MEMBER_NAME_MAX_BYTES) {
    fail("unsafe-entry", `Workspace entry name is not portable: ${bounded(rel)}`);
  }
  let stats: Stats;
  try {
    stats = await lstat(join(dirRel === "" ? workspacePath : join(workspacePath, ...dirRel.split("/")), name));
  } catch (error) {
    throw toArchiveError(error, "io-failed", `Cannot stat workspace entry ${bounded(rel)}`);
  }
  const mode = sanitizeMode(stats.mode, stats.isDirectory() ? 0o755 : 0o644);
  if (stats.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlink(join(workspacePath, ...rel.split("/")));
    } catch (error) {
      throw toArchiveError(error, "io-failed", `Cannot read workspace link ${bounded(rel)}`);
    }
    assertLinkTargetForm(target, "unsafe-entry", rel);
    return { record: { rel, kind: "symlink", size: 0, mode: 0o777, mtime: stats.mtime, target } };
  }
  if (stats.isDirectory()) {
    return { record: { rel, kind: "directory", size: 0, mode, mtime: stats.mtime }, childDir: rel };
  }
  if (stats.isFile()) {
    if (stats.nlink > 1) {
      fail("unsafe-entry", `Workspace entry has other hard links and is never archived: ${bounded(rel)}`);
    }
    state.bytes += stats.size;
    if (state.bytes > limits.maxBytes) {
      fail("workspace-too-large", `Workspace exceeds the ${limits.maxBytes} byte ceiling`);
    }
    return { record: { rel, kind: "file", size: stats.size, mode, mtime: stats.mtime } };
  }
  fail("unsupported-entry", `Workspace entry is not a file, directory, or symlink: ${bounded(rel)}`);
}

const CONTEXT_TREE_STATE_REL = ".opentag/context-tree/home/.context-tree";
const CONTEXT_TREE_CLEANUP_REL = `${CONTEXT_TREE_STATE_REL}/cleanup`;
const CONTEXT_TREE_CACHE_RELS = new Set([
  `${CONTEXT_TREE_STATE_REL}/repositories`,
  `${CONTEXT_TREE_STATE_REL}/snapshots`,
  CONTEXT_TREE_CLEANUP_REL,
]);
const GIT_FILE_MAX_BYTES = 4096;
const GIT_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const GIT_OBJECT_MAX_BYTES = 32 * 1024 * 1024;
const GIT_PACK_MAX_BYTES = 256 * 1024 * 1024;
const GIT_MAX_REF_HOPS = 8;
const GIT_MAX_DELTA_DEPTH = 64;
const GIT_MAX_ANCESTOR_COMMITS = 4096;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const REFLOG_MUTATION_PREFIX = /^(commit|merge|rebase|cherry-pick|reset|am)\b/i;

interface SnapshotFileExpectation {
  readonly size: number;
  readonly sha1: string;
  readonly executable: boolean;
}

interface GitObjectRecord {
  readonly type: string;
  readonly payload: Buffer;
}

interface LoadedPack {
  readonly idxBuf: Buffer;
  readonly packPath: string;
  packBuf?: Buffer;
}

interface GitObjectStore {
  readonly commonDir: string;
  packs?: LoadedPack[];
}

async function hasDirectoryEntries(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return true;
    return (await readdir(path)).length > 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxBytes) return undefined;
    const content = await readFile(path);
    return content.length <= maxBytes ? content : undefined;
  } catch {
    return undefined;
  }
}

async function resolveContainedDirectory(rootCanonical: string, targetPath: string): Promise<string | undefined> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
    const canonical = await canonicalPath(targetPath);
    const rel = relative(rootCanonical, canonical);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

async function resolveSnapshotGitDirs(
  contextTreeRoot: string,
  snapshotDir: string,
): Promise<{ readonly gitDir: string; readonly commonDir: string } | undefined> {
  const dotGit = await readBoundedRegularFile(join(snapshotDir, ".git"), GIT_FILE_MAX_BYTES);
  const rawGitDir = dotGit?.toString("utf8").trim();
  if (!rawGitDir?.startsWith("gitdir:")) return undefined;
  const reposCanonical = await canonicalPath(join(contextTreeRoot, "repositories"));
  const gitDir = await resolveContainedDirectory(
    reposCanonical,
    resolve(snapshotDir, rawGitDir.slice("gitdir:".length).trim()),
  );
  if (!gitDir) return undefined;
  const commonRaw = (await readBoundedRegularFile(join(gitDir, "commondir"), GIT_FILE_MAX_BYTES))
    ?.toString("utf8")
    .trim();
  const commonDir = commonRaw ? await resolveContainedDirectory(reposCanonical, resolve(gitDir, commonRaw)) : gitDir;
  return commonDir ? { gitDir, commonDir } : undefined;
}

async function parsePackedRefs(commonDir: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const raw = await readBoundedRegularFile(join(commonDir, "packed-refs"), GIT_INDEX_MAX_BYTES);
  if (!raw) return refs;
  for (const line of raw.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    const match = /^([0-9a-f]{40})\s+(refs\/\S+)$/.exec(trimmed);
    if (match?.[1] && match[2]) refs.set(match[2], match[1]);
  }
  return refs;
}

async function readRefTarget(
  baseDir: string,
  commonDir: string,
  refName: string,
  packed: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  if (refName.includes("..") || refName.startsWith("/") || refName.includes("\\")) return undefined;
  for (const root of [baseDir, commonDir]) {
    const buf = await readBoundedRegularFile(join(root, ...refName.split("/")), GIT_FILE_MAX_BYTES);
    if (buf) return buf.toString("utf8").trim();
  }
  return packed.get(refName);
}

async function resolveGitRef(
  baseDir: string,
  commonDir: string,
  rawValue: string | undefined,
  packed: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  let current = rawValue?.trim();
  for (let hop = 0; hop <= GIT_MAX_REF_HOPS && current; hop += 1) {
    if (SHA1_HEX.test(current)) return current;
    if (!current.startsWith("ref:")) return undefined;
    current = await readRefTarget(baseDir, commonDir, current.slice("ref:".length).trim(), packed);
  }
  return undefined;
}

async function visitLooseRefEntry(fullPath: string): Promise<string | { readonly dir: string } | undefined> {
  const stats = await lstat(fullPath).catch(() => undefined);
  if (!stats || stats.isSymbolicLink()) return undefined;
  if (stats.isDirectory()) return { dir: fullPath };
  if (!stats.isFile() || stats.size > GIT_FILE_MAX_BYTES) return undefined;
  const buf = await readBoundedRegularFile(fullPath, GIT_FILE_MAX_BYTES);
  return buf?.toString("utf8").trim();
}

async function collectLooseRefValues(refsRoot: string): Promise<string[]> {
  const values: string[] = [];
  const pending: string[] = [refsRoot];
  while (pending.length > 0) {
    const dir = pending.pop() ?? "";
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const visited = await visitLooseRefEntry(join(dir, name));
      if (typeof visited === "string") values.push(visited);
      else if (visited) pending.push(visited.dir);
    }
  }
  return values;
}

async function hasCleanSnapshotReflog(gitDir: string): Promise<boolean> {
  const logPath = join(gitDir, "logs", "HEAD");
  try {
    const stats = await lstat(logPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > GIT_INDEX_MAX_BYTES) return false;
    const raw = await readFile(logPath, "utf8");
    for (const line of raw.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab >= 0 && REFLOG_MUTATION_PREFIX.test(line.slice(tab + 1).trim())) return false;
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function matchesOptionalSnapshotIdentity(
  snapshotDir: string,
  origHeadRaw: string | undefined,
  headSha: string,
): boolean {
  if (origHeadRaw !== undefined && origHeadRaw !== headSha) return false;
  const suffix = /-([0-9a-f]{40})$/.exec(basename(snapshotDir));
  return !suffix?.[1] || suffix[1] === headSha;
}

function parseCommitParents(payload: Buffer): string[] {
  const text = payload.toString("utf8");
  const headerEnd = text.indexOf("\n\n");
  const headerBlock = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const parents: string[] = [];
  for (const line of headerBlock.split("\n")) {
    const match = /^parent ([0-9a-f]{40})$/.exec(line);
    if (match?.[1]) parents.push(match[1]);
  }
  return parents;
}

async function isReachableFromPublishedTips(
  store: GitObjectStore,
  targetSha: string,
  publishedTips: ReadonlySet<string>,
): Promise<boolean> {
  if (publishedTips.has(targetSha)) return true;
  const visited = new Set<string>(publishedTips);
  const queue = [...publishedTips];
  let cursor = 0;
  while (cursor < queue.length && visited.size <= GIT_MAX_ANCESTOR_COMMITS) {
    const current = queue[cursor++];
    const commitObj = current ? await readGitObject(store, current) : undefined;
    if (commitObj?.type !== "commit") continue;
    for (const parentSha of parseCommitParents(commitObj.payload)) {
      if (parentSha === targetSha) return true;
      if (!visited.has(parentSha)) {
        visited.add(parentSha);
        queue.push(parentSha);
      }
    }
  }
  return false;
}

async function collectUpstreamPublishedTips(
  commonDir: string,
  packed: ReadonlyMap<string, string>,
  bareHeadRef: string,
): Promise<Set<string> | undefined> {
  const remoteTips = new Set<string>();
  for (const [refName, sha] of packed) {
    if (refName.startsWith("refs/remotes/")) remoteTips.add(sha);
  }
  for (const rawRef of await collectLooseRefValues(join(commonDir, "refs", "remotes"))) {
    const resolved = await resolveGitRef(commonDir, commonDir, rawRef, packed);
    if (resolved) remoteTips.add(resolved);
  }
  if (remoteTips.size > 0) return remoteTips;
  for (const refName of packed.keys()) {
    if (refName.startsWith("refs/heads/") && refName !== bareHeadRef) return undefined;
  }
  const fallback = packed.get(bareHeadRef);
  return fallback ? new Set<string>([fallback]) : undefined;
}

async function resolvePublishedSnapshotHead(
  snapshotDir: string,
  gitDir: string,
  commonDir: string,
  store: GitObjectStore,
): Promise<string | undefined> {
  if (!(await hasCleanSnapshotReflog(gitDir))) return undefined;
  if (commonDir !== gitDir && !(await hasCleanSnapshotReflog(commonDir))) return undefined;
  if ((await collectLooseRefValues(join(commonDir, "refs", "heads"))).length > 0) return undefined;
  const commonHeadRaw = (await readBoundedRegularFile(join(commonDir, "HEAD"), GIT_FILE_MAX_BYTES))
    ?.toString("utf8")
    .trim();
  if (!commonHeadRaw?.startsWith("ref:")) return undefined;
  const bareHeadRef = commonHeadRaw.slice("ref:".length).trim();
  if (!bareHeadRef.startsWith("refs/heads/")) return undefined;
  const headSha = (await readBoundedRegularFile(join(gitDir, "HEAD"), GIT_FILE_MAX_BYTES))?.toString("utf8").trim();
  if (!headSha || !SHA1_HEX.test(headSha)) return undefined;
  const origHeadRaw = (await readBoundedRegularFile(join(gitDir, "ORIG_HEAD"), GIT_FILE_MAX_BYTES))
    ?.toString("utf8")
    .trim();
  if (!matchesOptionalSnapshotIdentity(snapshotDir, origHeadRaw, headSha)) return undefined;
  const packed = await parsePackedRefs(commonDir);
  const published = await collectUpstreamPublishedTips(commonDir, packed, bareHeadRef);
  if (!published || !(await isReachableFromPublishedTips(store, headSha, published))) return undefined;
  return headSha;
}

async function readLooseGitObject(commonDir: string, sha: string): Promise<GitObjectRecord | undefined> {
  const compressed = await readBoundedRegularFile(
    join(commonDir, "objects", sha.slice(0, 2), sha.slice(2)),
    GIT_OBJECT_MAX_BYTES,
  );
  if (!compressed) return undefined;
  const raw = inflateSync(compressed, { maxOutputLength: GIT_OBJECT_MAX_BYTES });
  if (createHash("sha1").update(raw).digest("hex") !== sha) return undefined;
  const nul = raw.indexOf(0);
  if (nul <= 0) return undefined;
  const [type, sizeStr] = raw.subarray(0, nul).toString("ascii").split(" ");
  const payload = raw.subarray(nul + 1);
  if (!type || Number(sizeStr) !== payload.length) return undefined;
  return { type, payload };
}

function resolvePackIndexEntryOffset(
  idxBuf: Buffer,
  offsetTableOffset: number,
  count: number,
  index: number,
): number | undefined {
  const rawOffset = idxBuf.readUInt32BE(offsetTableOffset + index * 4);
  if ((rawOffset & 0x80000000) === 0) return rawOffset;
  const largeOffsetPos = offsetTableOffset + count * 4 + (rawOffset & 0x7fffffff) * 8;
  return largeOffsetPos + 8 <= idxBuf.length ? Number(idxBuf.readBigUInt64BE(largeOffsetPos)) : undefined;
}

function findPackIndexOffset(idxBuf: Buffer, shaHex: string): number | undefined {
  if (idxBuf.length < 1032 + 40 || idxBuf.readUInt32BE(0) !== 0xff744f63 || idxBuf.readUInt32BE(4) !== 2) {
    return undefined;
  }
  const count = idxBuf.readUInt32BE(8 + 255 * 4);
  const firstByte = Number.parseInt(shaHex.slice(0, 2), 16);
  let lo = firstByte === 0 ? 0 : idxBuf.readUInt32BE(8 + (firstByte - 1) * 4);
  let hi = idxBuf.readUInt32BE(8 + firstByte * 4);
  const target = Buffer.from(shaHex, "hex");
  const shaTableOffset = 1032;
  const offsetTableOffset = shaTableOffset + count * 24;
  if (offsetTableOffset + count * 4 > idxBuf.length) return undefined;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = target.compare(idxBuf, shaTableOffset + mid * 20, shaTableOffset + (mid + 1) * 20);
    if (cmp === 0) return resolvePackIndexEntryOffset(idxBuf, offsetTableOffset, count, mid);
    if (cmp < 0) hi = mid;
    else lo = mid + 1;
  }
  return undefined;
}

function readPackHeader(
  packBuf: Buffer,
  offset: number,
): { readonly typeCode: number; readonly size: number; readonly pos: number } | undefined {
  if (offset < 12 || offset >= packBuf.length) return undefined;
  let pos = offset;
  let byte = packBuf[pos++] ?? 0;
  const typeCode = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    if (pos >= packBuf.length) return undefined;
    byte = packBuf[pos++] ?? 0;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return size <= GIT_OBJECT_MAX_BYTES ? { typeCode, size, pos } : undefined;
}

function readDeltaVarint(buf: Buffer, start: number): { readonly value: number; readonly pos: number } | undefined {
  let pos = start;
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) return undefined;
    const byte = buf[pos++] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, pos };
    shift += 7;
  }
}

function readCopyInstruction(
  cmd: number,
  base: Buffer,
  delta: Buffer,
  start: number,
): { readonly slice: Buffer; readonly pos: number } | undefined {
  let pos = start;
  let cpOff = 0;
  let cpSize = 0;
  for (let bit = 0; bit < 4; bit += 1) {
    if ((cmd & (1 << bit)) !== 0) cpOff |= (delta[pos++] ?? 0) << (bit * 8);
  }
  for (let bit = 0; bit < 3; bit += 1) {
    if ((cmd & (0x10 << bit)) !== 0) cpSize |= (delta[pos++] ?? 0) << (bit * 8);
  }
  const unsignedOff = cpOff >>> 0;
  const finalSize = cpSize === 0 ? 0x10000 : cpSize;
  if (pos > delta.length || unsignedOff + finalSize > base.length) return undefined;
  return { slice: base.subarray(unsignedOff, unsignedOff + finalSize), pos };
}

function stepGitDeltaInstruction(
  cmd: number,
  base: Buffer,
  delta: Buffer,
  pos: number,
): { readonly slice: Buffer; readonly pos: number } | undefined {
  if ((cmd & 0x80) !== 0) return readCopyInstruction(cmd, base, delta, pos);
  if (cmd > 0 && pos + cmd <= delta.length) return { slice: delta.subarray(pos, pos + cmd), pos: pos + cmd };
  return undefined;
}

function applyGitDelta(base: Buffer, delta: Buffer): Buffer | undefined {
  const srcHeader = readDeltaVarint(delta, 0);
  if (!srcHeader || srcHeader.value !== base.length) return undefined;
  const dstHeader = readDeltaVarint(delta, srcHeader.pos);
  if (!dstHeader || dstHeader.value > GIT_OBJECT_MAX_BYTES) return undefined;
  const out = Buffer.allocUnsafe(dstHeader.value);
  let outPos = 0;
  let pos = dstHeader.pos;
  while (pos < delta.length) {
    const step = stepGitDeltaInstruction(delta[pos++] ?? 0, base, delta, pos);
    if (!step || outPos + step.slice.length > out.length) return undefined;
    step.slice.copy(out, outPos);
    outPos += step.slice.length;
    pos = step.pos;
  }
  return outPos === out.length ? out : undefined;
}

const PACK_OBJECT_TYPES: Readonly<Record<number, string>> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

function readOfsDeltaOffset(
  packBuf: Buffer,
  start: number,
  entryOffset: number,
): { readonly baseOffset: number; readonly pos: number } | undefined {
  let pos = start;
  let byte = packBuf[pos++] ?? 0;
  let relOffset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (pos >= packBuf.length) return undefined;
    byte = packBuf[pos++] ?? 0;
    relOffset = (relOffset + 1) * 128 + (byte & 0x7f);
  }
  return relOffset > 0 && relOffset < entryOffset ? { baseOffset: entryOffset - relOffset, pos } : undefined;
}

function combineDeltaObject(
  base: GitObjectRecord | undefined,
  compressedDelta: Buffer,
  expectedDeltaSize: number,
): GitObjectRecord | undefined {
  if (!base) return undefined;
  const delta = inflateSync(compressedDelta, { maxOutputLength: Math.max(expectedDeltaSize, 1) });
  if (delta.length !== expectedDeltaSize) return undefined;
  const applied = applyGitDelta(base.payload, delta);
  return applied ? { type: base.type, payload: applied } : undefined;
}

async function decodePackEntry(
  store: GitObjectStore,
  packBuf: Buffer,
  offset: number,
  depth: number,
): Promise<GitObjectRecord | undefined> {
  if (depth > GIT_MAX_DELTA_DEPTH) return undefined;
  const header = readPackHeader(packBuf, offset);
  if (!header) return undefined;
  const directType = PACK_OBJECT_TYPES[header.typeCode];
  if (directType) {
    const payload = inflateSync(packBuf.subarray(header.pos), { maxOutputLength: Math.max(header.size, 1) });
    return payload.length === header.size ? { type: directType, payload } : undefined;
  }
  if (header.typeCode === 6) {
    const ofs = readOfsDeltaOffset(packBuf, header.pos, offset);
    if (!ofs) return undefined;
    const base = await decodePackEntry(store, packBuf, ofs.baseOffset, depth + 1);
    return combineDeltaObject(base, packBuf.subarray(ofs.pos), header.size);
  }
  if (header.typeCode === 7 && header.pos + 20 <= packBuf.length) {
    const baseSha = packBuf.subarray(header.pos, header.pos + 20).toString("hex");
    const base = await readGitObject(store, baseSha, depth + 1);
    return combineDeltaObject(base, packBuf.subarray(header.pos + 20), header.size);
  }
  return undefined;
}

async function loadRepositoryPacks(store: GitObjectStore): Promise<readonly LoadedPack[]> {
  if (store.packs) return store.packs;
  const packDir = join(store.commonDir, "objects", "pack");
  const names = await readdir(packDir).catch(() => [] as string[]);
  const loaded: LoadedPack[] = [];
  for (const name of names) {
    if (!name.endsWith(".idx")) continue;
    const idxBuf = await readBoundedRegularFile(join(packDir, name), GIT_INDEX_MAX_BYTES);
    if (idxBuf) loaded.push({ idxBuf, packPath: join(packDir, `${name.slice(0, -4)}.pack`) });
  }
  store.packs = loaded;
  return loaded;
}

async function readPackedGitObject(
  store: GitObjectStore,
  sha: string,
  depth: number,
): Promise<GitObjectRecord | undefined> {
  for (const pack of await loadRepositoryPacks(store)) {
    const offset = findPackIndexOffset(pack.idxBuf, sha);
    if (offset === undefined) continue;
    pack.packBuf ??= await readBoundedRegularFile(pack.packPath, GIT_PACK_MAX_BYTES);
    if (!pack.packBuf) return undefined;
    return await decodePackEntry(store, pack.packBuf, offset, depth);
  }
  return undefined;
}

async function readGitObject(store: GitObjectStore, sha: string, depth = 0): Promise<GitObjectRecord | undefined> {
  if (!SHA1_HEX.test(sha) || depth > GIT_MAX_DELTA_DEPTH) return undefined;
  return (await readLooseGitObject(store.commonDir, sha)) ?? (await readPackedGitObject(store, sha, depth));
}

function parseTreeObjectEntries(
  payload: Buffer,
): { readonly mode: string; readonly name: string; readonly sha1: string }[] | undefined {
  const out: { readonly mode: string; readonly name: string; readonly sha1: string }[] = [];
  let pos = 0;
  while (pos < payload.length) {
    const nul = payload.indexOf(0, pos);
    if (nul <= pos || nul + 21 > payload.length) return undefined;
    const header = payload.subarray(pos, nul).toString("utf8");
    const space = header.indexOf(" ");
    if (space <= 0) return undefined;
    const mode = header.slice(0, space);
    const name = header.slice(space + 1);
    if (!name || name === "." || name === ".." || name.includes("/")) return undefined;
    const sha1 = payload.subarray(nul + 1, nul + 21).toString("hex");
    out.push({ mode, name, sha1 });
    pos = nul + 21;
  }
  return out;
}

function applyTreeEntriesToWalk(
  prefix: string,
  parsed: readonly { readonly mode: string; readonly name: string; readonly sha1: string }[],
  files: Map<string, { readonly executable: boolean; readonly sha1: string }>,
  pending: { readonly prefix: string; readonly sha: string }[],
): boolean {
  for (const entry of parsed) {
    const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === "40000") {
      pending.push({ prefix: relPath, sha: entry.sha1 });
    } else if ((entry.mode === "100644" || entry.mode === "100755") && files.size < WORKSPACE_MAX_ENTRIES) {
      files.set(relPath, { executable: entry.mode === "100755", sha1: entry.sha1 });
    } else {
      return false;
    }
  }
  return true;
}

async function readCommitHeadTree(
  store: GitObjectStore,
  commitSha: string,
): Promise<Map<string, { readonly executable: boolean; readonly sha1: string }> | undefined> {
  const commitObj = await readGitObject(store, commitSha);
  if (commitObj?.type !== "commit") return undefined;
  const treeMatch = /^tree ([0-9a-f]{40})\n/.exec(commitObj.payload.toString("utf8"));
  if (!treeMatch?.[1]) return undefined;
  const files = new Map<string, { readonly executable: boolean; readonly sha1: string }>();
  const pending: { readonly prefix: string; readonly sha: string }[] = [{ prefix: "", sha: treeMatch[1] }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const treeObj = await readGitObject(store, current.sha);
    const parsed = treeObj?.type === "tree" ? parseTreeObjectEntries(treeObj.payload) : undefined;
    if (!parsed || !applyTreeEntriesToWalk(current.prefix, parsed, files, pending)) return undefined;
  }
  return files;
}

function hasValidOptionalIndexExtensions(indexBuf: Buffer, startOffset: number, trailerStart: number): boolean {
  let offset = startOffset;
  while (offset < trailerStart) {
    if (offset + 8 > trailerStart) return false;
    const sig = indexBuf.subarray(offset, offset + 4).toString("ascii");
    if (!/^[A-Z]{4}$/.test(sig)) return false;
    const extSize = indexBuf.readUInt32BE(offset + 4);
    offset += 8 + extSize;
  }
  return offset === trailerStart;
}

function parseSingleIndexEntry(
  indexBuf: Buffer,
  offset: number,
  version: number,
  trailerStart: number,
):
  | {
      readonly relPath: string;
      readonly entry: SnapshotFileExpectation;
      readonly nextOffset: number;
    }
  | undefined {
  if (offset + 62 > trailerStart) return undefined;
  const mode = indexBuf.readUInt32BE(offset + 24);
  const size = indexBuf.readUInt32BE(offset + 36);
  const sha1 = indexBuf.subarray(offset + 40, offset + 60).toString("hex");
  const flags = indexBuf.readUInt16BE(offset + 60);
  if (((flags >> 12) & 0x3) !== 0 || (mode !== 0o100644 && mode !== 0o100755)) return undefined;
  const headerLen = version === 3 && (flags & 0x4000) !== 0 ? 64 : 62;
  const nameEnd = indexBuf.indexOf(0, offset + headerLen);
  if (nameEnd < 0 || nameEnd >= trailerStart) return undefined;
  const relPath = indexBuf.subarray(offset + headerLen, nameEnd).toString("utf8");
  const nextOffset = offset + Math.ceil((nameEnd - offset + 1) / 8) * 8;
  if (!relPath || nextOffset > trailerStart) return undefined;
  return { relPath, entry: { size, sha1, executable: mode === 0o100755 }, nextOffset };
}

function parseVerifiedGitIndex(
  indexBuf: Buffer,
  headTree: ReadonlyMap<string, { readonly executable: boolean; readonly sha1: string }>,
): Map<string, SnapshotFileExpectation> | undefined {
  if (indexBuf.length < 32 || indexBuf.subarray(0, 4).toString("ascii") !== "DIRC") return undefined;
  const trailerStart = indexBuf.length - 20;
  const digest = createHash("sha1").update(indexBuf.subarray(0, trailerStart)).digest();
  if (!digest.equals(indexBuf.subarray(trailerStart))) return undefined;
  const version = indexBuf.readUInt32BE(4);
  const count = indexBuf.readUInt32BE(8);
  if ((version !== 2 && version !== 3) || count !== headTree.size || count > WORKSPACE_MAX_ENTRIES) {
    return undefined;
  }
  const entries = new Map<string, SnapshotFileExpectation>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const parsed = parseSingleIndexEntry(indexBuf, offset, version, trailerStart);
    const committed = parsed ? headTree.get(parsed.relPath) : undefined;
    if (
      !parsed ||
      !committed ||
      committed.sha1 !== parsed.entry.sha1 ||
      committed.executable !== parsed.entry.executable
    ) {
      return undefined;
    }
    entries.set(parsed.relPath, parsed.entry);
    offset = parsed.nextOffset;
  }
  return entries.size === headTree.size && hasValidOptionalIndexExtensions(indexBuf, offset, trailerStart)
    ? entries
    : undefined;
}

async function resolveSnapshotHeadTree(
  contextTreeRoot: string,
  snapshotDir: string,
  stores: Map<string, GitObjectStore>,
): Promise<Map<string, SnapshotFileExpectation> | undefined> {
  const dirs = await resolveSnapshotGitDirs(contextTreeRoot, snapshotDir);
  if (!dirs) return undefined;
  const indexBuf = await readBoundedRegularFile(join(dirs.gitDir, "index"), GIT_INDEX_MAX_BYTES);
  if (!indexBuf) return undefined;
  let store = stores.get(dirs.commonDir);
  if (!store) {
    store = { commonDir: dirs.commonDir };
    stores.set(dirs.commonDir, store);
  }
  const headSha = await resolvePublishedSnapshotHead(snapshotDir, dirs.gitDir, dirs.commonDir, store);
  if (!headSha) return undefined;
  const headTree = await readCommitHeadTree(store, headSha);
  if (!headTree) return undefined;
  return parseVerifiedGitIndex(indexBuf, headTree);
}

async function isSnapshotFileDirty(
  absPath: string,
  stats: Stats,
  expected: SnapshotFileExpectation | undefined,
): Promise<boolean> {
  if (!expected || expected.size !== stats.size || stats.size > WORKSPACE_MAX_BYTES) return true;
  if (((stats.mode & 0o111) !== 0) !== expected.executable) return true;
  const content = await readFile(absPath);
  const sha1 = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  return sha1 !== expected.sha1;
}

async function inspectSnapshotEntry(
  snapshotDir: string,
  relDir: string,
  name: string,
  indexed: ReadonlyMap<string, SnapshotFileExpectation>,
): Promise<{ readonly kind: "skip" | "dirty" | "file" } | { readonly kind: "dir"; readonly relPath: string }> {
  if (relDir === "" && name === ".git") return { kind: "skip" };
  const relPath = relDir === "" ? name : `${relDir}/${name}`;
  const absPath = join(snapshotDir, ...relPath.split("/"));
  const stats = await lstat(absPath);
  if (stats.isSymbolicLink()) return { kind: "dirty" };
  if (stats.isDirectory()) return { kind: "dir", relPath };
  if (!stats.isFile() || (await isSnapshotFileDirty(absPath, stats, indexed.get(relPath)))) {
    return { kind: "dirty" };
  }
  return { kind: "file" };
}

async function walkSnapshotWorktree(
  snapshotDir: string,
  indexed: ReadonlyMap<string, SnapshotFileExpectation>,
): Promise<boolean> {
  let fileCount = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relDir = pending.pop() ?? "";
    const absDir = relDir === "" ? snapshotDir : join(snapshotDir, ...relDir.split("/"));
    for (const name of await readdir(absDir)) {
      const outcome = await inspectSnapshotEntry(snapshotDir, relDir, name, indexed);
      if (outcome.kind === "dirty") return true;
      if (outcome.kind === "dir") pending.push(outcome.relPath);
      if (outcome.kind === "file") fileCount += 1;
    }
  }
  return fileCount !== indexed.size;
}

async function isSnapshotWorktreeDirty(
  contextTreeRoot: string,
  snapshotDir: string,
  stores: Map<string, GitObjectStore>,
): Promise<boolean> {
  try {
    const headTree = await resolveSnapshotHeadTree(contextTreeRoot, snapshotDir, stores);
    if (!headTree) return true;
    return await walkSnapshotWorktree(snapshotDir, headTree);
  } catch {
    return true;
  }
}

async function shouldPreserveContextTreeCache(workspacePath: string): Promise<boolean> {
  const contextTreeRoot = join(workspacePath, ...CONTEXT_TREE_STATE_REL.split("/"));
  if (
    (await hasDirectoryEntries(join(contextTreeRoot, "sessions"))) ||
    (await hasDirectoryEntries(join(contextTreeRoot, "worktrees")))
  ) {
    return true;
  }
  const snapshotsRoot = join(contextTreeRoot, "snapshots");
  try {
    const stats = await lstat(snapshotsRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return true;
    const stores = new Map<string, GitObjectStore>();
    for (const name of await readdir(snapshotsRoot)) {
      const candidate = join(snapshotsRoot, name);
      const entryStats = await lstat(candidate);
      if (entryStats.isSymbolicLink() || !entryStats.isDirectory()) return true;
      if (await isSnapshotWorktreeDirty(contextTreeRoot, candidate, stores)) return true;
    }
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function shouldSkipContextTreeEntry(dirRel: string, name: string, preserveContextTreeCache: boolean): boolean {
  const rel = dirRel === "" ? name : `${dirRel}/${name}`;
  return rel === CONTEXT_TREE_CLEANUP_REL || (!preserveContextTreeCache && CONTEXT_TREE_CACHE_RELS.has(rel));
}

async function readScannableDirectoryNames(
  workspacePath: string,
  dirRel: string,
  preserveContextTreeCache: boolean,
): Promise<string[]> {
  const absDir = dirRel === "" ? workspacePath : join(workspacePath, ...dirRel.split("/"));
  let names: string[];
  try {
    names = await readdir(absDir);
  } catch (error) {
    throw toArchiveError(error, "io-failed", `Cannot read workspace directory ${bounded(dirRel || ".")}`);
  }
  names.sort();
  return names.filter((name) => !shouldSkipContextTreeEntry(dirRel, name, preserveContextTreeCache));
}

async function scanWorkspace(workspacePath: string, limits: ResolvedLimits): Promise<WorkspaceScan> {
  const records: WalkRecord[] = [];
  const namespace = new Map<string, NamespaceEntry>();
  const state: ScanState = { bytes: 0 };
  const preserveContextTreeCache = await shouldPreserveContextTreeCache(workspacePath);
  const pendingDirs: string[] = [""];
  let cursor = 0;
  while (cursor < pendingDirs.length) {
    const dirRel = pendingDirs[cursor] ?? "";
    cursor += 1;
    const names = await readScannableDirectoryNames(workspacePath, dirRel, preserveContextTreeCache);
    for (const name of names) {
      if (records.length >= limits.maxEntries) {
        fail("too-many-entries", `Workspace exceeds the ${limits.maxEntries} entry ceiling`);
      }
      const { record, childDir } = await scanWorkspaceEntry(workspacePath, dirRel, name, limits, state);
      records.push(record);
      namespace.set(record.rel, { kind: record.kind, target: record.target });
      if (childDir !== undefined) pendingDirs.push(childDir);
    }
  }
  return { records, namespace };
}

/**
 * Pass 2 drift check, run immediately before each entry is streamed: kind, file size, and
 * link target must match the pass 1 scan that validated the link graph. Writers are required
 * to be stopped; any drift fails closed instead of archiving an unvalidated tree.
 */
async function assertEntryUnchanged(workspacePath: string, record: WalkRecord): Promise<void> {
  const abs = join(workspacePath, ...record.rel.split("/"));
  let stats: Stats;
  try {
    stats = await lstat(abs);
  } catch (error) {
    throw toArchiveError(error, "workspace-changed", `Workspace entry changed while archiving: ${bounded(record.rel)}`);
  }
  const sameKind =
    (record.kind === "file" && stats.isFile()) ||
    (record.kind === "directory" && stats.isDirectory() && !stats.isSymbolicLink()) ||
    (record.kind === "symlink" && stats.isSymbolicLink());
  if (!sameKind || (record.kind === "file" && stats.size !== record.size)) {
    fail("workspace-changed", `Workspace entry changed while archiving: ${bounded(record.rel)}`);
  }
  if (record.kind === "symlink") {
    let target: string;
    try {
      target = await readlink(abs);
    } catch (error) {
      throw toArchiveError(
        error,
        "workspace-changed",
        `Workspace link changed while archiving: ${bounded(record.rel)}`,
      );
    }
    if (target !== record.target) {
      fail("workspace-changed", `Workspace link changed while archiving: ${bounded(record.rel)}`);
    }
  }
}

/**
 * Streams one tar entry and resolves only after tar-stream has flushed it, keeping entry
 * production strictly sequential so memory stays bounded. A source whose size drifts mid-read
 * also fails closed via tar-stream's own size-mismatch check.
 */
function addArchiveEntry(pack: Pack, header: TarHeaders, sourcePath?: string): Promise<void> {
  return new Promise<void>((resolveEntry, rejectEntry) => {
    let settled = false;
    const done = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error === undefined || error === null) {
        resolveEntry();
      } else {
        rejectEntry(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const sink = pack.entry(header, (err) => done(err));
    if (sourcePath === undefined) {
      sink.end();
      return;
    }
    pipeline(createReadStream(sourcePath), sink).then(() => done(), done);
  });
}

async function writeWorkspaceEntries(pack: Pack, workspacePath: string, records: readonly WalkRecord[]): Promise<void> {
  for (const record of records) {
    await assertEntryUnchanged(workspacePath, record);
    if (record.kind === "symlink") {
      await addArchiveEntry(pack, {
        name: record.rel,
        type: "symlink",
        linkname: record.target ?? "",
        mode: 0o777,
        mtime: record.mtime,
      });
    } else if (record.kind === "directory") {
      await addArchiveEntry(pack, { name: record.rel, type: "directory", mode: record.mode, mtime: record.mtime });
    } else {
      await addArchiveEntry(
        pack,
        { name: record.rel, type: "file", size: record.size, mode: record.mode, mtime: record.mtime },
        join(workspacePath, ...record.rel.split("/")),
      );
    }
  }
}

export async function createWorkspaceArchive(
  workspace: string,
  archivePath: string,
  limits?: WorkspaceArchiveLimits,
): Promise<WorkspaceArchiveInfo> {
  const resolvedLimits = resolveLimits(limits);
  const workspacePath = resolve(workspace);
  const archivePathResolved = resolve(archivePath);
  await assertRealWorkspaceRoot(workspacePath);
  await assertArchiveOutsideWorkspace(workspacePath, archivePathResolved);

  // Scan and validate the full tree (including the complete link graph) before any byte is
  // streamed; then re-check every entry against the scan while streaming (drift fails closed).
  const scan = await scanWorkspace(workspacePath, resolvedLimits);
  assertLinksContained(scan.namespace, "unsafe-entry");

  const tempArchive = join(dirname(archivePathResolved), `.${basename(archivePathResolved)}.${randomUUID()}.tmp`);

  const hashes = { sha256: createHash("sha256"), md5: createHash("md5") };
  const meter = new PassThrough();
  const compressed = attachCompressedMeter(meter, resolvedLimits.maxArchiveBytes, hashes);

  const pack = tarPack();
  // Level 1 keeps interactive save latency low; output stays deterministic for a fixed tree.
  const output = pipeline(
    pack,
    createGzip({ level: 1 }),
    meter,
    createWriteStream(tempArchive, { flags: "wx", mode: 0o600 }),
  );
  // An output failure (including the compressed-size ceiling) must abort entry production
  // instead of letting backpressure stall the walk forever.
  output.catch(() => pack.destroy());

  try {
    await writeWorkspaceEntries(pack, workspacePath, scan.records);
    pack.finalize();
    await output;
  } catch (error) {
    pack.destroy();
    await output.catch(() => undefined);
    await rm(tempArchive, { force: true });
    throw toArchiveError(error, "io-failed", "Archive creation failed");
  }

  try {
    await rename(tempArchive, archivePathResolved);
  } catch (error) {
    await rm(tempArchive, { force: true });
    throw toArchiveError(error, "io-failed", "Archive publish failed");
  }

  return { bytes: compressed.readCount(), sha256: hashes.sha256.digest("hex"), md5: hashes.md5.digest("base64") };
}

function validateExpected(expected: WorkspaceArchiveInfo, limits: ResolvedLimits): void {
  if (!Number.isInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > limits.maxArchiveBytes) {
    fail("invalid-expected", `Expected archive length must be an integer between 0 and ${limits.maxArchiveBytes}`);
  }
  if (!SHA256_HEX.test(expected.sha256)) {
    fail("invalid-expected", "Expected sha256 must be 64 lowercase hex characters");
  }
  if (!MD5_BASE64.test(expected.md5)) {
    fail("invalid-expected", "Expected md5 must be base64 with padding");
  }
}

/**
 * Sequential archive-member validator and writer. Directories and files are written while
 * streaming; symlinks are only RECORDED and installed by `finalize`, after the stream ends,
 * the digests verify, and the complete link graph is validated. Directory modes are applied
 * last (deepest first) so restrictive modes cannot block their own children. Nothing here
 * follows symlinks, applies ownership, or trusts header modes.
 */
class RestoreState {
  private readonly declared = new Map<string, MemberKind>();
  private readonly implicitDirs = new Set<string>();
  private readonly dirModes = new Map<string, number>();
  private readonly links = new Map<string, string>();
  private entries = 0;
  private bytes = 0;

  constructor(
    private readonly staging: string,
    private readonly limits: ResolvedLimits,
  ) {}

  async handle(header: TarHeaders, stream: Readable): Promise<void> {
    const name = normalizeMemberName(header.name);
    this.entries += 1;
    if (this.entries > this.limits.maxEntries) {
      fail("too-many-entries", `Archive exceeds the ${this.limits.maxEntries} entry ceiling`);
    }
    if (name === "") {
      if (header.type !== "directory") fail("unsafe-member", "The archive root must be a directory");
      await drain(stream);
      return;
    }
    if (this.declared.has(name)) {
      fail("duplicate-member", `Archive member is duplicated: ${bounded(name)}`);
    }
    if (this.implicitDirs.has(name) && header.type !== "directory") {
      fail("unsafe-member", `Archive member collides with a directory: ${bounded(name)}`);
    }
    const segments = name.split("/");
    await this.ensureParents(segments, name);

    if (header.type === "directory") {
      this.declared.set(name, "directory");
      if (!this.implicitDirs.delete(name)) {
        await mkdir(this.dest(name));
      }
      // Staged permissive; the declared mode is applied in finalize after all content.
      await chmod(this.dest(name), 0o700);
      this.dirModes.set(name, sanitizeMode(header.mode, 0o755));
      await drain(stream);
      return;
    }
    if (header.type === "symlink") {
      this.declared.set(name, "symlink");
      const target = typeof header.linkname === "string" ? header.linkname : "";
      assertLinkTargetForm(target, "unsafe-member", name);
      this.links.set(name, target);
      await drain(stream);
      return;
    }
    if (header.type === "file") {
      this.declared.set(name, "file");
      const dest = this.dest(name);
      // Exclusive and private while streaming; the declared mode (sanitized) is applied after.
      const tap = new PassThrough();
      tap.on("data", (chunk: Buffer) => {
        this.bytes += chunk.length;
        if (this.bytes > this.limits.maxBytes) {
          tap.destroy(
            new WorkspaceArchiveError(
              "workspace-too-large",
              `Archive expands beyond the ${this.limits.maxBytes} byte ceiling`,
            ),
          );
        }
      });
      await pipeline(stream, tap, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
      await chmod(dest, sanitizeMode(header.mode, 0o644));
      return;
    }
    if (header.type === "link") {
      fail("unsafe-member", `Hard-link members are never restorable: ${bounded(name)}`);
    }
    fail("unsupported-member", `Archive member has an unsupported type: ${bounded(name)}`);
  }

  /** Runs after the archive stream is fully consumed and both digests verify. */
  async finalize(): Promise<void> {
    const namespace = new Map<string, NamespaceEntry>();
    for (const dir of this.implicitDirs) namespace.set(dir, { kind: "directory" });
    for (const [name, kind] of this.declared) {
      namespace.set(name, kind === "symlink" ? { kind, target: this.links.get(name) ?? "" } : { kind });
    }
    assertLinksContained(namespace, "unsafe-member");
    for (const [name, target] of this.links) {
      await symlink(target, this.dest(name));
    }
    const deepestFirst = [...this.dirModes.keys()].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const dir of deepestFirst) {
      await chmod(this.dest(dir), this.dirModes.get(dir) ?? 0o755);
    }
  }

  private dest(name: string): string {
    const dest = join(this.staging, ...name.split("/"));
    const suffix = relative(this.staging, dest);
    if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      fail("unsafe-member", `Archive member escapes the staging root: ${bounded(name)}`);
    }
    return dest;
  }

  /** Creates missing parents on demand; a parent declared as a file/symlink rejects the child. */
  private async ensureParents(segments: readonly string[], memberName: string): Promise<void> {
    let current = this.staging;
    let rel = "";
    for (const segment of segments.slice(0, -1)) {
      rel = rel === "" ? segment : `${rel}/${segment}`;
      current = join(current, segment);
      const kind = this.declared.get(rel);
      if (kind !== undefined && kind !== "directory") {
        fail("unsafe-member", `Archive member is nested beneath a non-directory: ${bounded(memberName)}`);
      }
      if (kind === undefined && !this.implicitDirs.has(rel)) {
        await mkdir(current);
        await chmod(current, 0o700);
        this.implicitDirs.add(rel);
      }
    }
  }
}

type MemberKind = "file" | "directory" | "symlink";

async function extractArchiveInto(
  archivePath: string,
  staging: string,
  expected: WorkspaceArchiveInfo,
  limits: ResolvedLimits,
): Promise<void> {
  const hashes = { sha256: createHash("sha256"), md5: createHash("md5") };
  const compressedMeter = new PassThrough();
  const compressed = attachCompressedMeter(compressedMeter, limits.maxArchiveBytes, hashes);

  let decompressedBytes = 0;
  const decompressedMeter = new PassThrough();
  decompressedMeter.on("data", (chunk: Buffer) => {
    decompressedBytes += chunk.length;
    if (decompressedBytes > limits.maxDecompressedBytes) {
      decompressedMeter.destroy(
        new WorkspaceArchiveError("decompression-limit", "Archive expands beyond the decompressed stream ceiling"),
      );
    }
  });

  const extractor = tarExtract();
  const state = new RestoreState(staging, limits);
  extractor.on("entry", (header, stream, next) => {
    state.handle(header, stream).then(
      () => next(),
      (error: unknown) => next(error),
    );
  });

  try {
    await pipeline(createReadStream(archivePath), compressedMeter, createGunzip(), decompressedMeter, extractor);
  } catch (error) {
    throw toArchiveError(error, "invalid-archive", "Archive cannot be unpacked");
  }

  if (compressed.readCount() !== expected.bytes) {
    fail("size-mismatch", `Archive length ${compressed.readCount()} does not match the expected ${expected.bytes}`);
  }
  const sha256 = hashes.sha256.digest("hex");
  const md5 = hashes.md5.digest("base64");
  if (sha256 !== expected.sha256 || md5 !== expected.md5) {
    fail("hash-mismatch", "Archive digests do not match the expected integrity metadata");
  }

  // Integrity is proven and the full member graph is known: only now install symlinks and
  // apply declared directory modes.
  await state.finalize();
}

/**
 * Moves the fully validated staging tree onto an EMPTY or missing destination. A nonempty or
 * non-directory destination is refused untouched; on a rename failure the previous empty
 * destination is recreated best-effort so a failed restore never deletes user state.
 */
async function replaceDestination(staging: string, workspacePath: string): Promise<void> {
  let hadDestination = false;
  try {
    const stats = await lstat(workspacePath);
    hadDestination = true;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail("invalid-destination", "Restore destination exists but is not a real directory");
    }
    if ((await readdir(workspacePath)).length > 0) {
      fail("destination-not-empty", "Restore destination is not empty; refusing to overwrite a workspace");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (hadDestination) {
    await rmdir(workspacePath);
  }
  try {
    await rename(staging, workspacePath);
  } catch (error) {
    if (hadDestination) {
      await mkdir(workspacePath).catch(() => undefined);
    }
    throw toArchiveError(error, "io-failed", "Failed to move the validated workspace into place");
  }
}

export async function restoreWorkspaceArchive(
  archivePath: string,
  workspace: string,
  expected: WorkspaceArchiveInfo,
  limits?: WorkspaceArchiveLimits,
): Promise<void> {
  const resolvedLimits = resolveLimits(limits);
  validateExpected(expected, resolvedLimits);
  const archivePathResolved = resolve(archivePath);
  const workspacePath = resolve(workspace);
  await assertArchiveOutsideWorkspace(workspacePath, archivePathResolved);

  let archiveStats: Stats;
  try {
    archiveStats = await lstat(archivePathResolved);
  } catch (error) {
    throw toArchiveError(error, "io-failed", "Archive is not readable");
  }
  if (archiveStats.isSymbolicLink() || !archiveStats.isFile()) {
    fail("invalid-archive", "Archive path must be a regular file");
  }
  if (archiveStats.size !== expected.bytes) {
    fail("size-mismatch", `Archive length ${archiveStats.size} does not match the expected ${expected.bytes}`);
  }

  const parent = dirname(workspacePath);
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    throw toArchiveError(error, "io-failed", "Workspace parent directory is not writable");
  }
  const staging = await mkdtemp(join(parent, `.${basename(workspacePath)}.opentag-restore-`));

  try {
    await extractArchiveInto(archivePathResolved, staging, expected, resolvedLimits);
    await replaceDestination(staging, workspacePath);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error instanceof WorkspaceArchiveError
      ? error
      : toArchiveError(error, "io-failed", "Workspace restore failed");
  }
}
