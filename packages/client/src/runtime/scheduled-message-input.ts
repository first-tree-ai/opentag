/*
 * Scheduled SessionMessage Agent-input helpers (issue #744).
 *
 * A scheduled message carries the Server-generated `scheduledOrigin` snapshot plus the dynamic
 * `sentAt` / `scheduleDetailUrl` display metadata. When the Runtime actually starts processing
 * the message (after every queue wait), the managed input gains a distinct scheduled-task
 * metadata item and a single best-effort start notification the Agent sends through the existing
 * IM provider CLI. Everything here is pure text assembly: no scheduler state, no notification
 * ledger, and nothing that feeds a persistent hash or configuration fingerprint.
 */

/** The notification/summary budget: 120 Unicode code points, 119 + `…` when truncated. */
export const SCHEDULE_TASK_PREVIEW_MAX_CODE_POINTS = 120;

/**
 * Collapse every whitespace run to one space, then cap at 120 Unicode code points (119 + a
 * single `…` beyond that). Spreading iterates code points, so a non-BMP character never splits a
 * surrogate pair; a multi-code-point grapheme may still end mid-sequence, matching the agreed
 * code-point semantics.
 */
export function normalizeScheduleTaskPreview(prompt: string): string {
  const collapsed = prompt.replace(/\s+/gu, " ").trim();
  const points = [...collapsed];
  if (points.length <= SCHEDULE_TASK_PREVIEW_MAX_CODE_POINTS) return collapsed;
  return `${points.slice(0, SCHEDULE_TASK_PREVIEW_MAX_CODE_POINTS - 1).join("")}…`;
}

/*
 * Emoji removal for DISPLAY only: extended pictographs, regional indicators, tag characters, and
 * the joiner/variation/keycap glue that would otherwise dangle after the base characters are
 * gone. `#`, `*`, and ASCII digits are NOT emoji components here — they stay. The source snapshot
 * and the full task text are never modified; only the composed notification display is filtered.
 */
const EMOJI_DISPLAY_PATTERN =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}]|\u{200d}|\u{fe0f}|\u{20e3}|[\u{e0020}-\u{e007f}]/gu;

/** Remove emoji from notification display text and re-collapse the whitespace that surrounded them. */
export function filterEmojiForDisplay(text: string): string {
  return text.replace(EMOJI_DISPLAY_PATTERN, "").replace(/\s+/gu, " ").trim();
}

/**
 * One instant rendered in an explicit IANA timezone as `YYYY-MM-DD HH:mm:ss ±HH:MM` — the same
 * display contract the Server schedule preview uses. Returns null when the timezone cannot be
 * interpreted by this Runtime's tzdata; callers fall back to UTC instead of failing the Turn.
 */
export function formatScheduleLocalTime(at: Date, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
    const wallAsUtc = Date.UTC(
      Number(value("year")),
      Number(value("month")) - 1,
      Number(value("day")),
      Number(value("hour")) % 24,
      Number(value("minute")),
      Number(value("second")),
    );
    const offsetMs = wallAsUtc - Math.floor(at.getTime() / 1000) * 1000;
    const sign = offsetMs < 0 ? "-" : "+";
    const absMinutes = Math.round(Math.abs(offsetMs) / 60_000);
    const offset = `${sign}${String(Math.floor(absMinutes / 60)).padStart(2, "0")}:${String(absMinutes % 60).padStart(2, "0")}`;
    const wall = new Date(at.getTime() + offsetMs).toISOString();
    return `${wall.slice(0, 10)} ${wall.slice(11, 19)} ${offset}`;
  } catch {
    return null;
  }
}

/** The facts one scheduled start notification displays; name/preview arrive unfiltered. */
export interface ScheduleStartNotificationFacts {
  readonly name: string;
  readonly preview: string;
  readonly scheduledFor: Date;
  readonly processedAt: Date;
  readonly timezone: string;
  readonly detailUrl: string;
}

function localOrUtc(at: Date, timezone: string): string {
  const local = formatScheduleLocalTime(at, timezone);
  return local === null ? `${at.toISOString()} (UTC)` : `${local} (${timezone})`;
}

function displayName(name: string): string {
  const filtered = filterEmojiForDisplay(name);
  return filtered === "" ? "(unnamed)" : filtered;
}

function displayPreview(preview: string): string {
  const filtered = filterEmojiForDisplay(preview);
  return filtered === "" ? "(no preview)" : filtered;
}

/**
 * The exact best-effort start notification body. Emoji are filtered HERE, in the display copy
 * only — never from the managed metadata fields or the task body. No emoji is ever added.
 */
export function buildScheduleStartNotification(facts: ScheduleStartNotificationFacts): string {
  return [
    `Scheduled task started: ${displayName(facts.name)}`,
    `Scheduled time: ${localOrUtc(facts.scheduledFor, facts.timezone)}`,
    `Started at: ${localOrUtc(facts.processedAt, facts.timezone)}`,
    `Task preview: ${displayPreview(facts.preview)}`,
    `Details: ${facts.detailUrl}`,
  ].join("\n");
}

/** Escape untrusted text for interpolation into a managed metadata block (single line, quoted). */
export function escapeScheduledMetadataText(text: string): string {
  return JSON.stringify(text).replace(
    /[<>&]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
