import { createHash } from "node:crypto";
import { SKILL_ERROR_CODES, SKILL_FILE_PREVIEW_MAX_BYTES } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { readSkillFile } from "../services/skills/skill-file-reader.js";
import type { SkillBundle } from "../services/skills/skill-service.js";
import { skillManifest, tarGz } from "./support/skill-archive-fixtures.js";

function bundle(bytes: Uint8Array): SkillBundle {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  } as SkillBundle;
}

describe("Skill file reader", () => {
  it("preserves full UTF-8 text, BOM, frontmatter and empty files without executing markup", async () => {
    const text = "\uFEFF---\nname: reader\n---\n# 完整内容\n<script>alert(1)</script>\n";
    const bytes = await tarGz([
      { name: "SKILL.md", body: text },
      { name: "empty.txt", body: "" },
    ]);
    expect((await readSkillFile(bundle(bytes), "SKILL.md")).preview).toEqual({ status: "text", content: text });
    expect((await readSkillFile(bundle(bytes), "empty.txt")).preview).toEqual({ status: "text", content: "" });
  });

  it("distinguishes binary, invalid UTF-8 and oversized files without returning partial content", async () => {
    const bytes = await tarGz([
      { name: "SKILL.md", body: skillManifest("reader") },
      { name: "image.png", body: new Uint8Array([0, 1, 2]) },
      { name: "invalid.txt", body: new Uint8Array([255, 254]) },
      { name: "large.txt", body: "a".repeat(SKILL_FILE_PREVIEW_MAX_BYTES + 1) },
      { name: "limit.txt", body: "a".repeat(SKILL_FILE_PREVIEW_MAX_BYTES) },
    ]);
    expect((await readSkillFile(bundle(bytes), "image.png")).preview).toEqual({ status: "binary" });
    expect((await readSkillFile(bundle(bytes), "invalid.txt")).preview).toEqual({ status: "binary" });
    expect((await readSkillFile(bundle(bytes), "large.txt")).preview).toEqual({ status: "too_large" });
    expect((await readSkillFile(bundle(bytes), "limit.txt")).preview.status).toBe("text");
  });

  it("cancels streams exceeding the archive bound and rejects missing/corrupted bytes", async () => {
    const cancel = vi.fn();
    const over = {
      ...bundle(new Uint8Array([1, 2, 3])),
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel,
      }),
    };
    await expect(readSkillFile(over, "SKILL.md", { maxArchiveBytes: 2 })).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE,
    });
    expect(cancel).toHaveBeenCalled();
    const bytes = await tarGz([{ name: "SKILL.md", body: skillManifest("reader") }]);
    await expect(readSkillFile({ ...bundle(bytes), sha256: "a".repeat(64) }, "SKILL.md")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.HASH_MISMATCH,
    });
    await expect(readSkillFile({ ...bundle(bytes), bytes: bytes.length + 1 }, "SKILL.md")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.HASH_MISMATCH,
    });
  });

  it("keeps archive link, traversal and decompression guards on reads", async () => {
    const unsafe = await tarGz([
      { name: "SKILL.md", body: skillManifest("reader") },
      { name: "secret", type: "symlink", linkname: "/etc/passwd" },
    ]);
    await expect(readSkillFile(bundle(unsafe), "SKILL.md")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.ARCHIVE_INVALID,
    });
    const bytes = await tarGz([{ name: "SKILL.md", body: skillManifest("reader") }]);
    await expect(readSkillFile(bundle(bytes), "../SKILL.md")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.ARCHIVE_INVALID,
    });
    await expect(readSkillFile(bundle(bytes), "SKILL.md", { maxUnpackedBytes: 1 })).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE,
    });
  });
});
