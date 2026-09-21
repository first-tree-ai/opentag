import type { ListAgentSkillsResponse, Skill, SkillDetail } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { removeSkillFromList, updateSkillInList, upsertSkill } from "./skills-cache.js";

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

function skill(name: string, id: string, enabled = true): Skill {
  return {
    id,
    agentId: AGENT_ID,
    name,
    description: `${name} description`,
    enabled,
    source: "web_upload",
    archiveSha256: "a".repeat(64),
    archiveBytes: 2048,
    fileCount: 3,
    revision: 1,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function detailOf(listItem: Skill): SkillDetail {
  return { ...listItem, files: [{ path: "SKILL.md", bytes: 10 }], filesTruncated: false };
}

function list(skills: Skill[]): ListAgentSkillsResponse {
  return { skills, storage: "available" };
}

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BRAVO = "22222222-2222-4222-8222-222222222222";
const CHARLIE = "33333333-3333-4333-8333-333333333333";

describe("upsertSkill", () => {
  it("inserts a new Skill in the Server's name order rather than appending it", () => {
    const result = upsertSkill(
      list([skill("alpha", ALPHA), skill("charlie", CHARLIE)]),
      detailOf(skill("bravo", BRAVO)),
    );

    expect(result.skills.map((entry) => entry.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("replaces a same-id Skill in place, so a replace never duplicates a row", () => {
    const before = upsertSkill(list([]), detailOf(skill("demo", ALPHA, true)));
    const after = upsertSkill(before, detailOf(skill("demo", ALPHA, false)));

    expect(after.skills).toHaveLength(1);
    expect(after.skills[0]?.enabled).toBe(false);
  });

  it("never leaks the detail-only fields into a list item", () => {
    const result = upsertSkill(list([]), detailOf(skill("demo", ALPHA)));

    expect(result.skills[0]).not.toHaveProperty("files");
    expect(result.skills[0]).not.toHaveProperty("filesTruncated");
  });

  it("keeps the storage status from the list it reconciled into", () => {
    const result = upsertSkill({ skills: [], storage: "unavailable" }, detailOf(skill("demo", ALPHA)));

    expect(result.storage).toBe("unavailable");
  });
});

describe("updateSkillInList", () => {
  it("replaces the item with the same id and preserves its position", () => {
    const result = updateSkillInList(
      list([skill("alpha", ALPHA), skill("bravo", BRAVO, true)]),
      detailOf(skill("bravo", BRAVO, false)),
    );

    expect(result.skills.map((entry) => entry.name)).toEqual(["alpha", "bravo"]);
    expect(result.skills[1]?.enabled).toBe(false);
  });

  it("never leaks the detail-only fields into a list item", () => {
    const result = updateSkillInList(list([skill("alpha", ALPHA)]), detailOf(skill("alpha", ALPHA, false)));

    expect(result.skills[0]).not.toHaveProperty("files");
  });
});

describe("removeSkillFromList", () => {
  it("drops only the removed Skill", () => {
    const result = removeSkillFromList(list([skill("alpha", ALPHA), skill("bravo", BRAVO)]), ALPHA);

    expect(result.skills.map((entry) => entry.name)).toEqual(["bravo"]);
  });

  it("is a no-op when the id is not present", () => {
    const before = list([skill("alpha", ALPHA)]);
    expect(removeSkillFromList(before, CHARLIE)).toEqual(before);
  });
});
