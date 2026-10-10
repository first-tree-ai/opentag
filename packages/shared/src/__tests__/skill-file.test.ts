import { describe, expect, it } from "vitest";
import { agentSkillFilePath } from "../http-paths.js";
import {
  ReadSkillFileQuerySchema,
  ReadSkillFileResponseSchema,
  SKILL_FILE_PREVIEW_MAX_BYTES,
  SkillFilePathSchema,
} from "../skill.js";

describe("Skill file contract", () => {
  it("accepts canonical paths and bounds UTF-8 bytes rather than characters", () => {
    for (const path of ["SKILL.md", "references/a b.md", "assets/说明.txt", "a".repeat(256)]) {
      expect(SkillFilePathSchema.safeParse(path).success).toBe(true);
    }
    for (const path of [
      "",
      "/root",
      "../root",
      "a/../b",
      "a//b",
      "./a",
      "a\\b",
      "C:root",
      "a\0b",
      "a".repeat(257),
      "文".repeat(86),
    ]) {
      expect(SkillFilePathSchema.safeParse(path).success).toBe(false);
    }
    expect(agentSkillFilePath("agent/id", "skill id")).toBe("/api/v1/agents/agent%2Fid/skills/skill%20id/file");
    expect(
      ReadSkillFileQuerySchema.safeParse({ path: "SKILL.md", archiveSha256: "a".repeat(64), extra: true }).success,
    ).toBe(false);
  });
  it("supports the full archive index and rejects partial/binary content disguised as a preview", () => {
    const response = {
      archiveSha256: "a".repeat(64),
      path: "SKILL.md",
      files: Array.from({ length: 1000 }, (_, i) => ({ path: `${i}.txt`, bytes: 1 })),
      preview: { status: "binary" },
    };
    expect(ReadSkillFileResponseSchema.safeParse(response).success).toBe(true);
    expect(
      ReadSkillFileResponseSchema.safeParse({ ...response, preview: { status: "binary", content: "payload" } }).success,
    ).toBe(false);
    expect(
      ReadSkillFileResponseSchema.safeParse({
        ...response,
        preview: { status: "text", content: "a".repeat(SKILL_FILE_PREVIEW_MAX_BYTES + 1) },
      }).success,
    ).toBe(false);
    expect(
      ReadSkillFileResponseSchema.safeParse({
        ...response,
        files: [...response.files, { path: "extra.txt", bytes: 1 }],
      }).success,
    ).toBe(false);
  });
});
