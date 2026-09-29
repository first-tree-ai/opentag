import { createHash } from "node:crypto";

/**
 * The reader a fetched source is presented as, whichever transport produced it.
 *
 * A git repository is read lazily: the tree listing is cheap and its blobs arrive only when a
 * candidate is actually inspected or packaged. An archive or a single downloaded document is already
 * in memory, so reading is a lookup. Both look the same to discovery and packaging, which is what
 * keeps the discovery rules and the archive validation in one place instead of one per transport.
 */

export interface SkillSourceFile {
  /** Source-relative path, POSIX separators. */
  path: string;
  /** Whether the executable bit was set. Preserved so a packaged Skill keeps its modes. */
  executable: boolean;
  /**
   * A content identity for the file: the blob id from a repository tree, or the sha256 of the bytes
   * from an in-memory source. It is what makes a fingerprint of the whole Skill possible without
   * re-reading anything, and both forms are content-derived, so the two transports agree.
   */
  id: string;
}

export interface SkillSourceSnapshot {
  /** Every regular file in the source. Symlinks and submodule links are already excluded. */
  readonly files: readonly SkillSourceFile[];
  read(path: string): Promise<Uint8Array>;
  /** Releases whatever the snapshot holds: a temporary clone, or nothing at all. */
  dispose(): Promise<void>;
}

export interface MemorySkillSourceEntry {
  path: string;
  body: Uint8Array;
  executable?: boolean;
}

/** The content identity of an in-memory file, in the same shape a repository blob id takes. */
export function contentId(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The fingerprint of one Skill's files: every path with its content identity and mode, sorted so the
 * value does not depend on the order the source listed them. `sha256:` marks a content-derived value;
 * a source that can only see names uses the `declared:` form instead, so the two can never be
 * confused for one another.
 */
export function skillFingerprint(files: readonly { path: string; id: string; executable: boolean }[]): string {
  const lines = files.map((file) => `${file.path}\0${file.id}\0${file.executable ? "755" : "644"}`);
  return `sha256:${createHash("sha256").update(lines.sort().join("\n")).digest("hex")}`;
}

/** The fingerprint of a declared file list alone, for a source that publishes no content hash. */
export function declaredFingerprint(paths: readonly string[]): string {
  const digest = createHash("sha256")
    .update([...paths].sort().join("\n"))
    .digest("hex");
  return `declared:${digest}`;
}

/** The snapshot of an already-materialized source: an unpacked archive, or one downloaded file. */
export function memorySkillSourceSnapshot(entries: Iterable<MemorySkillSourceEntry>): SkillSourceSnapshot {
  const files = new Map<string, MemorySkillSourceEntry>();
  for (const entry of entries) files.set(entry.path, entry);
  return {
    files: [...files.values()].map((entry) => ({
      path: entry.path,
      executable: entry.executable === true,
      id: contentId(entry.body),
    })),
    read(path: string) {
      const entry = files.get(path);
      if (entry === undefined) throw new Error(`The source does not contain ${path}`);
      return Promise.resolve(entry.body);
    },
    dispose() {
      return Promise.resolve();
    },
  };
}
