import { z } from "zod";
import { TaskQueryError } from "./task-error.js";
import { toIso } from "./task-rows.js";

const CursorSchema = z.object({ at: z.string().datetime(), id: z.string().uuid() }).strict();

export interface TaskCursor {
  at: Date;
  id: string;
}

/**
 * A keyset cursor is opaque to callers and strict to this service: it carries the exact sort key of
 * the last row of a page, and anything that is not that shape is a validation error rather than a
 * silently different page.
 */
export function parseCursor(cursor: string | undefined): TaskCursor | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { at: new Date(decoded.at), id: decoded.id };
  } catch {
    throw new TaskQueryError("VALIDATION_ERROR", "The pagination cursor is invalid", 400);
  }
}

export function encodeCursor(at: Date | string, id: string): string {
  return Buffer.from(JSON.stringify({ at: toIso(at), id }), "utf8").toString("base64url");
}

/**
 * Keep cursor timestamps explicit when they cross the SQL boundary. The postgres driver rejects
 * binding the decoded Date directly in a tuple comparison, which only affects requests after the
 * first page. An ISO value with a timestamptz cast preserves the cursor's instant and its ordering.
 */
export function cursorTimestamp(cursor: TaskCursor): string {
  return cursor.at.toISOString();
}
