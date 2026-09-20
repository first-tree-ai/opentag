import {
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_ERROR_CODES,
  type SkillArchiveFormat,
  type SkillErrorCode,
  type SkillSource,
} from "@opentag/shared/browser";
import { formatNumber } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";

/**
 * The pure half of the Skills page: archive classification, hashing, byte formatting, and the one
 * place the platform's error codes become sentences. Kept out of the component so each rule can be
 * tested without a DOM and so the page body stays about layout and state.
 */

/**
 * The archive formats the platform accepts, by file extension. `.skill` is a `zip` bundle, which is
 * why it maps to the zip format rather than to a format of its own.
 */
export function archiveFormatForFile(name: string): SkillArchiveFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip") || lower.endsWith(".skill")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  return null;
}

/** Lowercase hex SHA-256 of the bytes, the value the upload's integrity header carries. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type SkillArchiveRejection = "too_large" | "unsupported_format";

export type SkillArchiveCheck =
  | { ok: true; format: SkillArchiveFormat }
  | { ok: false; rejection: SkillArchiveRejection };

/**
 * Client-side pre-checks, run before any request. Size and extension are the two failures the user
 * can fix without a round trip, so the page reports them locally rather than uploading a bundle the
 * Server is certain to reject.
 */
export function checkSkillArchiveFile(file: { name: string; size: number }): SkillArchiveCheck {
  if (file.size > SKILL_ARCHIVE_MAX_BYTES) return { ok: false, rejection: "too_large" };
  const format = archiveFormatForFile(file.name);
  if (format === null) return { ok: false, rejection: "unsupported_format" };
  return { ok: true, format };
}

/** A compact human size for one stored archive. Bytes stay exact below a kibibyte. */
export function formatArchiveBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) return `${formatNumber(Math.round(kibibytes * 10) / 10)} KB`;
  return `${formatNumber(Math.round((kibibytes / 1024) * 10) / 10)} MB`;
}

const SOURCE_MESSAGES: Record<SkillSource, () => string> = {
  web_upload: m.skills_source_web_upload,
  cli_upload: m.skills_source_cli_upload,
  agent_upload: m.skills_source_agent_upload,
};

/** Where this Skill's archive came from, as a sentence rather than the wire value. */
export function skillSourceLabel(source: SkillSource): string {
  return SOURCE_MESSAGES[source]();
}

/**
 * Every platform error code, mapped to its sentence. A `Record` over the union is deliberate: adding
 * a code to the contract breaks this file at typecheck until it is given copy.
 */
const ERROR_MESSAGES: Record<SkillErrorCode, () => string> = {
  [SKILL_ERROR_CODES.NOT_FOUND]: m.skills_error_not_found,
  [SKILL_ERROR_CODES.NAME_CONFLICT]: m.skills_error_name_conflict,
  [SKILL_ERROR_CODES.REVISION_CONFLICT]: m.skills_error_revision_conflict,
  [SKILL_ERROR_CODES.LIMIT_REACHED]: m.skills_error_limit_reached,
  [SKILL_ERROR_CODES.NAME_RESERVED]: m.skills_error_name_reserved,
  [SKILL_ERROR_CODES.MANIFEST_INVALID]: m.skills_error_manifest_invalid,
  [SKILL_ERROR_CODES.ARCHIVE_INVALID]: m.skills_error_archive_invalid,
  [SKILL_ERROR_CODES.HASH_MISMATCH]: m.skills_error_hash_mismatch,
  [SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE]: m.skills_error_archive_too_large,
  [SKILL_ERROR_CODES.STORAGE_UNAVAILABLE]: m.skills_error_storage_unavailable,
};

export function skillErrorMessage(code: string | undefined): string {
  if (code !== undefined && Object.hasOwn(ERROR_MESSAGES, code)) {
    return ERROR_MESSAGES[code as SkillErrorCode]();
  }
  return m.skills_error_generic();
}

export function skillRejectionMessage(rejection: SkillArchiveRejection): string {
  return rejection === "too_large" ? m.skills_error_client_too_large() : m.skills_error_client_unsupported();
}

export type { SkillArchiveFormat, SkillErrorCode };
