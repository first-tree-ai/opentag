import { describe, expect, it } from "vitest";
import { executableFormatSupportsHost, inspectExecutableFormat } from "../runtime/provider-cli/executable-format.js";

// Real header prefixes captured from the reviewed catalog artifacts.
const MACHO_ARM64 = bytes("cffaedfe0c0000010000000002000000110000006008000004002000000000001900000048000000");
const ELF_X86_64 = bytes("7f454c4602010100000000000000000002003e0001000000600d4900000000004000000000000000900100");
const ELF_AARCH64 = bytes("7f454c460201010000000000000000000200b70001000000009c0900000000004000000000000000900100");

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function fatMachO(archs: readonly number[]): Uint8Array {
  const buffer = new Uint8Array(8 + archs.length * 20);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, 0xca_fe_ba_be, false);
  view.setUint32(4, archs.length, false);
  for (const [index, cputype] of archs.entries()) {
    view.setUint32(8 + index * 20, cputype, false);
  }
  return buffer;
}

describe("inspectExecutableFormat", () => {
  it("detects thin Mach-O arm64", () => {
    expect(inspectExecutableFormat(MACHO_ARM64)).toEqual({ kind: "macho", archs: ["arm64"] });
  });

  it("detects ELF x86_64 and aarch64", () => {
    expect(inspectExecutableFormat(ELF_X86_64)).toEqual({ kind: "elf", arch: "x64" });
    expect(inspectExecutableFormat(ELF_AARCH64)).toEqual({ kind: "elf", arch: "arm64" });
  });

  it("detects fat Mach-O with multiple architectures", () => {
    expect(inspectExecutableFormat(fatMachO([0x01_00_00_07, 0x01_00_00_0c]))).toEqual({
      kind: "macho",
      archs: ["x64", "arm64"],
    });
  });

  it("treats shebang scripts as architecture-neutral", () => {
    expect(inspectExecutableFormat(new TextEncoder().encode("#!/bin/sh\necho hi\n"))).toEqual({ kind: "script" });
  });

  it("reports unknown for anything else", () => {
    expect(inspectExecutableFormat(new TextEncoder().encode("not an executable at all"))).toEqual({ kind: "unknown" });
    expect(inspectExecutableFormat(new Uint8Array([0x7f, 0x45, 0x4c]))).toEqual({ kind: "unknown" });
  });
});

describe("executableFormatSupportsHost", () => {
  it("matches Mach-O only on macOS and only for a contained architecture", () => {
    expect(executableFormatSupportsHost({ kind: "macho", archs: ["arm64"] }, "darwin", "arm64")).toBe(true);
    expect(executableFormatSupportsHost({ kind: "macho", archs: ["arm64"] }, "darwin", "x64")).toBe(false);
    expect(executableFormatSupportsHost({ kind: "macho", archs: ["arm64"] }, "linux", "arm64")).toBe(false);
  });

  it("matches ELF only on Linux and only for the exact architecture", () => {
    expect(executableFormatSupportsHost({ kind: "elf", arch: "x64" }, "linux", "x64")).toBe(true);
    expect(executableFormatSupportsHost({ kind: "elf", arch: "arm64" }, "linux", "x64")).toBe(false);
    expect(executableFormatSupportsHost({ kind: "elf", arch: "x64" }, "darwin", "x64")).toBe(false);
  });

  it("accepts scripts on any P0 host and rejects unknown formats", () => {
    expect(executableFormatSupportsHost({ kind: "script" }, "linux", "x64")).toBe(true);
    expect(executableFormatSupportsHost({ kind: "unknown" }, "linux", "x64")).toBe(false);
  });
});
