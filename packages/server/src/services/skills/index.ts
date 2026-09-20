/*
 * Agent Skills server-side support.
 *
 * Delivered here: metadata in `agent_skills`, an S3-compatible object store behind
 * `SkillObjectStore`, upload validation and deterministic re-packing, and `SkillService` with the
 * Account, Computer, and Agent CLI surfaces. Storage is optional at deploy time; without it, listing
 * works and bundle operations fail with `SKILL_STORAGE_UNAVAILABLE`. See
 * docs/design/agent-skills.md.
 */

export {
  SkillServiceError,
  skillArchiveInvalid,
  skillArchiveTooLarge,
  skillHashMismatch,
  skillLimitReached,
  skillManifestInvalid,
  skillNameConflict,
  skillNameReserved,
  skillNotFound,
  skillRevisionConflict,
  skillStorageFailure,
  skillStorageUnavailable,
} from "./errors.js";
export {
  S3SkillObjectStore,
  type S3SkillObjectStoreConfig,
  type S3SkillObjectStoreOptions,
} from "./s3-skill-object-store.js";
export { type NormalizedSkillArchive, normalizeSkillArchive } from "./skill-archive.js";
export {
  DEFAULT_MAX_TAR_STREAM_BYTES,
  isIgnoredSkillPath,
  normalizeMemberPath,
  type RawSkillEntry,
  type ResolvedSkillReadLimits,
  readSkillEntries,
  resolveSkillReadLimits,
  type SkillReadLimits,
} from "./skill-archive-reader.js";
export {
  SKILL_GC_DEFAULT_GRACE_MS,
  SKILL_GC_DEFAULT_INTERVAL_MS,
  SKILL_GC_DEFAULT_MAX_DELETES_PER_RUN,
  SKILL_GC_DEFAULT_PAGE_SIZE,
  SkillObjectGc,
  type SkillObjectGcOptions,
  type SkillObjectGcSummary,
} from "./skill-object-gc.js";
export {
  isSkillObjectKey,
  type SkillObjectKeyInput,
  type SkillObjectListEntry,
  type SkillObjectListOptions,
  type SkillObjectListResult,
  type SkillObjectStore,
  SkillObjectStoreError,
  type SkillObjectStoreErrorCode,
  skillObjectKey,
} from "./skill-object-store.js";
export {
  type SkillBundle,
  SkillService,
  type SkillServiceOptions,
  type SkillUploadInput,
} from "./skill-service.js";
export { readZipDirectory, type ZipDirectoryEntry } from "./skill-zip-directory.js";
