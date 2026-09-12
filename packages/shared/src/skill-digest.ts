import { createHash } from "node:crypto";
import { type SkillFileEntry, type SkillManifest, SkillManifestSchema } from "./skill.js";

/**
 * Digest helpers for the skill library. They need `node:crypto`, so they are exported from the Node entrypoint only;
 * the browser entrypoint receives the schemas and constants from `skill.ts`.
 *
 * Both digests are pure functions of content, so the Client daemon can recompute them offline from the files on disk
 * and compare them with what the Server advertises without downloading anything.
 */

/**
 * Agent digest of an empty assignment set: `sha256("")`. `computeAgentSkillsDigest([])` returns this value, so a
 * daemon can compare against it without special-casing an agent that has no skills.
 */
export const EMPTY_AGENT_SKILLS_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalFileEntry(entry: SkillFileEntry): SkillFileEntry {
  return { path: entry.path, sha256: entry.sha256, size: entry.size, mode: entry.mode };
}

/**
 * Return the manifest with its files sorted by UTF-8 byte order and every object in a fixed key order. The result is
 * what `computeSkillDigest` hashes and what the Server persists.
 */
export function canonicalizeSkillManifest(input: SkillManifest): SkillManifest {
  const manifest = SkillManifestSchema.parse(input);
  const files = [...manifest.files].sort((left, right) => compareUtf8(left.path, right.path)).map(canonicalFileEntry);
  return { schemaVersion: manifest.schemaVersion, name: manifest.name, files };
}

/** `sha256(JSON.stringify(canonical manifest))`; independent of zip metadata and compression. */
export function computeSkillDigest(manifest: SkillManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeSkillManifest(manifest)), "utf8")
    .digest("hex");
}

/**
 * Digest of the skill set assigned to one agent: `sha256(sorted("<name>:<digest>").join("\n"))`. Order of the input
 * does not matter; an empty set yields `EMPTY_AGENT_SKILLS_DIGEST`.
 */
export function computeAgentSkillsDigest(entries: ReadonlyArray<{ name: string; digest: string }>): string {
  const lines = entries.map((entry) => `${entry.name}:${entry.digest}`).sort(compareUtf8);
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
