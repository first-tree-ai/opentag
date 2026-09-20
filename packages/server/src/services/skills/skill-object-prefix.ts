/**
 * The one place the deployment object-key prefix is normalized.
 *
 * Deliberately dependency-free: `config.ts` validates the configured prefix with it, and the store
 * and collector build and match keys with it. A config module must not have to import the
 * object-store implementation (and its `@opentag/shared` dependency) just to check one string, and a
 * single implementation is what guarantees the writer and the collector agree on the same form.
 */

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Thrown for a prefix that is not a slash-separated list of non-empty, safe segments. */
export class SkillObjectPrefixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillObjectPrefixError";
  }
}

/**
 * `<prefix>` with empty slash segments dropped and every remaining segment validated.
 *
 * `skills/`, `/skills`, and `//skills//` all normalize to `skills`; one leading or trailing slash is
 * therefore a configuration detail, not a different namespace. `/`, `""`, and any segment that is
 * not `[A-Za-z0-9._-]+` (including `.` and `..`) are rejected, so a traversal or an empty prefix can
 * never become a key. This is the only implementation of the rule: `skillObjectKey` writes with it
 * and `SkillObjectGc` lists and matches with it.
 */
export function normalizeSkillObjectPrefix(prefix: string): string {
  if (typeof prefix !== "string") throw new SkillObjectPrefixError("Skill object store prefix must be a string");
  const segments = prefix.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      throw new SkillObjectPrefixError("Skill object store prefix has a malformed segment");
    }
  }
  if (segments.length === 0) throw new SkillObjectPrefixError("Skill object store prefix is empty");
  return segments.join("/");
}
