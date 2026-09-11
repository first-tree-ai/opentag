import { SKILL_ARCHIVE_MAX_BYTES, type SkillUpdatedByKind } from "@opentag/shared/browser";
import { ApiError } from "../../api.js";
import { formatNumber } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";

const KIB = 1024;
const MIB = KIB * KIB;

/** Binary units, because the Server's archive and unpacked limits are defined in MiB. */
export function formatBytes(bytes: number): string {
  if (bytes < KIB) return `${formatNumber(bytes)} B`;
  if (bytes < MIB) return `${formatNumber(roundTenth(bytes / KIB))} KiB`;
  return `${formatNumber(roundTenth(bytes / MIB))} MiB`;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function skillArchiveLimitLabel(): string {
  return formatBytes(SKILL_ARCHIVE_MAX_BYTES);
}

/**
 * The checks the browser can make before sending anything: the extension the picker was asked
 * for, and the size the Server would refuse with a 413 anyway. Null means the file may be sent.
 */
export function skillFileRejection(file: File): string | null {
  const isZip = file.type === "application/zip" || /\.zip$/i.test(file.name);
  if (!isZip) return m.skills_upload_invalid_type();
  if (file.size > SKILL_ARCHIVE_MAX_BYTES) {
    return m.skills_upload_too_large({ file: file.name, limit: skillArchiveLimitLabel() });
  }
  return null;
}

/**
 * Every refusal the upload endpoint documents, keyed on the status because the shared error code
 * catalogue may lag the Server's skill codes; the Server's own sentence follows where it adds detail.
 */
export function skillUploadErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return m.skills_upload_failed();
  const detail = error.code ? error.message : undefined;
  const sentence =
    error.status === 413
      ? m.skills_error_too_large({ limit: skillArchiveLimitLabel() })
      : error.status === 415
        ? m.skills_error_unsupported_type()
        : error.status === 400
          ? m.skills_error_invalid_archive()
          : error.status === 503
            ? m.skills_error_storage_unavailable()
            : (detail ?? m.skills_upload_failed());
  return detail && sentence !== detail ? `${sentence} ${detail}` : sentence;
}

export function skillUpdatedByLabel(kind: SkillUpdatedByKind): string {
  return kind === "session" ? m.skills_updated_by_session() : m.skills_updated_by_user();
}
