import { createHash } from "node:crypto";
import {
  type ReadSkillFileResponse,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_FILE_PREVIEW_MAX_BYTES,
  SkillFilePathSchema,
  type SkillFilePreview,
} from "@opentag/shared";
import { skillArchiveInvalid, skillArchiveTooLarge, skillHashMismatch, skillNotFound } from "./errors.js";
import { readSkillEntries, type SkillReadLimits } from "./skill-archive-reader.js";
import { mapSkillStoreError } from "./skill-object-lifecycle.js";
import type { SkillBundle } from "./skill-service.js";

/** Read storage under the archive ceiling, including when storage reports a false size. */
async function readBundle(bundle: SkillBundle, maxBytes: number): Promise<Uint8Array> {
  const reader = bundle.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes || total > bundle.bytes) throw skillArchiveTooLarge();
      chunks.push(next.value);
    }
  } catch (error) {
    // Cancellation is cleanup; the original failure remains authoritative.
    await reader.cancel().catch(() => undefined);
    throw mapSkillStoreError(error);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (total !== bundle.bytes || createHash("sha256").update(bytes).digest("hex") !== bundle.sha256) {
    throw skillHashMismatch();
  }
  return bytes;
}

function preview(body: Uint8Array): SkillFilePreview {
  if (body.byteLength > SKILL_FILE_PREVIEW_MAX_BYTES) return { status: "too_large" };
  let content: string;
  try {
    // Keep a UTF-8 BOM in source view; invalid UTF-8 must never be silently replaced.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { status: "binary" };
  }
  if (
    Array.from(content).some((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    })
  )
    return { status: "binary" };
  return { status: "text", content };
}

/** Never extract to disk. Reuse the upload reader's path, link, entry and decompression guards. */
export async function readSkillFile(
  bundle: SkillBundle,
  path: string,
  limits?: SkillReadLimits,
): Promise<ReadSkillFileResponse> {
  if (!SkillFilePathSchema.safeParse(path).success) throw skillArchiveInvalid("Invalid Skill file path");
  const bytes = await readBundle(
    bundle,
    Math.min(limits?.maxArchiveBytes ?? SKILL_ARCHIVE_MAX_BYTES, SKILL_ARCHIVE_MAX_BYTES),
  );
  const entries = await readSkillEntries(bytes, "tar.gz", limits);
  const entry = entries.find((item) => item.path === path);
  if (!entry) throw skillNotFound("The Skill file was not found");
  return {
    archiveSha256: bundle.sha256,
    path,
    files: entries
      .map((item) => ({ path: item.path, bytes: item.body.byteLength }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    preview: preview(entry.body),
  };
}
