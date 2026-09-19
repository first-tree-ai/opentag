import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentSkills } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { SkillServiceError, skillNotFound, skillStorageFailure } from "./errors.js";
import type { NormalizedSkillArchive } from "./skill-archive.js";
import { type SkillObjectStore, SkillObjectStoreError } from "./skill-object-store.js";

/**
 * Object-lifecycle helpers for `SkillService`.
 *
 * The invariant they exist to protect: **a row must never point at an object that does not exist.**
 * An orphaned object is harmless and can be swept later; a dangling row breaks every bundle read
 * until the next successful replace. Because the row and the object are two systems, every step
 * here is written to fail toward keeping the object rather than deleting one that might still be
 * referenced, and every writer re-checks its own object after its row write commits.
 */

type ObjectBinding = { agentId?: string; skillId?: string };

/** Maps a store failure to the Skill error the caller sees; never leaks an upstream detail. */
export function mapSkillStoreError(error: unknown): SkillServiceError {
  if (error instanceof SkillServiceError) return error;
  if (error instanceof SkillObjectStoreError && error.code === "not_found") {
    return skillNotFound("The Skill bundle is missing from storage");
  }
  return skillStorageFailure();
}

/** Best-effort object cleanup: a failure is logged and never fails the request it belongs to. */
export async function bestEffortDeleteSkillObject(
  store: SkillObjectStore,
  key: string,
  context: string,
  logger?: ServiceLogger,
  binding: ObjectBinding = {},
): Promise<void> {
  try {
    await store.delete(key);
  } catch (error) {
    logger?.warn(
      {
        key,
        ...(binding.agentId ? { agentId: binding.agentId } : {}),
        ...(binding.skillId ? { skillId: binding.skillId } : {}),
        code: error instanceof SkillObjectStoreError ? error.code : "unknown",
      },
      `Skill object cleanup failed: ${context}`,
    );
  }
}

/**
 * Removes a newly written object after the row write did not land, but only when no current row
 * still references it. A failed read is treated as "do not delete": an orphan is recoverable, a
 * dangling row is data loss.
 */
export async function discardUnreferencedObject(
  database: DatabaseClient,
  store: SkillObjectStore,
  objectKey: string,
  skillId: string,
  logger?: ServiceLogger,
): Promise<void> {
  let current: { objectKey: string } | undefined;
  try {
    [current] = await database
      .select({ objectKey: agentSkills.objectKey })
      .from(agentSkills)
      .where(eq(agentSkills.id, skillId))
      .limit(1);
  } catch {
    logger?.warn(
      { code: "skill_object_cleanup_skipped", skillId },
      "Skill object cleanup skipped because the row could not be read",
    );
    return;
  }
  if (current?.objectKey === objectKey) return;
  await bestEffortDeleteSkillObject(store, objectKey, "new Skill object after a failed write", logger, { skillId });
}

/**
 * Deletes the replaced object only while our own write is still the row's current object.
 *
 * A later replace may have moved the row to a different key — or even back to this same key by
 * re-uploading identical content — so deleting the old object unconditionally can strand the row on
 * an object that no longer exists.
 */
export async function deleteReplacedObject(
  database: DatabaseClient,
  store: SkillObjectStore,
  existing: { id: string; agentId: string; objectKey: string },
  newObjectKey: string,
  logger?: ServiceLogger,
): Promise<void> {
  const [current] = await database
    .select({ objectKey: agentSkills.objectKey })
    .from(agentSkills)
    .where(eq(agentSkills.id, existing.id))
    .limit(1);
  if (current?.objectKey !== newObjectKey) return;
  await bestEffortDeleteSkillObject(store, existing.objectKey, "replaced Skill object", logger, {
    agentId: existing.agentId,
    skillId: existing.id,
  });
}

/**
 * Confirms the object this write committed still exists, restoring it from the in-memory archive if
 * another writer's cleanup removed it between our PUT and our commit. The row is correct either way,
 * so a failed restore is `SKILL_STORAGE_UNAVAILABLE` rather than a silent dangling row.
 *
 * The row is re-read before restoring so a writer whose write was superseded does not resurrect an
 * orphan the new row no longer references.
 */
export async function ensureObjectPresent(
  database: DatabaseClient,
  store: SkillObjectStore,
  objectKey: string,
  skillId: string,
  normalized: NormalizedSkillArchive,
  logger?: ServiceLogger,
): Promise<void> {
  let present: { bytes: number } | null;
  try {
    present = await store.head(objectKey);
  } catch (error) {
    throw mapSkillStoreError(error);
  }
  if (present !== null) return;
  const [current] = await database
    .select({ objectKey: agentSkills.objectKey })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId))
    .limit(1);
  if (current?.objectKey !== objectKey) return;
  try {
    await store.put(objectKey, normalized.archive, { sha256: normalized.sha256 });
  } catch (error) {
    throw mapSkillStoreError(error);
  }
  logger?.warn(
    { code: "skill_object_restored", skillId, sha256: normalized.sha256.slice(0, 12) },
    "Skill object was missing after the row write; restored",
  );
}
