/**
 * Parses a Server response with its shared schema while ignoring fields this client does not know.
 *
 * The CLI, long-lived open Web SPA tabs, and the Server can run at different versions: the Server
 * changes for everyone at once, while a CLI upgrades only on its next connect and an open Web tab
 * stays on its loaded bundle until the next navigation or reload. Shared response schemas are
 * strict because they also define what the Server may send, so a field added by a newer Server
 * would make an older client reject the whole response. This parse keeps every known field fully
 * validated and drops only the keys the schema reports as unrecognized, at the exact paths Zod
 * reports them.
 *
 * Only unknown keys are forgiven. A wrong type, a missing field, or an enum value the client does not
 * know still fails, because those are breaking changes that need version negotiation.
 *
 * In a plain union, a key unknown to one branch is stripped even if another branch knows it. The
 * re-parse succeeds only when the remaining data fully satisfies a branch, so the result is never
 * worse than an older client that predates the field.
 */
interface StrictSchema<T> {
  safeParse(value: unknown): ParseResult<T>;
}

type ParseResult<T> = { success: true; data: T } | { success: false; error?: { issues: readonly ParseIssue[] } };

export interface ParseIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly keys?: readonly string[];
  readonly errors?: readonly (readonly ParseIssue[])[];
}

/**
 * Each pass may reveal keys one union level deeper, so passes continue while they keep removing new
 * keys. The cap only guards against a schema or body that never converges.
 */
export const MAX_UNKNOWN_KEY_PASSES = 16;

export type ResponseParseResult<T> =
  | { success: true; data: T; ignoredKeys: readonly string[] }
  | {
      success: false;
      reason: "invalid" | "unknown_key_pass_limit";
      ignoredKeys: readonly string[];
      issues: readonly ParseIssue[];
    };

export function parseResponseIgnoringUnknownKeys<T>(schema: StrictSchema<T>, body: unknown): ResponseParseResult<T> {
  let candidate = body;
  const ignored = new Set<string>();
  for (let pass = 0; ; pass += 1) {
    const parsed = schema.safeParse(candidate);
    const ignoredKeys = [...ignored];
    if (parsed.success) return { success: true, data: parsed.data, ignoredKeys };
    const issues = parsed.error?.issues ?? [];
    const unknownKeys = onlyUnknownKeys(issues);
    if (!unknownKeys || unknownKeys.length === 0) return { success: false, reason: "invalid", ignoredKeys, issues };
    const paths = unknownKeys.flatMap(({ path, keys }) => keys.map((key) => [...path, key].map(String).join(".")));
    const fresh = paths.filter((path) => !ignored.has(path));
    // A pass that removes nothing new cannot converge: the same issue would come back unchanged.
    if (fresh.length === 0) return { success: false, reason: "invalid", ignoredKeys, issues };
    if (pass >= MAX_UNKNOWN_KEY_PASSES) {
      return { success: false, reason: "unknown_key_pass_limit", ignoredKeys, issues };
    }
    for (const path of fresh) ignored.add(path);
    candidate = withoutKeys(candidate, unknownKeys);
  }
}

type UnknownKeys = { path: readonly PropertyKey[]; keys: readonly string[] };

/** The unrecognized keys, or undefined when any issue is something other than an unknown key. */
function onlyUnknownKeys(
  issues: readonly ParseIssue[],
  prefix: readonly PropertyKey[] = [],
): UnknownKeys[] | undefined {
  const found: UnknownKeys[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === "unrecognized_keys" && issue.keys) {
      found.push({ path, keys: issue.keys });
      continue;
    }
    if (issue.code === "invalid_union" && issue.errors) {
      // A union issue is forgivable when at least one branch failed only on unknown keys.
      const branch = issue.errors
        .map((errors) => onlyUnknownKeys(errors, path))
        .find((keys) => keys !== undefined && keys.length > 0);
      if (!branch) return undefined;
      found.push(...branch);
      continue;
    }
    return undefined;
  }
  return found;
}

function withoutKeys(value: unknown, unknownKeys: readonly UnknownKeys[]): unknown {
  const copy = structuredClone(value);
  for (const { path, keys } of unknownKeys) {
    const target = path.reduce<unknown>(
      (node, segment) => (isRecord(node) ? (node as Record<PropertyKey, unknown>)[segment] : undefined),
      copy,
    );
    if (!isRecord(target)) continue;
    for (const key of keys) delete (target as Record<string, unknown>)[key];
  }
  return copy;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
