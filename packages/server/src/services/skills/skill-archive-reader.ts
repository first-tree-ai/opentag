import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_MAX_ENTRIES,
  SKILL_MAX_PATH_BYTES,
  SKILL_UNPACKED_MAX_BYTES,
  type SkillArchiveFormat,
} from "@opentag/shared";
import { type UnzipFileInfo, type Unzipped, unzipSync } from "fflate";
import { type Entry as TarEntry, type Headers as TarHeaders, extract as tarExtract } from "tar-stream";
import { SkillServiceError, skillArchiveInvalid, skillArchiveTooLarge } from "./errors.js";
import { readZipDirectory, type ZipDirectoryEntry } from "./skill-zip-directory.js";

/**
 * Reads a Skill upload into a flat list of file members.
 *
 * This module is the untrusted-input boundary: member paths are normalized and bounded here, and
 * every unsafe member shape is rejected before any of its bytes are trusted. A `tar.gz` is streamed
 * through a bounded gunzip + tar reader so a compressed bomb is cut off at the declared entry size,
 * and a `zip` is inspected through `fflate`'s central-directory filter so an entry is bounded by its
 * declared uncompressed size before it is inflated. The caller re-packs deterministically; nothing
 * here preserves the input's ordering, metadata, or compression.
 */

export interface RawSkillEntry {
  /** Root-relative POSIX path, already normalized. */
  path: string;
  body: Uint8Array;
  /** Original permission bits, used only to decide the exec bit on re-pack. */
  mode: number;
}

/**
 * Injectable ceilings so tests can exercise a bound cheaply without materializing a real bomb. All
 * values default to the production constants; `DEFAULT_MAX_TAR_STREAM_BYTES` is the default guard
 * over the decompressed tar stream (payload plus bounded per-member framing).
 */
export interface SkillReadLimits {
  maxArchiveBytes?: number;
  maxUnpackedBytes?: number;
  maxTarStreamBytes?: number;
}

export interface ResolvedSkillReadLimits {
  maxArchiveBytes: number;
  maxUnpackedBytes: number;
  maxTarStreamBytes: number;
}

export const DEFAULT_MAX_TAR_STREAM_BYTES = SKILL_UNPACKED_MAX_BYTES + (SKILL_MAX_ENTRIES + 2) * 512 * 2;

export function resolveSkillReadLimits(limits?: SkillReadLimits): ResolvedSkillReadLimits {
  const resolved: ResolvedSkillReadLimits = {
    maxArchiveBytes: limits?.maxArchiveBytes ?? SKILL_ARCHIVE_MAX_BYTES,
    maxUnpackedBytes: limits?.maxUnpackedBytes ?? SKILL_UNPACKED_MAX_BYTES,
    maxTarStreamBytes: limits?.maxTarStreamBytes ?? DEFAULT_MAX_TAR_STREAM_BYTES,
  };
  for (const [label, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw skillArchiveInvalid(`Skill read limit ${label} must be a positive integer`);
    }
  }
  return resolved;
}

/**
 * Normalizes a member name to a root-relative POSIX path, rejecting anything absolute, ambiguous,
 * or escaping the root. Directory pseudo-entries and empty names are dropped by the caller.
 */
export function normalizeMemberPath(rawName: string): string {
  if (typeof rawName !== "string" || rawName.length === 0) {
    throw skillArchiveInvalid("Skill archive member has no name");
  }
  if (rawName.includes("\0")) throw skillArchiveInvalid("Skill archive member name contains a NUL byte");
  if (rawName.includes("\\")) throw skillArchiveInvalid("Skill archive member name contains a backslash");
  if (rawName.startsWith("/") || /^[A-Za-z]:[\\/]?/.test(rawName)) {
    throw skillArchiveInvalid(`Skill archive member name is absolute: ${rawName}`);
  }
  const segments: string[] = [];
  for (const segment of rawName.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw skillArchiveInvalid(`Skill archive member escapes the root: ${rawName}`);
    segments.push(segment);
  }
  const path = segments.join("/");
  if (path.length === 0) throw skillArchiveInvalid("Skill archive member has an empty path");
  if (Buffer.byteLength(path, "utf8") > SKILL_MAX_PATH_BYTES) {
    throw skillArchiveInvalid("Skill archive member path exceeds the length bound");
  }
  return path;
}

/** `__MACOSX` metadata and `.DS_Store` files are ignored, as they are not part of the Skill. */
export function isIgnoredSkillPath(path: string): boolean {
  if (path === "__MACOSX" || path.startsWith("__MACOSX/")) return true;
  return path === ".DS_Store" || path.endsWith("/.DS_Store");
}

function assertTarEntryType(header: TarHeaders): void {
  if (header.type === "file" || header.type === "contiguous-file" || header.type == null) return;
  if (header.type === "symlink" || header.type === "link") {
    throw skillArchiveInvalid("Skill archive may not contain links");
  }
  if (header.type === "character-device" || header.type === "block-device" || header.type === "fifo") {
    throw skillArchiveInvalid("Skill archive may not contain special files");
  }
  throw skillArchiveInvalid(`Skill archive member has an unsupported type: ${header.type}`);
}

function mapArchiveReadError(error: unknown): SkillServiceError {
  if (error instanceof SkillServiceError) return error;
  return skillArchiveInvalid("Skill archive could not be read");
}

/** Counts decompressed bytes as they pass and fails the stream once the ceiling is exceeded. */
function createTarStreamMeter(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(skillArchiveTooLarge());
      else callback(null, chunk);
    },
  });
}

/** Reads one tar entry body, refusing to read past its declared size or the global unpacked cap. */
async function readTarEntryBody(
  entry: AsyncIterable<Uint8Array>,
  size: number,
  maxUnpackedBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of entry) {
    total += chunk.byteLength;
    if (total > size || total > maxUnpackedBytes) {
      throw skillArchiveInvalid("Skill archive member exceeds its declared size");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (total !== size) throw skillArchiveInvalid("Skill archive member is truncated");
  return new Uint8Array(Buffer.concat(chunks));
}

/** Validates and reads one tar entry, returning its normalized record or `null` when ignored. */
async function collectTarEntry(
  entry: TarEntry,
  state: { seen: Set<string>; declaredBytes: number },
  maxUnpackedBytes: number,
): Promise<RawSkillEntry | null> {
  const header = entry.header;
  if ((header.type ?? "file") === "directory") {
    entry.resume();
    return null;
  }
  assertTarEntryType(header);
  const mode = typeof header.mode === "number" ? header.mode : 0o644;
  if ((mode & 0o6000) !== 0) {
    throw skillArchiveInvalid("Skill archive member carries a setuid or setgid bit");
  }
  const path = normalizeMemberPath(header.name);
  if (isIgnoredSkillPath(path)) {
    entry.resume();
    return null;
  }
  if (state.seen.has(path)) throw skillArchiveInvalid(`Skill archive member is duplicated: ${path}`);
  state.seen.add(path);
  const size = typeof header.size === "number" && header.size >= 0 ? header.size : 0;
  state.declaredBytes += size;
  if (state.declaredBytes > maxUnpackedBytes) throw skillArchiveTooLarge();
  const body = await readTarEntryBody(entry, size, maxUnpackedBytes);
  return { path, body, mode };
}

async function readTarGzEntries(
  bytes: Uint8Array,
  limits: { maxUnpackedBytes: number; maxTarStreamBytes: number },
): Promise<RawSkillEntry[]> {
  const source = Readable.from([bytes]);
  const gunzip = createGunzip();
  const meter = createTarStreamMeter(limits.maxTarStreamBytes);
  const extract = tarExtract();
  const streamed = pipeline(source, gunzip, meter, extract);
  const entries: RawSkillEntry[] = [];
  const state = { seen: new Set<string>(), declaredBytes: 0 };
  let count = 0;
  try {
    for await (const entry of extract) {
      count += 1;
      if (count > SKILL_MAX_ENTRIES) throw skillArchiveInvalid("Skill archive has too many members");
      const collected = await collectTarEntry(entry, state, limits.maxUnpackedBytes);
      if (collected) entries.push(collected);
    }
    await streamed;
    return entries;
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    meter.destroy();
    extract.destroy();
    await streamed.catch(() => undefined);
    throw mapArchiveReadError(error);
  }
}

interface ZipBoundsState {
  seen: Set<string>;
  declaredBytes: number;
  compressedBytes: number;
  count: number;
}

/**
 * Bounds one zip central-directory entry before `unzipSync` produces its bytes.
 *
 * The declared `originalSize` alone is not trustworthy: a STORED entry is copied as its compressed
 * `size` bytes, and every central-directory entry may point at the SAME local data. The compressed
 * sizes are therefore summed against the input length — overlapping members cannot all fit inside
 * the archive — and a stored entry whose two sizes disagree is rejected outright.
 */
function assertZipEntryWithinBounds(
  info: UnzipFileInfo,
  state: ZipBoundsState,
  inputBytes: number,
  maxUnpackedBytes: number,
): void {
  state.count += 1;
  if (state.count > SKILL_MAX_ENTRIES) throw skillArchiveInvalid("Skill archive has too many members");
  if (
    !Number.isSafeInteger(info.size) ||
    info.size < 0 ||
    !Number.isSafeInteger(info.originalSize) ||
    info.originalSize < 0
  ) {
    throw skillArchiveInvalid("Skill archive member declares an invalid size");
  }
  if (info.compression === 0 && info.size !== info.originalSize) {
    throw skillArchiveInvalid("Skill archive member declares inconsistent stored sizes");
  }
  state.compressedBytes += info.size;
  if (state.compressedBytes > inputBytes) throw skillArchiveInvalid("Skill archive members overlap");
  if (info.originalSize > maxUnpackedBytes) throw skillArchiveTooLarge();
  state.declaredBytes += info.originalSize;
  if (state.declaredBytes > maxUnpackedBytes) throw skillArchiveTooLarge();
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/**
 * The canonical mode for a zip member: `0755` when a Unix-made regular file carries any execute bit,
 * `0644` otherwise — the same normalization the tar path applies. A Unix symlink, a special file, or
 * any setuid/setgid/sticky bit is rejected; a DOS/Windows entry has no mode to lose, so it is `0644`.
 */
function canonicalZipMode(rawName: string, directory: Map<string, ZipDirectoryEntry>): number {
  const info = directory.get(rawName);
  if (!info?.madeByUnix || info.unixMode === 0) return 0o644;
  const type = info.unixMode & S_IFMT;
  if (type === S_IFLNK) throw skillArchiveInvalid("Skill archive may not contain links");
  if (type !== S_IFREG && type !== S_IFDIR) {
    throw skillArchiveInvalid("Skill archive may not contain special files");
  }
  if ((info.unixMode & 0o7000) !== 0) {
    throw skillArchiveInvalid("Skill archive member carries a setuid or setgid bit");
  }
  return (info.unixMode & 0o111) !== 0 ? 0o755 : 0o644;
}

function readZipEntries(bytes: Uint8Array, maxUnpackedBytes: number): RawSkillEntry[] {
  const directory = new Map<string, ZipDirectoryEntry>();
  for (const item of readZipDirectory(bytes, SKILL_MAX_ENTRIES + 1)) directory.set(item.name, item);
  const state: ZipBoundsState = { seen: new Set<string>(), declaredBytes: 0, compressedBytes: 0, count: 0 };
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(bytes, {
      filter: (info) => {
        assertZipEntryWithinBounds(info, state, bytes.byteLength, maxUnpackedBytes);
        return true;
      },
    });
  } catch (error) {
    throw mapArchiveReadError(error);
  }
  // Backstop on the bytes that actually exist, independent of any declared size.
  let actualBytes = 0;
  for (const body of Object.values(unzipped)) actualBytes += body?.byteLength ?? 0;
  if (actualBytes > maxUnpackedBytes) throw skillArchiveTooLarge();
  const entries: RawSkillEntry[] = [];
  for (const [rawName, body] of Object.entries(unzipped)) {
    if (rawName.endsWith("/") || body === undefined) continue;
    const path = normalizeMemberPath(rawName);
    if (isIgnoredSkillPath(path)) continue;
    if (state.seen.has(path)) throw skillArchiveInvalid(`Skill archive member is duplicated: ${path}`);
    state.seen.add(path);
    entries.push({ path, body, mode: canonicalZipMode(rawName, directory) });
  }
  return entries;
}

export async function readSkillEntries(
  bytes: Uint8Array,
  format: SkillArchiveFormat,
  limits?: SkillReadLimits,
): Promise<RawSkillEntry[]> {
  const resolved = resolveSkillReadLimits(limits);
  return format === "zip" ? readZipEntries(bytes, resolved.maxUnpackedBytes) : readTarGzEntries(bytes, resolved);
}
