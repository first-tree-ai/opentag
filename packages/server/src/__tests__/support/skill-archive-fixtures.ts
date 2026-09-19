import { Buffer } from "node:buffer";
import { gzipSync, zipSync } from "fflate";
import { type Headers as TarHeaders, pack as tarPack } from "tar-stream";

/**
 * Archive fixtures for the Skill tests. Real `tar.gz`/`zip` bytes are built through the same
 * libraries the reader uses, so the tests exercise the actual format rather than a stub. The one
 * synthetic case is `tarGzWithDeclaredSize`, which forges a header that declares more bytes than the
 * archive carries — the only way to prove the unpacked-size guard rejects before any payload exists.
 */

export interface TarFixtureEntry {
  name: string;
  body?: Uint8Array | string;
  type?: TarHeaders["type"];
  linkname?: string;
  mode?: number;
  mtime?: number;
  uid?: number;
  gid?: number;
  size?: number;
  devmajor?: number;
  devminor?: number;
}

export function skillManifest(name: string, description = "A test Skill", extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n`;
}

export function bytesOf(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function tarHeaderFor(entry: TarFixtureEntry, body: Uint8Array | undefined): TarHeaders {
  const header: TarHeaders = {
    name: entry.name,
    type: entry.type ?? "file",
    mode: entry.mode ?? 0o644,
    mtime: new Date(entry.mtime ?? 0),
    uid: entry.uid ?? 0,
    gid: entry.gid ?? 0,
  };
  const size = body?.byteLength ?? entry.size;
  if (size !== undefined) header.size = size;
  if (entry.linkname !== undefined) header.linkname = entry.linkname;
  if (entry.devmajor !== undefined) header.devmajor = entry.devmajor;
  if (entry.devminor !== undefined) header.devminor = entry.devminor;
  return header;
}

function writeTarEntry(pack: ReturnType<typeof tarPack>, entry: TarFixtureEntry): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const body = entry.body === undefined ? undefined : bytesOf(entry.body);
    const sink = pack.entry(tarHeaderFor(entry, body), (error) => (error ? reject(error) : resolve()));
    sink.end(body === undefined ? undefined : Buffer.from(body));
  });
}

export async function packTar(entries: TarFixtureEntry[]): Promise<Uint8Array> {
  const pack = tarPack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  for (const entry of entries) await writeTarEntry(pack, entry);
  pack.finalize();
  await finished;
  return gzipSync(new Uint8Array(Buffer.concat(chunks)), { level: 9, mtime: 0 });
}

/** Same as `packTar` but with an outer gzip level that differs, to prove repack determinism. */
export async function tarGz(entries: TarFixtureEntry[]): Promise<Uint8Array> {
  return packTar(entries);
}

export function zipFiles(files: Record<string, Uint8Array | string>, level: 0 | 6 | 9 = 6): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) input[name] = bytesOf(value);
  return zipSync(input, { level });
}

/** Writes a zero-padded octal field of `length` bytes, the last of which is NUL. */
function octal(value: number, length: number): Buffer {
  const text = value.toString(8);
  return Buffer.from(`${text.padStart(length - 1, "0")}\0`, "utf8");
}

interface RawTarHeaderInput {
  name: string;
  size: number;
  type?: string;
  mode?: number;
  linkname?: string;
}

function rawTarHeader(input: RawTarHeaderInput): Buffer {
  const header = Buffer.alloc(512);
  header.write(input.name, 0, 100, "utf8");
  octal(input.mode ?? 0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(input.size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(input.type ?? "0", 156, 1, "utf8");
  header.write(input.linkname ?? "", 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  octal(checksum, 8).copy(header, 148);
  return header;
}

/**
 * A `tar.gz` whose single file header declares `size` bytes but carries none. Reading the header is
 * enough for the unpacked-size guard to reject, so a real 64 MiB payload is never materialized.
 */
export function tarGzWithDeclaredSize(name: string, size: number): Uint8Array {
  const header = rawTarHeader({ name, size });
  const trailer = Buffer.alloc(1024);
  return gzipSync(new Uint8Array(Buffer.concat([header, trailer])), { level: 9, mtime: 0 });
}

/**
 * A zip whose central-directory record declares a huge uncompressed size for a tiny stored entry.
 * `fflate`'s filter sees the declared size before it allocates the output buffer, which is the
 * contract the guard relies on.
 */
export function zipWithDeclaredSize(name: string, uncompressedSize: number): Uint8Array {
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(0, 18);
  local.writeUInt32LE(uncompressedSize >>> 0, 22);
  local.writeUInt16LE(nameBytes.byteLength, 26);
  local.writeUInt16LE(0, 28);
  const localRecord = Buffer.concat([local, nameBytes]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(0, 20);
  central.writeUInt32LE(uncompressedSize >>> 0, 24);
  central.writeUInt16LE(nameBytes.byteLength, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralRecord = Buffer.concat([central, nameBytes]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRecord.byteLength, 12);
  end.writeUInt32LE(localRecord.byteLength, 16);
  return new Uint8Array(Buffer.concat([localRecord, centralRecord, end]));
}
