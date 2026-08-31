import { gunzipSync } from "node:zlib";

/**
 * Minimal safe `tar.gz` reader for the managed-install transaction.
 *
 * Implemented in-process (no system tar dependency) so member validation is exact and
 * deterministic: path traversal, absolute members, links, devices, fifos, setuid/setgid
 * files, and unexpected executables are rejected before anything is written. Only the
 * one expected executable member is ever returned for publication; other regular
 * files (licenses, documentation) are validated and discarded.
 */

export type ProviderCliArchiveRejection =
  | "decompression-limit"
  | "invalid-archive"
  | "absolute-member"
  | "path-traversal"
  | "unexpected-member-type"
  | "setuid-setgid"
  | "unexpected-executable"
  | "executable-missing"
  | "executable-oversized";

export class ProviderCliArchiveError extends Error {
  override readonly name = "ProviderCliArchiveError";
  constructor(
    readonly rejection: ProviderCliArchiveRejection,
    message: string,
  ) {
    super(message);
  }
}

export interface ExtractedProviderCliExecutable {
  /** Normalized archive-relative path of the executable member. */
  readonly name: string;
  readonly content: Uint8Array;
}

const BLOCK = 512;

function parseOctalField(bytes: Uint8Array): number | undefined {
  // Reject base-256 binary fields: reviewed artifacts are far below the octal limit.
  if (bytes.length === 0 || (bytes[0] !== undefined && (bytes[0] & 0x80) !== 0)) return undefined;
  let value = 0;
  let sawDigit = false;
  for (const byte of bytes) {
    if (byte === 0 || byte === 0x20) {
      if (sawDigit) break;
      continue;
    }
    if (byte < 0x30 || byte > 0x37) return undefined;
    value = value * 8 + (byte - 0x30);
    sawDigit = true;
  }
  return sawDigit ? value : undefined;
}

function readString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  const end = nul === -1 ? bytes.length : nul;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function normalizeMemberName(raw: string): string {
  const segments = raw.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  return segments.join("/");
}

function validateMemberName(raw: string): string {
  if (raw.length === 0 || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\\")) {
    throw new ProviderCliArchiveError("absolute-member", `Archive member name is absolute or ambiguous: ${raw}`);
  }
  for (const segment of raw.split("/")) {
    if (segment === "..") {
      throw new ProviderCliArchiveError("path-traversal", `Archive member escapes its root: ${raw}`);
    }
  }
  return normalizeMemberName(raw);
}

function verifyChecksum(header: Uint8Array): boolean {
  const expected = parseOctalField(header.subarray(148, 156));
  if (expected === undefined) return false;
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return sum === expected;
}

/** Parse pax extended-header records; only `path` overrides are honored. */
function parsePaxPathOverride(content: Uint8Array): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space === -1) return undefined;
    const lengthText = readString(content.subarray(offset, space));
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > content.length) return undefined;
    const record = readString(content.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

export interface ExtractProviderCliExecutableOptions {
  /** Normalized archive-relative path of the one member that may be executable. */
  readonly expectedExecutable: string;
  /** Hard cap on the decompressed archive stream. */
  readonly maxExtractedBytes: number;
  /** Hard cap on the executable member itself. */
  readonly maxExecutableBytes: number;
}

export function extractProviderCliExecutable(
  archive: Uint8Array,
  options: ExtractProviderCliExecutableOptions,
): ExtractedProviderCliExecutable {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive, { maxOutputLength: options.maxExtractedBytes });
  } catch (error) {
    if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === "ERR_OUT_OF_RANGE") {
      throw new ProviderCliArchiveError("decompression-limit", "Archive exceeds the decompressed size bound");
    }
    throw new ProviderCliArchiveError("invalid-archive", "Archive is not valid gzip data");
  }

  let offset = 0;
  let pendingName: string | undefined;
  let found: ExtractedProviderCliExecutable | undefined;
  let sawEnd = false;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    if (!verifyChecksum(header)) {
      throw new ProviderCliArchiveError("invalid-archive", "Archive member header checksum is invalid");
    }
    const size = parseOctalField(header.subarray(124, 136));
    if (size === undefined) {
      throw new ProviderCliArchiveError("invalid-archive", "Archive member size is not octal");
    }
    if (offset + size > tar.length) {
      throw new ProviderCliArchiveError("invalid-archive", "Archive member content is truncated");
    }
    const content = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    const typeflag = header[156];
    const rawName = readString(header.subarray(0, 100));
    const prefix = readString(header.subarray(345, 500));
    const memberName = pendingName ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
    pendingName = undefined;

    if (typeflag === 0x78) {
      // 'x': pax per-file extended header.
      pendingName = parsePaxPathOverride(content) ?? undefined;
      continue;
    }
    if (typeflag === 0x67) {
      // 'g': pax global header; carries no per-member identity we honor.
      continue;
    }
    if (typeflag === 0x4c) {
      // 'L': GNU long name for the next member.
      pendingName = readString(content);
      continue;
    }

    const name = validateMemberName(memberName);
    const mode = parseOctalField(header.subarray(100, 108));
    if (mode === undefined) {
      throw new ProviderCliArchiveError("invalid-archive", `Archive member mode is not octal: ${name}`);
    }

    if (typeflag === 0x35) {
      // '5': directory. Names went through traversal validation above; a bare archive
      // root entry (`./`) normalizes to nothing and is skipped.
      continue;
    }
    if (name.length === 0) {
      throw new ProviderCliArchiveError("path-traversal", "Archive member name resolves to nothing");
    }
    if (typeflag !== 0x30 && typeflag !== 0x00) {
      throw new ProviderCliArchiveError(
        "unexpected-member-type",
        `Archive member has an unsupported type (${String.fromCharCode(typeflag ?? 0)}): ${name}`,
      );
    }
    if ((mode & 0o6000) !== 0) {
      throw new ProviderCliArchiveError("setuid-setgid", `Archive member is setuid/setgid: ${name}`);
    }
    const isExecutableMember = (mode & 0o111) !== 0;
    if (isExecutableMember && name !== options.expectedExecutable) {
      throw new ProviderCliArchiveError("unexpected-executable", `Archive member is an unexpected executable: ${name}`);
    }
    if (name === options.expectedExecutable) {
      if (found) {
        throw new ProviderCliArchiveError(
          "unexpected-executable",
          `Archive contains the expected executable more than once: ${name}`,
        );
      }
      if (size > options.maxExecutableBytes) {
        throw new ProviderCliArchiveError("executable-oversized", `Archive executable exceeds its size bound: ${name}`);
      }
      found = { name, content: content.slice() };
    }
  }

  if (!sawEnd) {
    throw new ProviderCliArchiveError("invalid-archive", "Archive has no end-of-archive marker");
  }
  if (!found) {
    throw new ProviderCliArchiveError("executable-missing", `Archive does not contain ${options.expectedExecutable}`);
  }
  return found;
}
