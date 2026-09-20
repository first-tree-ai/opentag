import { skillArchiveInvalid } from "./errors.js";

/**
 * A bounded reader for the ZIP central directory.
 *
 * `fflate` inflates an archive but does not expose the Unix mode living in each central-directory
 * record's `externalFileAttributes`, so ZIP imports would otherwise lose the execute bit and could
 * never see a symlink. This parser walks exactly the central directory — bounded by entry count and
 * by every offset and length — and returns only the two fields that matter: whether the entry was
 * made on Unix, and its Unix mode. Anything malformed is a typed `SKILL_ARCHIVE_INVALID`, so a
 * hostile archive never reaches `unzipSync` and never allocates.
 */

export interface ZipDirectoryEntry {
  name: string;
  madeByUnix: boolean;
  unixMode: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_HEADER_BYTES = 46;
const ZIP64_SENTINEL = 0xffff;

function reader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u16: (offset: number): number => view.getUint16(offset, true),
    u32: (offset: number): number => view.getUint32(offset, true),
  };
}

/** Finds the End Of Central Directory record by scanning back over the optional comment. */
function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const { u32 } = reader(bytes);
  const lowest = Math.max(0, bytes.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let offset = bytes.length - EOCD_MIN_BYTES; offset >= lowest; offset -= 1) {
    if (u32(offset) === EOCD_SIGNATURE) return offset;
  }
  throw skillArchiveInvalid("Skill archive is not a zip with a central directory");
}

function decodeName(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, start + length));
}

export function readZipDirectory(bytes: Uint8Array, maxEntries: number): ZipDirectoryEntry[] {
  const end = findEndOfCentralDirectory(bytes);
  const { u16, u32 } = reader(bytes);
  const count = u16(end + 10);
  if (count === ZIP64_SENTINEL || count > maxEntries) {
    throw skillArchiveInvalid("Skill archive has too many members");
  }
  const directorySize = u32(end + 12);
  const directoryOffset = u32(end + 16);
  if (directoryOffset + directorySize > bytes.length) {
    throw skillArchiveInvalid("Skill archive central directory is out of bounds");
  }

  const entries: ZipDirectoryEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > bytes.length) {
      throw skillArchiveInvalid("Skill archive central directory record is truncated");
    }
    if (u32(cursor) !== CENTRAL_SIGNATURE) {
      throw skillArchiveInvalid("Skill archive central directory record is malformed");
    }
    const madeByUnix = u16(cursor + 4) >> 8 === 3;
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const nameStart = cursor + CENTRAL_HEADER_BYTES;
    if (nameStart + nameLength + extraLength + commentLength > bytes.length) {
      throw skillArchiveInvalid("Skill archive central directory record is out of bounds");
    }
    entries.push({
      name: decodeName(bytes, nameStart, nameLength),
      madeByUnix,
      unixMode: (u32(cursor + 38) >>> 16) & 0xffff,
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}
