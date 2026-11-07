/*
 * Scheduled SessionMessage Agent-input helpers (issue #744).
 *
 * A scheduled message carries the Server-generated `scheduledOrigin` snapshot plus the dynamic
 * `sentAt` / `scheduleDetailUrl` display metadata. When the Runtime actually starts processing
 * the message (after every queue wait), the managed input gains a distinct scheduled-task
 * metadata item. Everything here is pure text assembly: no scheduler state and nothing that feeds
 * a persistent hash or configuration fingerprint.
 */

/** The preview budget: 120 Unicode code points, 119 + `…` when truncated. */
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

/** Escape untrusted text for interpolation into a managed metadata block (single line, quoted). */
export function escapeScheduledMetadataText(text: string): string {
  return JSON.stringify(text).replace(
    /[<>&]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
