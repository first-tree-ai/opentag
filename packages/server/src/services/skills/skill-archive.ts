import { createHash } from "node:crypto";
import {
  SKILL_FILE_NAME,
  SKILL_FILE_PATH_MAX_BYTES,
  SKILL_FILE_PATH_SEGMENT_MAX_BYTES,
  SKILL_MAX_FILES,
  SKILL_UNPACKED_MAX_BYTES,
  type SkillFileMode,
} from "@opentag/shared";
import { zipSync } from "fflate";
import {
  skillArchiveInvalid,
  skillArchiveInvalidPath,
  skillArchiveTooLarge,
  skillArchiveTooManyFiles,
  skillManifestInvalid,
} from "./errors.js";
import { parseSkillFrontmatter } from "./skill-frontmatter.js";
import { readZipDirectory, readZipEntry, rewriteZipTimestamps, type ZipEntry } from "./zip-reader.js";

export interface SkillArchiveFile {
  bytes: Uint8Array;
  mode: SkillFileMode;
}

export interface ExtractedSkillArchive {
  name: string;
  description: string;
  skillMd: string;
  /** Paths relative to the skill root, sorted by UTF-8 byte order. */
  files: Map<string, SkillArchiveFile>;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const EXECUTE_BITS = 0o111;
const DOS_DIRECTORY = 0x10;
const IGNORED_TOP_LEVEL = new Set(["__MACOSX"]);
/** 1980-01-01 00:00:00, the zip epoch; every repacked entry carries it so equal content yields equal bytes. */
const FIXED_DOS_DATE = (1 << 5) | 1;
const FIXED_DOS_TIME = 0;
const REPACK_LEVEL = 6;
const utf8 = new TextEncoder();

function isDirectory(entry: ZipEntry): boolean {
  return (
    entry.name.endsWith("/") || (entry.unixMode & S_IFMT) === S_IFDIR || (entry.dosAttributes & DOS_DIRECTORY) !== 0
  );
}

function isIgnored(entry: ZipEntry): boolean {
  const first = entry.name.split("/")[0] ?? "";
  return IGNORED_TOP_LEVEL.has(first);
}

function requireRegularFile(entry: ZipEntry): void {
  const type = entry.unixMode & S_IFMT;
  if (type === S_IFLNK) throw skillArchiveInvalidPath(entry.name, "symbolic links are not allowed");
  if (type !== 0 && type !== S_IFREG) throw skillArchiveInvalidPath(entry.name, "only regular files are allowed");
}

function validateSegments(path: string): void {
  for (const segment of path.split("/")) {
    if (segment === "") throw skillArchiveInvalidPath(path, "empty path segments are not allowed");
    if (segment === "." || segment === "..") throw skillArchiveInvalidPath(path, "path traversal is not allowed");
    if (utf8.encode(segment).byteLength > SKILL_FILE_PATH_SEGMENT_MAX_BYTES) {
      throw skillArchiveInvalidPath(path, `a path segment exceeds ${SKILL_FILE_PATH_SEGMENT_MAX_BYTES} bytes`);
    }
  }
}

function hasControlCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validatePath(path: string): void {
  if (utf8.encode(path).byteLength > SKILL_FILE_PATH_MAX_BYTES) {
    throw skillArchiveInvalidPath(path, `the path exceeds ${SKILL_FILE_PATH_MAX_BYTES} bytes`);
  }
  if (path.includes("\\")) throw skillArchiveInvalidPath(path, "backslashes are not allowed");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw skillArchiveInvalidPath(path, "absolute paths are not allowed");
  }
  if (hasControlCharacter(path)) throw skillArchiveInvalidPath(path, "control characters are not allowed");
  validateSegments(path);
}

function fileEntries(bytes: Uint8Array): ZipEntry[] {
  const { entries } = readZipDirectory(bytes);
  const files = entries.filter((entry) => !isDirectory(entry) && !isIgnored(entry));
  if (files.length === 0) throw skillArchiveInvalid("The skill archive contains no files");
  if (files.length > SKILL_MAX_FILES) throw skillArchiveTooManyFiles(SKILL_MAX_FILES);
  let total = 0;
  for (const entry of files) {
    validatePath(entry.name);
    requireRegularFile(entry);
    total += entry.uncompressedSize;
  }
  if (total > SKILL_UNPACKED_MAX_BYTES) {
    throw skillArchiveTooLarge(`The skill archive expands to more than ${SKILL_UNPACKED_MAX_BYTES} bytes`);
  }
  return files;
}

/**
 * The archive root is either the skill root itself or a single directory wrapping it. Anything else is rejected, so
 * a nested-directory zip never silently becomes a skill whose SKILL.md sits in a subdirectory.
 */
function rootPrefix(entries: ZipEntry[]): string {
  const paths = new Set(entries.map((entry) => entry.name));
  if (paths.has(SKILL_FILE_NAME)) return "";
  const topLevel = new Set(entries.map((entry) => entry.name.split("/")[0] ?? ""));
  const [only] = [...topLevel];
  if (topLevel.size === 1 && only !== undefined && paths.has(`${only}/${SKILL_FILE_NAME}`)) return `${only}/`;
  throw skillManifestInvalid(
    SKILL_FILE_NAME,
    "SKILL.md must be at the archive root or inside a single top-level directory",
  );
}

function fileMode(entry: ZipEntry): SkillFileMode {
  return (entry.unixMode & S_IFMT) === S_IFREG && (entry.unixMode & EXECUTE_BITS) !== 0 ? "0755" : "0644";
}

function collisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortFiles(files: Map<string, SkillArchiveFile>): Map<string, SkillArchiveFile> {
  return new Map([...files.entries()].sort(([left], [right]) => compareUtf8(left, right)));
}

function collectFiles(bytes: Uint8Array, entries: ZipEntry[], prefix: string): Map<string, SkillArchiveFile> {
  const files = new Map<string, SkillArchiveFile>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = entry.name.slice(prefix.length);
    if (path === "") throw skillArchiveInvalidPath(entry.name, "the entry has no file name");
    const key = collisionKey(path);
    if (seen.has(key)) throw skillArchiveInvalidPath(entry.name, "the path collides with another entry");
    seen.add(key);
    files.set(path, { bytes: readZipEntry(bytes, entry), mode: fileMode(entry) });
  }
  return sortFiles(files);
}

/** Validate an uploaded zip against every archive rule and return its normalized content. */
export function extractSkillArchive(bytes: Uint8Array): ExtractedSkillArchive {
  const entries = fileEntries(bytes);
  const prefix = rootPrefix(entries);
  const files = collectFiles(bytes, entries, prefix);
  const skillMd = files.get(SKILL_FILE_NAME);
  if (!skillMd) throw skillManifestInvalid(SKILL_FILE_NAME, "SKILL.md is missing");
  const frontmatter = parseSkillFrontmatter(skillMd.bytes);
  return { name: frontmatter.name, description: frontmatter.description, skillMd: frontmatter.markdown, files };
}

/**
 * Deterministically repack normalized files: sorted paths, fixed timestamps, Unix attributes carrying only the
 * regular-file bit plus 0644/0755, deflate level 6. Equal content always yields an identical archive and sha256.
 */
export function repackSkillArchive(files: Map<string, SkillArchiveFile>): { bytes: Uint8Array; sha256: string } {
  const zippable: Record<
    string,
    [Uint8Array, { level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; os: number; attrs: number }]
  > = {};
  for (const [path, file] of sortFiles(files)) {
    const mode = file.mode === "0755" ? 0o755 : 0o644;
    zippable[path] = [file.bytes, { level: REPACK_LEVEL, os: 3, attrs: (S_IFREG | mode) << 16 }];
  }
  const bytes = zipSync(zippable, { level: REPACK_LEVEL });
  rewriteZipTimestamps(bytes, readZipDirectory(bytes), FIXED_DOS_TIME, FIXED_DOS_DATE);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
