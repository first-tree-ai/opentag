import { z } from "zod";

/**
 * Agent Skills contract.
 *
 * A Skill is a directory containing a `SKILL.md` manifest plus supporting files, uploaded to the
 * platform, stored as one archive object, owned by exactly one Agent, and materialized into that
 * Agent's workspace at runtime. This module is the shared contract only: the Server, Client/CLI and
 * Web lanes build on these schemas, constants, and parsing rules. See
 * `docs/design/agent-skills.md`.
 *
 * Like every module under `src/` that the browser entrypoint re-exports, this one is
 * browser-compatible: no `node:*` import and no `Buffer`. Byte lengths are measured with
 * `TextEncoder` for the same reason `mcp.ts` avoids the Node global.
 */

/* ---------------------------------- limits --------------------------------- */

export const SKILL_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
export const SKILL_UNPACKED_MAX_BYTES = 64 * 1024 * 1024;
export const SKILL_MAX_ENTRIES = 1000;
export const SKILL_MAX_PATH_BYTES = 256;
export const SKILL_MANIFEST_MAX_BYTES = 256 * 1024;
export const SKILL_MAX_PER_AGENT = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_MAX_LISTED_FILES = 500;
export const SKILL_MANIFEST_FILE = "SKILL.md";
/**
 * The marker the Client writes inside every platform-managed skill directory. Sync only ever
 * rewrites directories that carry it, so a Skill an Agent authors locally, and every Context Tree
 * skill, is left alone.
 */
export const SKILL_MARKER_FILE = ".opentag-skill.json";

/* ----------------------------------- names --------------------------------- */

/** A Skill name: lowercase, hyphens, 1–64 characters, and never a leading hyphen. */
export const SkillNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    "Skill name must start with a lowercase letter or number and contain only lowercase letters, numbers, and hyphens",
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
 */
export const SkillManifestSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
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

function readFrontmatterEntry(lines: string[], index: number): FrontmatterEntry {
  const line = lines[index] ?? "";
  if (/^[ \t]/.test(line)) return { ok: false, reason: "Skill manifest frontmatter has an indented line" };
  const match = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
  if (!match) return { ok: false, reason: "Skill manifest frontmatter has a line that is not a top-level key" };
  const key = match[1] ?? "";
  const rawValue = (match[2] ?? "").trim();
  if (rawValue.startsWith("|") || rawValue.startsWith(">")) {
    const block = parseBlockIndicator(rawValue);
    if (!block) return { ok: false, reason: `Skill manifest has an unsupported block scalar for ${key}` };
    const collected = collectBlockLines(lines, index + 1);
    const value = renderBlockScalar(collected.lines, block.style, block.chomp);
    return { ok: true, key, value, nextIndex: collected.nextIndex };
  }
  const scalar = parseScalarValue(rawValue);
  if (scalar === null) return { ok: false, reason: `Skill manifest has an unsupported value for ${key}` };
  return { ok: true, key, value: scalar, nextIndex: index + 1 };
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
    entries.set(entry.key, entry.value);
    index = entry.nextIndex;
  }
  return { ok: true, entries };
}

/**
 * Parse the `SKILL.md` frontmatter into a manifest, never throwing.
 *
 * The platform deliberately carries no YAML dependency: a manifest is a flat map of scalars, so a
 * bounded hand-written parser is smaller and has no transitive supply chain. It supports exactly
 * plain and quoted single-line scalars plus `>`/`|` block scalars with an optional `-`/`+` chomping
 * indicator. Anything it cannot represent faithfully is a typed rejection with a specific reason,
 * which the Server surfaces as `SKILL_MANIFEST_INVALID`.
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

/* --------------------------------- resources ------------------------------- */

const SkillIdSchema = z.string().uuid();
export const SkillSourceSchema = z.enum(["web_upload", "cli_upload", "agent_upload"]);
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export const SkillArchiveFormatSchema = z.enum(["tar.gz", "zip"]);
export type SkillArchiveFormat = z.infer<typeof SkillArchiveFormatSchema>;
export const SkillStorageStatusSchema = z.enum(["available", "unavailable"]);
export type SkillStorageStatus = z.infer<typeof SkillStorageStatusSchema>;

/** Lowercase hex SHA-256 of the stored archive. */
export const SkillArchiveSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export type SkillArchiveSha256 = z.infer<typeof SkillArchiveSha256Schema>;

export const SkillFileEntrySchema = z
  .object({
    path: z.string().min(1).max(SKILL_MAX_PATH_BYTES),
    bytes: z.number().int().min(0),
  })
  .strict();
export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;

export const SkillSchema = z
  .object({
    id: SkillIdSchema,
    agentId: SkillIdSchema,
    name: SkillNameSchema,
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
    enabled: z.boolean(),
    source: SkillSourceSchema,
    archiveSha256: SkillArchiveSha256Schema,
    archiveBytes: z.number().int().min(1).max(SKILL_ARCHIVE_MAX_BYTES),
    fileCount: z.number().int().min(1).max(SKILL_MAX_ENTRIES),
    revision: z.number().int().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Skill = z.infer<typeof SkillSchema>;

export const SkillDetailSchema = SkillSchema.extend({
  files: z.array(SkillFileEntrySchema).max(SKILL_MAX_LISTED_FILES),
  filesTruncated: z.boolean(),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const ListAgentSkillsResponseSchema = z
  .object({
    skills: z.array(SkillSchema),
    storage: SkillStorageStatusSchema,
  })
  .strict();
export type ListAgentSkillsResponse = z.infer<typeof ListAgentSkillsResponseSchema>;

export const UpdateSkillRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequestSchema>;

/** One enabled Skill as a Computer needs it to fetch and verify a bundle. */
export const RuntimeSkillManifestEntrySchema = z
  .object({
    id: SkillIdSchema,
    name: SkillNameSchema,
    archiveSha256: SkillArchiveSha256Schema,
    archiveBytes: z.number().int().min(1).max(SKILL_ARCHIVE_MAX_BYTES),
  })
  .strict();
export type RuntimeSkillManifestEntry = z.infer<typeof RuntimeSkillManifestEntrySchema>;

export const RuntimeSkillManifestSchema = z
  .object({
    skills: z.array(RuntimeSkillManifestEntrySchema).max(SKILL_MAX_PER_AGENT),
  })
  .strict();
export type RuntimeSkillManifest = z.infer<typeof RuntimeSkillManifestSchema>;

/** The content of `SKILL_MARKER_FILE` written inside every platform-managed skill directory. */
export const SkillInstallMarkerSchema = z
  .object({
    skillId: SkillIdSchema,
    archiveSha256: SkillArchiveSha256Schema,
  })
  .strict();
export type SkillInstallMarker = z.infer<typeof SkillInstallMarkerSchema>;

/* ------------------------------ upload headers ----------------------------- */

export const SKILL_SHA256_HEADER = "x-opentag-skill-sha256";
export const SKILL_FORMAT_HEADER = "x-opentag-skill-format";
export const SKILL_REPLACE_HEADER = "x-opentag-skill-replace";
export const SKILL_UPLOAD_CONTENT_TYPE = "application/octet-stream";

/* ---------------------------------- errors --------------------------------- */

export const SKILL_ERROR_CODES = {
  NOT_FOUND: "SKILL_NOT_FOUND",
  NAME_CONFLICT: "SKILL_NAME_CONFLICT",
  LIMIT_REACHED: "SKILL_LIMIT_REACHED",
  NAME_RESERVED: "SKILL_NAME_RESERVED",
  MANIFEST_INVALID: "SKILL_MANIFEST_INVALID",
  ARCHIVE_INVALID: "SKILL_ARCHIVE_INVALID",
  HASH_MISMATCH: "SKILL_HASH_MISMATCH",
  ARCHIVE_TOO_LARGE: "SKILL_ARCHIVE_TOO_LARGE",
  STORAGE_UNAVAILABLE: "SKILL_STORAGE_UNAVAILABLE",
} as const;
export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[keyof typeof SKILL_ERROR_CODES];
export type SkillErrorCategory = "credential" | "deterministic" | "validation" | "transient";

export const SKILL_ERROR_CODE_METADATA: Readonly<
  Record<SkillErrorCode, { category: SkillErrorCategory; statusCode: number }>
> = {
  [SKILL_ERROR_CODES.NOT_FOUND]: { category: "deterministic", statusCode: 404 },
  [SKILL_ERROR_CODES.NAME_CONFLICT]: { category: "deterministic", statusCode: 409 },
  [SKILL_ERROR_CODES.LIMIT_REACHED]: { category: "deterministic", statusCode: 409 },
  [SKILL_ERROR_CODES.NAME_RESERVED]: { category: "validation", statusCode: 400 },
  [SKILL_ERROR_CODES.MANIFEST_INVALID]: { category: "validation", statusCode: 400 },
  [SKILL_ERROR_CODES.ARCHIVE_INVALID]: { category: "validation", statusCode: 400 },
  [SKILL_ERROR_CODES.HASH_MISMATCH]: { category: "validation", statusCode: 400 },
  [SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE]: { category: "validation", statusCode: 413 },
  [SKILL_ERROR_CODES.STORAGE_UNAVAILABLE]: { category: "transient", statusCode: 503 },
};
