import {
  type RemoteSkillInstallResult,
  type RemoteSkillUnavailableReason,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_ERROR_CODES,
  type SkillArchiveFormat,
  type SkillErrorCode,
  type SkillPresetCategoryId,
  type SkillPresetInstallAction,
  type SkillPresetState,
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

/**
 * Whether this deployment can store bundles, in three states rather than two.
 *
 * `unknown` is not "available": before the first successful list the page knows nothing, and an
 * enabled Upload button would invite a request the Server is about to refuse. It is derived only
 * from successful data, so a failed initial load stays `unknown` and never renders the calm
 * "unavailable" notice, which is a claim about the deployment rather than about this request.
 */
export function storageStateForList(data: { storage: "available" | "unavailable" } | undefined) {
  if (data === undefined) return "unknown" as const;
  return data.storage;
}

export type SkillStorageState = ReturnType<typeof storageStateForList>;

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
  url_install: m.skills_source_url_install,
  preset: m.skills_source_preset,
};

/**
 * Where this Skill's archive came from, as a sentence rather than the wire value.
 *
 * A value the page does not know — a Skill written by a newer Server and read by this build after a
 * rollback — falls back to the raw value instead of throwing. A row that cannot be labelled is a
 * display problem; a page that cannot render is an outage.
 */
export function skillSourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_MESSAGES, source) ? SOURCE_MESSAGES[source as SkillSource]() : source;
}

/**
 * Every platform error code, mapped to its sentence. A `Record` over the union is deliberate: adding
 * a code to the contract breaks this file at typecheck until it is given copy.
 */
const ERROR_MESSAGES: Record<SkillErrorCode, () => string> = {
  [SKILL_ERROR_CODES.NOT_FOUND]: m.skills_error_not_found,
  [SKILL_ERROR_CODES.PRESET_NOT_FOUND]: m.skills_error_preset_not_found,
  [SKILL_ERROR_CODES.NAME_CONFLICT]: m.skills_error_name_conflict,
  [SKILL_ERROR_CODES.REVISION_CONFLICT]: m.skills_error_revision_conflict,
  [SKILL_ERROR_CODES.LIMIT_REACHED]: m.skills_error_limit_reached,
  [SKILL_ERROR_CODES.NAME_RESERVED]: m.skills_error_name_reserved,
  [SKILL_ERROR_CODES.MANIFEST_INVALID]: m.skills_error_manifest_invalid,
  [SKILL_ERROR_CODES.ARCHIVE_INVALID]: m.skills_error_archive_invalid,
  [SKILL_ERROR_CODES.HASH_MISMATCH]: m.skills_error_hash_mismatch,
  [SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE]: m.skills_error_archive_too_large,
  [SKILL_ERROR_CODES.STORAGE_UNAVAILABLE]: m.skills_error_storage_unavailable,
  [SKILL_ERROR_CODES.SOURCE_INVALID]: m.skills_error_source_invalid,
  [SKILL_ERROR_CODES.SOURCE_UNREACHABLE]: m.skills_error_source_unreachable,
  [SKILL_ERROR_CODES.SOURCE_BLOCKED]: m.skills_error_source_blocked,
  [SKILL_ERROR_CODES.SOURCE_TOO_LARGE]: m.skills_error_source_too_large,
  [SKILL_ERROR_CODES.SOURCE_NO_SKILLS]: m.skills_error_source_no_skills,
};

/**
 * The reason a candidate is listed but cannot be installed, as a sentence. Kept beside the error
 * map because both turn a contract value into copy the user reads.
 */
const UNAVAILABLE_MESSAGES: Record<RemoteSkillUnavailableReason, () => string> = {
  manifest_invalid: m.skills_install_unavailable_manifest_invalid,
  name_reserved: m.skills_install_unavailable_name_reserved,
  too_large: m.skills_install_unavailable_too_large,
  path_invalid: m.skills_install_unavailable_path_invalid,
};

export function skillUnavailableMessage(reason: RemoteSkillUnavailableReason): string {
  return UNAVAILABLE_MESSAGES[reason]();
}

/** The label for one install result: what happened to that name, in a sentence. */
export function skillInstallResultMessage(result: RemoteSkillInstallResult): string {
  if (result.status === "installed") return m.skills_install_result_installed();
  if (result.status === "skipped_name_conflict") return m.skills_install_result_skipped();
  return skillErrorMessage(result.errorCode);
}

export function skillErrorMessage(code: string | undefined): string {
  if (code !== undefined && Object.hasOwn(ERROR_MESSAGES, code)) {
    return ERROR_MESSAGES[code as SkillErrorCode]();
  }
  return m.skills_error_generic();
}

export function skillRejectionMessage(rejection: SkillArchiveRejection): string {
  return rejection === "too_large" ? m.skills_error_client_too_large() : m.skills_error_client_unsupported();
}

/*
 * Preset catalog copy. Both maps are total over their union so a new state, category, or action in
 * the contract breaks typecheck here until it is given copy, and the category map is what keeps the
 * shared taxonomy and this build's messages in step.
 */

const PRESET_STATE_MESSAGES: Record<SkillPresetState, () => string> = {
  not_installed: m.skills_preset_state_not_installed,
  installed: m.skills_preset_state_installed,
  update_available: m.skills_preset_state_update_available,
  name_conflict: m.skills_preset_state_name_conflict,
};

export function skillPresetStateLabel(state: SkillPresetState): string {
  return PRESET_STATE_MESSAGES[state]();
}

const PRESET_CATEGORY_MESSAGES: Record<SkillPresetCategoryId, () => string> = {
  "getting-started": m.skills_preset_category_getting_started,
  engineering: m.skills_preset_category_engineering,
};

export function skillPresetCategoryLabel(category: SkillPresetCategoryId): string {
  return PRESET_CATEGORY_MESSAGES[category]();
}

/** Whether the card offers a write: an installed preset is a no-op and a conflict is refused. */
export function isSkillPresetActionable(state: SkillPresetState): boolean {
  return state === "not_installed" || state === "update_available";
}

export function skillPresetActionLabel(state: SkillPresetState): string {
  if (state === "not_installed") return m.skills_preset_install();
  if (state === "update_available") return m.skills_preset_update();
  if (state === "installed") return m.skills_preset_state_installed();
  return m.skills_preset_unavailable();
}

export function skillPresetActionMessage(action: SkillPresetInstallAction): string {
  if (action === "installed") return m.skills_preset_action_installed();
  if (action === "updated") return m.skills_preset_action_updated();
  return m.skills_preset_action_unchanged();
}

export type { SkillArchiveFormat, SkillErrorCode };
