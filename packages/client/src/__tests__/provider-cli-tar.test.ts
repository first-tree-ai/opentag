import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractProviderCliExecutable, ProviderCliArchiveError } from "../runtime/provider-cli/tar.js";
import { buildTar, buildTarGz } from "./fixtures/provider-cli.js";

const OPTIONS = {
  expectedExecutable: "bin/slack",
  maxExtractedBytes: 16 * 1024 * 1024,
  maxExecutableBytes: 1024 * 1024,
} as const;

function rejectionOf(archive: Uint8Array, options: typeof OPTIONS = OPTIONS): string {
  try {
    extractProviderCliExecutable(archive, options);
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderCliArchiveError);
    return (error as ProviderCliArchiveError).rejection;
  }
  throw new Error("expected extraction to fail");
}

describe("extractProviderCliExecutable", () => {
  it("extracts exactly the expected executable member", () => {
    const archive = buildTarGz([
      { name: "README.md", content: "docs", mode: 0o644 },
      { name: "bin/slack", content: "#!/bin/sh\necho ok\n", mode: 0o755 },
      { name: "bin", type: "dir" },
    ]);
    const extracted = extractProviderCliExecutable(archive, OPTIONS);
    expect(extracted.name).toBe("bin/slack");
    expect(new TextDecoder().decode(extracted.content)).toBe("#!/bin/sh\necho ok\n");
  });

  it("accepts flat member names and ./-prefixed names", () => {
    const flat = buildTarGz([{ name: "lark-cli", content: "exe", mode: 0o755 }]);
    expect(
      new TextDecoder().decode(
        extractProviderCliExecutable(flat, { ...OPTIONS, expectedExecutable: "lark-cli" }).content,
      ),
    ).toBe("exe");
    const prefixed = buildTarGz([{ name: "./bin/slack", content: "exe", mode: 0o755 }]);
    expect(new TextDecoder().decode(extractProviderCliExecutable(prefixed, OPTIONS).content)).toBe("exe");
  });

  it("accepts a bare ./ archive root directory entry", () => {
    const archive = buildTarGz([
      { name: "./", type: "dir" },
      { name: "./bin/", type: "dir" },
      { name: "./bin/slack", content: "exe", mode: 0o755 },
    ]);
    expect(new TextDecoder().decode(extractProviderCliExecutable(archive, OPTIONS).content)).toBe("exe");
  });

  it("rejects path traversal members", () => {
    const archive = buildTarGz([
      { name: "../evil", content: "x" },
      { name: "bin/slack", content: "exe", mode: 0o755 },
    ]);
    expect(rejectionOf(archive)).toBe("path-traversal");
  });

  it("rejects absolute members", () => {
    const archive = buildTarGz([
      { name: "/etc/passwd", content: "x" },
      { name: "bin/slack", content: "exe", mode: 0o755 },
    ]);
    expect(rejectionOf(archive)).toBe("absolute-member");
  });

  it("rejects symlinks, hardlinks, devices, and fifos", () => {
    for (const type of ["symlink", "hardlink", "char", "block", "fifo"] as const) {
      const archive = buildTarGz([
        { name: "bin/slack", content: "exe", mode: 0o755 },
        { name: "hook", type, linkname: "/tmp/target" },
      ]);
      expect(rejectionOf(archive)).toBe("unexpected-member-type");
    }
  });

  it("rejects setuid and setgid members", () => {
    const archive = buildTarGz([{ name: "bin/slack", content: "exe", mode: 0o4755 }]);
    expect(rejectionOf(archive)).toBe("setuid-setgid");
  });

  it("rejects unexpected executables", () => {
    const archive = buildTarGz([
      { name: "bin/slack", content: "exe", mode: 0o755 },
      { name: "postinstall.sh", content: "x", mode: 0o755 },
    ]);
    expect(rejectionOf(archive)).toBe("unexpected-executable");
  });

  it("rejects duplicate copies of the expected executable", () => {
    const archive = buildTarGz([
      { name: "bin/slack", content: "first", mode: 0o755 },
      { name: "bin/slack", content: "second", mode: 0o755 },
    ]);
    expect(rejectionOf(archive)).toBe("unexpected-executable");
  });

  it("rejects archives without the expected executable", () => {
    const archive = buildTarGz([{ name: "README.md", content: "docs" }]);
    expect(rejectionOf(archive)).toBe("executable-missing");
  });

  it("rejects an oversized executable member", () => {
    const archive = buildTarGz([{ name: "bin/slack", content: "a".repeat(2048), mode: 0o755 }]);
    expect(rejectionOf(archive, { ...OPTIONS, maxExecutableBytes: 128 })).toBe("executable-oversized");
  });

  it("rejects a decompression bomb at the bound", () => {
    const huge = "a".repeat(2 * 1024 * 1024);
    const archive = buildTarGz([
      { name: "bin/slack", content: "exe", mode: 0o755 },
      { name: "docs.txt", content: huge },
    ]);
    expect(rejectionOf(archive, { ...OPTIONS, maxExtractedBytes: 64 * 1024 })).toBe("decompression-limit");
  });

  it("rejects non-gzip and truncated archives", () => {
    expect(rejectionOf(new Uint8Array([1, 2, 3, 4]))).toBe("invalid-archive");
    const good = buildTarGz([{ name: "bin/slack", content: "exe", mode: 0o755 }]);
    expect(rejectionOf(good.subarray(0, good.length - 100))).toBe("invalid-archive");
  });

  it("rejects corrupted header checksums", () => {
    const tar = buildTar([{ name: "bin/slack", content: "exe", mode: 0o755 }]);
    const corrupted = new Uint8Array(tar);
    corrupted[0] = 0x7f; // damage the name field without fixing the checksum
    expect(rejectionOf(gzipSync(corrupted))).toBe("invalid-archive");
  });

  it("honors a pax path override, a pax global header, and a GNU long name", () => {
    // A long expected path is carried by a pax 'path' record, preceded by an ignored global header.
    const longName = `packages/${"nested/".repeat(12)}bin/slack`;
    const pax = gzipSync(
      paxArchive(
        [
          { type: "global", content: "comment=ignored\n" },
          { content: paxRecord("path", longName), type: "pax" },
        ],
        longName,
      ),
    );
    const extracted = extractProviderCliExecutable(pax, { ...OPTIONS, expectedExecutable: longName });
    expect(extracted.name).toBe(longName);
    expect(new TextDecoder().decode(extracted.content)).toBe("exe");

    // A GNU 'L' long-name header names the following member too.
    const viaLongName = gzipSync(gnuLongNameArchive("bin/slack"));
    expect(new TextDecoder().decode(extractProviderCliExecutable(viaLongName, OPTIONS).content)).toBe("exe");
  });

  it("rejects a malformed pax record, a non-octal size, and a non-octal mode", () => {
    // A pax record whose declared length does not fit the content is rejected as a member name
    // that resolves to nothing (the override is discarded, so the ustar name is used instead).
    const truncatedPax = gzipSync(paxArchive([{ content: "9999 path=x\n", type: "pax" }], "bin/other"));
    expect(rejectionOf(truncatedPax)).toBe("unexpected-executable");

    const nonOctalSize = buildTar([{ name: "bin/slack", content: "exe", mode: 0o755 }]);
    // Overwrite the size field with binary-base-256 (high bit set) and fix the checksum.
    nonOctalSize[124] = 0x80;
    fixChecksum(nonOctalSize, 0);
    expect(rejectionOf(gzipSync(nonOctalSize))).toBe("invalid-archive");

    const nonOctalMode = buildTar([{ name: "bin/slack", content: "exe", mode: 0o755 }]);
    nonOctalMode[100] = 0x39; // '9' is not an octal digit
    fixChecksum(nonOctalMode, 0);
    expect(rejectionOf(gzipSync(nonOctalMode))).toBe("invalid-archive");
  });

  it("rejects an archive whose member content is truncated and one with no end marker", () => {
    const good = buildTar([{ name: "bin/slack", content: "exe", mode: 0o755 }]);
    // Claim a size larger than the remaining bytes without changing the checksum-covered fields:
    // write a bigger size AND recompute the checksum so the size check is the one that fires.
    const truncatedContent = new Uint8Array(good.subarray(0, 512 + 512));
    truncatedContent.set(octalField(4096, 12), 124);
    fixChecksum(truncatedContent, 0);
    expect(rejectionOf(gzipSync(truncatedContent))).toBe("invalid-archive");

    // A tar without the two zero blocks has no end-of-archive marker.
    const noEnd = new Uint8Array(good.subarray(0, good.length - 1024));
    expect(rejectionOf(gzipSync(noEnd))).toBe("invalid-archive");
  });
});

function octalField(value: number, length: number): Uint8Array {
  const text = value.toString(8).padStart(length - 1, "0");
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length - 1; index += 1) bytes[index] = text.charCodeAt(index);
  bytes[length - 1] = 0;
  return bytes;
}

function writeField(header: Uint8Array, offset: number, value: string, length: number): void {
  const bytes = new TextEncoder().encode(value);
  header.set(bytes.subarray(0, Math.min(bytes.length, length - 1)), offset);
}

/** Recompute the ustar checksum after in-place field damage. */
function fixChecksum(header: Uint8Array, offset: number): void {
  header.fill(0x20, offset + 148, offset + 156);
  let sum = 0;
  for (let index = offset; index < offset + 512; index += 1) sum += header[index] ?? 0;
  header.set(octalField(sum, 8).subarray(0, 7), offset + 148);
  header[offset + 155] = 0;
}

/**
 * One pax record: `<decimal length> <key>=<value>\n`, where the length covers its own digits.
 */
function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  const bodyBytes = new TextEncoder().encode(body).length;
  for (let digits = 1; digits < 8; digits += 1) {
    const total = digits + 1 + bodyBytes;
    if (String(total).length === digits) return `${total} ${body}`;
  }
  throw new Error("pax record length could not be encoded");
}

/** Build one archive with pax header entries followed by the expected executable member. */
function paxArchive(extras: readonly { type: "pax" | "global"; content: string }[], memberName: string): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const extra of extras) {
    const content = new TextEncoder().encode(extra.content);
    const header = new Uint8Array(512);
    writeField(header, 0, extra.type === "pax" ? "PaxHeaders/file" : "PaxHeaders/global", 100);
    header.set(octalField(0o644, 8), 100);
    header.set(octalField(content.length, 12), 124);
    header.fill(0x20, 148, 156);
    header[156] = extra.type === "pax" ? 0x78 : 0x67;
    writeField(header, 257, "ustar", 6);
    header[263] = 0x30;
    header[264] = 0x30;
    let sum = 0;
    for (const byte of header) sum += byte;
    header.set(octalField(sum, 8).subarray(0, 7), 148);
    header[155] = 0;
    blocks.push(header, padTo512(content));
  }
  const exe = buildTar([{ content: "exe", mode: 0o755, name: memberName }]);
  blocks.push(exe);
  return concatBlocks(blocks);
}

/** Build a GNU 'L' long-name header followed by the expected executable member. */
function gnuLongNameArchive(memberName: string): Uint8Array {
  const content = new TextEncoder().encode(`${memberName}\0`);
  const header = new Uint8Array(512);
  writeField(header, 0, "././@LongLink", 100);
  header.set(octalField(0o644, 8), 100);
  header.set(octalField(content.length, 12), 124);
  header.fill(0x20, 148, 156);
  header[156] = 0x4c;
  writeField(header, 257, "ustar", 6);
  header[263] = 0x30;
  header[264] = 0x30;
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(octalField(sum, 8).subarray(0, 7), 148);
  header[155] = 0;
  return concatBlocks([header, padTo512(content), buildTar([{ content: "exe", mode: 0o755, name: "short" }])]);
}

function padTo512(content: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
  padded.set(content);
  return padded;
}

function concatBlocks(blocks: readonly Uint8Array[]): Uint8Array {
  const total = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    total.set(block, offset);
    offset += block.length;
  }
  return total;
}
