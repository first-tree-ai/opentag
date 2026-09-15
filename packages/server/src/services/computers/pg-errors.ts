export function uniqueConstraintName(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && current.code === "23505") {
      if ("constraint_name" in current && typeof current.constraint_name === "string") return current.constraint_name;
      if ("constraint" in current && typeof current.constraint === "string") return current.constraint;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
