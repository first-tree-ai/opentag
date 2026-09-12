import type { ErrorCategory, ErrorCode, SkillErrorDetail } from "@opentag/shared";

export class SkillServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly category: ErrorCategory,
    message: string,
    readonly statusCode: number,
    readonly details?: SkillErrorDetail,
  ) {
    super(message);
    this.name = "SkillServiceError";
  }
}

export function skillNotFound(missing?: string[]): SkillServiceError {
  return new SkillServiceError(
    "SKILL_NOT_FOUND",
    "deterministic",
    missing ? "Some requested skills do not exist" : "The requested skill was not found",
    missing ? 400 : 404,
    missing ? { missing } : undefined,
  );
}

export function skillAlreadyExists(name: string): SkillServiceError {
  return new SkillServiceError(
    "SKILL_ALREADY_EXISTS",
    "deterministic",
    `A skill named "${name}" already exists; retry with onConflict=replace to overwrite it`,
    409,
  );
}

export function skillArchiveInvalid(message: string): SkillServiceError {
  return new SkillServiceError("SKILL_ARCHIVE_INVALID", "validation", message, 400);
}

export function skillArchiveTooLarge(message: string, statusCode: 400 | 413 = 400): SkillServiceError {
  return new SkillServiceError("SKILL_ARCHIVE_TOO_LARGE", "validation", message, statusCode);
}

export function skillArchiveTooManyFiles(limit: number): SkillServiceError {
  return new SkillServiceError(
    "SKILL_ARCHIVE_TOO_MANY_FILES",
    "validation",
    `The skill archive contains more than ${limit} files`,
    400,
  );
}

export function skillArchiveInvalidPath(path: string, reason: string): SkillServiceError {
  return new SkillServiceError(
    "SKILL_ARCHIVE_INVALID_PATH",
    "validation",
    `The archive entry "${path}" is not allowed: ${reason}`,
    400,
  );
}

export function skillArchiveUnsupportedMediaType(): SkillServiceError {
  return new SkillServiceError(
    "SKILL_ARCHIVE_UNSUPPORTED_MEDIA_TYPE",
    "validation",
    "Skill archives must be uploaded as application/zip",
    415,
  );
}

export function skillManifestInvalid(field: string, message: string): SkillServiceError {
  return new SkillServiceError("SKILL_MANIFEST_INVALID", "validation", message, 400, { field });
}

export function skillQuotaExceeded(limit: number): SkillServiceError {
  return new SkillServiceError(
    "SKILL_QUOTA_EXCEEDED",
    "deterministic",
    `This account already has ${limit} skills; delete one before uploading another`,
    400,
  );
}

export function skillStorageUnavailable(): SkillServiceError {
  return new SkillServiceError(
    "SKILL_STORAGE_UNAVAILABLE",
    "transient",
    "Skill storage is not available on this server",
    503,
  );
}

export function skillResourceNotFound(): SkillServiceError {
  return new SkillServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
