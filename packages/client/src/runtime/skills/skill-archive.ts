import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import {
  computeSkillDigest,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_FILE_NAME,
  SKILL_FILE_PATH_MAX_BYTES,
  SKILL_FILE_PATH_SEGMENT_MAX_BYTES,
  SKILL_MAX_FILES,
  SKILL_UNPACKED_MAX_BYTES,
  type SkillFileEntry,
  type SkillFileMode,
  type SkillManifest,
} from "@opentag/shared";
import { unzipSync, zipSync } from "fflate";
import { assertWithin } from "../../storage/durable-file.js";

/**
 * Hardened zip handling for the skill library.
 *
 * The Server validates every upload, but the daemon still treats an archive as untrusted input:
 * the central directory is parsed in-process so path, link, size, and entry-count rules are
 * enforced before a single byte is inflated, and every extracted file is checked against the
 * manifest the Server advertised for it. The same module packs a local directory into the
 * canonical zip the CLI uploads.
 */

export type SkillArchiveRejection =
  | "invalid-archive"
  | "unsupported-archive"
  | "encrypted-entry"
  | "unsupported-compression"
  | "too-many-files"
  | "unpacked-limit"
  | "archive-limit"
  | "invalid-path"
  | "duplicate-path"
  | "link-entry"
  | "unexpected-entry-type"
  | "skill-md-missing"
  | "manifest-mismatch"
  | "content-mismatch"
  | "digest-mismatch";

export class SkillArchiveError extends Error {
  override readonly name = "SkillArchiveError";
  constructor(
    readonly rejection: SkillArchiveRejection,
    message: string,
  ) {
    super(message);
  }
}

export interface SkillArchiveEntry {
  /** Archive-relative POSIX path of a regular file. */
  readonly path: string;
  readonly size: number;
  readonly mode: SkillFileMode;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const HOST_UNIX = 3;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;
const MSDOS_DIRECTORY_ATTRIBUTE = 0x10;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x1;
/** Fixed member timestamp so identical trees always produce byte-identical archives. */
const FIXED_MTIME = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
const SKIPPED_DIRECTORY_ENTRIES = new Set([".git", "node_modules", ".DS_Store"]);

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPathShape(path: string): void {
  if (path.length === 0) throw new SkillArchiveError("invalid-path", "Archive entry path is empty");
  if (Buffer.byteLength(path, "utf8") > SKILL_FILE_PATH_MAX_BYTES) {
    throw new SkillArchiveError("invalid-path", "Archive entry path is too long");
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    throw new SkillArchiveError("invalid-path", `Archive entry path is absolute or ambiguous: ${path}`);
  }
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new SkillArchiveError("invalid-path", "Archive entry path contains control characters");
    }
  }
}

function assertPathSegment(path: string, segment: string): void {
  if (segment === "..") throw new SkillArchiveError("invalid-path", `Archive entry escapes its root: ${path}`);
  if (segment === "" || segment === ".") {
    throw new SkillArchiveError("invalid-path", `Archive entry path is not canonical: ${path}`);
  }
  if (Buffer.byteLength(segment, "utf8") > SKILL_FILE_PATH_SEGMENT_MAX_BYTES) {
    throw new SkillArchiveError("invalid-path", `Archive entry path segment is too long: ${path}`);
  }
}

/** Validate one archive-relative path against the shared skill path rules. */
export function validateSkillPath(path: string): void {
  assertPathShape(path);
  for (const segment of path.split("/")) assertPathSegment(path, segment);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (readUint16(bytes, offset) | (readUint16(bytes, offset + 2) << 16)) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const lowest = Math.max(0, bytes.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = bytes.length - EOCD_MIN_LENGTH; offset >= lowest; offset -= 1) {
    if (readUint32(bytes, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new SkillArchiveError("invalid-archive", "Archive has no end-of-central-directory record");
}

/** Entry names are always read as strict UTF-8; the canonical archives the Server produces set the UTF-8 flag. */
function decodeEntryName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillArchiveError("invalid-path", "Archive entry path is not valid UTF-8");
  }
}

interface RawCentralEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly uncompressedSize: number;
  readonly externalAttributes: number;
  readonly hostOs: number;
}

function readCentralDirectory(bytes: Uint8Array): RawCentralEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = readUint16(bytes, eocd + 10);
  const directorySize = readUint32(bytes, eocd + 12);
  const directoryOffset = readUint32(bytes, eocd + 16);
  if (
    entryCount === ZIP64_MARKER_16 ||
    directorySize === ZIP64_MARKER_32 ||
    directoryOffset === ZIP64_MARKER_32 ||
    readUint16(bytes, eocd + 8) !== entryCount
  ) {
    throw new SkillArchiveError("unsupported-archive", "Multi-disk and ZIP64 archives are not supported");
  }
  if (directoryOffset + directorySize > eocd) {
    throw new SkillArchiveError("invalid-archive", "Archive central directory is truncated");
  }
  // Directory entries are dropped later, so this is only a bound on parsing work; the file count is checked after.
  if (entryCount > SKILL_MAX_FILES * 2) {
    throw new SkillArchiveError("too-many-files", `Archive lists more than ${SKILL_MAX_FILES * 2} entries`);
  }
  const entries: RawCentralEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || readUint32(bytes, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new SkillArchiveError("invalid-archive", "Archive central directory entry is invalid");
    }
    const flags = readUint16(bytes, offset + 8);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > eocd) throw new SkillArchiveError("invalid-archive", "Archive entry name is truncated");
    const uncompressedSize = readUint32(bytes, offset + 24);
    if (uncompressedSize === ZIP64_MARKER_32 || readUint32(bytes, offset + 20) === ZIP64_MARKER_32) {
      throw new SkillArchiveError("unsupported-archive", "ZIP64 archive entries are not supported");
    }
    entries.push({
      name: decodeEntryName(bytes.subarray(offset + 46, nameEnd)),
      flags,
      method: readUint16(bytes, offset + 10),
      uncompressedSize,
      externalAttributes: readUint32(bytes, offset + 38),
      hostOs: bytes[offset + 5] ?? 0,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function classifyEntry(entry: RawCentralEntry): "file" | "directory" {
  const unixMode = entry.externalAttributes >>> 16;
  const unixType = entry.hostOs === HOST_UNIX || unixMode !== 0 ? unixMode & UNIX_TYPE_MASK : 0;
  if (entry.name.endsWith("/") || unixType === UNIX_DIRECTORY) return "directory";
  if (entry.externalAttributes & MSDOS_DIRECTORY_ATTRIBUTE) return "directory";
  if (unixType === UNIX_SYMLINK) {
    throw new SkillArchiveError("link-entry", `Archive entry is a symbolic link: ${entry.name}`);
  }
  if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE) {
    throw new SkillArchiveError("unexpected-entry-type", `Archive entry is not a regular file: ${entry.name}`);
  }
  return "file";
}

/** Regular files keep only the executable bit; setuid, setgid, and sticky bits are dropped. */
function entryMode(entry: RawCentralEntry): SkillFileMode {
  const permissions = (entry.externalAttributes >>> 16) & 0o777;
  return (permissions & 0o111) !== 0 ? "0755" : "0644";
}

/**
 * Parse and validate the archive's central directory without inflating anything. Directory
 * entries are dropped; every returned entry is a regular file with a canonical relative path.
 */
export function inspectSkillArchive(archive: Uint8Array): SkillArchiveEntry[] {
  if (archive.length > SKILL_ARCHIVE_MAX_BYTES) {
    throw new SkillArchiveError("archive-limit", `Archive exceeds ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
  }
  const seen = new Set<string>();
  const entries: SkillArchiveEntry[] = [];
  let unpackedBytes = 0;
  for (const entry of readCentralDirectory(archive)) {
    if (entry.flags & FLAG_ENCRYPTED) {
      throw new SkillArchiveError("encrypted-entry", `Archive entry is encrypted: ${entry.name}`);
    }
    if (classifyEntry(entry) === "directory") continue;
    validateSkillPath(entry.name);
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      throw new SkillArchiveError("unsupported-compression", `Archive entry uses an unsupported method: ${entry.name}`);
    }
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new SkillArchiveError("duplicate-path", `Archive entry path repeats: ${entry.name}`);
    seen.add(key);
    unpackedBytes += entry.uncompressedSize;
    if (unpackedBytes > SKILL_UNPACKED_MAX_BYTES) {
      throw new SkillArchiveError("unpacked-limit", `Archive unpacks to more than ${SKILL_UNPACKED_MAX_BYTES} bytes`);
    }
    entries.push({ path: entry.name, size: entry.uncompressedSize, mode: entryMode(entry) });
  }
  if (entries.length > SKILL_MAX_FILES) {
    throw new SkillArchiveError("too-many-files", `Archive contains more than ${SKILL_MAX_FILES} files`);
  }
  return entries;
}

export interface ExtractSkillArchiveOptions {
  /** The manifest the Server advertised for this archive. */
  readonly manifest: SkillManifest;
  /** The skill digest the Server advertised; must equal `computeSkillDigest(manifest)`. */
  readonly digest: string;
  /** Directory that receives the files; created when missing. */
  readonly destination: string;
  /** `destination` must resolve inside this root. */
  readonly root: string;
}

function assertEntriesMatchManifest(entries: readonly SkillArchiveEntry[], manifest: SkillManifest): void {
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (entries.length !== expected.size) {
    throw new SkillArchiveError("manifest-mismatch", "Archive file count differs from the skill manifest");
  }
  for (const entry of entries) {
    const file = expected.get(entry.path);
    if (!file) throw new SkillArchiveError("manifest-mismatch", `Archive contains an unlisted file: ${entry.path}`);
    if (file.size !== entry.size) {
      throw new SkillArchiveError("manifest-mismatch", `Archive entry size differs from the manifest: ${entry.path}`);
    }
    if (file.mode !== entry.mode) {
      throw new SkillArchiveError("manifest-mismatch", `Archive entry mode differs from the manifest: ${entry.path}`);
    }
  }
}

function inflateArchive(archive: Uint8Array, names: ReadonlySet<string>): Record<string, Uint8Array> {
  try {
    return unzipSync(archive, { filter: (file) => names.has(file.name) });
  } catch (error) {
    if (error instanceof SkillArchiveError) throw error;
    throw new SkillArchiveError("invalid-archive", `Archive could not be inflated: ${String(error)}`);
  }
}

/**
 * Validate the archive against the expected manifest and digest, then write its files into
 * `destination`. Nothing is written until every file has been verified.
 */
export async function extractSkillArchive(
  archive: Uint8Array,
  options: ExtractSkillArchiveOptions,
): Promise<SkillManifest> {
  const destination = resolve(options.destination);
  assertWithin(options.root, destination);
  if (computeSkillDigest(options.manifest) !== options.digest) {
    throw new SkillArchiveError("digest-mismatch", "Skill manifest does not hash to the advertised digest");
  }
  const entries = inspectSkillArchive(archive);
  assertEntriesMatchManifest(entries, options.manifest);
  const inflated = inflateArchive(archive, new Set(entries.map((entry) => entry.path)));
  const contents = new Map<string, Uint8Array>();
  for (const file of options.manifest.files) {
    const content = inflated[file.path];
    if (!content || content.length !== file.size || sha256Hex(content) !== file.sha256) {
      throw new SkillArchiveError("content-mismatch", `Archive entry content differs from the manifest: ${file.path}`);
    }
    contents.set(file.path, content);
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of options.manifest.files) {
    const target = resolve(destination, ...file.path.split("/"));
    assertWithin(destination, target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const content = contents.get(file.path) as Uint8Array;
    await writeFile(target, content, { flag: "wx", mode: file.mode === "0755" ? 0o700 : 0o600 });
  }
  return {
    schemaVersion: options.manifest.schemaVersion,
    name: options.manifest.name,
    files: entries.map((entry) => {
      const content = contents.get(entry.path) as Uint8Array;
      return { path: entry.path, sha256: sha256Hex(content), size: entry.size, mode: entry.mode };
    }),
  };
}

export interface PackedSkillDirectory {
  readonly bytes: Uint8Array;
  readonly files: readonly SkillFileEntry[];
  readonly fileCount: number;
  readonly totalBytes: number;
}

interface CollectedFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly mode: SkillFileMode;
  readonly size: number;
}

function classifyLocalEntry(status: Stats, relativePath: string): "directory" | "file" {
  if (status.isSymbolicLink()) {
    throw new SkillArchiveError("link-entry", `Symbolic links are not packed: ${relativePath}`);
  }
  if (status.isDirectory()) return "directory";
  if (!status.isFile()) {
    throw new SkillArchiveError("unexpected-entry-type", `Only regular files are packed: ${relativePath}`);
  }
  return "file";
}

async function collectSkillFiles(root: string, relativeDirectory: string, output: CollectedFile[]): Promise<void> {
  const directory = relativeDirectory ? join(root, relativeDirectory) : root;
  const names = (await readdir(directory)).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  for (const name of names) {
    if (SKIPPED_DIRECTORY_ENTRIES.has(name)) continue;
    const relativePath = relativeDirectory ? posix.join(relativeDirectory, name) : name;
    const absolutePath = join(directory, name);
    const status = await lstat(absolutePath);
    if (classifyLocalEntry(status, relativePath) === "directory") {
      await collectSkillFiles(root, relativePath, output);
      continue;
    }
    validateSkillPath(relativePath);
    output.push({
      path: relativePath,
      absolutePath,
      mode: (status.mode & 0o111) !== 0 ? "0755" : "0644",
      size: status.size,
    });
    if (output.length > SKILL_MAX_FILES) {
      throw new SkillArchiveError("too-many-files", `Skill directories may contain at most ${SKILL_MAX_FILES} files`);
    }
  }
}

/**
 * Pack a skill directory into the canonical zip: paths in UTF-8 byte order, a fixed timestamp,
 * Unix attributes carrying only the executable bit. `.git/`, `node_modules/`, and `.DS_Store`
 * are skipped; symbolic links and special files are rejected.
 */
export async function packSkillDirectory(directory: string): Promise<PackedSkillDirectory> {
  const root = resolve(directory);
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new SkillArchiveError("unexpected-entry-type", "A skill must be packed from a real directory");
  }
  const collected: CollectedFile[] = [];
  await collectSkillFiles(root, "", collected);
  if (!collected.some((file) => file.path === SKILL_FILE_NAME)) {
    throw new SkillArchiveError("skill-md-missing", `The skill directory has no ${SKILL_FILE_NAME} at its root`);
  }
  const totalBytes = collected.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > SKILL_UNPACKED_MAX_BYTES) {
    throw new SkillArchiveError("unpacked-limit", `Skill files exceed ${SKILL_UNPACKED_MAX_BYTES} bytes`);
  }
  const zippable: Record<string, [Uint8Array, { mtime: Date; os: number; attrs: number }]> = {};
  const files: SkillFileEntry[] = [];
  for (const file of collected) {
    const content = new Uint8Array(await readFile(file.absolutePath));
    const permissions = file.mode === "0755" ? 0o755 : 0o644;
    zippable[file.path] = [
      content,
      { mtime: FIXED_MTIME, os: HOST_UNIX, attrs: (UNIX_REGULAR_FILE | permissions) << 16 },
    ];
    files.push({ path: file.path, sha256: sha256Hex(content), size: content.length, mode: file.mode });
  }
  const bytes = zipSync(zippable, { level: 6, mtime: FIXED_MTIME, os: HOST_UNIX });
  if (bytes.length > SKILL_ARCHIVE_MAX_BYTES) {
    throw new SkillArchiveError("archive-limit", `The packed skill exceeds ${SKILL_ARCHIVE_MAX_BYTES} bytes`);
  }
  return { bytes, files, fileCount: files.length, totalBytes };
}
