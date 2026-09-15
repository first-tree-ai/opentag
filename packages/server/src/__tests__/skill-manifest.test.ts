import { createHash } from "node:crypto";
import { computeSkillDigest, SkillManifestSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { buildSkillManifest, extractSkillArchive } from "../services/skills/index.js";
import { buildSkillZip, skillMarkdown, validSkillZip } from "./support/skill-fixtures.js";

const S_IFREG = 0o100000;

describe("buildSkillManifest", () => {
  it("hashes every file, sorts by path, and derives the digest from the canonical manifest", () => {
    const extracted = extractSkillArchive(validSkillZip("my-skill"));
    const built = buildSkillManifest(extracted.name, extracted.files);
    expect(SkillManifestSchema.parse(built.manifest)).toEqual(built.manifest);
    expect(built.manifest.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(built.manifest.files[1]).toMatchObject({
      mode: "0755",
      size: "#!/bin/sh\necho hi\n".length,
      sha256: createHash("sha256").update("#!/bin/sh\necho hi\n").digest("hex"),
    });
    expect(built.digest).toBe(computeSkillDigest(built.manifest));
    expect(built.fileCount).toBe(2);
    expect(built.totalBytes).toBe(built.manifest.files.reduce((sum, file) => sum + file.size, 0));
  });

  it("is independent of zip metadata: different mtimes and compression levels give the same digest", () => {
    const files = {
      "SKILL.md": skillMarkdown("my-skill"),
      "scripts/run.sh": { content: "echo", mode: S_IFREG | 0o755 },
    };
    const a = buildSkillZip(files, { mtime: new Date("2020-01-01T00:00:00Z"), level: 0 });
    const b = buildSkillZip(files, { mtime: new Date("2026-09-11T12:00:00Z"), level: 9 });
    const digestA = buildSkillManifest("my-skill", extractSkillArchive(a).files).digest;
    const digestB = buildSkillManifest("my-skill", extractSkillArchive(b).files).digest;
    expect(digestA).toBe(digestB);
  });

  it("changes when content, mode, or the wrapping directory content differs but not the wrapper name", () => {
    const base = buildSkillManifest("my-skill", extractSkillArchive(validSkillZip()).files).digest;
    const wrapped = buildSkillZip({
      "anything/SKILL.md": skillMarkdown("my-skill"),
      "anything/scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: S_IFREG | 0o755 },
    });
    expect(buildSkillManifest("my-skill", extractSkillArchive(wrapped).files).digest).toBe(base);
    const modeChanged = buildSkillZip({
      "SKILL.md": skillMarkdown("my-skill"),
      "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: S_IFREG | 0o644 },
    });
    expect(buildSkillManifest("my-skill", extractSkillArchive(modeChanged).files).digest).not.toBe(base);
  });
});
