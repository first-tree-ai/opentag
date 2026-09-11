import { createHash } from "node:crypto";
import { computeSkillDigest, type RuntimeSkillEntry, type SkillManifest, SkillManifestSchema } from "@opentag/shared";
import { strToU8, zipSync } from "fflate";

export interface SkillZipFile {
  content: string | Uint8Array;
  /** Unix permission bits; defaults to 0o644. */
  mode?: number;
  /** Full Unix type bits (for example `0o120000` for a symlink); defaults to a regular file. */
  type?: number;
}

export interface SkillZipFixture {
  bytes: Uint8Array;
  manifest: SkillManifest;
  digest: string;
  archiveSha256: string;
  entry: RuntimeSkillEntry;
}

const FIXED_MTIME = new Date(Date.UTC(2000, 0, 1));

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build a canonical skill zip plus the manifest the Server would advertise for it. */
export function buildSkillZip(name: string, files: Record<string, SkillZipFile | string>): SkillZipFixture {
  const zippable: Record<string, [Uint8Array, { os: number; attrs: number; mtime: Date }]> = {};
  const manifestFiles: SkillManifest["files"] = [];
  for (const [path, value] of Object.entries(files)) {
    const file = typeof value === "string" ? { content: value } : value;
    const content = typeof file.content === "string" ? strToU8(file.content) : file.content;
    const mode = file.mode ?? 0o644;
    const type = file.type ?? 0o100000;
    zippable[path] = [content, { os: 3, attrs: (type | mode) << 16, mtime: FIXED_MTIME }];
    if (type === 0o100000) {
      manifestFiles.push({
        path,
        sha256: sha256(content),
        size: content.length,
        mode: (mode & 0o111) !== 0 ? "0755" : "0644",
      });
    }
  }
  const bytes = zipSync(zippable, { os: 3, mtime: FIXED_MTIME });
  const manifest: SkillManifest = { schemaVersion: 1, name, files: manifestFiles };
  // Hostile fixtures deliberately violate the manifest schema; they never need a digest.
  const digest = SkillManifestSchema.safeParse(manifest).success ? computeSkillDigest(manifest) : "";
  const archiveSha256 = sha256(bytes);
  return {
    bytes,
    manifest,
    digest,
    archiveSha256,
    entry: { name, digest, archiveSha256, archiveBytes: bytes.length, manifest },
  };
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (readUint16(bytes, offset) | (readUint16(bytes, offset + 2) << 16)) >>> 0;
}

/** Apply a mutation to every central directory entry; `offset` points at the entry signature. */
export function patchCentralDirectory(bytes: Uint8Array, mutate: (view: DataView, offset: number) => void): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  let eocd = -1;
  for (let offset = copy.length - 22; offset >= 0; offset -= 1) {
    if (readUint32(copy, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("fixture has no end-of-central-directory record");
  let offset = readUint32(copy, eocd + 16);
  const count = readUint16(copy, eocd + 10);
  for (let index = 0; index < count; index += 1) {
    mutate(view, offset);
    const nameLength = readUint16(copy, offset + 28);
    const extraLength = readUint16(copy, offset + 30);
    const commentLength = readUint16(copy, offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return copy;
}
