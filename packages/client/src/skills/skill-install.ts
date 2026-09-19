import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { type RuntimeSkillManifest, SKILL_MANIFEST_FILE, SKILL_MARKER_FILE } from "@opentag/shared";
import { ensurePrivateDirectory } from "../storage/durable-file.js";
import { extractSkillArchive, SKILL_CONTENT_SIDECAR_FILE } from "./skill-archive.js";

/**
 * Staging and staging-root maintenance for Skill installs.
 *
 * A bundle is fully extracted, marked and digest-verified in a private staging directory before it
 * can replace anything, so a failed extraction never costs the Agent the Skill it already had.
 */

/** A staging dir older than this is a crash leftover; extraction is not bounded by the sync budget. */
const DEFAULT_STAGING_STALE_MS = 10 * 60 * 1000;

/** Content digest of a directory, ignoring the platform marker and its sidecar. */
export async function hashSkillDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  await hashSkillTree(root, "", hash);
  return hash.digest("hex");
}

async function hashSkillTree(directory: string, prefix: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) await hashSkillEntry(directory, prefix, entry, hash);
}

async function hashSkillEntry(
  directory: string,
  prefix: string,
  entry: Dirent,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  if (entry.name === SKILL_MARKER_FILE || entry.name === SKILL_CONTENT_SIDECAR_FILE) return;
  const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
  const absolute = join(directory, entry.name);
  if (entry.isDirectory()) {
    hash.update(`d\0${rel}\0`);
    await hashSkillTree(absolute, rel, hash);
    return;
  }
  if (!entry.isFile()) return;
  hash.update(`f\0${rel}\0`);
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
}

async function assertStagedBundle(staging: string): Promise<void> {
  const info = await stat(join(staging, SKILL_MANIFEST_FILE));
  if (!info.isFile()) throw new Error(`Skill bundle is missing its root ${SKILL_MANIFEST_FILE}`);
}

/**
 * Extract a verified bundle into a fresh staging directory and mark it managed.
 *
 * Returns the staging path, which is fully validated: on any failure the staging directory is
 * removed and the error propagates, so the caller's current copy is still intact.
 */
export async function stageBundle(
  stagingRoot: string,
  entry: RuntimeSkillManifest["skills"][number],
  bytes: Uint8Array,
): Promise<string> {
  await ensurePrivateDirectory(dirname(stagingRoot), stagingRoot);
  const staging = await mkdtemp(join(stagingRoot, "skill-"));
  try {
    await extractSkillArchive(Readable.from(Buffer.from(bytes)), staging);
    await assertStagedBundle(staging);
    await writeFile(
      join(staging, SKILL_MARKER_FILE),
      `${JSON.stringify({ skillId: entry.id, archiveSha256: entry.archiveSha256 })}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(staging, SKILL_CONTENT_SIDECAR_FILE), `${await hashSkillDirectory(staging)}\n`, {
      mode: 0o600,
    });
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Move an unedited managed copy aside so it can be restored if the swap fails. */
export async function moveAside(stagingRoot: string, source: string, tag: string): Promise<string> {
  await ensurePrivateDirectory(dirname(stagingRoot), stagingRoot);
  const aside = join(stagingRoot, `retired-${tag}`);
  await rename(source, aside);
  return aside;
}

/** A crash leaves an unmarked staging directory; anything older than `maxAgeMs` is garbage. */
export async function sweepStaleStaging(
  stagingRoot: string,
  maxAgeMs: number = DEFAULT_STAGING_STALE_MS,
  now: () => number = () => Date.now(),
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stagingRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(stagingRoot, entry);
    try {
      if (now() - (await stat(path)).mtimeMs > maxAgeMs) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent sync may have renamed or removed it already.
    }
  }
}
