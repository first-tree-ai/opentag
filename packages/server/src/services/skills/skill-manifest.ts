import { createHash } from "node:crypto";
import {
  canonicalizeSkillManifest,
  computeSkillDigest,
  type SkillFileEntry,
  type SkillManifest,
} from "@opentag/shared";
import type { SkillArchiveFile } from "./skill-archive.js";

export interface BuiltSkillManifest {
  manifest: SkillManifest;
  digest: string;
  fileCount: number;
  totalBytes: number;
}

function fileEntry(path: string, file: SkillArchiveFile): SkillFileEntry {
  return {
    path,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    size: file.bytes.byteLength,
    mode: file.mode,
  };
}

/** Hash every file, canonicalize the manifest, and compute the skill digest the daemon can recompute offline. */
export function buildSkillManifest(name: string, files: Map<string, SkillArchiveFile>): BuiltSkillManifest {
  const entries = [...files.entries()].map(([path, file]) => fileEntry(path, file));
  const manifest = canonicalizeSkillManifest({ schemaVersion: 1, name, files: entries });
  return {
    manifest,
    digest: computeSkillDigest(manifest),
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
  };
}
