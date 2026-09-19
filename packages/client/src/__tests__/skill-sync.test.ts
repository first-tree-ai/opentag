import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSkillMaterializationTarget,
  markSkillDirectoryManaged,
  resolveMaterializationWorkspace,
  SKILL_CONTENT_SIDECAR_FILE,
} from "../skills/skill-sync.js";
import {
  buildSkill,
  cleanupSkillSyncHarness,
  fakeApi,
  type LogRecord,
  managerFor,
  manifestEntry,
  temporaryRoot,
} from "./support/skill-sync-harness.js";

afterEach(cleanupSkillSyncHarness);

async function readSkillName(directory: string): Promise<string> {
  const markdown = await readFile(join(directory, "SKILL.md"), "utf8");
  return /name:\s*(.+)/u.exec(markdown)?.[1]?.trim() ?? "";
}

describe("SkillSyncManager", () => {
  it("installs a fresh Skill into the Claude Code root and skips an unchanged one", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const { api, downloads } = fakeApi([{ skills: [entry] }], new Map([[entry.id, packed.archive]]));
    const records: LogRecord[] = [];
    const manager = managerFor(api, records);

    const first = await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    expect(first.status).toBe("synced");
    expect(first.skillPaths).toEqual([join(cwd, ".claude", "skills", "my-skill")]);
    expect(await readSkillName(join(cwd, ".claude", "skills", "my-skill"))).toBe("my-skill");
    expect(downloads).toHaveLength(1);

    const second = await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    expect(second.status).toBe("synced");
    expect(downloads).toHaveLength(1);
    expect(records.some((record) => record.fields.code === "skill_sync_skip")).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "materializes a runnable script and does not report it as edited on the next sync",
    async () => {
      const root = await temporaryRoot();
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const packed = await buildSkill(root, "my-skill", "# Body\n", {
        "scripts/run.sh": "#!/bin/sh\necho synced\n",
      });
      const entry = manifestEntry(packed, "my-skill");
      const { api } = fakeApi([{ skills: [entry] }], new Map([[entry.id, packed.archive]]));
      const records: LogRecord[] = [];
      const manager = managerFor(api, records);

      await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
      const script = join(cwd, ".claude", "skills", "my-skill", "scripts", "run.sh");
      expect((await lstat(script)).mode & 0o777).toBe(0o700);
      expect(execFileSync(script, { encoding: "utf8" }).trim()).toBe("synced");

      // Mode normalization must not make the digest look edited, or the copy is quarantined.
      const second = await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
      expect(second.status).toBe("synced");
      expect(second.skillPaths).toEqual([join(cwd, ".claude", "skills", "my-skill")]);
      expect(records.some((record) => record.fields.code === "skill_conflict_quarantined")).toBe(false);
      await expect(stat(join(cwd, ".opentag", "skill-conflicts"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("replaces a managed Skill when the platform version changes", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const first = await buildSkill(root, "my-skill", "# One\n");
    const second = await buildSkill(root, "my-skill", "# Two\n");
    const firstEntry = manifestEntry(first, "my-skill");
    const secondEntry = manifestEntry(second, "my-skill");
    const bundles = new Map([
      [firstEntry.id, first.archive],
      [secondEntry.id, second.archive],
    ]);
    const { api } = fakeApi([{ skills: [firstEntry] }, { skills: [secondEntry] }], bundles);
    const manager = managerFor(api, []);

    await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    expect(await readFile(join(cwd, ".claude", "skills", "my-skill", "SKILL.md"), "utf8")).toContain("# Two");
  });

  it("removes a managed directory whose Skill left the manifest", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const { api } = fakeApi([{ skills: [entry] }, { skills: [] }], new Map([[entry.id, packed.archive]]));
    const manager = managerFor(api, []);
    await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    const target = join(cwd, ".claude", "skills", "my-skill");
    expect(await stat(target)).toBeDefined();

    const result = await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    expect(result.skillPaths).toEqual([]);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never reads, modifies, or removes an unmanaged directory", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    const authored = join(cwd, ".claude", "skills", "my-skill");
    await mkdir(authored, { recursive: true });
    await writeFile(join(authored, "SKILL.md"), "authored\n");
    const before = (await stat(authored)).mtimeMs;
    const beforeFiles = await readdir(authored);
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const { api, downloads } = fakeApi([{ skills: [entry] }], new Map([[entry.id, packed.archive]]));
    const records: LogRecord[] = [];
    const manager = managerFor(api, records);

    const result = await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    expect(downloads).toHaveLength(0);
    expect(await readFile(join(authored, "SKILL.md"), "utf8")).toBe("authored\n");
    expect(await readdir(authored)).toEqual(beforeFiles);
    expect((await stat(authored)).mtimeMs).toBe(before);
    expect(records.some((record) => record.fields.code === "skill_name_shadowed_locally")).toBe(true);
    expect(result.skillPaths).toEqual([]);
  });

  it("quarantines a locally edited managed directory when the platform version changes", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const first = await buildSkill(root, "my-skill", "# One\n");
    const second = await buildSkill(root, "my-skill", "# Two\n");
    const firstEntry = manifestEntry(first, "my-skill");
    const secondEntry = manifestEntry(second, "my-skill");
    const bundles = new Map([
      [firstEntry.id, first.archive],
      [secondEntry.id, second.archive],
    ]);
    const { api } = fakeApi([{ skills: [firstEntry] }, { skills: [secondEntry] }], bundles);
    const records: LogRecord[] = [];
    const manager = managerFor(api, records);
    await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    const target = join(cwd, ".claude", "skills", "my-skill", "SKILL.md");
    await writeFile(target, "locally edited\n");

    await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    expect(await readFile(target, "utf8")).toContain("# Two");
    const conflicts = await readdir(join(cwd, ".opentag", "skill-conflicts"));
    expect(conflicts).toHaveLength(1);
    expect(records.some((record) => record.fields.code === "skill_conflict_quarantined")).toBe(true);
  });

  it("keeps the old copy and warns when a bundle hash does not match", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const good = await buildSkill(root, "my-skill", "# One\n");
    const entry = manifestEntry(good, "my-skill");
    const { api } = fakeApi([{ skills: [entry] }], new Map([[entry.id, good.archive]]));
    const manager = managerFor(api, []);
    await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });

    const badEntry = { ...entry, archiveSha256: "0".repeat(64) };
    const { api: badApi } = fakeApi([{ skills: [badEntry] }], new Map([[badEntry.id, good.archive]]));
    const records: LogRecord[] = [];
    const badManager = managerFor(badApi, records);
    const result = await badManager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    expect(result.status).toBe("unavailable");
    expect(await readFile(join(cwd, ".claude", "skills", "my-skill", "SKILL.md"), "utf8")).toContain("# One");
    expect(records.some((record) => record.fields.code === "skill_sync_unavailable")).toBe(true);
  });

  it("resolves to the on-disk Skills for every soft failure mode", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const okApi = fakeApi([{ skills: [entry] }], new Map([[entry.id, packed.archive]]));
    await managerFor(okApi.api, []).ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });

    const failures: unknown[] = [
      Object.assign(new Error("not found"), { status: 404 }),
      Object.assign(new Error("storage unavailable"), { status: 503 }),
      Object.assign(new Error("timed out"), { code: "REQUEST_TIMEOUT" }),
      new Error("thrown"),
    ];
    for (const failure of failures) {
      const records: LogRecord[] = [];
      const { api } = fakeApi([{ skills: [entry] }], new Map(), { manifestError: failure });
      const result = await managerFor(api, records).ensureAgent({
        agentId: randomUUID(),
        cwd,
        provider: "claude-code",
      });
      expect(result.status).toBe("unavailable");
      expect(result.skillPaths).toEqual([join(cwd, ".claude", "skills", "my-skill")]);
      expect(records.some((record) => record.fields.code === "skill_sync_unavailable")).toBe(true);
    }
  });

  it("resolves agent-scoped roots per provider and returns Pi skill paths", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const bundles = new Map([[entry.id, packed.archive]]);

    const codex = fakeApi([{ skills: [entry] }], bundles);
    const codexResult = await managerFor(codex.api, []).ensureAgent({
      agentId: randomUUID(),
      cwd,
      provider: "codex",
    });
    expect(codexResult.skillPaths).toEqual([join(cwd, ".agents", "skills", "my-skill")]);
    expect(await stat(join(cwd, ".agents", "skills", "my-skill", "SKILL.md"))).toBeDefined();

    const pi = fakeApi([{ skills: [entry] }], bundles);
    const piResult = await managerFor(pi.api, []).ensureAgent({ agentId: randomUUID(), cwd, provider: "pi" });
    expect(piResult.skillPaths).toEqual([join(cwd, ".opentag", "skills", "my-skill")]);
  });

  it("quarantines local edits when a managed Skill is removed from the manifest", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const target = join(cwd, ".claude", "skills", "my-skill");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "authored\n");
    await markSkillDirectoryManaged(target, { skillId: entry.id, archiveSha256: packed.sha256 });
    await writeFile(join(target, "notes.md"), "unpushed work\n");

    const { api } = fakeApi([{ skills: [] }], new Map());
    const records: LogRecord[] = [];
    const result = await managerFor(api, records).ensureAgent({
      agentId: randomUUID(),
      cwd,
      provider: "claude-code",
    });

    expect(result.status).toBe("synced");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const conflicts = await readdir(join(cwd, ".opentag", "skill-conflicts"));
    expect(conflicts).toHaveLength(1);
    expect(await readFile(join(cwd, ".opentag", "skill-conflicts", conflicts[0] as string, "notes.md"), "utf8")).toBe(
      "unpushed work\n",
    );
    expect(records.some((record) => record.fields.code === "skill_conflict_quarantined")).toBe(true);
  });

  it("still removes an unedited managed Skill when it leaves the manifest", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const target = join(cwd, ".claude", "skills", "my-skill");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "authored\n");
    await markSkillDirectoryManaged(target, { skillId: entry.id, archiveSha256: packed.sha256 });

    const { api } = fakeApi([{ skills: [] }], new Map());
    await managerFor(api, []).ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });

    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(cwd, ".opentag", "skill-conflicts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts a pushed authored directory so a later disable removes it", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const target = join(cwd, ".claude", "skills", "my-skill");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "authored\n");

    expect(isSkillMaterializationTarget(target, "my-skill")).toBe(true);
    expect(isSkillMaterializationTarget(join(root, "elsewhere"), "my-skill")).toBe(false);
    await markSkillDirectoryManaged(target, { skillId: entry.id, archiveSha256: packed.sha256 });
    expect(await stat(join(target, SKILL_CONTENT_SIDECAR_FILE))).toBeDefined();

    const { api } = fakeApi([{ skills: [] }], new Map());
    const result = await managerFor(api, []).ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    expect(result.skillPaths).toEqual([]);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("skill materialization targets", () => {
  it("matches the provider roots by path shape, without an ambient cwd", () => {
    expect(isSkillMaterializationTarget("/workspace/.claude/skills/demo", "demo")).toBe(true);
    expect(isSkillMaterializationTarget("/workspace/.agents/skills/demo", "demo")).toBe(true);
    expect(isSkillMaterializationTarget("/workspace/.opentag/skills/demo", "demo")).toBe(true);
    expect(isSkillMaterializationTarget("/workspace/.claude/skills/other", "demo")).toBe(false);
    expect(isSkillMaterializationTarget("/workspace/skills/demo", "demo")).toBe(false);
    expect(resolveMaterializationWorkspace("/workspace/.agents/skills/demo", "demo")).toBe("/workspace");
    expect(resolveMaterializationWorkspace("/workspace/.agents/skills/other", "demo")).toBeUndefined();
  });
});

describe("hashSkillDirectory", () => {
  it("ignores the marker and sidecar files", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "SKILL.md"), "x");
    const before = await (await import("../skills/skill-sync.js")).hashSkillDirectory(root);
    await writeFile(join(root, ".opentag-skill.json"), "{}");
    await writeFile(join(root, SKILL_CONTENT_SIDECAR_FILE), "digest");
    const after = await (await import("../skills/skill-sync.js")).hashSkillDirectory(root);
    expect(after).toBe(before);
    expect(after).toBe(createHash("sha256").update("f\0SKILL.md\0").update("x").digest("hex"));
  });

  it("hashes content and relative paths only, so a mode change is not a local edit", async () => {
    const root = await temporaryRoot();
    const { hashSkillDirectory } = await import("../skills/skill-sync.js");
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    const executable = await hashSkillDirectory(root);
    await chmod(join(root, "scripts", "run.sh"), 0o600);
    expect(await hashSkillDirectory(root)).toBe(executable);
  });
});
