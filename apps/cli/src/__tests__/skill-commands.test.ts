import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenTagApiError, packSkillDirectory, SkillArchiveError } from "@opentag/client";
import { SKILL_ERROR_CODES, type Skill } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../core/command/policy.js";
import { resolveSkillCommandContext } from "../core/skill/context.js";
import {
  runSkillList,
  runSkillPull,
  runSkillPush,
  runSkillRemove,
  runSkillSetEnabled,
} from "../core/skill/operations.js";
import type { SkillApiClient } from "../core/skill/shared.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-skill-cli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeSkillDirectory(parent: string, name: string): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} description`, "---", "", "# Body", ""].join("\n"),
  );
  return directory;
}

function skillRecord(name: string, overrides: Partial<Skill> = {}): Skill {
  return {
    id: randomUUID(),
    agentId: randomUUID(),
    name,
    description: `${name} description`,
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

function accountApi(overrides: Partial<SkillApiClient> = {}): SkillApiClient {
  return {
    listAgentSkills: vi.fn(async () => ({ skills: [], storage: "available" as const })),
    uploadAgentSkill: vi.fn(async (_token, _agentId, _input) => skillRecord("my-skill")),
    updateAgentSkill: vi.fn(async () => skillRecord("my-skill")),
    removeAgentSkill: vi.fn(async () => undefined),
    openAgentSkillBundle: vi.fn(async () => new Response()),
    listRuntimeSkills: vi.fn(async () => ({ skills: [], storage: "available" as const })),
    pushRuntimeSkill: vi.fn(async () => skillRecord("my-skill")),
    openRuntimeSkillBundle: vi.fn(async () => new Response()),
    ...overrides,
  };
}

describe("skill command authority", () => {
  it("rejects --agent, lifecycle commands, and missing --agent outside their modes", async () => {
    await expect(
      resolveSkillCommandContext("push", {
        agentId: "agent-a",
        api: accountApi(),
        proof: "p".repeat(32),
        environment: { OPENTAG_SESSION_PROOF_FILE: "/tmp/proof.json" },
      }),
    ).rejects.toMatchObject({ code: "SKILL_AGENT_FLAG_FORBIDDEN" });

    for (const operation of ["remove", "enable", "disable"] as const) {
      await expect(
        resolveSkillCommandContext(operation, {
          api: accountApi(),
          proof: "p".repeat(32),
          environment: { OPENTAG_SESSION_PROOF_FILE: "/tmp/proof.json" },
        }),
      ).rejects.toMatchObject({ code: "SKILL_LIFECYCLE_ACCOUNT_ONLY" });
    }

    await expect(resolveSkillCommandContext("list", { environment: {} })).rejects.toMatchObject({
      code: "SKILL_AGENT_REQUIRED",
    });
  });

  it("resolves Agent mode from the proof and Account mode from an operator context", async () => {
    const agent = await resolveSkillCommandContext("push", {
      api: accountApi(),
      proof: "p".repeat(32),
      environment: { OPENTAG_SESSION_PROOF_FILE: "/tmp/proof.json" },
    });
    expect(agent).toMatchObject({ mode: "agent", proof: "p".repeat(32) });

    const account = await resolveSkillCommandContext("list", {
      accessToken: "fixture-account-access",
      agentId: "agent-a",
      api: accountApi(),
    });
    expect(account).toMatchObject({ mode: "account", agentId: "agent-a" });
  });
});

describe("skill push", () => {
  it("adopts the pushed directory in Agent mode when it is the Skill's materialization target", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const directory = await writeSkillDirectory(join(workspace, ".claude", "skills"), "my-skill");
    await mkdir(join(workspace, ".opentag", "skill-staging"), { recursive: true });
    const api = accountApi();

    const result = await runSkillPush(directory, {}, { api, proof: "p".repeat(32) });
    expect(result.skill.name).toBe("my-skill");
    expect(result.adopted).toBe(true);
    expect(result.adoptionReason).toBeUndefined();
    const marker = JSON.parse(await readFile(join(directory, ".opentag-skill.json"), "utf8")) as {
      skillId: string;
      archiveSha256: string;
    };
    expect(marker).toEqual({ skillId: result.skill.id, archiveSha256: result.skill.archiveSha256 });
  });

  it("does not adopt a nested checkout that sync never manages", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const directory = await writeSkillDirectory(join(workspace, "checkout", ".claude", "skills"), "my-skill");
    await mkdir(join(workspace, ".opentag", "skill-staging"), { recursive: true });
    const api = accountApi();

    const result = await runSkillPush(directory, {}, { api, proof: "p".repeat(32) });
    expect(result.adopted).toBe(false);
    expect(result.adoptionReason).toContain("synced workspace");
    await expect(stat(join(directory, ".opentag-skill.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not adopt in a workspace with no sync sentinel", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const directory = await writeSkillDirectory(join(workspace, ".claude", "skills"), "my-skill");
    const api = accountApi();

    const result = await runSkillPush(directory, {}, { api, proof: "p".repeat(32) });
    expect(result.adopted).toBe(false);
    expect(result.adoptionReason).toContain("synced workspace");
  });

  it("adopts even when the caller has cd-ed into the skill directory", async () => {
    const root = await temporaryRoot();
    const directory = await writeSkillDirectory(join(root, "workspace", ".agents", "skills"), "my-skill");
    await mkdir(join(root, "workspace", ".opentag", "skill-staging"), { recursive: true });
    const api = accountApi();
    const result = await runSkillPush(directory, {}, { api, proof: "p".repeat(32) });
    expect(result.adopted).toBe(true);
  });

  it("never adopts in Account mode, even for a materialization-shaped path", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const directory = await writeSkillDirectory(join(workspace, ".claude", "skills"), "my-skill");
    const api = accountApi();

    const result = await runSkillPush(
      directory,
      { agentId: "agent-a" },
      { accessToken: "fixture-account-access", api },
    );
    expect(result.adopted).toBe(false);
    expect(result.adoptionReason).toContain("Agent Session");
    await expect(stat(join(directory, ".opentag-skill.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(api.uploadAgentSkill).toHaveBeenCalledWith(
      "fixture-account-access",
      "agent-a",
      expect.objectContaining({ format: "tar.gz" }),
    );
  });

  it("does not adopt a directory pushed from outside a materialization target", async () => {
    const root = await temporaryRoot();
    const elsewhere = await writeSkillDirectory(join(root, "authoring"), "my-skill");
    const api = accountApi();
    const result = await runSkillPush(elsewhere, {}, { api, proof: "p".repeat(32) });
    expect(result.adopted).toBe(false);
    expect(result.adoptionReason).toContain("materialization target");
    await expect(stat(join(elsewhere, ".opentag-skill.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(elsewhere)).toEqual(["SKILL.md"]);
  });

  it("does not adopt a Skill the server reports as disabled", async () => {
    const root = await temporaryRoot();
    const directory = await writeSkillDirectory(join(root, "workspace", ".claude", "skills"), "my-skill");
    await mkdir(join(root, "workspace", ".opentag", "skill-staging"), { recursive: true });
    const api = accountApi({
      pushRuntimeSkill: vi.fn(async () => skillRecord("my-skill", { enabled: false })),
    });
    const result = await runSkillPush(directory, { replace: true }, { api, proof: "p".repeat(32) });
    expect(result.skill.enabled).toBe(false);
    expect(result.adopted).toBe(false);
    expect(result.adoptionReason).toContain("disabled");
    await expect(stat(join(directory, ".opentag-skill.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hints at --replace when the name already exists", async () => {
    const root = await temporaryRoot();
    const directory = await writeSkillDirectory(root, "my-skill");
    const api = accountApi({
      uploadAgentSkill: vi.fn(async () => {
        throw new OpenTagApiError(SKILL_ERROR_CODES.NAME_CONFLICT, "deterministic", "exists", 409);
      }),
    });
    await expect(
      runSkillPush(directory, { agentId: "agent-a" }, { accessToken: "fixture-account-access", api }),
    ).rejects.toMatchObject({ code: SKILL_ERROR_CODES.NAME_CONFLICT });
    await expect(
      runSkillPush(directory, { agentId: "agent-a" }, { accessToken: "fixture-account-access", api }),
    ).rejects.toThrow("--replace");
  });

  it("pushes through the Session proof and rejects --agent in Agent mode", async () => {
    const root = await temporaryRoot();
    const directory = await writeSkillDirectory(root, "my-skill");
    const api = accountApi();
    await expect(
      runSkillPush(directory, { agentId: "must-not-be-used" }, { api, proof: "p".repeat(32) }),
    ).rejects.toMatchObject({ code: "SKILL_AGENT_FLAG_FORBIDDEN" });
    await expect(runSkillPush(directory, {}, { api, proof: "p".repeat(32) })).resolves.toMatchObject({
      skill: { name: "my-skill" },
      adopted: false,
    });
    expect(api.pushRuntimeSkill).toHaveBeenCalledWith("p".repeat(32), expect.objectContaining({ format: "tar.gz" }));
  });
});

describe("skill pull", () => {
  it("extracts into an empty directory and refuses a non-empty one", async () => {
    const root = await temporaryRoot();
    const source = await writeSkillDirectory(join(root, "source"), "my-skill");
    const packed = await packSkillDirectory(source);
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({
        skills: [skillRecord("my-skill", { archiveBytes: packed.archive.byteLength, archiveSha256: packed.sha256 })],
        storage: "available" as const,
      })),
      openAgentSkillBundle: vi.fn(async () => new Response(packed.archive)),
    });
    const dependencies = { accessToken: "fixture-account-access", api, cwd: root };
    const out = join(root, "out");
    const result = await runSkillPull("my-skill", { agentId: "agent-a", outDir: out }, dependencies);
    expect(result.directory).toBe(resolve(out));
    expect(await readFile(join(out, "SKILL.md"), "utf8")).toContain("my-skill");

    await writeFile(join(out, "extra.txt"), "existing");
    await expect(runSkillPull("my-skill", { agentId: "agent-a", outDir: out }, dependencies)).rejects.toMatchObject({
      code: "SKILL_PULL_DESTINATION_NOT_EMPTY",
    });
  });
  it("verifies the bundle before extracting it", async () => {
    const root = await temporaryRoot();
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({
        skills: [skillRecord("my-skill", { archiveBytes: 3, archiveSha256: "b".repeat(64) })],
        storage: "available" as const,
      })),
      openAgentSkillBundle: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    });
    await expect(
      runSkillPull(
        "my-skill",
        { agentId: "agent-a", outDir: join(root, "out") },
        { accessToken: "fixture-account-access", api },
      ),
    ).rejects.toThrow("failed its sha256 check");
  });
});

describe("skill lifecycle", () => {
  it("refuses a lifecycle change from an Agent and allows it for an operator", async () => {
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({ skills: [skillRecord("my-skill")], storage: "available" as const })),
    });
    await expect(runSkillSetEnabled("my-skill", false, {}, { api, proof: "p".repeat(32) })).rejects.toBeInstanceOf(
      CommandError,
    );

    await runSkillSetEnabled("my-skill", false, { agentId: "agent-a" }, { accessToken: "fixture-account-access", api });
    expect(api.updateAgentSkill).toHaveBeenCalledWith("fixture-account-access", "agent-a", expect.any(String), {
      enabled: false,
    });
  });
});

describe("skill list", () => {
  it("lists through the Session proof without naming an Agent", async () => {
    const api = accountApi({
      listRuntimeSkills: vi.fn(async () => ({ skills: [skillRecord("my-skill")], storage: "available" as const })),
    });
    await expect(runSkillList({}, { api, proof: "p".repeat(32) })).resolves.toMatchObject({
      skills: [expect.objectContaining({ name: "my-skill" })],
    });
    expect(api.listRuntimeSkills).toHaveBeenCalledWith("p".repeat(32));
    expect(api.listAgentSkills).not.toHaveBeenCalled();
  });

  it("lists one Agent's Skills when an operator names it", async () => {
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({ skills: [], storage: "available" as const })),
    });
    await expect(runSkillList({ agentId: "agent-a" }, { accessToken: "fixture-account-access", api })).resolves.toEqual(
      {
        skills: [],
        storage: "available",
      },
    );
    expect(api.listAgentSkills).toHaveBeenCalledWith("fixture-account-access", "agent-a");
  });

  it("refuses --agent inside a Session even for a read", async () => {
    await expect(
      runSkillList({ agentId: "agent-a" }, { api: accountApi(), proof: "p".repeat(32) }),
    ).rejects.toMatchObject({ code: "SKILL_AGENT_FLAG_FORBIDDEN" });
  });

  it("requires --agent outside a Session, because a Skill always belongs to one Agent", async () => {
    await expect(runSkillList({}, { environment: {}, api: accountApi() })).rejects.toMatchObject({
      code: "SKILL_AGENT_REQUIRED",
    });
  });
});

describe("skill remove", () => {
  it("deletes a Skill for an operator, resolving it by name and by id", async () => {
    const record = skillRecord("my-skill");
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({ skills: [record], storage: "available" as const })),
    });
    await expect(
      runSkillRemove("my-skill", { agentId: "agent-a" }, { accessToken: "fixture-account-access", api }),
    ).resolves.toEqual(record);
    await expect(
      runSkillRemove(record.id, { agentId: "agent-a" }, { accessToken: "fixture-account-access", api }),
    ).resolves.toEqual(record);
    expect(api.removeAgentSkill).toHaveBeenCalledTimes(2);
    expect(api.removeAgentSkill).toHaveBeenLastCalledWith("fixture-account-access", "agent-a", record.id);
  });

  it("refuses an unknown name rather than deleting the wrong Skill", async () => {
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({ skills: [skillRecord("other")], storage: "available" as const })),
    });
    await expect(
      runSkillRemove("my-skill", { agentId: "agent-a" }, { accessToken: "fixture-account-access", api }),
    ).rejects.toThrow('No Skill named or identified by "my-skill"');
    expect(api.removeAgentSkill).not.toHaveBeenCalled();
  });

  it("refuses deletion from an Agent, because lifecycle is a human decision", async () => {
    await expect(runSkillRemove("my-skill", {}, { api: accountApi(), proof: "p".repeat(32) })).rejects.toMatchObject({
      code: "SKILL_LIFECYCLE_ACCOUNT_ONLY",
    });
  });
});

describe("skill pull edge cases", () => {
  it("opened the bundle through the Session proof in Agent mode", async () => {
    const root = await temporaryRoot();
    const source = await writeSkillDirectory(join(root, "source"), "my-skill");
    const packed = await packSkillDirectory(source);
    const api = accountApi({
      listRuntimeSkills: vi.fn(async () => ({
        skills: [skillRecord("my-skill", { archiveBytes: packed.archive.byteLength, archiveSha256: packed.sha256 })],
        storage: "available" as const,
      })),
      openRuntimeSkillBundle: vi.fn(async () => new Response(packed.archive)),
    });
    const out = join(root, "out");
    const result = await runSkillPull("my-skill", { outDir: out }, { api, proof: "p".repeat(32), cwd: root });
    expect(result.directory).toBe(resolve(out));
    expect(api.openRuntimeSkillBundle).toHaveBeenCalledWith("p".repeat(32), "my-skill", {
      signal: expect.any(AbortSignal),
    });
    expect(await readFile(join(out, "SKILL.md"), "utf8")).toContain("my-skill");
  });

  it("refuses a destination that exists as a file", async () => {
    const root = await temporaryRoot();
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({ skills: [skillRecord("my-skill")], storage: "available" as const })),
    });
    const out = join(root, "out");
    await writeFile(out, "not a directory");
    await expect(
      runSkillPull("my-skill", { agentId: "agent-a", outDir: out }, { accessToken: "fixture-account-access", api }),
    ).rejects.toMatchObject({ code: "SKILL_PULL_DESTINATION_INVALID" });
    expect(api.openAgentSkillBundle).not.toHaveBeenCalled();
  });

  it("defaults the destination to the Skill name under the working directory", async () => {
    const root = await temporaryRoot();
    const source = await writeSkillDirectory(join(root, "source"), "my-skill");
    const packed = await packSkillDirectory(source);
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({
        skills: [skillRecord("my-skill", { archiveBytes: packed.archive.byteLength, archiveSha256: packed.sha256 })],
        storage: "available" as const,
      })),
      openAgentSkillBundle: vi.fn(async () => new Response(packed.archive)),
    });
    const result = await runSkillPull(
      "my-skill",
      { agentId: "agent-a" },
      { accessToken: "fixture-account-access", api, cwd: root },
    );
    expect(result.directory).toBe(resolve(root, "my-skill"));
    expect(await readFile(join(root, "my-skill", "SKILL.md"), "utf8")).toContain("my-skill");
  });

  it("refuses a destination that was filled between the check and the extraction", async () => {
    const root = await temporaryRoot();
    const source = await writeSkillDirectory(join(root, "source"), "my-skill");
    const packed = await packSkillDirectory(source);
    const out = join(root, "out");
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({
        skills: [skillRecord("my-skill", { archiveBytes: packed.archive.byteLength, archiveSha256: packed.sha256 })],
        storage: "available" as const,
      })),
      openAgentSkillBundle: vi.fn(async () => {
        // The destination is empty when it is checked, and occupied by the time it is written.
        await writeFile(join(out, "racing.txt"), "something landed first");
        return new Response(packed.archive);
      }),
    });
    await mkdir(out, { recursive: true });
    await expect(
      runSkillPull("my-skill", { agentId: "agent-a", outDir: out }, { accessToken: "fixture-account-access", api }),
    ).rejects.toMatchObject({ code: "SKILL_PULL_DESTINATION_NOT_EMPTY" });
  });
});

describe("skill upload failures", () => {
  it("rethrows an upload failure that is not a name conflict, unchanged", async () => {
    const root = await temporaryRoot();
    const directory = await writeSkillDirectory(root, "my-skill");
    const original = new OpenTagApiError("SKILL_VALIDATION_FAILED", "validation", "manifest is invalid", 400);
    const api = accountApi({
      uploadAgentSkill: vi.fn(async () => {
        throw original;
      }),
    });
    await expect(
      runSkillPush(directory, { agentId: "agent-a" }, { accessToken: "fixture-account-access", api }),
    ).rejects.toBe(original);
    expect(api.uploadAgentSkill).toHaveBeenCalledWith(
      "fixture-account-access",
      "agent-a",
      expect.objectContaining({ format: "tar.gz" }),
    );
  });

  it("reserves the --replace hint for the name conflict itself", async () => {
    const root = await temporaryRoot();
    const directory = await writeSkillDirectory(root, "my-skill");
    const api = accountApi({
      pushRuntimeSkill: vi.fn(async () => {
        throw new Error("the platform is unreachable");
      }),
    });
    await expect(runSkillPush(directory, {}, { api, proof: "p".repeat(32) })).rejects.not.toThrow("--replace");
  });
});

describe("skill extraction failures", () => {
  it("rethrows an archive failure that is not a destination collision", async () => {
    const root = await temporaryRoot();
    const bytes = new TextEncoder().encode("this is not a gzipped tar archive");
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({
        skills: [
          skillRecord("my-skill", {
            archiveBytes: bytes.byteLength,
            archiveSha256: createHash("sha256").update(bytes).digest("hex"),
          }),
        ],
        storage: "available" as const,
      })),
      openAgentSkillBundle: vi.fn(async () => new Response(bytes)),
    });
    await expect(
      runSkillPull(
        "my-skill",
        { agentId: "agent-a", outDir: join(root, "out") },
        { accessToken: "fixture-account-access", api },
      ),
    ).rejects.toBeInstanceOf(SkillArchiveError);
  });
});

describe("skill push with --replace", () => {
  it("never adopts when the push is a replacement from an authoring directory", async () => {
    const root = await temporaryRoot();
    const directory = await writeSkillDirectory(join(root, "authoring"), "my-skill");
    const api = accountApi();
    const result = await runSkillPush(directory, { replace: true }, { api, proof: "p".repeat(32) });
    expect(api.pushRuntimeSkill).toHaveBeenCalledWith(
      "p".repeat(32),
      expect.objectContaining({ format: "tar.gz", replace: true }),
    );
    expect(result.adopted).toBe(false);
  });
});

describe("skill lifecycle enable", () => {
  it("enables a Skill for an operator and re-reads the row it wrote", async () => {
    const record = skillRecord("my-skill", { enabled: false });
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({ skills: [record], storage: "available" as const })),
      updateAgentSkill: vi.fn(async () => skillRecord("my-skill", { enabled: true })),
    });
    await expect(
      runSkillSetEnabled("my-skill", true, { agentId: "agent-a" }, { accessToken: "fixture-account-access", api }),
    ).resolves.toMatchObject({ enabled: true });
    expect(api.updateAgentSkill).toHaveBeenCalledWith("fixture-account-access", "agent-a", record.id, {
      enabled: true,
    });
  });
});

describe("skill pull default destination", () => {
  it("falls back to the process working directory when no cwd was injected", async () => {
    const root = await temporaryRoot();
    const source = await writeSkillDirectory(join(root, "source"), "my-skill");
    const packed = await packSkillDirectory(source);
    const api = accountApi({
      listAgentSkills: vi.fn(async () => ({
        skills: [skillRecord("my-skill", { archiveBytes: packed.archive.byteLength, archiveSha256: packed.sha256 })],
        storage: "available" as const,
      })),
      openAgentSkillBundle: vi.fn(async () => new Response(packed.archive)),
    });
    // The fallback is `process.cwd()`, so it is redirected to a temporary directory rather than
    // writing a Skill into the repository the test runs in.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const result = await runSkillPull(
        "my-skill",
        { agentId: "agent-a" },
        { accessToken: "fixture-account-access", api },
      );
      expect(result.directory).toBe(resolve(root, "my-skill"));
      expect(await readFile(join(root, "my-skill", "SKILL.md"), "utf8")).toContain("my-skill");
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("skill name conflict with a request id", () => {
  it("carries the server's request id into the CLI error, so a report can be traced", async () => {
    const root = await temporaryRoot();
    const directory = await writeSkillDirectory(root, "my-skill");
    const api = accountApi({
      uploadAgentSkill: vi.fn(async () => {
        throw new OpenTagApiError(SKILL_ERROR_CODES.NAME_CONFLICT, "deterministic", "exists", 409, undefined, {
          requestId: "req-conflict-1",
        });
      }),
    });
    await expect(
      runSkillPush(directory, { agentId: "agent-a" }, { accessToken: "fixture-account-access", api }),
    ).rejects.toMatchObject({ code: SKILL_ERROR_CODES.NAME_CONFLICT, requestId: "req-conflict-1" });
  });
});
