/**
 * YAML non-string scalar resolution for `SKILL.md` manifest fields.
 *
 * A strict YAML parser resolves a plain scalar like `true`, `123`, `~`, or `2024-01-01` to a
 * boolean, number, null, or timestamp, so the reference validator rejects such a manifest. This
 * platform reads `name` and `description` as text, so it must reject the same values rather than
 * silently stringifying them. Each entry is one pattern for one type, checked against the whole
 * folded, trimmed value; a value that merely contains a token (`true story`, `v2`) stays a string.
 */

export type YamlNonStringType = "null" | "boolean" | "number" | "date";

const YAML_NULL_PATTERN = /^(?:~|null)$/i;
const YAML_BOOLEAN_PATTERN = /^(?:true|false|yes|no|on|off|y|n)$/i;
const YAML_INTEGER_PATTERN = /^[-+]?(?:0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*)$/i;
const YAML_FLOAT_PATTERN =
  /^[-+]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?(?:e[-+]?[0-9]+)?|\.[0-9_]+(?:e[-+]?[0-9]+)?|\.inf|\.nan)$/i;
const YAML_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::?\d{2})?))?)?$/;

const YAML_NON_STRING_PATTERNS: readonly [YamlNonStringType, RegExp][] = [
  ["null", YAML_NULL_PATTERN],
  ["boolean", YAML_BOOLEAN_PATTERN],
  ["number", YAML_INTEGER_PATTERN],
  ["number", YAML_FLOAT_PATTERN],
  ["date", YAML_DATE_PATTERN],
];

/** The non-string type a plain scalar resolves to, or `null` when YAML would keep it a string. */
export function resolveYamlNonStringType(value: string): YamlNonStringType | null {
  for (const [type, pattern] of YAML_NON_STRING_PATTERNS) {
    if (pattern.test(value)) return type;
  }
  return null;
}
