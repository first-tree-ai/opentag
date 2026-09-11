import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { type SkillManifest, SkillManifestSchema, SkillNameSchema } from "@opentag/shared";
import { z } from "zod";
import { ensurePrivateDirectory, readDurableJson, writeDurableJson } from "../../storage/durable-file.js";

/**
 * The daemon-managed `.skills/` directory inside an Agent Home and the manifest that records what
 * it currently holds. The manifest is the local half of the sync comparison: its agent digest is
 * compared with the Server's, and its per-file hashes let `verifyLocalSkills` notice tampering or
 * partial writes without any network access.
 */

export const SKILLS_DIRECTORY = ".skills";
export const SKILLS_MANIFEST_FILE = ".opentag-skills.json";
export const LOCAL_SKILLS_MANIFEST_SCHEMA_VERSION = 1;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const LocalSkillEntrySchema = z
  .object({
    digest: Sha256Schema,
    archiveSha256: Sha256Schema,
    manifest: SkillManifestSchema,
  })
  .strict();

export const LocalSkillsManifestSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_SKILLS_MANIFEST_SCHEMA_VERSION),
    agentId: z.string().min(1),
    digest: Sha256Schema,
    skills: z.record(SkillNameSchema, LocalSkillEntrySchema),
    syncedAt: z.string().datetime(),
    lastError: z.string().min(1).max(2_048).optional(),
  })
  .strict();

export type LocalSkillEntry = z.infer<typeof LocalSkillEntrySchema>;
export type LocalSkillsManifest = z.infer<typeof LocalSkillsManifestSchema>;

export function skillsRootPath(agentHome: string): string {
  return resolve(agentHome, SKILLS_DIRECTORY);
}

export function skillsManifestPath(agentHome: string): string {
  return resolve(skillsRootPath(agentHome), SKILLS_MANIFEST_FILE);
}

export function skillDirectoryPath(agentHome: string, name: string): string {
  return resolve(skillsRootPath(agentHome), SkillNameSchema.parse(name));
}

/** Read the local manifest; `undefined` when no sync has completed yet. Corrupt files throw. */
export function readLocalSkillsManifest(agentHome: string): Promise<LocalSkillsManifest | undefined> {
  return readDurableJson(skillsManifestPath(agentHome), (value) => LocalSkillsManifestSchema.parse(value));
}

/** Write the manifest atomically with owner-only permissions, creating `.skills/` when needed. */
export async function writeLocalSkillsManifest(agentHome: string, manifest: LocalSkillsManifest): Promise<void> {
  await ensurePrivateDirectory(agentHome, skillsRootPath(agentHome));
  await writeDurableJson(skillsManifestPath(agentHome), LocalSkillsManifestSchema.parse(manifest));
}

export interface LocalSkillsVerification {
  readonly ok: boolean;
  /** Names of skills whose files are missing, resized, or altered. */
  readonly damaged: readonly string[];
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function verifySkillFiles(directory: string, manifest: SkillManifest): Promise<boolean> {
  for (const file of manifest.files) {
    const path = resolve(directory, ...file.path.split("/"));
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(path);
    } catch {
      return false;
    }
    if (!status.isFile() || status.isSymbolicLink() || status.size !== file.size) return false;
    if ((await hashFile(path)) !== file.sha256) return false;
  }
  return true;
}

/** Check that every file the manifest lists exists with the recorded size and content hash. */
export async function verifyLocalSkills(
  agentHome: string,
  manifest: LocalSkillsManifest,
): Promise<LocalSkillsVerification> {
  const damaged: string[] = [];
  for (const [name, entry] of Object.entries(manifest.skills)) {
    const intact = await verifySkillFiles(skillDirectoryPath(agentHome, name), entry.manifest);
    if (!intact) damaged.push(name);
  }
  return { ok: damaged.length === 0, damaged };
}
