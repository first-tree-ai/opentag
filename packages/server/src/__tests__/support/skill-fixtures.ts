import { zipSync } from "fflate";

/**
 * Zip fixtures for skill tests, generated in-process so no binary blobs live in the repository.
 *
 * `mode` is written as a Unix external attribute the way Info-ZIP does, which is what the server reads back to decide
 * between 0644 and 0755 and to refuse symbolic links.
 */
export interface SkillZipEntry {
  content: string | Uint8Array;
  /** Unix file mode including the type bits, e.g. `0o100755` or `0o120777` for a symlink. Regular 0644 by default. */
  mode?: number;
  /** Override the DOS/Unix host byte; 3 (Unix) by default, 0 (MS-DOS) to omit Unix modes entirely. */
  os?: number;
}

export type SkillZipFiles = Record<string, string | Uint8Array | SkillZipEntry>;

const S_IFREG = 0o100000;

function normalizeEntry(value: string | Uint8Array | SkillZipEntry): SkillZipEntry {
  if (typeof value === "string" || value instanceof Uint8Array) return { content: value };
  return value;
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** Build a zip whose entries carry Unix attributes. Pass `mtime` to prove digests ignore timestamps. */
export function buildSkillZip(files: SkillZipFiles, options: { mtime?: Date; level?: 0 | 6 | 9 } = {}): Uint8Array {
  const zippable: Record<string, [Uint8Array, Record<string, unknown>]> = {};
  for (const [path, value] of Object.entries(files)) {
    const entry = normalizeEntry(value);
    const os = entry.os ?? 3;
    const mode = entry.mode ?? S_IFREG | 0o644;
    zippable[path] = [
      bytesOf(entry.content),
      {
        level: options.level ?? 6,
        os,
        ...(os === 3 ? { attrs: mode << 16 } : {}),
        ...(options.mtime ? { mtime: options.mtime } : {}),
      },
    ];
  }
  return zipSync(zippable);
}

export function skillMarkdown(name: string, description = "Does something useful", body = "# Usage\n\nRun it.\n") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

/** A minimal valid skill: SKILL.md plus one executable script. */
export function validSkillZip(name = "my-skill", extra: SkillZipFiles = {}): Uint8Array {
  return buildSkillZip({
    "SKILL.md": skillMarkdown(name),
    "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: S_IFREG | 0o755 },
    ...extra,
  });
}
