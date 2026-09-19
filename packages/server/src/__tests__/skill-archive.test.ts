import {
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_ERROR_CODES,
  SKILL_MAX_ENTRIES,
  SKILL_UNPACKED_MAX_BYTES,
} from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TAR_STREAM_BYTES,
  normalizeSkillArchive,
  resolveSkillReadLimits,
} from "../services/skills/index.js";
import {
  buildRawZip,
  buildStoredZip,
  gzipOfZeros,
  skillManifest,
  tarGz,
  tarGzWithDeclaredSize,
  tarMemberModes,
  zipFiles,
  zipLocalHeader,
  zipWithDeclaredSize,
} from "./support/skill-archive-fixtures.js";

const entry = (name: string, body: string, extra: Record<string, unknown> = {}) => ({ name, body, ...extra });

const MIB = 1024 * 1024;

async function failure(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("normalizeSkillArchive", () => {
  it("accepts tar.gz and zip happy paths with a root SKILL.md", async () => {
    const tar = await tarGz([
      entry("SKILL.md", skillManifest("my-skill")),
      entry("scripts/run.sh", "#!/bin/sh\n", { mode: 0o755 }),
    ]);
    const fromTar = await normalizeSkillArchive(tar, "tar.gz");
    expect(fromTar.manifest).toEqual({ name: "my-skill", description: "A test Skill" });
    expect(fromTar.files).toEqual([
      { path: "SKILL.md", bytes: expect.any(Number) },
      { path: "scripts/run.sh", bytes: 10 },
    ]);
    expect(fromTar.fileCount).toBe(2);
    expect(fromTar.filesTruncated).toBe(false);
    expect(fromTar.archive[0]).toBe(0x1f);
    expect(fromTar.sha256).toMatch(/^[0-9a-f]{64}$/);

    const zip = zipFiles({ "SKILL.md": skillManifest("zip-skill"), "lib/x.txt": "hello" });
    const fromZip = await normalizeSkillArchive(zip, "zip");
    expect(fromZip.manifest.name).toBe("zip-skill");
    expect(fromZip.files.map((file) => file.path)).toEqual(["SKILL.md", "lib/x.txt"]);
  });

  it("strips a single shared top-level directory", async () => {
    const tar = await tarGz([entry("wrap/SKILL.md", skillManifest("wrapped")), entry("wrap/lib/x.txt", "x")]);
    const normalized = await normalizeSkillArchive(tar, "tar.gz");
    expect(normalized.files.map((file) => file.path)).toEqual(["SKILL.md", "lib/x.txt"]);
  });

  it("ignores __MACOSX and .DS_Store members", async () => {
    const tar = await tarGz([
      entry("__MACOSX/._SKILL.md", "junk"),
      entry(".DS_Store", "junk"),
      entry("SKILL.md", skillManifest("clean")),
      entry("docs/.DS_Store", "junk"),
    ]);
    const normalized = await normalizeSkillArchive(tar, "tar.gz");
    expect(normalized.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("is deterministic across member order and mtimes", async () => {
    const first = await tarGz([
      entry("SKILL.md", skillManifest("stable"), { mtime: 1_000 }),
      entry("a.txt", "a", { mtime: 2_000 }),
      entry("b.txt", "b", { mtime: 3_000 }),
    ]);
    const second = await tarGz([
      entry("b.txt", "b", { mtime: 999_999 }),
      entry("SKILL.md", skillManifest("stable"), { mtime: 50 }),
      entry("a.txt", "a", { mtime: 7 }),
    ]);
    const a = await normalizeSkillArchive(first, "tar.gz");
    const b = await normalizeSkillArchive(second, "tar.gz");
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.from(a.archive).equals(Buffer.from(b.archive))).toBe(true);
  });

  it("rejects traversal, absolute, and backslash paths", async () => {
    await failure(
      normalizeSkillArchive(await tarGz([entry("../evil", "x"), entry("SKILL.md", skillManifest("t"))]), "tar.gz"),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
    await failure(
      normalizeSkillArchive(await tarGz([entry("/etc/passwd", "x"), entry("SKILL.md", skillManifest("t"))]), "tar.gz"),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
    await failure(
      normalizeSkillArchive(await tarGz([entry("a\\b.txt", "x"), entry("SKILL.md", skillManifest("t"))]), "tar.gz"),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
  });

  it("rejects symlinks, hard links, and device members", async () => {
    await failure(
      normalizeSkillArchive(
        await tarGz([
          entry("link", "", { type: "symlink", linkname: "SKILL.md" }),
          entry("SKILL.md", skillManifest("t")),
        ]),
        "tar.gz",
      ),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
    await failure(
      normalizeSkillArchive(
        await tarGz([entry("hard", "", { type: "link", linkname: "SKILL.md" }), entry("SKILL.md", skillManifest("t"))]),
        "tar.gz",
      ),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
    await failure(
      normalizeSkillArchive(
        await tarGz([
          entry("dev", "", { type: "character-device", devmajor: 1, devminor: 3 }),
          entry("SKILL.md", skillManifest("t")),
        ]),
        "tar.gz",
      ),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
  });

  it("rejects setuid and setgid modes", async () => {
    await failure(
      normalizeSkillArchive(
        await tarGz([entry("SKILL.md", skillManifest("t")), entry("evil.sh", "x", { mode: 0o4755 })]),
        "tar.gz",
      ),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
  });

  it("rejects an archive with too many members", async () => {
    const entries = [entry("SKILL.md", skillManifest("many"))];
    for (let index = 0; index < SKILL_MAX_ENTRIES; index += 1) {
      entries.push(entry(`f/${index}.txt`, "x"));
    }
    await failure(normalizeSkillArchive(await tarGz(entries), "tar.gz"), SKILL_ERROR_CODES.ARCHIVE_INVALID);
  });

  it("rejects unpacked-size bombs before inflating", async () => {
    await failure(
      normalizeSkillArchive(tarGzWithDeclaredSize("SKILL.md", 128 * 1024 * 1024), "tar.gz"),
      SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE,
    );
    await failure(
      normalizeSkillArchive(zipWithDeclaredSize("SKILL.md", 128 * 1024 * 1024), "zip"),
      SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE,
    );
  });

  it("requires a root SKILL.md", async () => {
    await failure(
      normalizeSkillArchive(await tarGz([entry("readme.txt", "x")]), "tar.gz"),
      SKILL_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects an invalid manifest and a reserved name", async () => {
    await failure(
      normalizeSkillArchive(await tarGz([entry("SKILL.md", "no frontmatter")]), "tar.gz"),
      SKILL_ERROR_CODES.MANIFEST_INVALID,
    );
    await failure(
      normalizeSkillArchive(await tarGz([entry("SKILL.md", skillManifest("git"))]), "tar.gz"),
      SKILL_ERROR_CODES.NAME_RESERVED,
    );
    await failure(
      normalizeSkillArchive(await tarGz([entry("SKILL.md", skillManifest("pdf-"))]), "tar.gz"),
      SKILL_ERROR_CODES.MANIFEST_INVALID,
    );
    await failure(
      normalizeSkillArchive(await tarGz([entry("SKILL.md", skillManifest("a--b"))]), "tar.gz"),
      SKILL_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects a stored zip whose declared sizes disagree before any body is produced", async () => {
    const blob = Buffer.alloc(MIB, 0x41);
    const local = Buffer.concat([zipLocalHeader("blob", 0, MIB, 0), blob]);
    const entries = Array.from({ length: 64 }, (_, index) => ({
      name: `f${index}.txt`,
      compression: 0,
      size: MIB,
      originalSize: 0,
      offset: 0,
    }));
    const zip = buildRawZip(local, entries);
    // The rejection comes from the central-directory filter — the message is the stored-size check,
    // not the post-inflate backstop — so the 64 MiB `unzipSync` would have allocated never exists.
    await expect(normalizeSkillArchive(zip, "zip")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.ARCHIVE_INVALID,
      message: expect.stringContaining("inconsistent stored sizes"),
    });
  });

  it("rejects overlapping zip central entries that cannot all fit inside the input", async () => {
    const blob = Buffer.alloc(MIB, 0x42);
    const local = Buffer.concat([zipLocalHeader("blob", 0, MIB, MIB), blob]);
    const entries = Array.from({ length: 64 }, (_, index) => ({
      name: `f${index}.txt`,
      compression: 0,
      size: MIB,
      originalSize: MIB,
      offset: 0,
    }));
    await expect(normalizeSkillArchive(buildRawZip(local, entries), "zip")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.ARCHIVE_INVALID,
      message: expect.stringContaining("overlap"),
    });
  });

  it("rejects a single stored zip entry whose declared sizes disagree", async () => {
    const local = Buffer.concat([zipLocalHeader("evil.txt", 0, 5, 3), Buffer.from("abcde")]);
    await failure(
      normalizeSkillArchive(
        buildRawZip(local, [{ name: "evil.txt", compression: 0, size: 5, originalSize: 3, offset: 0 }]),
        "zip",
      ),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
  });

  it("still accepts an honest stored zip", async () => {
    const zip = zipFiles({ "SKILL.md": skillManifest("stored-ok"), "lib/x.txt": "x" }, 0);
    const normalized = await normalizeSkillArchive(zip, "zip");
    expect(normalized.manifest.name).toBe("stored-ok");
    expect(normalized.files.map((file) => file.path)).toEqual(["SKILL.md", "lib/x.txt"]);
  });

  it("carries a Unix zip member's execute bit into the canonical tar", async () => {
    const zip = buildStoredZip([
      { name: "SKILL.md", body: skillManifest("exec-skill"), unixMode: 0o100644 },
      { name: "scripts/run.sh", body: "#!/bin/sh\n", unixMode: 0o100755 },
    ]);
    const tar = await tarGz([
      { name: "SKILL.md", body: skillManifest("exec-skill"), mode: 0o644 },
      { name: "scripts/run.sh", body: "#!/bin/sh\n", mode: 0o755 },
    ]);
    const fromZip = await normalizeSkillArchive(zip, "zip");
    const fromTar = await normalizeSkillArchive(tar, "tar.gz");
    // The same tree normalizes to identical bytes whichever container it arrived in.
    expect(fromZip.sha256).toBe(fromTar.sha256);
    const modes = await tarMemberModes(fromZip.archive);
    expect(modes.get("scripts/run.sh")).toBe(0o755);
    expect(modes.get("SKILL.md")).toBe(0o644);
  });

  it("rejects a Unix zip symlink and a setuid member", async () => {
    await failure(
      normalizeSkillArchive(
        buildStoredZip([
          { name: "SKILL.md", body: skillManifest("link-skill"), unixMode: 0o100644 },
          { name: "link", body: "SKILL.md", unixMode: 0o120777 },
        ]),
        "zip",
      ),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
    await failure(
      normalizeSkillArchive(
        buildStoredZip([
          { name: "SKILL.md", body: skillManifest("setuid-skill"), unixMode: 0o100644 },
          { name: "evil", body: "x", unixMode: 0o104755 },
        ]),
        "zip",
      ),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
  });

  it("normalizes a DOS-made zip to 0644", async () => {
    const zip = buildStoredZip([
      { name: "SKILL.md", body: skillManifest("dos-skill") },
      { name: "scripts/run.sh", body: "#!/bin/sh\n" },
    ]);
    const normalized = await normalizeSkillArchive(zip, "zip");
    const modes = await tarMemberModes(normalized.archive);
    expect(modes.get("scripts/run.sh")).toBe(0o644);
  });

  it("rejects a malformed zip central directory", async () => {
    await failure(
      normalizeSkillArchive(new TextEncoder().encode("not a zip at all"), "zip"),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
    const valid = buildStoredZip([{ name: "SKILL.md", body: skillManifest("truncated") }]);
    await failure(
      normalizeSkillArchive(valid.slice(0, valid.byteLength - 16), "zip"),
      SKILL_ERROR_CODES.ARCHIVE_INVALID,
    );
  });

  it("rejects a gzip that inflates past an injected decompressed-stream ceiling", () => {
    // A 1 MiB ceiling with a few MiB of zeros exercises the meter in milliseconds; the real ceiling
    // is the default checked in the next test.
    return failure(
      normalizeSkillArchive(gzipOfZeros(4 * MIB), "tar.gz", { maxTarStreamBytes: MIB }),
      SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE,
    );
  });

  it("uses the documented default limits", () => {
    expect(DEFAULT_MAX_TAR_STREAM_BYTES).toBe(SKILL_UNPACKED_MAX_BYTES + (SKILL_MAX_ENTRIES + 2) * 512 * 2);
    expect(resolveSkillReadLimits().maxArchiveBytes).toBe(SKILL_ARCHIVE_MAX_BYTES);
  });
});
