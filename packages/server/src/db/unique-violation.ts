const UNIQUE_VIOLATION = "23505";

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
