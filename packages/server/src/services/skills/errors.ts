import {
  SKILL_ERROR_CODE_METADATA,
  SKILL_ERROR_CODES,
  type SkillErrorCategory,
  type SkillErrorCode,
} from "@opentag/shared";

/**
 * A Skill failure carrying the shared error contract: the code the client branches on, the retry
 * category, and the HTTP status. `app.ts` treats it as an Account-facing error, so its `code` and
 * `category` are exactly what the response envelope reports — nothing internal leaks through.
 */
export class SkillServiceError extends Error {
  readonly code: SkillErrorCode;
  readonly category: SkillErrorCategory;
  readonly statusCode: number;

  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.name = "SkillServiceError";
    this.code = code;
    this.category = SKILL_ERROR_CODE_METADATA[code].category;
    this.statusCode = SKILL_ERROR_CODE_METADATA[code].statusCode;
  }
}

export function skillNotFound(message = "The Skill was not found"): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.NOT_FOUND, message);
}

export function skillNameConflict(message = "A Skill with that name already exists"): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.NAME_CONFLICT, message);
}

export function skillRevisionConflict(message = "The Skill changed concurrently; reload and retry"): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.REVISION_CONFLICT, message);
}

export function skillLimitReached(): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.LIMIT_REACHED, "This Agent has reached its Skill limit");
}

export function skillNameReserved(name: string): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.NAME_RESERVED, `The Skill name ${name} is reserved`);
}

export function skillManifestInvalid(message: string): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.MANIFEST_INVALID, message);
}

export function skillArchiveInvalid(message: string): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.ARCHIVE_INVALID, message);
}

export function skillHashMismatch(): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.HASH_MISMATCH, "The uploaded archive does not match its sha256");
}

export function skillArchiveTooLarge(): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE, "The Skill archive is too large");
}

export function skillStorageUnavailable(): SkillServiceError {
  return new SkillServiceError(
    SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    "Skill storage is not configured on this deployment",
  );
}

export function skillStorageFailure(): SkillServiceError {
  return new SkillServiceError(SKILL_ERROR_CODES.STORAGE_UNAVAILABLE, "Skill storage is unavailable");
}
