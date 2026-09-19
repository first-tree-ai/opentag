import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { extractSkillArchive, packSkillDirectory } from "../skills/skill-archive.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-skill-archive-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeSkill(root: string, files: Record<string, string> = {}): Promise<string> {
  const skill = join(root, "my-skill");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    ["---", "name: my-skill", "description: A test skill", "---", "", "# Body", ""].join("\n"),
  );
  for (const [rel, content] of Object.entries(files)) {
    const path = join(skill, ...rel.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, rel.endsWith(".sh") ? { mode: 0o755 } : undefined);
  }
  return skill;
}

async function withArchiveError(operation: () => Promise<unknown>, code: string): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ name: "SkillArchiveError", code });
}

/** Builds a gzipped tar archive whose members are described by the entries. */
async function writeTar(
  path: string,
  entries: Array<{ name: string; type?: "file" | "directory" | "symlink"; content?: string }>,
): Promise<void> {
  await new Promise<void>((resolveEntry, rejectEntry) => {
    const pack = tarPack();
    pipeline(pack, createGzip(), createWriteStream(path, { mode: 0o600 })).then(
      () => resolveEntry(),
      (error: unknown) => rejectEntry(error),
    );
    let index = 0;
    const next = (): void => {
      if (index >= entries.length) {
        pack.finalize();
        return;
      }
      const entry = entries[index] as { name: string; type?: "file" | "directory" | "symlink"; content?: string };
      index += 1;
      const sink = pack.entry(
        { name: entry.name, type: entry.type ?? "file", size: entry.content?.length ?? 0 },
        (error?: unknown) => {
          if (error) {
            rejectEntry(error);
            return;
          }
          next();
        },
      );
      sink.end(entry.content ?? "");
    };
    next();
  });
}

describe("packSkillDirectory", () => {
  it("round trips a skill directory through pack and extract with modes intact", async () => {
    const root = await temporaryRoot();
    const skill = await writeSkill(root, {
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
      "reference/notes.md": "notes\n",
    });
    const packed = await packSkillDirectory(skill);
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(packed.fileCount).toBe(3);
    expect(packed.archive.byteLength).toBeGreaterThan(0);

    const target = join(root, "out");
    await extractSkillArchive(Readable.from(Buffer.from(packed.archive)), target);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("A test skill");
    expect(await readFile(join(target, "scripts", "run.sh"), "utf8")).toContain("echo hi");
    expect(await readFile(join(target, "reference", "notes.md"), "utf8")).toBe("notes\n");
    expect((await lstat(join(target, "scripts", "run.sh"))).mode & 0o777).toBe(0o600);
    expect((await lstat(target)).mode & 0o777).toBe(0o700);
  });

  it("excludes repository, dependency, OS and marker files", async () => {
    const root = await temporaryRoot();
    const skill = await writeSkill(root, {
      ".git/config": "git",
      "node_modules/pkg/index.js": "dep",
      "nested/.DS_Store": "ds",
      "nested/node_modules/dep.js": "dep",
    });
    await writeFile(join(skill, ".opentag-skill.json"), "{}");
    const packed = await packSkillDirectory(skill);
    const target = join(root, "out");
    await extractSkillArchive(Readable.from(Buffer.from(packed.archive)), target);
    const extracted = await readdir(target);
    expect(extracted.sort()).toEqual(["SKILL.md", "nested"]);
    expect(await readdir(join(target, "nested"))).toEqual([]);
  });

  it("packs an adopted copy of a skill to the same sha256 as the clean copy", async () => {
    const root = await temporaryRoot();
    const clean = await writeSkill(root, { "notes.md": "same content\n" });
    const adopted = join(root, "adopted");
    await cp(clean, adopted, { recursive: true });
    await writeFile(join(adopted, ".opentag-skill.json"), '{"skillId":"x","archiveSha256":"y"}');
    await writeFile(join(adopted, ".opentag-skill.content"), "digest\n");

    const cleanPacked = await packSkillDirectory(clean);
    const adoptedPacked = await packSkillDirectory(adopted);
    expect(adoptedPacked.sha256).toBe(cleanPacked.sha256);
    expect(adoptedPacked.archive).toEqual(cleanPacked.archive);
  });

  it("refuses a missing, invalid, or reserved manifest before uploading", async () => {
    const root = await temporaryRoot();
    const empty = join(root, "empty");
    await mkdir(empty);
    await withArchiveError(() => packSkillDirectory(empty), "manifest_missing");

    const invalid = join(root, "invalid");
    await mkdir(invalid);
    await writeFile(join(invalid, "SKILL.md"), "no frontmatter");
    await withArchiveError(() => packSkillDirectory(invalid), "manifest_invalid");

    const reserved = join(root, "reserved");
    await mkdir(reserved);
    await writeFile(join(reserved, "SKILL.md"), ["---", "name: git", "description: reserved", "---"].join("\n"));
    await withArchiveError(() => packSkillDirectory(reserved), "name_reserved");
  });

  it("refuses symlinks and special files", async () => {
    const root = await temporaryRoot();
    const skill = await writeSkill(root, { "real.txt": "real" });
    await symlink("real.txt", join(skill, "link.txt"));
    await withArchiveError(() => packSkillDirectory(skill), "symlink");
  });

  it("enforces the path and entry ceilings", async () => {
    const root = await temporaryRoot();
    const skill = await writeSkill(root);
    const deep = ["a".repeat(60), "b".repeat(60), "c".repeat(60), "d".repeat(60), "e".repeat(60)];
    const longPath = join(skill, ...deep, "x.txt");
    await mkdir(dirname(longPath), { recursive: true });
    await writeFile(longPath, "x");
    await withArchiveError(() => packSkillDirectory(skill), "path_too_long");

    const many = await writeSkill(join(root, "many"), {});
    await mkdir(join(many, "files"), { recursive: true });
    await Promise.all(
      Array.from({ length: 1002 }, (_value, index) =>
        writeFile(join(many, "files", `f-${String(index).padStart(4, "0")}.txt`), "x"),
      ),
    );
    await withArchiveError(() => packSkillDirectory(many), "too_many_entries");
  });

  it("enforces the unpacked-size ceiling", async () => {
    const root = await temporaryRoot();
    const skill = await writeSkill(root);
    const large = join(skill, "large.bin");
    await writeFile(large, "");
    await truncate(large, 64 * 1024 * 1024 + 1);
    await withArchiveError(() => packSkillDirectory(skill), "unpacked_too_large");
  });

  it("enforces the archive-size ceiling on incompressible content", async () => {
    const root = await temporaryRoot();
    const skill = await writeSkill(root);
    await writeFile(join(skill, "random.bin"), randomBytes(17 * 1024 * 1024));
    await withArchiveError(() => packSkillDirectory(skill), "archive_too_large");
  });
});

describe("extractSkillArchive", () => {
  it("refuses a non-empty destination", async () => {
    const root = await temporaryRoot();
    const target = join(root, "out");
    await mkdir(target);
    await writeFile(join(target, "existing.txt"), "keep");
    const tar = join(root, "archive.tar");
    await writeTar(tar, [{ name: "SKILL.md", content: "x" }]);
    await withArchiveError(() => extractSkillArchive(createReadStream(tar), target), "destination_not_empty");
  });

  it("rejects absolute and traversing member paths", async () => {
    for (const name of ["/etc/passwd", "../escape.txt", "a/../../escape.txt"]) {
      const root = await temporaryRoot();
      const tar = join(root, "archive.tar");
      await writeTar(tar, [{ name, content: "x" }]);
      await withArchiveError(() => extractSkillArchive(createReadStream(tar), join(root, "out")), "unsafe_member");
    }
  });

  it("ignores the platform marker and digest sidecar members during extraction", async () => {
    const root = await temporaryRoot();
    const tar = join(root, "archive.tar");
    await writeTar(tar, [
      { name: "SKILL.md", content: "x" },
      { name: ".opentag-skill.json", content: '{"skillId":"x","archiveSha256":"y"}' },
      { name: ".opentag-skill.content", content: "digest" },
    ]);
    const target = join(root, "out");
    await extractSkillArchive(createReadStream(tar), target);
    expect(await readdir(target)).toEqual(["SKILL.md"]);
  });

  it("rejects link and device members", async () => {
    const root = await temporaryRoot();
    const tar = join(root, "archive.tar");
    await writeTar(tar, [{ name: "link", type: "symlink", content: "" }]);
    await withArchiveError(() => extractSkillArchive(createReadStream(tar), join(root, "out")), "unsafe_member");
  });

  it("rejects an over-limit compressed stream", async () => {
    const root = await temporaryRoot();
    const target = join(root, "out");
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
    await withArchiveError(() => extractSkillArchive(Readable.from(oversized), target), "archive_too_large");
  });

  it("rejects a corrupt archive and cleans up the destination", async () => {
    const root = await temporaryRoot();
    const target = join(root, "out");
    await withArchiveError(
      () => extractSkillArchive(Readable.from(Buffer.from("not a gzip")), target),
      "archive_invalid",
    );
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
