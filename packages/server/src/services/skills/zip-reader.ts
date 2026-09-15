import { inflateSync } from "fflate";
import { skillArchiveInvalid } from "./errors.js";

/**
 * A minimal, strict reader for the zip central directory.
 *
 * fflate's `unzipSync` inflates every entry and discards the external attributes, so it cannot tell a symbolic link
 * from a file or refuse an oversized entry before inflating it. This reader walks the central directory itself,
 * exposes the raw metadata the validation rules need, and hands only the compressed bytes to fflate.
 *
 * Deliberately unsupported: encryption, zip64, multi-disk archives, and compression methods other than stored and
 * deflate. Skill archives are at most 5 MiB, so none of them is needed.
 */

export interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  /** High 16 bits of the external attributes on Unix creators; 0 when the creator recorded no Unix mode. */
  unixMode: number;
  /** DOS attribute bits (low byte of the external attributes). */
  dosAttributes: number;
  localHeaderOffset: number;
  /** Offset of this entry's central directory header, for in-place metadata rewrites. */
  centralHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const CENTRAL_MIN_BYTES = 46;
const LOCAL_MIN_BYTES = 30;
const MAX_COMMENT_BYTES = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const data = view(bytes);
  const floor = Math.max(0, bytes.byteLength - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let offset = bytes.byteLength - EOCD_MIN_BYTES; offset >= floor; offset -= 1) {
    if (data.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw skillArchiveInvalid("The upload is not a zip archive");
}

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw skillArchiveInvalid("A zip entry name is not valid UTF-8");
  }
}

function readCentralEntry(bytes: Uint8Array, offset: number): { entry: ZipEntry; next: number } {
  const data = view(bytes);
  if (offset + CENTRAL_MIN_BYTES > bytes.byteLength || data.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
    throw skillArchiveInvalid("The zip central directory is corrupt");
  }
  const flags = data.getUint16(offset + 8, true);
  if (flags & FLAG_ENCRYPTED) throw skillArchiveInvalid("Encrypted zip archives are not supported");
  const compressedSize = data.getUint32(offset + 20, true);
  const uncompressedSize = data.getUint32(offset + 24, true);
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
    throw skillArchiveInvalid("Zip64 archives are not supported");
  }
  const nameLength = data.getUint16(offset + 28, true);
  const extraLength = data.getUint16(offset + 30, true);
  const commentLength = data.getUint16(offset + 32, true);
  const externalAttributes = data.getUint32(offset + 38, true);
  const nameStart = offset + CENTRAL_MIN_BYTES;
  const next = nameStart + nameLength + extraLength + commentLength;
  if (next > bytes.byteLength) throw skillArchiveInvalid("The zip central directory is truncated");
  return {
    entry: {
      name: decodeName(bytes.subarray(nameStart, nameStart + nameLength)),
      compression: data.getUint16(offset + 10, true),
      compressedSize,
      uncompressedSize,
      unixMode: externalAttributes >>> 16,
      dosAttributes: externalAttributes & 0xff,
      localHeaderOffset: data.getUint32(offset + 42, true),
      centralHeaderOffset: offset,
    },
    next,
  };
}

export interface ZipDirectory {
  entries: ZipEntry[];
  centralDirectoryOffset: number;
}

/** Parse the central directory without inflating anything. */
export function readZipDirectory(bytes: Uint8Array): ZipDirectory {
  if (bytes.byteLength < EOCD_MIN_BYTES) throw skillArchiveInvalid("The upload is not a zip archive");
  const data = view(bytes);
  const eocd = findEndOfCentralDirectory(bytes);
  const diskNumber = data.getUint16(eocd + 4, true);
  const totalEntries = data.getUint16(eocd + 10, true);
  const centralDirectoryOffset = data.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || totalEntries === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw skillArchiveInvalid("Multi-disk and zip64 archives are not supported");
  }
  if (centralDirectoryOffset > eocd) throw skillArchiveInvalid("The zip central directory is corrupt");
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const { entry, next } = readCentralEntry(bytes, offset);
    entries.push(entry);
    offset = next;
  }
  return { entries, centralDirectoryOffset };
}

function compressedSlice(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const data = view(bytes);
  const header = entry.localHeaderOffset;
  if (header + LOCAL_MIN_BYTES > bytes.byteLength || data.getUint32(header, true) !== LOCAL_SIGNATURE) {
    throw skillArchiveInvalid(`The zip entry "${entry.name}" has a corrupt local header`);
  }
  const nameLength = data.getUint16(header + 26, true);
  const extraLength = data.getUint16(header + 28, true);
  const start = header + LOCAL_MIN_BYTES + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw skillArchiveInvalid(`The zip entry "${entry.name}" is truncated`);
  return bytes.subarray(start, end);
}

/** Inflate one entry and verify it matches the size the central directory declared. */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const compressed = compressedSlice(bytes, entry);
  let content: Uint8Array;
  if (entry.compression === COMPRESSION_STORED) {
    content = compressed;
  } else if (entry.compression === COMPRESSION_DEFLATE) {
    try {
      content = inflateSync(compressed);
    } catch {
      throw skillArchiveInvalid(`The zip entry "${entry.name}" could not be decompressed`);
    }
  } else {
    throw skillArchiveInvalid(`The zip entry "${entry.name}" uses an unsupported compression method`);
  }
  if (content.byteLength !== entry.uncompressedSize) {
    throw skillArchiveInvalid(`The zip entry "${entry.name}" does not match its declared size`);
  }
  return content;
}

/** Local header mtime/mdate live at +10; central header mtime/mdate at +12. Both are two little-endian uint16s. */
export function rewriteZipTimestamps(
  bytes: Uint8Array,
  directory: ZipDirectory,
  dosTime: number,
  dosDate: number,
): void {
  const data = view(bytes);
  for (const entry of directory.entries) {
    data.setUint16(entry.localHeaderOffset + 10, dosTime, true);
    data.setUint16(entry.localHeaderOffset + 12, dosDate, true);
    data.setUint16(entry.centralHeaderOffset + 12, dosTime, true);
    data.setUint16(entry.centralHeaderOffset + 14, dosDate, true);
  }
}
