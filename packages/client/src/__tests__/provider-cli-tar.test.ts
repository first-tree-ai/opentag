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
});
