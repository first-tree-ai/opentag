import type { Skill } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  formatSkill,
  formatSkillEnabled,
  formatSkillList,
  formatSkillPull,
  formatSkillPush,
  formatSkillRemoval,
} from "../core/skill/shared.js";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "8e63f0b3-2b3c-4e57-9d6f-9b4dbb1e0f2a",
    agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
    name: "my-skill",
    description: "my-skill description",
    enabled: true,
    source: "cli_upload",
    archiveSha256: "a".repeat(64),
    archiveBytes: 128,
    fileCount: 2,
    revision: 3,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatSkill", () => {
  it("prints every field of the Skill record", () => {
    expect(formatSkill(skill())).toBe(
      [
        `id\t${skill().id}`,
        "name\tmy-skill",
        "description\tmy-skill description",
        "enabled\ttrue",
        "source\tcli_upload",
        "revision\t3",
        "bytes\t128",
        "files\t2",
        "sha256\t" + "a".repeat(64),
        "updatedAt\t2030-01-02T00:00:00.000Z",
      ].join("\n"),
    );
    expect(formatSkill(skill({ enabled: false }))).toContain("enabled\tfalse");
  });
});

describe("formatSkillPush", () => {
  it("omits the adoption reason when there is none", () => {
    const output = formatSkillPush({ skill: skill(), adopted: true });
    expect(output).toContain("adopted\ttrue");
    expect(output).not.toContain("adoptionReason");
  });

  it("prints the adoption reason when the push did not adopt the directory", () => {
    const output = formatSkillPush({
      skill: skill(),
      adopted: false,
      adoptionReason: "the directory is not a Skill materialization target",
    });
    expect(output).toContain("adopted\tfalse");
    expect(output).toContain("adoptionReason\tthe directory is not a Skill materialization target");
  });
});

describe("formatSkillList", () => {
  it("reports storage availability when the Agent has no Skills", () => {
    expect(formatSkillList({ skills: [], storage: "available" })).toBe("No Skills configured (storage: available)");
    expect(formatSkillList({ skills: [], storage: "unavailable" })).toBe("No Skills configured (storage: unavailable)");
  });

  it("prints a header row, one row per Skill, and the storage line", () => {
    const rows = formatSkillList({
      skills: [skill(), skill({ name: "other", enabled: false, revision: 1 })],
      storage: "available",
    }).split("\n");
    expect(rows[0]).toBe(["NAME", "ENABLED", "SOURCE", "FILES", "REVISION", "UPDATED"].join("\t"));
    expect(rows[1]).toBe(["my-skill", "enabled", "cli_upload", "2", "3", "2030-01-02T00:00:00.000Z"].join("\t"));
    expect(rows[2]).toBe(["other", "disabled", "cli_upload", "2", "1", "2030-01-02T00:00:00.000Z"].join("\t"));
    expect(rows[3]).toBe("storage\tavailable");
    expect(rows).toHaveLength(4);
  });
});

describe("formatSkillPull", () => {
  it("prints the Skill name and the directory it landed in", () => {
    expect(formatSkillPull({ skill: skill(), directory: "/tmp/out" })).toBe("name\tmy-skill\ndirectory\t/tmp/out");
  });
});

describe("formatSkillRemoval", () => {
  it("names the removed Skill", () => {
    expect(formatSkillRemoval(skill())).toBe("Removed Skill my-skill");
  });
});

describe("formatSkillEnabled", () => {
  it("distinguishes an enable from a disable", () => {
    expect(formatSkillEnabled(skill())).toBe("Enabled Skill my-skill");
    expect(formatSkillEnabled(skill({ enabled: false }))).toBe("Disabled Skill my-skill");
  });
});
