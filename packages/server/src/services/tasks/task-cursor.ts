import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { TaskQueryError } from "./task-error.js";

/**
 * A keyset cursor carries the exact ordering key of the last row of a page: its timestamp at the
 * precision PostgreSQL compared, and its id.
 *
 * The timestamp is a string, never a `Date`. PostgreSQL stores timestamps in microseconds and orders
 * by them, while `Date` keeps milliseconds; converting a row's timestamp through a `Date` and back
 * would truncate the microseconds, so an ascending page would re-read a row whose timestamp sits
 * between the truncated value and the real one, and a descending page would step over it. The SQL
 * side therefore projects the ordering timestamp as UTC text with six fractional digits
 * (`cursorText`), and the cursor stores that text verbatim.
 */
export interface TaskCursor {
  at: string;
  id: string;
}

/**
 * What a cursor may contain: the instant PostgreSQL prints, or a millisecond-precision ISO value
 * from a caller that had one.
 *
 * The shape alone is not enough. A cursor whose fields are digits but whose values are impossible —
 * `2026-99-99T99:99:99.123456Z` — has the right shape and would reach the `timestamptz` cast, where it
 * raises a database error instead of the caller error this service promises. The calendar and clock
 * ranges are therefore checked here, without turning the value into a `Date`: round-tripping through
 * `Date` is what truncated the microseconds this cursor exists to keep.
 */
const CURSOR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (DAYS_PER_MONTH[month - 1] ?? 0);
}

/** A UTC instant PostgreSQL can cast, at microsecond precision or coarser. */
function parseableInstant(value: string): boolean {
  const match = CURSOR_TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // PostgreSQL has no year zero, and a cursor it printed never carries one.
  if (year < 1 || month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

const CursorSchema = z
  .object({
    at: z.string().refine(parseableInstant, { message: "The cursor timestamp is not a UTC instant" }),
    id: z.string().uuid(),
  })
  .strict();

/**
 * A keyset cursor is opaque to callers and strict to this service: it carries the exact sort key of
 * the last row of a page, and anything that is not that shape is a validation error rather than a
 * silently different page.
 */
export function parseCursor(cursor: string | undefined): TaskCursor | undefined {
  if (!cursor) return undefined;
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new TaskQueryError("VALIDATION_ERROR", "The pagination cursor is invalid", 400);
  }
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id }), "utf8").toString("base64url");
}

/**
 * The one bare `timestamptz` value the cursor binds: PostgreSQL casts it back with the precision it
 * was printed with, so the comparison uses the same instant the page was ordered by.
 */
export function cursorTimestamp(cursor: TaskCursor): SQL {
  return sql`${cursor.at}::timestamptz`;
}

/**
 * The ordering timestamp of a row, at the precision the database compares. `US` is always six
 * digits, so every cursor has one shape; `at time zone 'UTC'` makes it independent of the session's
 * `TimeZone` setting.
 */
export function cursorText(column: SQL): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
