import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSkillArchive, packSkillDirectory, sha256Hex } from "@opentag/client";
import {
  type AgentSkillsResponse,
  computeSkillDigest,
  type ListSkillsResponse,
  SKILL_ARCHIVE_MAX_BYTES,
  type SkillDetail,
  type SkillSummary,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { CommandError, commandExitCode, EXIT_CODES } from "../core/command/policy.js";
import { resolveSkillCommandContext } from "../core/skill/context.js";
import { formatAgentSkills, formatSkillList, formatSkillPulled, formatSkillPushed } from "../core/skill/formatting.js";
import * as skillMutations from "../core/skill/mutations.js";
import { runSkillAssign, runSkillDelete, runSkillPush } from "../core/skill/mutations.js";
import * as skillQueries from "../core/skill/queries.js";
import { runSkillList, runSkillPull, runSkillShow } from "../core/skill/queries.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opentag-skill-cli-"));
  directories.push(path);
  return path;
}

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const summary: SkillSummary = {
  name: "demo",
  description: "Demo skill",
  digest: "a".repeat(64),
  archiveSha256: "b".repeat(64),
  archiveBytes: 10,
  fileCount: 2,
  totalBytes: 44,
  agentCount: 1,
  updatedAt: "2026-09-11T00:00:00.000Z",
  updatedBy: { kind: "user", id: "user-1" },
};

async function skillDirectory(): Promise<string> {
  const root = await temporaryDirectory();
  const skill = join(root, "demo");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await mkdir(join(skill, ".git"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n");
  await writeFile(join(skill, "scripts", "run.sh"), "#!/bin/sh\n");
  await writeFile(join(skill, ".git", "HEAD"), "ref: refs/heads/main\n");
  return skill;
}

async function packedDetail(skill: string): Promise<{ bytes: Uint8Array; detail: SkillDetail }> {
  const packed = await packSkillDirectory(skill);
  const manifest = { schemaVersion: 1 as const, name: "demo", files: [...packed.files] };
  const detail: SkillDetail = {
    ...summary,
    digest: computeSkillDigest(manifest),
    archiveSha256: sha256Hex(packed.bytes),
    archiveBytes: packed.bytes.length,
    fileCount: packed.fileCount,
    totalBytes: packed.totalBytes,
    manifest,
  };
  return { bytes: packed.bytes, detail };
}

function api(detail: SkillDetail = { ...summary, manifest: { schemaVersion: 1, name: "demo", files: [] } }) {
  return {
    listSkills: vi.fn<(token: string, input?: { cursor?: string }) => Promise<ListSkillsResponse>>(),
    getSkill: vi.fn().mockResolvedValue(detail),
    getSkillMarkdown: vi.fn().mockResolvedValue("# demo\n"),
    downloadSkillArchive: vi.fn(),
    uploadSkill: vi.fn().mockResolvedValue(detail),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    getAgentSkills: vi.fn(),
    replaceAgentSkills: vi.fn<(token: string, agent: string, input: unknown) => Promise<AgentSkillsResponse>>(),
    listAgents: vi.fn().mockResolvedValue({ agents: [{ id: agentId, name: "code-reviewer" }] }),
  };
}

describe("skill CLI core", () => {
  it("requires complete injected dependencies", async () => {
    await expect(resolveSkillCommandContext({ api: api() })).rejects.toThrow(
      "Skill command test dependencies must provide both api and accessToken",
    );
    await expect(resolveSkillCommandContext({ accessToken: "access" })).rejects.toThrow(
      "Skill command test dependencies must provide both api and accessToken",
    );
  });

  it("lists skills across every page and formats them", async () => {
    const client = api();
    client.listSkills
      .mockResolvedValueOnce({ skills: [summary], nextCursor: "page-2" })
      .mockResolvedValueOnce({ skills: [{ ...summary, name: "other", description: "Two\nlines" }], nextCursor: null });
    const result = await runSkillList({ api: client, accessToken: "access" });
    expect(result.skills.map((skill) => skill.name)).toEqual(["demo", "other"]);
    expect(client.listSkills).toHaveBeenNthCalledWith(1, "access", {});
    expect(client.listSkills).toHaveBeenNthCalledWith(2, "access", { cursor: "page-2" });
    const text = formatSkillList(result);
    expect(text.split("\n")[0]).toBe("NAME\tDIGEST\tFILES\tBYTES\tAGENTS\tUPDATED\tDESCRIPTION");
    expect(text).toContain("demo\taaaaaaaaaaaa\t2\t44\t1\t2026-09-11T00:00:00.000Z\tDemo skill");
    expect(text).toContain("Two lines");
    expect(formatSkillList({ skills: [], nextCursor: null })).toBe("No skills in this Account");
  });

  it("shows SKILL.md and rejects malformed names before calling the server", async () => {
    const client = api();
    await expect(runSkillShow("demo", { api: client, accessToken: "access" })).resolves.toBe("# demo\n");
    expect(client.getSkillMarkdown).toHaveBeenCalledWith("access", "demo");
    const error = await runSkillShow("Not Valid", { api: client, accessToken: "access" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect(commandExitCode(error as CommandError)).toBe(EXIT_CODES.usage);
    expect(client.getSkillMarkdown).toHaveBeenCalledTimes(1);
  });

  it("packs a directory into a canonical zip without .git and uploads it with the Account token", async () => {
    const skill = await skillDirectory();
    const client = api();
    const result = await runSkillPush(skill, { api: client, accessToken: "access", environment: {} });
    expect(result).toMatchObject({ source: "directory", via: "account", skill: { name: "demo" } });
    const [token, bytes, options] = client.uploadSkill.mock.calls[0] as [string, Uint8Array, { onConflict: string }];
    expect(token).toBe("access");
    expect(options).toEqual({ onConflict: "fail" });
    expect(inspectSkillArchive(bytes).map((entry) => entry.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    await runSkillPush(skill, { api: client, accessToken: "access", environment: {}, replace: true });
    expect(client.uploadSkill.mock.calls[1]?.[2]).toEqual({ onConflict: "replace" });
    expect(formatSkillPushed(result)).toContain("Pushed skill demo to the Account library");
  });

  it("uploads an existing zip, and rejects oversized, invalid, or non-file sources locally", async () => {
    const skill = await skillDirectory();
    const { bytes } = await packedDetail(skill);
    const root = await temporaryDirectory();
    const archive = join(root, "demo.zip");
    await writeFile(archive, bytes);
    const client = api();
    await expect(runSkillPush(archive, { api: client, accessToken: "access", environment: {} })).resolves.toMatchObject(
      {
        source: "archive",
      },
    );
    expect(client.uploadSkill.mock.calls[0]?.[1]).toEqual(bytes);

    const oversized = join(root, "big.zip");
    await writeFile(oversized, new Uint8Array(SKILL_ARCHIVE_MAX_BYTES + 1));
    await expect(
      runSkillPush(oversized, { api: client, accessToken: "access", environment: {} }),
    ).rejects.toMatchObject({
      code: "SKILL_ARCHIVE_TOO_LARGE",
      category: "validation",
    });
    const invalid = join(root, "invalid.zip");
    await writeFile(invalid, new Uint8Array([1, 2, 3]));
    await expect(runSkillPush(invalid, { api: client, accessToken: "access", environment: {} })).rejects.toMatchObject({
      code: "SKILL_ARCHIVE_INVALID_ARCHIVE",
    });
    const link = join(root, "link");
    await symlink(archive, link);
    await expect(runSkillPush(link, { api: client, accessToken: "access", environment: {} })).rejects.toMatchObject({
      code: "SKILL_SOURCE_INVALID",
    });
    await expect(
      runSkillPush(join(root, "empty"), { api: client, accessToken: "access", environment: {} }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.uploadSkill).toHaveBeenCalledTimes(1);
  });

  it("publishes through the Session endpoint inside an Agent Session", async () => {
    const skill = await skillDirectory();
    const client = api();
    const sessionApi = {
      uploadSessionSkill: vi
        .fn()
        .mockResolvedValue({ ...summary, manifest: { schemaVersion: 1, name: "demo", files: [] } }),
    };
    const environment = { OPENTAG_SESSION_PROOF_FILE: "/proof.json", OPENTAG_SESSION_ID: "session-env" };
    const result = await runSkillPush(skill, { environment, sessionApi, sessionProof: "proof-token", replace: true });
    expect(result).toMatchObject({ via: "session" });
    expect(sessionApi.uploadSessionSkill).toHaveBeenCalledWith("proof-token", "session-env", expect.any(Uint8Array), {
      onConflict: "replace",
    });
    expect(formatSkillPushed(result)).toContain("through the current Session");
    await runSkillPush(skill, { environment, sessionApi, sessionProof: "proof-token", session: "session-flag" });
    expect(sessionApi.uploadSessionSkill.mock.calls[1]?.[1]).toBe("session-flag");
    await expect(
      runSkillPush(skill, {
        environment: { OPENTAG_SESSION_PROOF_FILE: "/proof.json" },
        sessionApi,
        sessionProof: "p",
      }),
    ).rejects.toMatchObject({ code: "SKILL_SESSION_REQUIRED", category: "validation" });
    await expect(
      runSkillPush(skill, {
        environment: { OPENTAG_SESSION_PROOF_FILE: "/missing-proof.json", OPENTAG_SESSION_ID: "s" },
      }),
    ).rejects.toThrow();
    expect(client.uploadSkill).not.toHaveBeenCalled();
  });

  it("pulls a skill into <out>/<name> after verifying the archive against the manifest", async () => {
    const skill = await skillDirectory();
    const { bytes, detail } = await packedDetail(skill);
    const client = api(detail);
    client.downloadSkillArchive.mockResolvedValue({ status: 200, bytes });
    const out = await temporaryDirectory();
    const result = await runSkillPull("demo", { api: client, accessToken: "access", out });
    expect(result.directory).toBe(join(out, "demo"));
    expect(await readFile(join(out, "demo", "SKILL.md"), "utf8")).toContain("name: demo");
    expect(await readFile(join(out, "demo", "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\n");
    expect(formatSkillPulled(result)).toContain(`Pulled skill demo into ${join(out, "demo")}`);
    await expect(runSkillPull("demo", { api: client, accessToken: "access", out })).rejects.toMatchObject({
      code: "SKILL_TARGET_EXISTS",
    });

    const other = await temporaryDirectory();
    client.downloadSkillArchive.mockResolvedValueOnce({ status: 304 });
    await expect(runSkillPull("demo", { api: client, accessToken: "access", out: other })).rejects.toMatchObject({
      code: "SKILL_ARCHIVE_UNAVAILABLE",
    });
    client.downloadSkillArchive.mockResolvedValueOnce({ status: 200, bytes: new Uint8Array([...bytes, 0]) });
    await expect(runSkillPull("demo", { api: client, accessToken: "access", out: other })).rejects.toMatchObject({
      code: "SKILL_ARCHIVE_CHECKSUM_MISMATCH",
    });
    client.getSkill.mockResolvedValueOnce({ ...detail, digest: "0".repeat(64) });
    client.downloadSkillArchive.mockResolvedValueOnce({ status: 200, bytes });
    await expect(runSkillPull("demo", { api: client, accessToken: "access", out: other })).rejects.toMatchObject({
      rejection: "digest-mismatch",
    });
    await expect(readFile(join(other, "demo", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes only after confirmation or --yes", async () => {
    const client = api();
    await expect(runSkillDelete("demo", { api: client, accessToken: "access", yes: true })).resolves.toBe(
      "Deleted skill demo",
    );
    const cancelled = await runSkillDelete("demo", {
      api: client,
      accessToken: "access",
      confirm: async () => false,
    }).catch((error) => error);
    expect(cancelled).toMatchObject({ code: "SKILL_DELETE_CANCELLED" });
    expect(commandExitCode(cancelled as CommandError)).toBe(EXIT_CODES.interrupted);
    await expect(
      runSkillDelete("demo", { api: client, accessToken: "access", confirm: async () => true }),
    ).resolves.toBe("Deleted skill demo");
    expect(client.deleteSkill).toHaveBeenCalledTimes(2);
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(runSkillDelete("demo", { api: client, accessToken: "access" })).rejects.toMatchObject({
        code: "SKILL_DELETE_UNCONFIRMED",
      });
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });

  it("replaces an Agent's skill set by id or by name", async () => {
    const client = api();
    const response: AgentSkillsResponse = { agentId, digest: "c".repeat(64), skills: [summary] };
    client.replaceAgentSkills.mockResolvedValue(response);
    await expect(runSkillAssign(agentId, { api: client, accessToken: "access", set: ["demo"] })).resolves.toEqual(
      response,
    );
    expect(client.replaceAgentSkills).toHaveBeenCalledWith("access", agentId, { skillNames: ["demo"] });
    expect(client.listAgents).not.toHaveBeenCalled();
    await runSkillAssign("code-reviewer", { api: client, accessToken: "access", set: [] });
    expect(client.replaceAgentSkills).toHaveBeenLastCalledWith("access", agentId, { skillNames: [] });
    await expect(runSkillAssign("missing", { api: client, accessToken: "access", set: [] })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    await expect(
      runSkillAssign(agentId, { api: client, accessToken: "access", set: ["demo", "demo"] }),
    ).rejects.toThrow();
    expect(formatAgentSkills(response)).toBe(`Agent ${agentId} now has demo (digest ${"c".repeat(64)})`);
    expect(formatAgentSkills({ ...response, skills: [] })).toContain("now has no skills");
  });
});

describe("skill CLI commands", () => {
  it("registers every skill subcommand", () => {
    const skill = createProgram().commands.find((command) => command.name() === "skill");
    expect(skill?.commands.map((command) => command.name())).toEqual([
      "list",
      "show",
      "push",
      "pull",
      "delete",
      "assign",
    ]);
    expect(skill?.commands.find((command) => command.name() === "push")?.helpInformation()).toContain("--session");
  });

  it("routes each subcommand through the shared result policy", async () => {
    const list = vi.spyOn(skillQueries, "runSkillList").mockResolvedValue({ skills: [summary], nextCursor: null });
    const show = vi.spyOn(skillQueries, "runSkillShow").mockResolvedValue("# demo");
    const pull = vi.spyOn(skillQueries, "runSkillPull").mockResolvedValue({
      skill: { ...summary, manifest: { schemaVersion: 1, name: "demo", files: [] } },
      directory: "/tmp/demo",
    });
    const push = vi.spyOn(skillMutations, "runSkillPush").mockResolvedValue({
      skill: { ...summary, manifest: { schemaVersion: 1, name: "demo", files: [] } },
      source: "directory",
      via: "account",
    });
    const remove = vi.spyOn(skillMutations, "runSkillDelete").mockResolvedValue("Deleted skill demo");
    const assign = vi
      .spyOn(skillMutations, "runSkillAssign")
      .mockRejectedValue(
        new CommandError(
          { code: "AGENT_NOT_FOUND", category: "validation", retryability: "never", phase: "validation" },
          "no",
        ),
      );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = createProgram();
      await program.parseAsync(["node", "opentag", "skill", "list", "--json"]);
      expect(list).toHaveBeenCalledOnce();
      expect(stdout.mock.calls.at(-1)?.[0]).toContain('"ok":true');
      await program.parseAsync(["node", "opentag", "skill", "show", "demo"]);
      expect(show).toHaveBeenCalledWith("demo");
      expect(stdout.mock.calls.at(-1)?.[0]).toBe("# demo\n");
      await program.parseAsync(["node", "opentag", "skill", "push", "./demo", "--replace", "--session", "s-1"]);
      expect(push).toHaveBeenCalledWith("./demo", { replace: true, session: "s-1" });
      expect(stdout.mock.calls.at(-1)?.[0]).toContain("Pushed skill demo");
      await program.parseAsync(["node", "opentag", "skill", "pull", "demo", "--out", "/tmp"]);
      expect(pull).toHaveBeenCalledWith("demo", { out: "/tmp" });
      expect(stdout.mock.calls.at(-1)?.[0]).toContain("Pulled skill demo into /tmp/demo");
      await program.parseAsync(["node", "opentag", "skill", "delete", "demo", "--yes"]);
      expect(remove).toHaveBeenCalledWith("demo", { yes: true });
      expect(process.exitCode).toBe(EXIT_CODES.success);
      await program.parseAsync(["node", "opentag", "skill", "assign", "reviewer", "--set", "demo", "other", "--json"]);
      expect(assign).toHaveBeenCalledWith("reviewer", { set: ["demo", "other"] });
      expect(stderr.mock.calls.at(-1)?.[0]).toContain('"code":"AGENT_NOT_FOUND"');
      expect(process.exitCode).toBe(EXIT_CODES.usage);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
