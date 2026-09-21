import type { ListAgentSkillsResponse, Skill } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillApiClient } from "../core/skill/shared.js";

/**
 * `runSkillRemove` and `runSkillSetEnabled` each re-check that the authority they were handed is an
 * Account one, even though `resolveSkillCommandContext` already refuses the Session path for those
 * operations. That second check is a defence against a future caller reaching the operation by
 * another route, so it can only be driven by handing the operation an Agent authority directly —
 * which is what the context module is mocked to do here.
 */
vi.mock("../core/skill/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/skill/context.js")>();
  return { ...actual, resolveSkillCommandContext: vi.fn() };
});

const { resolveSkillCommandContext } = await import("../core/skill/context.js");
const { runSkillRemove, runSkillSetEnabled } = await import("../core/skill/operations.js");

function skillRecord(): Skill {
  return {
    id: "8e63f0b3-2b3c-4e57-9d6f-9b4dbb1e0f2a",
    agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
    name: "my-skill",
    description: "my-skill description",
    enabled: true,
    source: "cli_upload",
    archiveSha256: "a".repeat(64),
    archiveBytes: 128,
    fileCount: 1,
    revision: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

function agentAuthority() {
  const api = {
    listRuntimeSkills: vi.fn(
      async (): Promise<ListAgentSkillsResponse> => ({ skills: [skillRecord()], storage: "available" }),
    ),
    removeAgentSkill: vi.fn(async () => undefined),
    updateAgentSkill: vi.fn(async () => skillRecord()),
  } as unknown as SkillApiClient;
  vi.mocked(resolveSkillCommandContext).mockResolvedValue({ mode: "agent", api, proof: "p".repeat(32) });
  return api;
}

afterEach(() => {
  vi.mocked(resolveSkillCommandContext).mockReset();
});

describe("lifecycle operations handed an Agent authority", () => {
  it("refuses to remove a Skill, because lifecycle is a human decision", async () => {
    const api = agentAuthority();
    await expect(runSkillRemove("my-skill", {}, { api })).rejects.toThrow(
      "Removing a Skill requires an Account operator",
    );
    expect((api as unknown as { removeAgentSkill: ReturnType<typeof vi.fn> }).removeAgentSkill).not.toHaveBeenCalled();
  });

  it("refuses to change a Skill's state for the same reason", async () => {
    const api = agentAuthority();
    await expect(runSkillSetEnabled("my-skill", false, {}, { api })).rejects.toThrow(
      "Changing a Skill's state requires an Account operator",
    );
    expect((api as unknown as { updateAgentSkill: ReturnType<typeof vi.fn> }).updateAgentSkill).not.toHaveBeenCalled();
  });
});
