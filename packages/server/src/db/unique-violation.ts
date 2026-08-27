const UNIQUE_VIOLATION = "23505";
const DEADLOCK_DETECTED = "40P01";

/**
 * Whether a thrown error, or anything in its `cause` chain, is a PostgreSQL unique violation on one named constraint.
 *
 * Drizzle wraps the driver error, so a top-level `code` check misses the violation and lets it escape as an opaque
 * `INTERNAL_ERROR`. Matching the constraint by name keeps the classification narrow: an unrelated violation from the
 * same statement stays an error rather than being reported as the conflict the caller was expecting.
 */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      current.code === UNIQUE_VIOLATION &&
      "constraint_name" in current &&
      current.constraint_name === constraintName
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Whether a thrown error, or anything in its `cause` chain, is a PostgreSQL deadlock.
 *
 * A unique index is itself a waiting point: a statement that would collide with a not-yet-committed tuple waits on the
 * transaction holding it. Two transactions exchanging values on a unique column therefore wait on each other with no
 * explicit lock involved, and PostgreSQL aborts one with `40P01`. Callers that already treat the unique violation as a
 * decision want the same answer here, so classify it beside the statement that can produce it rather than globally.
 */
export function isDeadlock(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && current.code === DEADLOCK_DETECTED) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
