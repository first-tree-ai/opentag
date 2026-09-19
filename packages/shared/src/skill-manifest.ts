import { z } from "zod";
import { resolveYamlNonStringType, type YamlNonStringType } from "./skill-manifest-scalar.js";

/**
 * `SKILL.md` manifest parsing for the Agent Skills contract.
 *
 * A Skill manifest is YAML frontmatter with two fields this platform reads: `name` and
 * `description`. Everything else is advisory metadata a real Skill may carry (`license`,
 * `metadata`, `allowed-tools`), so it is skipped rather than validated. Keeping the parser in its own
 * module keeps `skill.ts` under the file-size ratchet; `skill.ts` re-exports this surface, so the
 * public `@opentag/shared` exports are unchanged.
 *
 * The platform deliberately carries no YAML dependency: a bounded hand-written parser is smaller and
 * has no transitive supply chain. The two fields must be scalars, so the parser classifies the value
 * by YAML's structural rules — a flow indicator, a block indicator, a mapping key, or a quoted scalar
 * — rather than by enumerating the collection shapes it has seen. Anything it cannot represent
 * faithfully is a typed rejection with a specific reason, which the Server surfaces as
 * `SKILL_MANIFEST_INVALID`.
 */

export const SKILL_MANIFEST_MAX_BYTES = 256 * 1024;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/* ----------------------------------- names --------------------------------- */

/** A Skill name: lowercase alphanumerics joined by single hyphens, 1–64 characters. */
export const SkillNameSchema = z
  .string()
  .regex(
    /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/,
    "Skill name must be 1 to 64 characters of lowercase letters, numbers, and single hyphens, and may not start or end with a hyphen",
  );
export type SkillName = z.infer<typeof SkillNameSchema>;

/**
 * Names the platform already owns, so an Agent can never shadow them with an uploaded Skill.
 *
 * These mirror `CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES` and `RUNNER_TOOL_SKILL_DIRECTORIES` in
 * `packages/client/src/runner/skills.ts`. `@opentag/shared` may not depend on the Client package, so
 * the values are copied here deliberately; the Client lane adds a parity test that fails when the
 * two lists drift.
 */
export const SKILL_RESERVED_NAMES: readonly string[] = Object.freeze([
  "context-tree-connect",
  "context-tree-create",
  "context-tree-publish",
  "context-tree-read",
  "context-tree-setup",
  "context-tree-write",
  "git",
  "gh",
  "lark-cli",
  "slack",
]);

export function isReservedSkillName(name: string): boolean {
  return SKILL_RESERVED_NAMES.includes(name);
}

/* --------------------------------- manifest -------------------------------- */

/**
 * The two fields the platform understands in a `SKILL.md` frontmatter block. Unknown top-level keys
 * are ignored because real Skills carry advisory metadata (`license`, `allowed-tools`, …) that the
 * platform neither stores nor validates.
 *
 * The description is trimmed, because a `>`/`|` block scalar carries its chomping-derived trailing
 * newline into the parsed value and the description is stored and shown as one line.
 */
export const SkillManifestSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export type ParseSkillManifestResult = { ok: true; manifest: SkillManifest } | { ok: false; reason: string };

type BlockScalarStyle = "folded" | "literal";
type BlockScalarChomp = "clip" | "strip" | "keep";

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A frontmatter fence: `---` at column zero, ignoring trailing whitespace. */
function isFrontmatterDelimiter(line: string): boolean {
  return line.trimEnd() === "---";
}

function extractFrontmatter(lines: string[]): { ok: true; lines: string[] } | { ok: false; reason: string } {
  if (!isFrontmatterDelimiter(lines[0] ?? "")) {
    return { ok: false, reason: "Skill manifest is missing its frontmatter" };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (isFrontmatterDelimiter(lines[index] ?? "")) {
      return { ok: true, lines: lines.slice(1, index) };
    }
  }
  return { ok: false, reason: "Skill manifest frontmatter is unterminated" };
}

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
  '"': '"',
};

function unescapeDoubleQuoted(value: string): string | null {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      result += character;
      index += 1;
      continue;
    }
    const replacement = DOUBLE_QUOTE_ESCAPES[value[index + 1] ?? ""];
    if (replacement === undefined) return null;
    result += replacement;
    index += 2;
  }
  return result;
}

/* ---------------------- YAML non-string scalar resolution ------------------ */

function nonStringRejection(key: string, type: YamlNonStringType): ManifestFieldValue {
  return { ok: false, reason: `Skill manifest ${key} must be a string, not a ${type}` };
}

function parseBlockIndicator(raw: string): { style: BlockScalarStyle; chomp: BlockScalarChomp } | null {
  const first = raw[0];
  if (first !== "|" && first !== ">") return null;
  const style: BlockScalarStyle = first === "|" ? "literal" : "folded";
  const rest = raw.slice(1);
  if (rest === "") return { style, chomp: "clip" };
  if (rest === "-") return { style, chomp: "strip" };
  if (rest === "+") return { style, chomp: "keep" };
  return null;
}

function collectBlockLines(lines: string[], startIndex: number): { lines: string[]; nextIndex: number } {
  const collected: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      collected.push("");
      index += 1;
      continue;
    }
    if (!/^[ \t]/.test(line)) break;
    collected.push(line);
    index += 1;
  }
  return { lines: collected, nextIndex: index };
}

function stripBlockIndent(lines: string[]): string[] {
  let indent: number | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const width = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    indent = indent === null ? width : Math.min(indent, width);
  }
  const base = indent ?? 0;
  return lines.map((line) => (line.trim().length === 0 ? "" : line.slice(base)));
}

function countTrailingBlankLines(lines: string[]): number {
  let count = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").length !== 0) break;
    count += 1;
  }
  return count;
}

function foldLines(lines: string[]): string {
  let result = "";
  let blankRun = 0;
  let started = false;
  for (const line of lines) {
    if (line.length === 0) {
      blankRun += 1;
      continue;
    }
    if (started) result += blankRun > 0 ? "\n".repeat(blankRun) : " ";
    result += line;
    started = true;
    blankRun = 0;
  }
  return result;
}

function applyChomp(body: string, chomp: BlockScalarChomp, trailingBlankLines: number): string {
  if (chomp === "strip") return body;
  if (chomp === "keep") return `${body}${"\n".repeat(1 + trailingBlankLines)}`;
  return body.length === 0 ? "" : `${body}\n`;
}

function renderBlockScalar(rawLines: string[], style: BlockScalarStyle, chomp: BlockScalarChomp): string {
  const lines = stripBlockIndent(rawLines);
  const trailingBlankLines = countTrailingBlankLines(lines);
  const core = trailingBlankLines === 0 ? lines : lines.slice(0, lines.length - trailingBlankLines);
  const body = style === "literal" ? core.join("\n") : foldLines(core);
  return applyChomp(body, chomp, trailingBlankLines);
}

type FrontmatterEntry = { ok: true; key: string; value: string; nextIndex: number } | { ok: false; reason: string };
type ManifestFieldValue = { ok: true; value: string; nextIndex: number } | { ok: false; reason: string };

/** A YAML block-sequence item at any indentation, e.g. `- read` or `  - read`. */
function isSequenceLine(line: string): boolean {
  return /^[ \t]*-(\s|$)/.test(line);
}

function firstNonBlankLine(lines: string[], startIndex: number): string | undefined {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length > 0) return line;
  }
  return undefined;
}

/**
 * Skip a value the platform does not read.
 *
 * Every following blank, indented, or list line belongs to the preceding key, whatever it contains.
 * Nested maps (`metadata:`) and block sequences (`allowed-tools:`) under an unknown key are therefore
 * ignored instead of being treated as malformed frontmatter — real `SKILL.md` files use both.
 */
function collectIgnoredValueLines(lines: string[], startIndex: number): number {
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const belongsToKey = line.trim().length === 0 || /^[ \t]/.test(line) || isSequenceLine(line);
    if (!belongsToKey) break;
    index += 1;
  }
  return index;
}

/** A YAML inline comment begins at whitespace followed by `#`; a plain scalar may not contain one. */
function hasInlineComment(line: string): boolean {
  return /[ \t]#/.test(line);
}

/**
 * The characters YAML forbids a plain scalar from starting with. `|` and `>` only reach this check on
 * the continuation path, because a key-line `|`/`>` is a block scalar.
 */
const PLAIN_START_INDICATORS = new Set(["[", "{", "]", "}", ",", "#", "&", "*", "!", "|", ">", "%", "@", "`"]);

function startsWithPlainScalarIndicator(line: string): boolean {
  const first = line[0];
  if (first !== undefined && PLAIN_START_INDICATORS.has(first)) return true;
  return /^[-?:](\s|$)/.test(line);
}

/**
 * The index of the first `:` that ends a mapping key — one followed by whitespace or the end of the
 * line — or -1 when the line has none. A colon inside a URL or a time (`http://x`, `12:30`) is not
 * one.
 */
function mappingColonIndex(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== ":") continue;
    const next = line[index + 1];
    if (next === undefined || /\s/.test(next)) return index;
  }
  return -1;
}

function collectionRejection(key: string): ManifestFieldValue {
  return { ok: false, reason: `Skill manifest ${key} must be a string, not a list or map` };
}

/**
 * A plain scalar on the key line cannot contain `: `; a strict YAML parser reads it as a mapping key.
 * The reason names the fix, quoting the value, while still containing the collection phrase.
 */
function quoteRejection(key: string): ManifestFieldValue {
  return {
    ok: false,
    reason: `Skill manifest ${key} must be a string, not a list or map; quote a value that contains ": "`,
  };
}

function quotedRejection(key: string): ManifestFieldValue {
  return { ok: false, reason: `Skill manifest ${key} must be one complete quoted string` };
}

/** Unquote a double-quoted run only when its closing `"` is the last character and is unescaped. */
function unquoteCompleteDoubleQuoted(folded: string): string | null {
  let escaped = false;
  for (let index = 1; index < folded.length; index += 1) {
    const character = folded[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    return index === folded.length - 1 ? unescapeDoubleQuoted(folded.slice(1, -1)) : null;
  }
  return null;
}

/** Unquote a single-quoted run only when its closing `'` is the last character and is not a `''`. */
function unquoteCompleteSingleQuoted(folded: string): string | null {
  for (let index = 1; index < folded.length; index += 1) {
    if (folded[index] !== "'") continue;
    if (folded[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index === folded.length - 1 ? folded.slice(1, -1).replaceAll("''", "'") : null;
  }
  return null;
}

/** Unquote a folded run only when it is one complete quoted scalar; otherwise `null`. */
function unquoteFoldedScalar(folded: string): string | null {
  if (folded.length < 2) return null;
  if (folded[0] === '"') return unquoteCompleteDoubleQuoted(folded);
  if (folded[0] === "'") return unquoteCompleteSingleQuoted(folded);
  return null;
}

/**
 * A quoted scalar, which may start on the key line or on the first continuation line and may span
 * lines. Fold the lines like `>` and require exactly one complete quoted scalar; trailing text, a
 * mapping key after the quote, and an unterminated quote are all rejected.
 */
function readQuotedScalar(valueLines: string[], key: string, nextIndex: number): ManifestFieldValue {
  const unquoted = unquoteFoldedScalar(foldLines(valueLines));
  if (unquoted !== null) return { ok: true, value: unquoted, nextIndex };
  const first = firstNonBlankLine(valueLines, 0) ?? "";
  if (mappingColonIndex(first) > 0) return collectionRejection(key);
  return quotedRejection(key);
}

function inlineCommentRejection(key: string): ManifestFieldValue {
  return { ok: false, reason: `Skill manifest has an inline comment on the ${key} value` };
}

function isQuotedStart(line: string): boolean {
  return line.startsWith('"') || line.startsWith("'");
}

/**
 * YAML's plain-scalar START rule on the effective first value line. A key-line value containing `: `
 * is not a collection but is still invalid YAML, so it gets the "quote the value" reason.
 */
function checkEffectivePlainLine(
  effective: string | undefined,
  key: string,
  fromKeyLine: boolean,
): ManifestFieldValue | null {
  if (effective === undefined) return null;
  if (startsWithPlainScalarIndicator(effective)) return collectionRejection(key);
  if (mappingColonIndex(effective) > 0) return fromKeyLine ? quoteRejection(key) : collectionRejection(key);
  if (hasInlineComment(effective)) return inlineCommentRejection(key);
  return null;
}

/** Every other line of a plain scalar must avoid a mapping colon (`: ` or a trailing `:`) and ` #`. */
function checkPlainContinuationLines(
  valueLines: string[],
  effective: string | undefined,
  key: string,
): ManifestFieldValue | null {
  for (const line of valueLines) {
    if (line.length === 0 || line === effective) continue;
    if (mappingColonIndex(line) >= 0) return quoteRejection(key);
    if (hasInlineComment(line)) return inlineCommentRejection(key);
  }
  return null;
}

/**
 * A plain scalar, optionally continued on following indented lines. The effective first value line is
 * the key-line value when there is one, otherwise the first non-blank continuation; YAML's
 * plain-scalar start rule applies to it, every line must avoid `: ` and a trailing `:`, and the whole
 * folded value must not resolve to a non-string YAML type.
 */
function readPlainScalar(lines: string[], index: number, key: string, rawValue: string): ManifestFieldValue {
  const collected = collectBlockLines(lines, index + 1);
  const continuation = stripBlockIndent(collected.lines);
  const valueLines = rawValue.length > 0 ? [rawValue, ...continuation] : continuation;
  const effective = firstNonBlankLine(valueLines, 0);

  if (effective !== undefined && isQuotedStart(effective)) {
    return readQuotedScalar(valueLines, key, collected.nextIndex);
  }
  const effectiveRejection = checkEffectivePlainLine(effective, key, rawValue.length > 0);
  if (effectiveRejection) return effectiveRejection;
  const continuationRejection = checkPlainContinuationLines(valueLines, effective, key);
  if (continuationRejection) return continuationRejection;
  const folded = foldLines(valueLines).trim();
  const nonStringType = resolveYamlNonStringType(folded);
  if (nonStringType !== null) return nonStringRejection(key, nonStringType);
  return { ok: true, value: folded, nextIndex: collected.nextIndex };
}

function readManifestFieldValue(lines: string[], index: number, key: string, rawValue: string): ManifestFieldValue {
  if (rawValue.startsWith("|") || rawValue.startsWith(">")) {
    const block = parseBlockIndicator(rawValue);
    if (!block) return { ok: false, reason: `Skill manifest has an unsupported block scalar for ${key}` };
    const collected = collectBlockLines(lines, index + 1);
    const value = renderBlockScalar(collected.lines, block.style, block.chomp);
    return { ok: true, value, nextIndex: collected.nextIndex };
  }
  return readPlainScalar(lines, index, key, rawValue);
}

function readFrontmatterEntry(lines: string[], index: number): FrontmatterEntry {
  const line = lines[index] ?? "";
  if (/^[ \t]/.test(line)) {
    return { ok: false, reason: "Skill manifest frontmatter has an indented line with no preceding key" };
  }
  const match = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
  if (!match) return { ok: false, reason: "Skill manifest frontmatter has a line that is not a top-level key" };
  const key = match[1] ?? "";
  const rawValue = (match[2] ?? "").trim();
  if (key !== "name" && key !== "description") {
    return { ok: true, key, value: "", nextIndex: collectIgnoredValueLines(lines, index + 1) };
  }
  const field = readManifestFieldValue(lines, index, key, rawValue);
  if (!field.ok) return field;
  return { ok: true, key, value: field.value, nextIndex: field.nextIndex };
}

function parseFrontmatterEntries(
  lines: string[],
): { ok: true; entries: Map<string, string> } | { ok: false; reason: string } {
  const entries = new Map<string, string>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.startsWith("#")) {
      index += 1;
      continue;
    }
    const entry = readFrontmatterEntry(lines, index);
    if (!entry.ok) return entry;
    index = entry.nextIndex;
    if (entry.key !== "name" && entry.key !== "description") continue;
    if (entries.has(entry.key)) return { ok: false, reason: `Skill manifest has a duplicate ${entry.key} field` };
    entries.set(entry.key, entry.value);
  }
  return { ok: true, entries };
}

/**
 * Parse the `SKILL.md` frontmatter into a manifest, never throwing.
 *
 * Only `name` and `description` are read, and both must be strings: a quoted scalar (on the key line
 * or on a continuation line), a `>`/`|` block scalar, or a plain scalar (single- or multi-line, folded
 * like `>`). A value that is structurally a collection — a flow list/map or a block
 * sequence/mapping — is rejected with a specific reason, because folding it into a string would accept
 * a `SKILL.md` the reference validator rejects. Unknown top-level keys are ignored together with their
 * value, including nested maps and block sequences, because real `SKILL.md` files carry `metadata` and
 * `allowed-tools`. A plain `name`/`description` may not carry an inline comment, and neither key may
 * repeat.
 */
export function parseSkillManifest(markdown: string): ParseSkillManifestResult {
  if (utf8Length(markdown) > SKILL_MANIFEST_MAX_BYTES) {
    return { ok: false, reason: `Skill manifest exceeds ${SKILL_MANIFEST_MAX_BYTES} bytes` };
  }
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const frontmatter = extractFrontmatter(lines);
  if (!frontmatter.ok) return frontmatter;
  const parsed = parseFrontmatterEntries(frontmatter.lines);
  if (!parsed.ok) return parsed;
  const name = parsed.entries.get("name");
  if (name === undefined) return { ok: false, reason: "Skill manifest is missing the name field" };
  const description = parsed.entries.get("description");
  if (description === undefined) return { ok: false, reason: "Skill manifest is missing the description field" };
  const result = SkillManifestSchema.safeParse({ name, description });
  if (!result.success) {
    return { ok: false, reason: result.error.issues[0]?.message ?? "Skill manifest is invalid" };
  }
  return { ok: true, manifest: result.data };
}
