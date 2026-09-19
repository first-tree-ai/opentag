import { createHash } from "node:crypto";
import {
  isReservedSkillName,
  parseSkillManifest,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_MANIFEST_FILE,
  SKILL_MANIFEST_MAX_BYTES,
  SKILL_MAX_LISTED_FILES,
  type SkillArchiveFormat,
  type SkillFileEntry,
  type SkillManifest,
} from "@opentag/shared";
import { gzipSync } from "fflate";
import { type Pack, type Headers as TarHeaders, pack as tarPack } from "tar-stream";
import { skillArchiveTooLarge, skillManifestInvalid, skillNameReserved } from "./errors.js";
import { type RawSkillEntry, readSkillEntries } from "./skill-archive-reader.js";

/**
 * Validates an untrusted Skill upload and re-packs it deterministically.
 *
 * Every member is checked before its bytes are trusted: paths are root-relative and bounded, links,
 * special files, setuid/setgid bits, and duplicate or oversized members are rejected, a single shared
 * top-level directory is stripped, and a root `SKILL.md` is required and parsed. The stored archive is
 * then rebuilt from scratch — entries sorted by path, mtime/uid/gid zeroed, permissions fixed to 0644
 * or 0755, gzip with a fixed level and timestamp — so the same logical tree always yields the same
 * bytes and the same sha256 regardless of how the uploader ordered or timestamped its members.
 *
 * The stored sha256 is therefore the Server's, not the uploader's; the request's declared hash is an
 * integrity check on the transfer, verified by the caller before this runs.
 */

export interface NormalizedSkillArchive {
  manifest: SkillManifest;
  files: SkillFileEntry[];
  filesTruncated: boolean;
  fileCount: number;
  /** The canonical stored `tar.gz` bytes. */
  archive: Uint8Array;
  /** Lowercase hex SHA-256 over `archive`. */
  sha256: string;
}

function byPath(a: RawSkillEntry, b: RawSkillEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Strips one shared top-level directory when every member lives beneath it. */
function stripSingleRoot(entries: RawSkillEntry[]): RawSkillEntry[] {
  if (entries.length === 0) return entries;
  let root: string | undefined;
  for (const entry of entries) {
    const slash = entry.path.indexOf("/");
    if (slash <= 0) return entries;
    const candidate = entry.path.slice(0, slash);
    if (root === undefined) root = candidate;
    else if (root !== candidate) return entries;
  }
  if (root === undefined) return entries;
  const prefix = `${root}/`;
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
}

function requireManifest(entries: RawSkillEntry[]): SkillManifest {
  const manifestEntry = entries.find((entry) => entry.path === SKILL_MANIFEST_FILE);
  if (!manifestEntry) throw skillManifestInvalid(`The Skill archive is missing ${SKILL_MANIFEST_FILE}`);
  if (manifestEntry.body.byteLength > SKILL_MANIFEST_MAX_BYTES) {
    throw skillManifestInvalid(`${SKILL_MANIFEST_FILE} exceeds the size bound`);
  }
  const parsed = parseSkillManifest(new TextDecoder().decode(manifestEntry.body));
  if (!parsed.ok) throw skillManifestInvalid(parsed.reason);
  if (isReservedSkillName(parsed.manifest.name)) throw skillNameReserved(parsed.manifest.name);
  return parsed.manifest;
}

function toFileList(entries: RawSkillEntry[]): { files: SkillFileEntry[]; filesTruncated: boolean } {
  const sorted = [...entries].sort(byPath);
  return {
    files: sorted.slice(0, SKILL_MAX_LISTED_FILES).map((entry) => ({
      path: entry.path,
      bytes: entry.body.byteLength,
    })),
    filesTruncated: sorted.length > SKILL_MAX_LISTED_FILES,
  };
}

function writeTarEntry(pack: Pack, entry: RawSkillEntry): Promise<void> {
  const mode = (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
  const header: TarHeaders = {
    name: entry.path,
    type: "file",
    size: entry.body.byteLength,
    mode,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
  };
  return new Promise((resolve, reject) => {
    const sink = pack.entry(header, (error) => (error ? reject(error) : resolve()));
    sink.end(Buffer.from(entry.body));
  });
}

/** Re-packs entries into canonical `tar.gz` bytes: sorted, metadata-zeroed, fixed gzip settings. */
async function packDeterministic(entries: RawSkillEntry[]): Promise<Uint8Array> {
  const pack = tarPack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  try {
    for (const entry of [...entries].sort(byPath)) await writeTarEntry(pack, entry);
    pack.finalize();
    await finished;
  } catch (error) {
    pack.destroy();
    throw error;
  }
  return gzipSync(new Uint8Array(Buffer.concat(chunks)), { level: 6, mtime: 0 });
}

export async function normalizeSkillArchive(
  bytes: Uint8Array,
  format: SkillArchiveFormat,
): Promise<NormalizedSkillArchive> {
  if (bytes.byteLength === 0 || bytes.byteLength > SKILL_ARCHIVE_MAX_BYTES) throw skillArchiveTooLarge();
  const entries = stripSingleRoot(await readSkillEntries(bytes, format));
  if (entries.length === 0) throw skillManifestInvalid("The Skill archive carries no files");
  const manifest = requireManifest(entries);
  const { files, filesTruncated } = toFileList(entries);
  const archive = await packDeterministic(entries);
  return {
    manifest,
    files,
    filesTruncated,
    fileCount: entries.length,
    archive,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}
