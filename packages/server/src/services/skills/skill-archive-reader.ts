import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  SKILL_MAX_ENTRIES,
  SKILL_MAX_PATH_BYTES,
  SKILL_UNPACKED_MAX_BYTES,
  type SkillArchiveFormat,
} from "@opentag/shared";
import { type Unzipped, unzipSync } from "fflate";
import { type Entry as TarEntry, type Headers as TarHeaders, extract as tarExtract } from "tar-stream";
import { SkillServiceError, skillArchiveInvalid, skillArchiveTooLarge } from "./errors.js";

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

/** Reads one tar entry body, refusing to read past its declared size or the global unpacked cap. */
async function readTarEntryBody(entry: AsyncIterable<Uint8Array>, size: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of entry) {
    total += chunk.byteLength;
    if (total > size || total > SKILL_UNPACKED_MAX_BYTES) {
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
  if (state.declaredBytes > SKILL_UNPACKED_MAX_BYTES) throw skillArchiveTooLarge();
  const body = await readTarEntryBody(entry, size);
  return { path, body, mode };
}

async function readTarGzEntries(bytes: Uint8Array): Promise<RawSkillEntry[]> {
  const source = Readable.from([bytes]);
  const gunzip = createGunzip();
  const extract = tarExtract();
  const streamed = pipeline(source, gunzip, extract);
  const entries: RawSkillEntry[] = [];
  const state = { seen: new Set<string>(), declaredBytes: 0 };
  let count = 0;
  try {
    for await (const entry of extract) {
      count += 1;
      if (count > SKILL_MAX_ENTRIES) throw skillArchiveTooLarge();
      const collected = await collectTarEntry(entry, state);
      if (collected) entries.push(collected);
    }
    await streamed;
    return entries;
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    extract.destroy();
    await streamed.catch(() => undefined);
    throw mapArchiveReadError(error);
  }
}

function readZipEntries(bytes: Uint8Array): RawSkillEntry[] {
  const state = { seen: new Set<string>(), declaredBytes: 0, count: 0 };
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(bytes, {
      filter: (info) => {
        state.count += 1;
        if (state.count > SKILL_MAX_ENTRIES) throw skillArchiveTooLarge();
        if (!Number.isSafeInteger(info.originalSize) || info.originalSize < 0) {
          throw skillArchiveInvalid("Skill archive member declares an invalid size");
        }
        state.declaredBytes += info.originalSize;
        if (state.declaredBytes > SKILL_UNPACKED_MAX_BYTES) throw skillArchiveTooLarge();
        return true;
      },
    });
  } catch (error) {
    throw mapArchiveReadError(error);
  }
  const entries: RawSkillEntry[] = [];
  for (const [rawName, body] of Object.entries(unzipped)) {
    if (rawName.endsWith("/") || body === undefined) continue;
    const path = normalizeMemberPath(rawName);
    if (isIgnoredSkillPath(path)) continue;
    if (state.seen.has(path)) throw skillArchiveInvalid(`Skill archive member is duplicated: ${path}`);
    state.seen.add(path);
    entries.push({ path, body, mode: 0o644 });
  }
  return entries;
}

export async function readSkillEntries(bytes: Uint8Array, format: SkillArchiveFormat): Promise<RawSkillEntry[]> {
  return format === "zip" ? readZipEntries(bytes) : readTarGzEntries(bytes);
}
