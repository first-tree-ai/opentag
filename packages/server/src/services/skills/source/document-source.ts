import {
  parseSkillManifest,
  SKILL_MANIFEST_FILE,
  SKILL_MANIFEST_MAX_BYTES,
  SKILL_SOURCE_DOWNLOAD_MAX_BYTES,
  SKILL_SOURCE_EXTRACT_MAX_BYTES,
} from "@opentag/shared";
import { skillSourceNoSkills } from "../errors.js";
import { readSkillEntries } from "../skill-archive-reader.js";
import type { SkillSourceFetcher } from "./source-fetcher.js";
import { memorySkillSourceSnapshot, type SkillSourceSnapshot } from "./source-snapshot.js";

/**
 * A direct download: a single `SKILL.md`, or an archive of one or more Skills.
 *
 * The format is decided by the bytes, not by the URL, because a source URL is under the peer's
 * control: a `.tar.gz` name with zip inside is unpacked as zip, and an extensionless download is
 * read for what it is. The two formats an archive may have are the two the Skill archive reader
 * already validates — zip and gzip-compressed tar — so a downloaded artifact gets the same path
 * traversal, link, entry-count and unpacked-size checks an uploaded archive gets, and no third
 * unpacker exists in this feature. An uncompressed `.tar` is deliberately not accepted: it is not a
 * format the upload surface accepts either.
 */

export interface DocumentSource {
  snapshot: SkillSourceSnapshot;
  /** How the download was read; logged, never shown. */
  format: "skill_md" | "zip" | "tar.gz";
}

const ZIP_MAGIC = [0x50, 0x4b];
const GZIP_MAGIC = [0x1f, 0x8b];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((value, index) => bytes[index] === value);
}

/**
 * Downloads one URL and presents it as a source.
 *
 * A download that is neither an archive nor a valid `SKILL.md` is a source with no Skills rather
 * than an error code of its own: the user pasted a URL that does not publish Skills, which is the
 * same outcome as a repository that holds none.
 */
export async function openDocumentSource(fetcher: SkillSourceFetcher, url: string): Promise<DocumentSource> {
  const { bytes } = await fetcher.fetchBytes(url);
  if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, GZIP_MAGIC)) {
    const format = startsWith(bytes, ZIP_MAGIC) ? "zip" : "tar.gz";
    // The documented source ceilings, not the general archive ones: a download is capped at 10 MiB
    // and may unpack to at most 25 MiB (and 1000 members, the reader's own entry bound).
    const entries = await readSkillEntries(bytes, format, {
      maxArchiveBytes: SKILL_SOURCE_DOWNLOAD_MAX_BYTES,
      maxUnpackedBytes: SKILL_SOURCE_EXTRACT_MAX_BYTES,
    });
    if (entries.length === 0) throw skillSourceNoSkills();
    return {
      format,
      snapshot: memorySkillSourceSnapshot(
        entries.map((entry) => ({
          path: entry.path,
          body: entry.body,
          executable: (entry.mode & 0o111) !== 0,
        })),
      ),
    };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > SKILL_MANIFEST_MAX_BYTES) throw skillSourceNoSkills();
  const parsed = parseSkillManifest(new TextDecoder().decode(bytes));
  if (!parsed.ok) throw skillSourceNoSkills();
  return {
    format: "skill_md",
    snapshot: memorySkillSourceSnapshot([{ path: SKILL_MANIFEST_FILE, body: bytes }]),
  };
}
