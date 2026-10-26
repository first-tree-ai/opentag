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
 * from a caller that had one. PostgreSQL parses either, and an out-of-range value fails the cast in
 * the next query rather than silently selecting a different page.
 */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CursorSchema = z.object({ at: z.string().regex(CURSOR_TIMESTAMP), id: z.string().uuid() }).strict();

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
