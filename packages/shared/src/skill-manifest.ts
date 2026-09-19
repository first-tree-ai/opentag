import { z } from "zod";

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
 * has no transitive supply chain. It supports plain scalars (single- or multi-line, folded like `>`)
 * and quoted scalars plus `>`/`|` block scalars with an optional `-`/`+` chomping indicator. Anything
 * it cannot represent faithfully is a typed rejection with a specific reason, which the Server
 * surfaces as `SKILL_MANIFEST_INVALID`.
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

/** A plain, single-quoted, or double-quoted scalar; `null` means "not faithfully representable". */
function parseScalarValue(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return "";
  const quote = value[0];
  if (quote === '"') {
    if (value.length < 2 || !value.endsWith('"')) return null;
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (quote === "'") {
    if (value.length < 2 || !value.endsWith("'")) return null;
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
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

/** A YAML mapping key line, e.g. `author: x` or `requires:`. */
function isMappingLine(line: string): boolean {
  return /^[A-Za-z0-9_.-]+:(\s|$)/.test(line);
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

function collectionRejection(key: string): ManifestFieldValue {
  return { ok: false, reason: `Skill manifest ${key} must be a string, not a list or map` };
}

/**
 * A plain scalar, optionally continued on following indented lines. Continuations are folded the way
 * `>` folds them, so a long description written over several lines keeps its paragraph breaks.
 *
 * A plain value that is really a collection is rejected rather than folded into a string: a block
 * sequence (`- read`) or, after an empty first line, a block mapping (`purpose: read files`). Folding
 * first would erase the type distinction and accept a `SKILL.md` the reference validator rejects.
 */
function readPlainScalar(lines: string[], index: number, key: string, rawValue: string): ManifestFieldValue {
  const collected = collectBlockLines(lines, index + 1);
  const continuation = stripBlockIndent(collected.lines);
  const nextContent = firstNonBlankLine(lines, index + 1);
  if (nextContent !== undefined && isSequenceLine(nextContent)) return collectionRejection(key);
  const firstContent = firstNonBlankLine(continuation, 0);
  if (rawValue.length === 0 && firstContent !== undefined && isMappingLine(firstContent)) {
    return collectionRejection(key);
  }
  if (hasInlineComment(rawValue) || continuation.some(hasInlineComment)) {
    return { ok: false, reason: `Skill manifest has an inline comment on the ${key} value` };
  }
  return { ok: true, value: foldLines([rawValue, ...continuation]), nextIndex: collected.nextIndex };
}

function readManifestFieldValue(lines: string[], index: number, key: string, rawValue: string): ManifestFieldValue {
  if (rawValue.startsWith("|") || rawValue.startsWith(">")) {
    const block = parseBlockIndicator(rawValue);
    if (!block) return { ok: false, reason: `Skill manifest has an unsupported block scalar for ${key}` };
    const collected = collectBlockLines(lines, index + 1);
    const value = renderBlockScalar(collected.lines, block.style, block.chomp);
    return { ok: true, value, nextIndex: collected.nextIndex };
  }
  if (rawValue.startsWith("'") || rawValue.startsWith('"')) {
    const scalar = parseScalarValue(rawValue);
    if (scalar === null) return { ok: false, reason: `Skill manifest has an unsupported value for ${key}` };
    return { ok: true, value: scalar, nextIndex: index + 1 };
  }
  if (rawValue.startsWith("[") || rawValue.startsWith("{")) return collectionRejection(key);
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
 * Only `name` and `description` are read. They must be strings: a quoted scalar, a `>`/`|` block
 * scalar, or a plain scalar (single- or multi-line, folded like `>`). A collection value — a flow
 * list/map or a block sequence/mapping — is rejected with a specific reason. Unknown top-level keys
 * are ignored together with their value, including nested maps and block sequences, because real
 * `SKILL.md` files carry `metadata` and `allowed-tools`. A plain `name`/`description` scalar may not
 * carry an inline comment, and neither key may repeat.
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
