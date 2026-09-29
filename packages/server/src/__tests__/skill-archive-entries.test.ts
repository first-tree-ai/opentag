import { describe, expect, it } from "vitest";
import { normalizeSkillArchive, normalizeSkillEntries } from "../services/skills/index.js";
import { openDocumentSource } from "../services/skills/source/document-source.js";
import { discoverRemoteSkills, skillArchiveEntries } from "../services/skills/source/remote-candidates.js";
import { memorySkillSourceSnapshot } from "../services/skills/source/source-snapshot.js";
import { bytesOf, skillManifest, tarGz } from "./support/skill-archive-fixtures.js";
import { stubFetcher } from "./support/skill-source-fixtures.js";

/**
 * One logical Skill, three ways in.
 *
 * An uploaded archive, a downloaded artifact, and a repository file listing all have to produce the
 * same canonical bytes: the sha256 is what the row and the object key are built from, and two
 * transports that disagreed would make the same Skill two different objects. The equality is
 * asserted rather than assumed, because the three paths reach the packer through different readers.
 */

const LOGICAL_FILES: readonly { name: string; body: string }[] = [
  { name: "SKILL.md", body: skillManifest("demo", "One logical Skill") },
  { name: "notes.md", body: "notes\n" },
  { name: "scripts/run.sh", body: "#!/bin/sh\necho demo\n" },
];

async function archiveBytes(): Promise<Uint8Array> {
  return tarGz(LOGICAL_FILES.map((file) => ({ name: file.name, body: file.body })));
}

/** The first entry, asserted present: a missing one is a test setup failure, not a soft expectation. */
function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("expected at least one item");
  return value;
}

function fetcherServing(bytes: Uint8Array) {
  return stubFetcher({ "https://example.test/demo": () => ({ status: 200, body: bytes }) });
}

describe("one logical Skill through every entry point", () => {
  it("produces the same canonical archive and sha256 from an upload", async () => {
    const bytes = await archiveBytes();
    const normalized = await normalizeSkillArchive(bytes, "tar.gz");
    expect(normalized.manifest.name).toBe("demo");
    expect(normalized.fileCount).toBe(3);
    expect(normalized.sha256).toHaveLength(64);
    // Deterministic: the same input packs to the same bytes twice.
    expect((await normalizeSkillArchive(bytes, "tar.gz")).sha256).toBe(normalized.sha256);
  });

  it("produces the same canonical archive and sha256 from a download", async () => {
    const bytes = await archiveBytes();
    const reference = await normalizeSkillArchive(bytes, "tar.gz");
    const document = await openDocumentSource(fetcherServing(bytes), "https://example.test/demo");
    try {
      const listings = await discoverRemoteSkills({ snapshot: document.snapshot });
      expect(listings.map((listing) => listing.candidate.name)).toEqual(["demo"]);
      const files = await first(listings).materialize();
      const normalized = await normalizeSkillEntries(skillArchiveEntries(files));
      expect(normalized.sha256).toBe(reference.sha256);
      expect(normalized.archive).toEqual(reference.archive);
    } finally {
      await document.snapshot.dispose();
    }
  });

  it("produces the same canonical archive and sha256 from a source listing", async () => {
    const bytes = await archiveBytes();
    const reference = await normalizeSkillArchive(bytes, "tar.gz");
    // A listing is what a git tree or a well-known directory yields: paths and contents, with no
    // archive framing to read.
    const snapshot = memorySkillSourceSnapshot(
      LOGICAL_FILES.map((file) => ({ path: file.name, body: bytesOf(file.body) })),
    );
    const listings = await discoverRemoteSkills({ snapshot });
    const normalized = await normalizeSkillEntries(skillArchiveEntries(await first(listings).materialize()));
    expect(normalized.sha256).toBe(reference.sha256);
    expect(normalized.archive).toEqual(reference.archive);
  });
});
