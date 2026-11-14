import { createHash, type Hash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { createGunzip, createGzip } from "node:zlib";
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

export const WORKSPACE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
export const WORKSPACE_MAX_BYTES = 512 * 1024 * 1024;
export const WORKSPACE_MAX_ENTRIES = 50_000;

export interface WorkspaceArchiveStats {
  readonly archiveBytes: number;
  readonly workspaceBytes: number;
  readonly entryCount: number;
}

/**
 * Injectable ceilings for tests. Production callers use the module constants; every limit
 * must be a positive integer. The decompressed-stream ceiling is derived, not injectable.
 */
export interface WorkspaceArchiveLimits {
  readonly maxArchiveBytes?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly onStats?: (stats: WorkspaceArchiveStats) => void;
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
  readonly workspaceBytes: number;
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

/**
 * Context Tree `cleanup` logs are host-local diagnostics and never archived. Repository caches,
 * snapshots, and write sessions are always kept so a restored workspace syncs incrementally.
 */
const CONTEXT_TREE_CLEANUP_REL = ".opentag/context-tree/home/.context-tree/cleanup";

async function readScannableDirectoryNames(workspacePath: string, dirRel: string): Promise<string[]> {
  const absDir = dirRel === "" ? workspacePath : join(workspacePath, ...dirRel.split("/"));
  let names: string[];
  try {
    names = await readdir(absDir);
  } catch (error) {
    throw toArchiveError(error, "io-failed", `Cannot read workspace directory ${bounded(dirRel || ".")}`);
  }
  names.sort();
  return names.filter((name) => (dirRel === "" ? name : `${dirRel}/${name}`) !== CONTEXT_TREE_CLEANUP_REL);
}

async function scanWorkspace(workspacePath: string, limits: ResolvedLimits): Promise<WorkspaceScan> {
  const records: WalkRecord[] = [];
  const namespace = new Map<string, NamespaceEntry>();
  const state: ScanState = { bytes: 0 };
  const pendingDirs: string[] = [""];
  let cursor = 0;
  while (cursor < pendingDirs.length) {
    const dirRel = pendingDirs[cursor] ?? "";
    cursor += 1;
    const names = await readScannableDirectoryNames(workspacePath, dirRel);
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
  return { records, namespace, workspaceBytes: state.bytes };
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
function addArchiveEntry(pack: Pack, header: TarHeaders, source?: { path: string; hash: Hash }): Promise<void> {
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
    if (source === undefined) {
      sink.end();
      return;
    }
    const stream = createReadStream(source.path);
    stream.on("data", (chunk: Buffer) => source.hash.update(chunk));
    pipeline(stream, sink).then(() => done(), done);
  });
}

function updateFingerprint(hash: Hash, record: WalkRecord, content?: Buffer): void {
  hash.update(JSON.stringify([record.rel, record.kind, record.size, record.mode, record.mtime, record.target]));
  if (content !== undefined) hash.update(content);
}

async function writeWorkspaceEntries(
  pack: Pack,
  workspacePath: string,
  records: readonly WalkRecord[],
): Promise<string> {
  const fingerprint = createHash("sha256");
  for (const record of records) {
    await assertEntryUnchanged(workspacePath, record);
    let content: Buffer | undefined;
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
      const hash = createHash("sha256");
      await addArchiveEntry(
        pack,
        { name: record.rel, type: "file", size: record.size, mode: record.mode, mtime: record.mtime },
        { path: join(workspacePath, ...record.rel.split("/")), hash },
      );
      content = hash.digest();
    }
    updateFingerprint(fingerprint, record, content);
  }
  return fingerprint.digest("hex");
}

/** Hash the saved tree semantics without packing it. Callers must quiesce every writer. */
export async function fingerprintWorkspace(workspace: string): Promise<string> {
  const workspacePath = resolve(workspace);
  await assertRealWorkspaceRoot(workspacePath);
  const scan = await scanWorkspace(workspacePath, resolveLimits(undefined));
  assertLinksContained(scan.namespace, "unsafe-entry");
  const hash = createHash("sha256");
  for (const record of scan.records) {
    await assertEntryUnchanged(workspacePath, record);
    let digest: Buffer | undefined;
    if (record.kind === "file") {
      const content = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(join(workspacePath, ...record.rel.split("/")))) {
        bytes += chunk.length;
        if (bytes > record.size) fail("workspace-changed", "Workspace changed while fingerprinting");
        content.update(chunk);
      }
      if (bytes !== record.size) fail("workspace-changed", "Workspace changed while fingerprinting");
      digest = content.digest();
    }
    updateFingerprint(hash, record, digest);
  }
  return hash.digest("hex");
}

export async function createWorkspaceArchive(
  workspace: string,
  archivePath: string,
  limits?: WorkspaceArchiveLimits,
): Promise<WorkspaceArchiveInfo & { readonly fingerprint: string }> {
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

  let fingerprint: string;
  try {
    fingerprint = await writeWorkspaceEntries(pack, workspacePath, scan.records);
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

  const result = {
    fingerprint,
    bytes: compressed.readCount(),
    sha256: hashes.sha256.digest("hex"),
    md5: hashes.md5.digest("base64"),
  };
  try {
    limits?.onStats?.({
      archiveBytes: result.bytes,
      workspaceBytes: scan.workspaceBytes,
      entryCount: scan.records.length,
    });
  } catch {
    // Telemetry callback must never fail archive creation.
  }
  return result;
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
  private readonly fileDigests = new Map<string, Buffer>();
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
      const hash = createHash("sha256");
      const tap = new PassThrough();
      tap.on("data", (chunk: Buffer) => {
        hash.update(chunk);
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
      this.fileDigests.set(name, hash.digest());
      return;
    }
    if (header.type === "link") {
      fail("unsafe-member", `Hard-link members are never restorable: ${bounded(name)}`);
    }
    fail("unsupported-member", `Archive member has an unsupported type: ${bounded(name)}`);
  }

  /** Runs after the archive stream is fully consumed and both digests verify. */
  async finalize(): Promise<string> {
    const namespace = new Map<string, NamespaceEntry>();
    for (const dir of this.implicitDirs) namespace.set(dir, { kind: "directory" });
    for (const [name, kind] of this.declared) {
      namespace.set(name, kind === "symlink" ? { kind, target: this.links.get(name) ?? "" } : { kind });
    }
    assertLinksContained(namespace, "unsafe-member");
    for (const [name, target] of this.links) {
      await symlink(target, this.dest(name));
    }
    const fingerprint = await this.fingerprint();
    const deepestFirst = [...this.dirModes.keys()].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const dir of deepestFirst) {
      await chmod(this.dest(dir), this.dirModes.get(dir) ?? 0o755);
    }
    return fingerprint;
  }

  private async fingerprint(): Promise<string> {
    // Scan the staged mtimes in workspace order while directories are still traversable.
    // A smaller archive entry limit counts tar members; implicit parents still fit under
    // the normal workspace ceiling. Larger overrides also apply to the staged tree.
    const scan = await scanWorkspace(this.staging, {
      ...this.limits,
      maxEntries: Math.max(this.limits.maxEntries, WORKSPACE_MAX_ENTRIES),
    });
    assertLinksContained(scan.namespace, "unsafe-entry");
    const hash = createHash("sha256");
    for (const record of scan.records) {
      const mode = this.dirModes.get(record.rel) ?? record.mode;
      const content = this.fileDigests.get(record.rel);
      if (record.kind === "file" && content === undefined) {
        fail("invalid-archive", `No extracted content digest for ${bounded(record.rel)}`);
      }
      updateFingerprint(hash, { ...record, mode }, content);
    }
    return hash.digest("hex");
  }

  get stats(): { readonly workspaceBytes: number; readonly entryCount: number } {
    return { workspaceBytes: this.bytes, entryCount: this.entries };
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
  input: Readable,
  staging: string,
  expected: WorkspaceArchiveInfo,
  limits: ResolvedLimits,
  signal?: AbortSignal,
): Promise<{ readonly workspaceBytes: number; readonly entryCount: number; readonly fingerprint: string }> {
  const hashes = { sha256: createHash("sha256"), md5: createHash("md5") };
  const compressedMeter = new PassThrough();
  const compressed = attachCompressedMeter(compressedMeter, expected.bytes, hashes);

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
  let entry: Promise<void> | undefined;
  let entryStream: Readable | undefined;
  extractor.on("entry", (header, stream, next) => {
    entryStream = stream;
    entry = state.handle(header, stream);
    void entry.then(
      () => next(),
      (error: unknown) => next(error),
    );
  });

  try {
    await pipeline(input, compressedMeter, createGunzip(), decompressedMeter, extractor, { signal });
    await entry;
  } catch (error) {
    // Tar can close before a detached member finishes. Stop it and join its staged writes.
    entryStream?.destroy();
    await entry?.catch(() => undefined);
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
  signal?.throwIfAborted();
  const fingerprint = await state.finalize();
  return { ...state.stats, fingerprint };
}

/**
 * Moves the fully validated staging tree onto an EMPTY or missing destination. A nonempty or
 * non-directory destination is refused untouched; on a rename failure the previous empty
 * destination is recreated best-effort so a failed restore never deletes user state.
 */
async function replaceDestination(staging: string, workspacePath: string, signal?: AbortSignal): Promise<void> {
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
  signal?.throwIfAborted();
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

interface WorkspaceArchiveRestoreOptions extends WorkspaceArchiveLimits {
  readonly signal?: AbortSignal;
  readonly onArchiveRead?: () => void;
}

export async function restoreWorkspaceArchive(
  archive: string | ReadableStream<Uint8Array>,
  workspace: string,
  expected: WorkspaceArchiveInfo,
  options?: WorkspaceArchiveRestoreOptions,
): Promise<string> {
  const resolvedLimits = resolveLimits(options);
  validateExpected(expected, resolvedLimits);
  const workspacePath = resolve(workspace);
  if (typeof archive === "string") {
    archive = resolve(archive);
    await assertArchiveOutsideWorkspace(workspacePath, archive);
    let archiveStats: Stats;
    try {
      archiveStats = await lstat(archive);
    } catch (error) {
      throw toArchiveError(error, "io-failed", "Archive is not readable");
    }
    if (archiveStats.isSymbolicLink() || !archiveStats.isFile()) {
      fail("invalid-archive", "Archive path must be a regular file");
    }
    if (archiveStats.size !== expected.bytes) {
      fail("size-mismatch", `Archive length ${archiveStats.size} does not match the expected ${expected.bytes}`);
    }
  }

  const parent = dirname(workspacePath);
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    throw toArchiveError(error, "io-failed", "Workspace parent directory is not writable");
  }
  const staging = await mkdtemp(join(parent, `.${basename(workspacePath)}.opentag-restore-`));

  try {
    options?.signal?.throwIfAborted();
    const input = typeof archive === "string" ? createReadStream(archive) : Readable.fromWeb(archive);
    input.once("end", () => {
      try {
        options?.onArchiveRead?.();
      } catch {
        // Telemetry callback must never fail workspace restoration.
      }
    });
    const stats = await extractArchiveInto(input, staging, expected, resolvedLimits, options?.signal);
    await replaceDestination(staging, workspacePath, options?.signal);
    try {
      options?.onStats?.({
        archiveBytes: expected.bytes,
        workspaceBytes: stats.workspaceBytes,
        entryCount: stats.entryCount,
      });
    } catch {
      // Telemetry callback must never fail workspace restoration.
    }
    return stats.fingerprint;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error instanceof WorkspaceArchiveError
      ? error
      : toArchiveError(error, "io-failed", "Workspace restore failed");
  }
}
