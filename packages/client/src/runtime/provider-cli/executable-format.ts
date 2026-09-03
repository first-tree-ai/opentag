/**
 * Executable format sniffing for Provider CLI candidates.
 *
 * Detection validates that a candidate can actually run on this platform and
 * architecture without executing it: Mach-O thin/fat binaries and ELF binaries carry
 * their CPU type in the first bytes; `#!` scripts are architecture-neutral. Anything
 * else is unrecognized and never eligible.
 */

export type ProviderCliExecutableArch = "arm64" | "x64";

export type ProviderCliExecutableFormat =
  | { readonly kind: "script" }
  | { readonly kind: "macho"; readonly archs: readonly ProviderCliExecutableArch[] }
  | { readonly kind: "elf"; readonly arch: ProviderCliExecutableArch }
  | { readonly kind: "unknown" };

const MACHO_CPU_X86_64 = 0x01_00_00_07;
const MACHO_CPU_ARM64 = 0x01_00_00_0c;

const ELF_MACHINE_X86_64 = 62;
const ELF_MACHINE_AARCH64 = 183;

function machoArch(cputype: number): ProviderCliExecutableArch | undefined {
  if (cputype === MACHO_CPU_X86_64) return "x64";
  if (cputype === MACHO_CPU_ARM64) return "arm64";
  return undefined;
}

function inspectMachO(header: Uint8Array): ProviderCliExecutableFormat | undefined {
  if (header.length < 8) return undefined;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const magic = view.getUint32(0, false);
  // Thin Mach-O, little-endian on disk (MH_MAGIC_64 / MH_MAGIC as stored on macOS).
  if (magic === 0xcf_fa_ed_fe || magic === 0xce_fa_ed_fe) {
    const arch = machoArch(view.getUint32(4, true));
    return arch ? { kind: "macho", archs: [arch] } : { kind: "unknown" };
  }
  // Fat (universal) Mach-O: big-endian magic, then a table of 20-byte arch records.
  if (magic === 0xca_fe_ba_be) {
    const count = view.getUint32(4, false);
    if (count > 64 || header.length < 8 + count * 20) return { kind: "unknown" };
    const archs: ProviderCliExecutableArch[] = [];
    for (let index = 0; index < count; index += 1) {
      const arch = machoArch(view.getUint32(8 + index * 20, false));
      if (arch && !archs.includes(arch)) archs.push(arch);
    }
    return archs.length > 0 ? { kind: "macho", archs } : { kind: "unknown" };
  }
  // Fat with 64-bit offsets (FAT_MAGIC_64) shares the same leading layout.
  if (magic === 0xca_fe_ba_bf) {
    const count = view.getUint32(4, false);
    if (count > 64 || header.length < 8 + count * 32) return { kind: "unknown" };
    const archs: ProviderCliExecutableArch[] = [];
    for (let index = 0; index < count; index += 1) {
      const arch = machoArch(view.getUint32(8 + index * 32, false));
      if (arch && !archs.includes(arch)) archs.push(arch);
    }
    return archs.length > 0 ? { kind: "macho", archs } : { kind: "unknown" };
  }
  return undefined;
}

function inspectElf(header: Uint8Array): ProviderCliExecutableFormat | undefined {
  if (header.length < 20) return undefined;
  if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return undefined;
  const littleEndian = header[5] !== 2;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const machine = view.getUint16(18, littleEndian);
  if (machine === ELF_MACHINE_X86_64) return { kind: "elf", arch: "x64" };
  if (machine === ELF_MACHINE_AARCH64) return { kind: "elf", arch: "arm64" };
  return { kind: "unknown" };
}

/** Inspect the first bytes of a candidate executable; 64 bytes cover every header read here. */
export function inspectExecutableFormat(header: Uint8Array): ProviderCliExecutableFormat {
  if (header.length >= 2 && header[0] === 0x23 && header[1] === 0x21) return { kind: "script" };
  const macho = inspectMachO(header);
  if (macho) return macho;
  const elf = inspectElf(header);
  if (elf) return elf;
  return { kind: "unknown" };
}

export function executableFormatSupportsHost(
  format: ProviderCliExecutableFormat,
  platform: NodeJS.Platform,
  arch: string,
): boolean {
  switch (format.kind) {
    case "script":
      return true;
    case "macho":
      return platform === "darwin" && format.archs.includes(arch as ProviderCliExecutableArch);
    case "elf":
      return platform === "linux" && format.arch === arch;
    case "unknown":
      return false;
  }
}
