import { createHash } from "node:crypto";
import { SKILL_MAX_FILES } from "@opentag/shared";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractSkillArchive, repackSkillArchive, SkillServiceError } from "../services/skills/index.js";
import { readZipDirectory } from "../services/skills/zip-reader.js";
import { buildSkillZip, type SkillZipFiles, skillMarkdown, validSkillZip } from "./support/skill-fixtures.js";

const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function rejection(bytes: Uint8Array) {
  try {
    extractSkillArchive(bytes);
  } catch (error) {
    if (error instanceof SkillServiceError) return { code: error.code, message: error.message, details: error.details };
    throw error;
  }
  throw new Error("expected the archive to be rejected");
}

function zipWith(files: SkillZipFiles) {
  return buildSkillZip({ "SKILL.md": skillMarkdown("my-skill"), ...files });
}

/** Rewrites the declared uncompressed size of every entry so a small fixture claims to be enormous. */
function claimUncompressedSize(bytes: Uint8Array, size: number): Uint8Array {
  const patched = Uint8Array.from(bytes);
  const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
  for (const entry of readZipDirectory(patched).entries) view.setUint32(entry.centralHeaderOffset + 24, size, true);
  return patched;
}

describe("extractSkillArchive", () => {
  it("accepts a root-level skill and reports files, modes, and frontmatter", () => {
    const extracted = extractSkillArchive(validSkillZip("my-skill", { "references/a.md": "# A" }));
    expect(extracted.name).toBe("my-skill");
    expect(extracted.description).toBe("Does something useful");
    expect(extracted.skillMd.startsWith("---\nname: my-skill")).toBe(true);
    expect([...extracted.files.keys()]).toEqual(["SKILL.md", "references/a.md", "scripts/run.sh"]);
    expect(extracted.files.get("scripts/run.sh")?.mode).toBe("0755");
    expect(extracted.files.get("SKILL.md")?.mode).toBe("0644");
  });

  it("strips a single top-level directory even when its name differs from the frontmatter name", () => {
    const extracted = extractSkillArchive(
      buildSkillZip({
        "wrapper-dir/": "",
        "wrapper-dir/SKILL.md": skillMarkdown("real-name"),
        "wrapper-dir/scripts/go.sh": "echo",
      }),
    );
    expect(extracted.name).toBe("real-name");
    expect([...extracted.files.keys()]).toEqual(["SKILL.md", "scripts/go.sh"]);
  });

  it("ignores __MACOSX resource forks and directory entries", () => {
    const extracted = extractSkillArchive(
      buildSkillZip({
        "SKILL.md": skillMarkdown("my-skill"),
        "scripts/": "",
        "__MACOSX/._SKILL.md": "junk",
        "scripts/run.sh": "echo",
      }),
    );
    expect([...extracted.files.keys()]).toEqual(["SKILL.md", "scripts/run.sh"]);
  });

  it("requires SKILL.md at the root or inside exactly one wrapping directory", () => {
    expect(rejection(buildSkillZip({ "a/SKILL.md": skillMarkdown("a"), "b/other.md": "x" }))).toMatchObject({
      code: "SKILL_MANIFEST_INVALID",
      details: { field: "SKILL.md" },
    });
    expect(rejection(buildSkillZip({ "docs/readme.md": "x" }))).toMatchObject({ code: "SKILL_MANIFEST_INVALID" });
  });

  it("rejects malformed uploads and empty archives", () => {
    expect(rejection(new TextEncoder().encode("not a zip at all"))).toMatchObject({ code: "SKILL_ARCHIVE_INVALID" });
    expect(rejection(buildSkillZip({ "only-dir/": "" }))).toMatchObject({ code: "SKILL_ARCHIVE_INVALID" });
  });

  it.each([
    ["../escape.sh", "traversal"],
    ["scripts/../../escape.sh", "traversal"],
    ["/etc/passwd", "absolute"],
    ["C:/windows/system32", "absolute"],
    ["scripts\\run.sh", "backslashes"],
    ["scripts/./run.sh", "traversal"],
    ["scripts//run.sh", "empty path segments"],
    ["bad\u0000name", "control characters"],
    ["bad\u001bname", "control characters"],
    [`${"a".repeat(256)}/file`, "segment exceeds"],
    [Array.from({ length: 6 }, (_, index) => String.fromCharCode(97 + index).repeat(200)).join("/"), "exceeds 1024"],
  ])("rejects the unsafe path %j", (path, reason) => {
    expect(rejection(zipWith({ [path]: "x" }))).toMatchObject({
      code: "SKILL_ARCHIVE_INVALID_PATH",
      message: expect.stringContaining(reason),
    });
  });

  it("rejects symbolic links and other non-regular entries", () => {
    expect(rejection(zipWith({ "scripts/link": { content: "SKILL.md", mode: S_IFLNK | 0o777 } }))).toMatchObject({
      code: "SKILL_ARCHIVE_INVALID_PATH",
      message: expect.stringContaining("symbolic links"),
    });
    expect(rejection(zipWith({ "scripts/fifo": { content: "", mode: 0o010644 } }))).toMatchObject({
      code: "SKILL_ARCHIVE_INVALID_PATH",
      message: expect.stringContaining("regular files"),
    });
  });

  it("rejects duplicate paths, including ones that only differ by case", () => {
    expect(rejection(zipWith({ "Scripts/run.sh": "a", "scripts/RUN.sh": "b" }))).toMatchObject({
      code: "SKILL_ARCHIVE_INVALID_PATH",
      message: expect.stringContaining("collides"),
    });
  });

  it("rejects more than the file limit before inflating anything", () => {
    const files: SkillZipFiles = { "SKILL.md": skillMarkdown("my-skill") };
    for (let index = 0; index < SKILL_MAX_FILES; index += 1) files[`f/${index}.txt`] = "x";
    expect(rejection(buildSkillZip(files))).toMatchObject({ code: "SKILL_ARCHIVE_TOO_MANY_FILES" });
    delete files["f/0.txt"];
    expect(extractSkillArchive(buildSkillZip(files)).files.size).toBe(SKILL_MAX_FILES);
  });

  it("refuses an archive whose declared expansion exceeds the limit without decompressing it", () => {
    // 21 entries each claiming 1 MiB: the sum trips the limit; had any entry been inflated the mismatch would have
    // surfaced as SKILL_ARCHIVE_INVALID instead.
    const files: SkillZipFiles = { "SKILL.md": skillMarkdown("my-skill") };
    for (let index = 0; index < 20; index += 1) files[`f/${index}.txt`] = "tiny";
    expect(rejection(claimUncompressedSize(buildSkillZip(files), 1024 * 1024))).toMatchObject({
      code: "SKILL_ARCHIVE_TOO_LARGE",
    });
  });

  it("detects an entry whose content does not match its declared size", () => {
    expect(rejection(claimUncompressedSize(validSkillZip(), 7))).toMatchObject({
      code: "SKILL_ARCHIVE_INVALID",
      message: expect.stringContaining("declared size"),
    });
  });

  it("keeps the executable bit only for regular files and drops setuid, setgid, and sticky bits", () => {
    const extracted = extractSkillArchive(
      zipWith({
        "scripts/setuid.sh": { content: "x", mode: S_IFREG | 0o4755 },
        "scripts/plain.sh": { content: "x", mode: S_IFREG | 0o644 },
        "scripts/group-exec.sh": { content: "x", mode: S_IFREG | 0o2010 },
        "scripts/dos.sh": { content: "x", os: 0 },
      }),
    );
    expect(extracted.files.get("scripts/setuid.sh")?.mode).toBe("0755");
    expect(extracted.files.get("scripts/plain.sh")?.mode).toBe("0644");
    expect(extracted.files.get("scripts/group-exec.sh")?.mode).toBe("0755");
    expect(extracted.files.get("scripts/dos.sh")?.mode).toBe("0644");
  });

  it("surfaces SKILL.md validation failures with the field that failed", () => {
    expect(rejection(buildSkillZip({ "SKILL.md": "# no frontmatter" }))).toMatchObject({
      code: "SKILL_MANIFEST_INVALID",
      details: { field: "SKILL.md" },
    });
    expect(rejection(buildSkillZip({ "SKILL.md": "---\nname: Nope\ndescription: x\n---\n" }))).toMatchObject({
      details: { field: "name" },
    });
  });
});

describe("repackSkillArchive", () => {
  it("produces identical bytes for identical content regardless of source zip metadata", () => {
    const first = extractSkillArchive(validSkillZip("my-skill"));
    const second = extractSkillArchive(
      buildSkillZip(
        {
          "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: S_IFREG | 0o755 },
          "SKILL.md": skillMarkdown("my-skill"),
        },
        { mtime: new Date("2001-02-03T04:05:06Z"), level: 9 },
      ),
    );
    const a = repackSkillArchive(first.files);
    const b = repackSkillArchive(second.files);
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.sha256).toBe(createHash("sha256").update(a.bytes).digest("hex"));
  });

  it("changes when file content or mode changes", () => {
    const base = repackSkillArchive(extractSkillArchive(validSkillZip()).files);
    const changed = repackSkillArchive(extractSkillArchive(validSkillZip("my-skill", { "extra.txt": "1" })).files);
    expect(changed.sha256).not.toBe(base.sha256);
  });

  it("writes an archive that standard tooling unpacks to the same files with fixed timestamps and Unix modes", () => {
    const extracted = extractSkillArchive(validSkillZip());
    const { bytes } = repackSkillArchive(extracted.files);
    const unpacked = unzipSync(bytes);
    expect(Object.keys(unpacked)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(new TextDecoder().decode(unpacked["scripts/run.sh"])).toBe("#!/bin/sh\necho hi\n");
    const directory = readZipDirectory(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const entry of directory.entries) {
      expect(view.getUint16(entry.centralHeaderOffset + 12, true)).toBe(0);
      expect(view.getUint16(entry.centralHeaderOffset + 14, true)).toBe((1 << 5) | 1);
    }
    expect(directory.entries.find((entry) => entry.name === "scripts/run.sh")?.unixMode).toBe(S_IFREG | 0o755);
    expect(directory.entries.find((entry) => entry.name === "SKILL.md")?.unixMode).toBe(S_IFREG | 0o644);
  });
});
