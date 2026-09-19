import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenTagApiError, packSkillDirectory } from "@opentag/client";
import { SKILL_ERROR_CODES, type Skill } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../core/command/policy.js";
import { resolveSkillCommandContext } from "../core/skill/context.js";
import { runSkillPull, runSkillPush, runSkillSetEnabled } from "../core/skill/operations.js";
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
  it("uploads the packed directory and adopts it when it is the Skill's materialization target", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    const directory = await writeSkillDirectory(join(cwd, ".claude", "skills"), "my-skill");
    const api = accountApi();
    const dependencies = { accessToken: "fixture-account-access", api, cwd };

    const uploaded = await runSkillPush(directory, { agentId: "agent-a" }, dependencies);
    expect(uploaded.name).toBe("my-skill");
    expect(api.uploadAgentSkill).toHaveBeenCalledWith(
      "fixture-account-access",
      "agent-a",
      expect.objectContaining({ format: "tar.gz" }),
    );
    const marker = JSON.parse(await readFile(join(directory, ".opentag-skill.json"), "utf8")) as {
      skillId: string;
      archiveSha256: string;
    };
    expect(marker).toEqual({ skillId: uploaded.id, archiveSha256: uploaded.archiveSha256 });
  });

  it("leaves a directory pushed from elsewhere untouched", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    const elsewhere = await writeSkillDirectory(join(root, "authoring"), "my-skill");
    const api = accountApi();
    await runSkillPush(elsewhere, { agentId: "agent-a" }, { accessToken: "fixture-account-access", api, cwd });
    await expect(stat(join(elsewhere, ".opentag-skill.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(elsewhere)).toEqual(["SKILL.md"]);
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
      name: "my-skill",
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
      listAgentSkills: vi.fn(async () => ({ skills: [skillRecord("my-skill")], storage: "available" as const })),
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
