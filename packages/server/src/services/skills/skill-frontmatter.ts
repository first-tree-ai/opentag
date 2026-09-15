import { SKILL_MD_MAX_BYTES, SkillDescriptionSchema, SkillNameSchema } from "@opentag/shared";
import { parse as parseYaml } from "yaml";
import { skillManifestInvalid } from "./errors.js";

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** The full SKILL.md as UTF-8 text with the BOM removed; line endings are preserved. */
  markdown: string;
}

const FRONTMATTER_OPEN = /^---[ \t]*\n/;
const FRONTMATTER_CLOSE = /\n---[ \t]*(?:\n|$)/;

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    throw skillManifestInvalid("SKILL.md", "SKILL.md must be valid UTF-8");
  }
}

function frontmatterBlock(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const open = FRONTMATTER_OPEN.exec(normalized);
  if (!open) throw skillManifestInvalid("SKILL.md", "SKILL.md must start with a YAML frontmatter block");
  const rest = normalized.slice(open[0].length);
  const close = FRONTMATTER_CLOSE.exec(rest);
  if (!close) throw skillManifestInvalid("SKILL.md", "SKILL.md frontmatter is not closed with ---");
  return rest.slice(0, close.index);
}

function parseFrontmatterObject(block: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseYaml(block, { uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw skillManifestInvalid("SKILL.md", `SKILL.md frontmatter is not valid YAML: ${errorMessage(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw skillManifestInvalid("SKILL.md", "SKILL.md frontmatter must be a YAML mapping");
  }
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
}

function requireName(value: unknown): string {
  if (typeof value !== "string") throw skillManifestInvalid("name", "SKILL.md frontmatter needs a string name");
  const parsed = SkillNameSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw skillManifestInvalid("name", "name must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }
  return parsed.data;
}

function requireDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw skillManifestInvalid("description", "SKILL.md frontmatter needs a string description");
  }
  const parsed = SkillDescriptionSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw skillManifestInvalid("description", "description must be 1 to 1024 characters");
  }
  return parsed.data;
}

/** Parse and validate a SKILL.md. Tolerates a UTF-8 BOM and CRLF line endings; keeps unknown frontmatter keys. */
export function parseSkillFrontmatter(bytes: Uint8Array): SkillFrontmatter {
  if (bytes.byteLength > SKILL_MD_MAX_BYTES) {
    throw skillManifestInvalid("SKILL.md", `SKILL.md must be at most ${SKILL_MD_MAX_BYTES} bytes`);
  }
  const markdown = decodeUtf8(bytes);
  const frontmatter = parseFrontmatterObject(frontmatterBlock(markdown));
  return {
    name: requireName(frontmatter.name),
    description: requireDescription(frontmatter.description),
    markdown,
  };
}
