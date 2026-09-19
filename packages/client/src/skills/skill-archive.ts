import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  isReservedSkillName,
  parseSkillManifest,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_MANIFEST_FILE,
  SKILL_MARKER_FILE,
  SKILL_MAX_ENTRIES,
  SKILL_MAX_PATH_BYTES,
  SKILL_UNPACKED_MAX_BYTES,
} from "@opentag/shared";
import { type Headers as TarHeaders, extract as tarExtract, pack as tarPack } from "tar-stream";
import { assertWithin, ensurePrivateDirectory } from "../storage/durable-file.js";

/**
 * Local packing and extraction for Agent Skills.
 *
 * `packSkillDirectory` turns a skill directory into the canonical `tar.gz` archive the platform
 * stores; `extractSkillArchive` is the only place a downloaded bundle becomes files. Both are
 * deliberately paranoid: a Skill an Agent authors may contain anything, and a bundle from the
 * platform must never be able to write outside the directory the caller nominated.
 */

export type SkillArchiveErrorCode =
  | "not_a_directory"
  | "manifest_missing"
  | "manifest_invalid"
  | "name_reserved"
  | "symlink"
  | "unsupported_entry"
  | "too_many_entries"
  | "unpacked_too_large"
  | "path_too_long"
  | "archive_too_large"
  | "archive_invalid"
  | "unsafe_member"
  | "destination_not_empty"
  | "io_failed";

export class SkillArchiveError extends Error {
  constructor(
    readonly code: SkillArchiveErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillArchiveError";
  }
}

export interface PackedSkillDirectory {
  readonly archive: Uint8Array;
  /** Lowercase hex SHA-256 over the compressed archive bytes. */
  readonly sha256: string;
  /** Number of files in the archive (directories are not counted). */
  readonly fileCount: number;
}

interface FileRecord {
  readonly rel: string;
  readonly abs: string;
  readonly bytes: number;
  readonly mode: number;
}

interface DirectoryRecord {
  readonly rel: string;
  readonly abs: string;
}

interface WalkState {
  bytes: number;
  entries: number;
}

const EXCLUDED_NAMES = new Set([".git", "node_modules", ".DS_Store", SKILL_MARKER_FILE]);

function fail(code: SkillArchiveErrorCode, message: string, cause?: unknown): never {
  throw new SkillArchiveError(code, message, cause === undefined ? undefined : { cause });
}

function relativePosix(root: string, absolute: string): string {
  return relative(root, absolute).split(/[\\/]/u).join("/");
}

function assertSkillPathWidth(rel: string): void {
  if (Buffer.byteLength(rel, "utf8") > SKILL_MAX_PATH_BYTES) {
    fail("path_too_long", `Skill entry path exceeds ${SKILL_MAX_PATH_BYTES} bytes: ${rel.slice(0, 120)}`);
  }
}

function entryMode(mode: number, directory: boolean): number {
  if (directory) return 0o755;
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

async function lstatEntry(abs: string, rel: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(abs);
  } catch (error) {
    fail("io_failed", `Cannot stat skill entry: ${rel}`, error);
  }
}

async function visitSkillEntry(
  root: string,
  directory: DirectoryRecord,
  name: string,
  files: FileRecord[],
  directories: DirectoryRecord[],
  state: WalkState,
): Promise<void> {
  const abs = join(directory.abs, name);
  const rel = relativePosix(root, abs);
  assertSkillPathWidth(rel);
  state.entries += 1;
  if (state.entries > SKILL_MAX_ENTRIES) {
    fail("too_many_entries", `Skill exceeds the ${SKILL_MAX_ENTRIES} entry ceiling`);
  }
  const stats = await lstatEntry(abs, rel);
  if (stats.isSymbolicLink()) {
    fail("symlink", `Skill directories may not contain symlinks: ${rel}`);
  }
  if (stats.isDirectory()) {
    const child = { abs, rel };
    directories.push(child);
    await walkSkillDirectory(root, child, files, directories, state);
    return;
  }
  if (!stats.isFile()) {
    fail("unsupported_entry", `Skill entries must be regular files or directories: ${rel}`);
  }
  state.bytes += stats.size;
  if (state.bytes > SKILL_UNPACKED_MAX_BYTES) {
    fail("unpacked_too_large", `Skill exceeds the ${SKILL_UNPACKED_MAX_BYTES} byte unpacked ceiling`);
  }
  files.push({ abs, rel, bytes: stats.size, mode: stats.mode });
}

async function walkSkillDirectory(
  root: string,
  directory: DirectoryRecord,
  files: FileRecord[],
  directories: DirectoryRecord[],
  state: WalkState,
): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(directory.abs)).sort();
  } catch (error) {
    fail("io_failed", `Cannot read skill directory: ${directory.rel || "."}`, error);
  }
  for (const name of names) {
    if (EXCLUDED_NAMES.has(name)) continue;
    await visitSkillEntry(root, directory, name, files, directories, state);
  }
}

async function validateSkillManifest(root: string): Promise<void> {
  let markdown: string;
  try {
    markdown = await readFile(join(root, SKILL_MANIFEST_FILE), "utf8");
  } catch (error) {
    fail("manifest_missing", `Skill directory must contain a root ${SKILL_MANIFEST_FILE}`, error);
  }
  const parsed = parseSkillManifest(markdown);
  if (!parsed.ok) fail("manifest_invalid", parsed.reason);
  if (isReservedSkillName(parsed.manifest.name)) {
    fail("name_reserved", `Skill name "${parsed.manifest.name}" is reserved by the platform`);
  }
}

function addTarEntry(pack: ReturnType<typeof tarPack>, header: TarHeaders, sourcePath?: string): Promise<void> {
  return new Promise<void>((resolveEntry, rejectEntry) => {
    let settled = false;
    const done = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error === undefined || error === null) resolveEntry();
      else rejectEntry(error instanceof Error ? error : new Error(String(error)));
    };
    const sink = pack.entry(header, (error) => done(error));
    if (sourcePath === undefined) {
      sink.end();
      return;
    }
    pipeline(createReadStream(sourcePath), sink).then(
      () => done(),
      (error) => done(error),
    );
  });
}

export async function packSkillDirectory(directory: string): Promise<PackedSkillDirectory> {
  const root = resolve(directory);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(root);
  } catch (error) {
    fail("not_a_directory", "Skill path is not accessible", error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("not_a_directory", "Skill path must be a real directory");
  }
  await validateSkillManifest(root);

  const files: FileRecord[] = [];
  const directories: DirectoryRecord[] = [];
  const state: WalkState = { bytes: 0, entries: 0 };
  await walkSkillDirectory(root, { abs: root, rel: "" }, files, directories, state);

  const records: Array<{ kind: "file" | "directory"; rel: string; abs: string; bytes: number; mode: number }> = [
    ...directories.map((entry) => ({
      kind: "directory" as const,
      rel: entry.rel,
      abs: entry.abs,
      bytes: 0,
      mode: 0o755,
    })),
    ...files.map((entry) => ({
      kind: "file" as const,
      rel: entry.rel,
      abs: entry.abs,
      bytes: entry.bytes,
      mode: entryMode(entry.mode, false),
    })),
  ].sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));

  const pack = tarPack();
  const meter = new PassThrough();
  const chunks: Buffer[] = [];
  let compressedBytes = 0;
  meter.on("data", (chunk: Buffer) => {
    compressedBytes += chunk.length;
    if (compressedBytes > SKILL_ARCHIVE_MAX_BYTES) {
      meter.destroy(new SkillArchiveError("archive_too_large", "Packed skill exceeds the archive ceiling"));
      return;
    }
    chunks.push(chunk);
  });
  const output = pipeline(pack, createGzip({ level: 1 }), meter);
  output.catch(() => pack.destroy());

  try {
    for (const record of records) {
      const header: TarHeaders = {
        name: record.rel,
        type: record.kind,
        mode: record.mode,
        mtime: new Date(0),
        ...(record.kind === "file" ? { size: record.bytes } : {}),
      };
      await addTarEntry(pack, header, record.kind === "file" ? record.abs : undefined);
    }
    pack.finalize();
    await output;
  } catch (error) {
    pack.destroy();
    await output.catch(() => undefined);
    if (error instanceof SkillArchiveError) throw error;
    fail("io_failed", "Packing the skill directory failed", error);
  }

  const archive = Buffer.concat(chunks);
  return {
    archive: new Uint8Array(archive),
    sha256: createHash("sha256").update(archive).digest("hex"),
    fileCount: files.length,
  };
}

/** Normalize an archive member name; "" is the root pseudo-entry; rejects escapes and ambiguity. */
function normalizeMemberName(rawName: string | undefined): string {
  if (typeof rawName !== "string" || rawName.length === 0 || rawName.includes("\0")) {
    fail("unsafe_member", "Archive member name is missing or invalid");
  }
  if (rawName.startsWith("/") || rawName.includes("\\") || /^[A-Za-z]:/u.test(rawName)) {
    fail("unsafe_member", `Archive member name is absolute or ambiguous: ${rawName.slice(0, 120)}`);
  }
  const segments: string[] = [];
  for (const segment of rawName.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") fail("unsafe_member", "Archive member escapes the skill root");
    segments.push(segment);
  }
  const normalized = segments.join("/");
  if (normalized.length > 0) assertSkillPathWidth(normalized);
  return normalized;
}

async function assertEmptyDirectory(target: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch (error) {
    fail("io_failed", "Cannot read the extraction destination", error);
  }
  if (entries.length > 0) fail("destination_not_empty", "Extraction destination must be empty");
}

function destinationPath(root: string, member: string): string {
  const dest = join(root, ...member.split("/"));
  assertWithin(root, dest);
  return dest;
}

async function handleMember(root: string, header: TarHeaders, stream: Readable, state: WalkState): Promise<void> {
  const name = normalizeMemberName(header.name);
  state.entries += 1;
  if (state.entries > SKILL_MAX_ENTRIES) {
    fail("too_many_entries", `Archive exceeds the ${SKILL_MAX_ENTRIES} entry ceiling`);
  }
  if (name === "") {
    if (header.type !== "directory") fail("unsafe_member", "The archive root must be a directory");
    for await (const chunk of stream) void chunk;
    return;
  }
  const dest = destinationPath(root, name);
  if (header.type === "directory") {
    await mkdir(dest, { recursive: true, mode: 0o700 });
    await chmod(dest, 0o700);
    for await (const chunk of stream) void chunk;
    return;
  }
  if (header.type !== "file") {
    fail("unsafe_member", `Archive member type is unsupported: ${name}`);
  }
  const tap = new PassThrough();
  tap.on("data", (chunk: Buffer) => {
    state.bytes += chunk.length;
    if (state.bytes > SKILL_UNPACKED_MAX_BYTES) {
      tap.destroy(new SkillArchiveError("unpacked_too_large", "Archive expands beyond the unpacked ceiling"));
    }
  });
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  await pipeline(stream, tap, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  await chmod(dest, 0o600);
}

export async function extractSkillArchive(stream: Readable, targetDirectory: string): Promise<void> {
  const target = resolve(targetDirectory);
  const parent = dirname(target);
  try {
    await ensurePrivateDirectory(parent, target);
  } catch (error) {
    fail("io_failed", "Extraction destination is not a private directory", error);
  }
  await assertEmptyDirectory(target);

  let compressed = 0;
  const compressedMeter = new PassThrough();
  compressedMeter.on("data", (chunk: Buffer) => {
    compressed += chunk.length;
    if (compressed > SKILL_ARCHIVE_MAX_BYTES) {
      compressedMeter.destroy(new SkillArchiveError("archive_too_large", "Archive exceeds the compressed ceiling"));
    }
  });
  const extractor = tarExtract();
  const state: WalkState = { bytes: 0, entries: 0 };
  extractor.on("entry", (header, entryStream, next) => {
    handleMember(target, header, entryStream, state).then(
      () => next(),
      (error: unknown) => next(error),
    );
  });

  try {
    await pipeline(stream, compressedMeter, createGunzip(), extractor);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    if (error instanceof SkillArchiveError) throw error;
    fail("archive_invalid", "Skill archive cannot be unpacked", error);
  }
}
