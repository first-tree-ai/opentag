import type { Skill } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import * as skillOperations from "../core/skill/operations.js";

/**
 * `commands/skill/index.ts` is registration and option mapping only, so it is driven through the real
 * Commander program with the `core/` operations spied. Every command is exercised with and without
 * its optional flags, because the uncovered branches are exactly the absent-versus-present ones.
 */

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "8e63f0b3-2b3c-4e57-9d6f-9b4dbb1e0f2a",
    agentId,
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
    ...overrides,
  };
}

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(["node", "opentag", ...args]);
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previousExitCode;
  }
}

function spyAll() {
  return {
    push: vi.spyOn(skillOperations, "runSkillPush").mockResolvedValue({ skill: skill(), adopted: false }),
    list: vi
      .spyOn(skillOperations, "runSkillList")
      .mockResolvedValue({ skills: [skill()], storage: "available" as const }),
    pull: vi.spyOn(skillOperations, "runSkillPull").mockResolvedValue({ skill: skill(), directory: "/tmp/my-skill" }),
    remove: vi.spyOn(skillOperations, "runSkillRemove").mockResolvedValue(skill()),
    setEnabled: vi.spyOn(skillOperations, "runSkillSetEnabled").mockResolvedValue(skill()),
  };
}

type Spies = ReturnType<typeof spyAll>;

function restore(spies: Spies): void {
  for (const spy of Object.values(spies)) spy.mockRestore();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("skill command registration", () => {
  it("advertises push, list, pull, remove, and both switch directions", () => {
    const skillCommand = createProgram().commands.find((command) => command.name() === "skill");
    expect(skillCommand?.commands.map((command) => command.name())).toEqual([
      "push",
      "list",
      "pull",
      "remove",
      "enable",
      "disable",
    ]);
  });

  it("keeps --agent optional on every subcommand, because a Session supplies the Agent", () => {
    const skillCommand = createProgram().commands.find((command) => command.name() === "skill");
    for (const sub of skillCommand?.commands ?? []) {
      expect(sub.options.find((option) => option.long === "--agent")?.mandatory).toBe(false);
    }
    expect(
      skillCommand?.commands
        .find((command) => command.name() === "pull")
        ?.options.find((option) => option.long === "--out")?.mandatory,
    ).toBe(false);
  });
});

describe("skill push", () => {
  it("omits both optional inputs when neither flag was given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "push", "./my-skill"]);
      expect(spies.push).toHaveBeenCalledWith("./my-skill", {});
    } finally {
      restore(spies);
    }
  });

  it("forwards --agent and --replace", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "push", "./my-skill", "--agent", agentId, "--replace"]);
      expect(spies.push).toHaveBeenCalledWith("./my-skill", { agentId, replace: true });
    } finally {
      restore(spies);
    }
  });

  it("prints the adoption outcome in human form and in JSON", async () => {
    const spies = spyAll();
    spies.push.mockResolvedValue({ skill: skill(), adopted: true });
    try {
      const human = await runCommand(["skill", "push", "./my-skill"]);
      expect(human.stdout).toContain("adopted\ttrue");
      const json = await runCommand(["skill", "push", "./my-skill", "--json"]);
      expect(JSON.parse(json.stdout)).toMatchObject({ ok: true });
    } finally {
      restore(spies);
    }
  });

  it("reports a refusal as a non-zero result on stderr", async () => {
    const spies = spyAll();
    spies.push.mockRejectedValue(new Error("SKILL.md is missing"));
    try {
      const result = await runCommand(["skill", "push", "./my-skill"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SKILL.md is missing");
      expect(result.stdout).toBe("");
    } finally {
      restore(spies);
    }
  });
});

describe("skill list", () => {
  it("omits --agent when it was not given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "list"]);
      expect(spies.list).toHaveBeenCalledWith({});
    } finally {
      restore(spies);
    }
  });

  it("forwards --agent when an operator named one", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "list", "--agent", agentId]);
      expect(spies.list).toHaveBeenCalledWith({ agentId });
    } finally {
      restore(spies);
    }
  });

  it("renders the storage-only message when there are no Skills", async () => {
    const spies = spyAll();
    spies.list.mockResolvedValue({ skills: [], storage: "unavailable" });
    try {
      const result = await runCommand(["skill", "list"]);
      expect(result.stdout).toContain("No Skills configured (storage: unavailable)");
    } finally {
      restore(spies);
    }
  });
});

describe("skill pull", () => {
  it("omits both optional inputs when neither flag was given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "pull", "my-skill"]);
      expect(spies.pull).toHaveBeenCalledWith("my-skill", {});
    } finally {
      restore(spies);
    }
  });

  it("forwards --agent and --out", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "pull", "my-skill", "--agent", agentId, "--out", "/tmp/out"]);
      expect(spies.pull).toHaveBeenCalledWith("my-skill", { agentId, outDir: "/tmp/out" });
    } finally {
      restore(spies);
    }
  });

  it("prints the name and the directory it landed in", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["skill", "pull", "my-skill", "--json"]);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { directory: "/tmp/my-skill" } });
    } finally {
      restore(spies);
    }
  });

  it("reports a non-empty destination as a validation failure", async () => {
    const spies = spyAll();
    spies.pull.mockRejectedValue(
      Object.assign(new Error("Pull destination is not empty: /tmp/out"), {
        code: "SKILL_PULL_DESTINATION_NOT_EMPTY",
        category: "validation",
        retryability: "never",
        phase: "validation",
      }),
    );
    try {
      const result = await runCommand(["skill", "pull", "my-skill", "--out", "/tmp/out"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("SKILL_PULL_DESTINATION_NOT_EMPTY");
    } finally {
      restore(spies);
    }
  });
});

describe("skill remove", () => {
  it("omits --agent when it was not given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "remove", "my-skill"]);
      expect(spies.remove).toHaveBeenCalledWith("my-skill", {});
    } finally {
      restore(spies);
    }
  });

  it("forwards --agent when an operator named one, and names the removed Skill", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["skill", "remove", "my-skill", "--agent", agentId]);
      expect(spies.remove).toHaveBeenCalledWith("my-skill", { agentId });
      expect(result.stdout).toContain("Removed Skill my-skill");
    } finally {
      restore(spies);
    }
  });
});

describe("skill enable and disable", () => {
  it("omits --agent when it was not given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "enable", "my-skill"]);
      expect(spies.setEnabled).toHaveBeenLastCalledWith("my-skill", true, {});
      await runCommand(["skill", "disable", "my-skill"]);
      expect(spies.setEnabled).toHaveBeenLastCalledWith("my-skill", false, {});
    } finally {
      restore(spies);
    }
  });

  it("forwards --agent and carries the switch direction of each generated command", async () => {
    const spies = spyAll();
    try {
      await runCommand(["skill", "enable", "my-skill", "--agent", agentId]);
      expect(spies.setEnabled).toHaveBeenLastCalledWith("my-skill", true, { agentId });
      await runCommand(["skill", "disable", "my-skill", "--agent", agentId]);
      expect(spies.setEnabled).toHaveBeenLastCalledWith("my-skill", false, { agentId });
    } finally {
      restore(spies);
    }
  });

  it("prints the resulting state", async () => {
    const spies = spyAll();
    spies.setEnabled.mockResolvedValue(skill({ enabled: false }));
    try {
      const result = await runCommand(["skill", "disable", "my-skill"]);
      expect(result.stdout).toContain("Disabled Skill my-skill");
    } finally {
      restore(spies);
    }
  });
});
