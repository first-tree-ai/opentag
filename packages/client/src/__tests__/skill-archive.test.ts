import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  computeSkillDigest,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_MAX_FILES,
  SKILL_UNPACKED_MAX_BYTES,
} from "@opentag/shared";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractSkillArchive,
  inspectSkillArchive,
  packSkillDirectory,
  SkillArchiveError,
  validateSkillPath,
} from "../runtime/skills/skill-archive.js";
import { RuntimeStorageError } from "../storage/durable-file.js";
import { buildSkillZip, patchCentralDirectory, sha256 } from "./fixtures/skill-zip.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opentag-skill-archive-"));
  directories.push(path);
  return path;
}

function rejection(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof SkillArchiveError) return error.rejection;
    throw error;
  }
  return undefined;
}

describe("inspectSkillArchive", () => {
  it("lists regular files with canonical paths and executable-only modes", () => {
    const fixture = buildSkillZip("demo", {
      "SKILL.md": "# demo",
      "scripts/run.sh": { content: "#!/bin/sh\n", mode: 0o755 },
      "scripts/setuid": { content: "x", mode: 0o4755 },
      "docs/": { content: "", type: 0o040000 },
    });
    expect(inspectSkillArchive(fixture.bytes)).toEqual([
      { path: "SKILL.md", size: 6, mode: "0644" },
      { path: "scripts/run.sh", size: 10, mode: "0755" },
      { path: "scripts/setuid", size: 1, mode: "0755" },
    ]);
  });

  it.each([
    "../escape.md",
    "/abs/SKILL.md",
    "C:evil.md",
    "dir\\file.md",
    "a/./b.md",
    "a//b.md",
    "nul\u0000.md",
    "tab\t.md",
    "del\u007f.md",
    `${"x".repeat(256)}.md`,
    `${Array.from({ length: 5 }, () => "y".repeat(250)).join("/")}.md`,
  ])("rejects hostile path %j", (path) => {
    const fixture = buildSkillZip("demo", { "SKILL.md": "# demo", [path]: "evil" });
    expect(rejection(() => inspectSkillArchive(fixture.bytes))).toBe("invalid-path");
    expect(rejection(() => validateSkillPath(path))).toBe("invalid-path");
  });

  it("rejects an empty path and accepts a canonical nested one", () => {
    expect(rejection(() => validateSkillPath(""))).toBe("invalid-path");
    expect(rejection(() => validateSkillPath("scripts/run.sh"))).toBeUndefined();
  });

  it("rejects symbolic link and other non-regular entries", () => {
    const link = buildSkillZip("demo", { "SKILL.md": "# demo", link: { content: "SKILL.md", type: 0o120000 } });
    expect(rejection(() => inspectSkillArchive(link.bytes))).toBe("link-entry");
    const fifo = buildSkillZip("demo", { "SKILL.md": "# demo", pipe: { content: "", type: 0o010000 } });
    expect(rejection(() => inspectSkillArchive(fifo.bytes))).toBe("unexpected-entry-type");
  });

  it("treats MS-DOS directory attributes and DOS-origin files without Unix bits as plain entries", () => {
    const fixture = buildSkillZip("demo", { "SKILL.md": "# demo", "dir/": "" });
    const dos = patchCentralDirectory(fixture.bytes, (view, offset) => {
      view.setUint8(offset + 5, 0);
      const name = new TextDecoder().decode(
        new Uint8Array(view.buffer, view.byteOffset + offset + 46, view.getUint16(offset + 28, true)),
      );
      view.setUint32(offset + 38, name.endsWith("/") ? 0x10 : 0x20, true);
    });
    expect(inspectSkillArchive(dos)).toEqual([{ path: "SKILL.md", size: 6, mode: "0644" }]);
  });

  it("rejects duplicate paths case-insensitively", () => {
    const fixture = buildSkillZip("demo", { "SKILL.md": "# demo", "Readme.md": "a", "readme.md": "b" });
    expect(rejection(() => inspectSkillArchive(fixture.bytes))).toBe("duplicate-path");
  });

  it("rejects more than the allowed number of files", () => {
    const files: Record<string, string> = { "SKILL.md": "# demo" };
    for (let index = 0; index < SKILL_MAX_FILES; index += 1) files[`f/${index}.txt`] = String(index);
    const fixture = buildSkillZip("demo", files);
    expect(rejection(() => inspectSkillArchive(fixture.bytes))).toBe("too-many-files");
    const withDirectories: Record<string, string> = { "SKILL.md": "# demo" };
    for (let index = 0; index < SKILL_MAX_FILES - 1; index += 1) withDirectories[`f/${index}.txt`] = String(index);
    for (let index = 0; index < 3; index += 1) withDirectories[`d${index}/`] = "";
    expect(inspectSkillArchive(buildSkillZip("demo", withDirectories).bytes)).toHaveLength(SKILL_MAX_FILES);
  });

  it("rejects an archive whose declared unpacked size exceeds the limit before inflating", () => {
    const fixture = buildSkillZip("demo", { "SKILL.md": "# demo" });
    const bomb = patchCentralDirectory(fixture.bytes, (view, offset) => {
      view.setUint32(offset + 24, SKILL_UNPACKED_MAX_BYTES + 1, true);
    });
    expect(rejection(() => inspectSkillArchive(bomb))).toBe("unpacked-limit");
  });

  it("rejects encrypted, unsupported-method, ZIP64, truncated, corrupt, and oversized archives", () => {
    const fixture = buildSkillZip("demo", { "SKILL.md": "# demo" });
    const encrypted = patchCentralDirectory(fixture.bytes, (view, offset) => view.setUint16(offset + 8, 0x1, true));
    expect(rejection(() => inspectSkillArchive(encrypted))).toBe("encrypted-entry");
    const lzma = patchCentralDirectory(fixture.bytes, (view, offset) => view.setUint16(offset + 10, 14, true));
    expect(rejection(() => inspectSkillArchive(lzma))).toBe("unsupported-compression");
    const zip64 = patchCentralDirectory(fixture.bytes, (view, offset) => view.setUint32(offset + 24, 0xffffffff, true));
    expect(rejection(() => inspectSkillArchive(zip64))).toBe("unsupported-archive");
    const zip64Compressed = patchCentralDirectory(fixture.bytes, (view, offset) =>
      view.setUint32(offset + 20, 0xffffffff, true),
    );
    expect(rejection(() => inspectSkillArchive(zip64Compressed))).toBe("unsupported-archive");
    const truncated = fixture.bytes.subarray(0, fixture.bytes.length - 4);
    expect(rejection(() => inspectSkillArchive(truncated))).toBe("invalid-archive");
    expect(rejection(() => inspectSkillArchive(new Uint8Array(SKILL_ARCHIVE_MAX_BYTES + 1)))).toBe("archive-limit");
    expect(rejection(() => inspectSkillArchive(new Uint8Array(64)))).toBe("invalid-archive");
    const badSignature = patchCentralDirectory(fixture.bytes, (view, offset) => view.setUint32(offset, 0, true));
    expect(rejection(() => inspectSkillArchive(badSignature))).toBe("invalid-archive");
    const eocd = fixture.bytes.length - 22;
    const multiDisk = new Uint8Array(fixture.bytes);
    multiDisk[eocd + 8] = 9;
    expect(rejection(() => inspectSkillArchive(multiDisk))).toBe("unsupported-archive");
    const zip64Count = new Uint8Array(fixture.bytes);
    zip64Count[eocd + 8] = 0xff;
    zip64Count[eocd + 9] = 0xff;
    zip64Count[eocd + 10] = 0xff;
    zip64Count[eocd + 11] = 0xff;
    expect(rejection(() => inspectSkillArchive(zip64Count))).toBe("unsupported-archive");
    const overflow = new Uint8Array(fixture.bytes);
    overflow[eocd + 12] = 0xff;
    overflow[eocd + 13] = 0x7f;
    expect(rejection(() => inspectSkillArchive(overflow))).toBe("invalid-archive");
    const tooManyDeclared = new Uint8Array(fixture.bytes);
    tooManyDeclared[eocd + 8] = 0xff;
    tooManyDeclared[eocd + 9] = 0x01;
    tooManyDeclared[eocd + 10] = 0xff;
    tooManyDeclared[eocd + 11] = 0x01;
    expect(rejection(() => inspectSkillArchive(tooManyDeclared))).toBe("too-many-files");
    const longName = patchCentralDirectory(fixture.bytes, (view, offset) => view.setUint16(offset + 28, 60000, true));
    expect(rejection(() => inspectSkillArchive(longName))).toBe("invalid-archive");
    const invalidUtf8 = patchCentralDirectory(fixture.bytes, (view, offset) => view.setUint8(offset + 46, 0xff));
    expect(rejection(() => inspectSkillArchive(invalidUtf8))).toBe("invalid-path");
  });
});

describe("extractSkillArchive", () => {
  it("writes verified files into the destination with owner-only modes", async () => {
    const root = await temporaryDirectory();
    const fixture = buildSkillZip("demo", {
      "SKILL.md": "# demo",
      "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
    });
    const destination = join(root, ".tmp-demo");
    const actual = await extractSkillArchive(fixture.bytes, {
      manifest: fixture.manifest,
      digest: fixture.digest,
      destination,
      root,
    });
    expect(actual).toEqual(fixture.manifest);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("# demo");
    expect((await stat(join(destination, "scripts", "run.sh"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(destination, "SKILL.md"))).mode & 0o777).toBe(0o600);
  });

  it("rejects a destination outside the root and a manifest that does not hash to the digest", async () => {
    const root = await temporaryDirectory();
    const fixture = buildSkillZip("demo", { "SKILL.md": "# demo" });
    await expect(
      extractSkillArchive(fixture.bytes, {
        manifest: fixture.manifest,
        digest: fixture.digest,
        destination: join(root, "..", "escape"),
        root,
      }),
    ).rejects.toBeInstanceOf(RuntimeStorageError);
    await expect(
      extractSkillArchive(fixture.bytes, {
        manifest: fixture.manifest,
        digest: "0".repeat(64),
        destination: join(root, "x"),
        root,
      }),
    ).rejects.toMatchObject({ rejection: "digest-mismatch" });
  });

  it("rejects archives whose entries, sizes, modes, or contents differ from the manifest", async () => {
    const root = await temporaryDirectory();
    const fixture = buildSkillZip("demo", { "SKILL.md": "# demo", "a.txt": "aaaa" });
    const options = { manifest: fixture.manifest, digest: fixture.digest, root };
    const extra = buildSkillZip("demo", { "SKILL.md": "# demo", "a.txt": "aaaa", "b.txt": "b" });
    await expect(extractSkillArchive(extra.bytes, { ...options, destination: join(root, "1") })).rejects.toMatchObject({
      rejection: "manifest-mismatch",
    });
    const renamed = buildSkillZip("demo", { "SKILL.md": "# demo", "c.txt": "aaaa" });
    await expect(
      extractSkillArchive(renamed.bytes, { ...options, destination: join(root, "2") }),
    ).rejects.toMatchObject({ rejection: "manifest-mismatch" });
    const resized = buildSkillZip("demo", { "SKILL.md": "# demo", "a.txt": "aaaaa" });
    await expect(
      extractSkillArchive(resized.bytes, { ...options, destination: join(root, "3") }),
    ).rejects.toMatchObject({ rejection: "manifest-mismatch" });
    const executable = buildSkillZip("demo", { "SKILL.md": "# demo", "a.txt": { content: "aaaa", mode: 0o755 } });
    await expect(
      extractSkillArchive(executable.bytes, { ...options, destination: join(root, "4") }),
    ).rejects.toMatchObject({ rejection: "manifest-mismatch" });
    const altered = buildSkillZip("demo", { "SKILL.md": "# demo", "a.txt": "bbbb" });
    await expect(
      extractSkillArchive(altered.bytes, { ...options, destination: join(root, "5") }),
    ).rejects.toMatchObject({ rejection: "content-mismatch" });
    await expect(stat(join(root, "5"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an entry whose central-directory size lies about the inflated content", async () => {
    const root = await temporaryDirectory();
    const fixture = buildSkillZip("demo", { "SKILL.md": "# demo", "a.txt": "aaaa" });
    const lying = patchCentralDirectory(fixture.bytes, (view, offset) => {
      if (view.getUint32(offset + 24, true) === 4) view.setUint32(offset + 24, 3, true);
    });
    const manifest = {
      ...fixture.manifest,
      files: fixture.manifest.files.map((file) => (file.path === "a.txt" ? { ...file, size: 3 } : file)),
    };
    await expect(
      extractSkillArchive(lying, {
        manifest,
        digest: computeSkillDigest(manifest),
        destination: join(root, "lying"),
        root,
      }),
    ).rejects.toBeInstanceOf(SkillArchiveError);
  });
});

describe("packSkillDirectory", () => {
  async function skillTree(root: string): Promise<void> {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
    await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\n");
    await chmod(join(root, "scripts", "run.sh"), 0o755);
    await writeFile(join(root, ".git", "objects", "x"), "git");
    await writeFile(join(root, "node_modules", "dep", "index.js"), "js");
    await writeFile(join(root, ".DS_Store"), "mac");
  }

  it("produces a deterministic archive the extractor accepts and skips ignored entries", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    await skillTree(first);
    await skillTree(second);
    const packedA = await packSkillDirectory(first);
    const packedB = await packSkillDirectory(second);
    expect(sha256(packedA.bytes)).toBe(sha256(packedB.bytes));
    expect(packedA.fileCount).toBe(2);
    expect(packedA.totalBytes).toBe(44);
    expect(packedA.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(packedA.files.find((file) => file.path === "scripts/run.sh")?.mode).toBe("0755");
    expect(Object.keys(unzipSync(packedA.bytes)).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(inspectSkillArchive(packedA.bytes)).toEqual([
      { path: "SKILL.md", size: 34, mode: "0644" },
      { path: "scripts/run.sh", size: 10, mode: "0755" },
    ]);
    const manifest = { schemaVersion: 1 as const, name: "demo", files: [...packedA.files] };
    const destination = resolve(first, "unpacked");
    await expect(
      extractSkillArchive(packedA.bytes, { manifest, digest: computeSkillDigest(manifest), destination, root: first }),
    ).resolves.toEqual(manifest);
  });

  it("requires SKILL.md at the root and rejects links, special files, and oversized trees", async () => {
    const root = await temporaryDirectory();
    await expect(packSkillDirectory(root)).rejects.toMatchObject({ rejection: "skill-md-missing" });
    await writeFile(join(root, "SKILL.md"), "# demo");
    await symlink("SKILL.md", join(root, "link.md"));
    await expect(packSkillDirectory(root)).rejects.toMatchObject({ rejection: "link-entry" });
    await rm(join(root, "link.md"));
    await writeFile(join(root, "big.bin"), new Uint8Array(SKILL_UNPACKED_MAX_BYTES + 1));
    await expect(packSkillDirectory(root)).rejects.toMatchObject({ rejection: "unpacked-limit" });
    await rm(join(root, "big.bin"));
    await expect(packSkillDirectory(join(root, "SKILL.md"))).rejects.toMatchObject({
      rejection: "unexpected-entry-type",
    });
    for (let index = 0; index < SKILL_MAX_FILES; index += 1) await writeFile(join(root, `f${index}.txt`), "x");
    await expect(packSkillDirectory(root)).rejects.toMatchObject({ rejection: "too-many-files" });
  });

  it("rejects a tree whose compressed archive exceeds the archive limit", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "SKILL.md"), "# demo");
    await writeFile(join(root, "noise.bin"), randomBytes(SKILL_ARCHIVE_MAX_BYTES + 65_536));
    await expect(packSkillDirectory(root)).rejects.toMatchObject({ rejection: "archive-limit" });
  });
});
