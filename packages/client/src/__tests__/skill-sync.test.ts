import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSkillManifest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenTagApi } from "../index.js";
import type { ClientLogger } from "../observability/logger.js";
import type { PackedSkillDirectory } from "../skills/skill-archive.js";
import { packSkillDirectory } from "../skills/skill-archive.js";
import {
  isSkillMaterializationTarget,
  markSkillDirectoryManaged,
  resolveMaterializationWorkspace,
  SKILL_CONTENT_SIDECAR_FILE,
  SkillSyncManager,
} from "../skills/skill-sync.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-skill-sync-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface LogRecord {
  readonly level: "debug" | "info" | "warn";
  readonly fields: Record<string, unknown>;
}

function recordingLogger(records: LogRecord[]): ClientLogger {
  const logger: ClientLogger = {
    child: () => logger,
    debug: (fields) => records.push({ level: "debug", fields }),
    info: (fields) => records.push({ level: "info", fields }),
    warn: (fields) => records.push({ level: "warn", fields }),
    error: (fields) => records.push({ level: "warn", fields }),
  };
  return logger;
}

async function buildSkill(root: string, name: string, body = "# Body\n"): Promise<PackedSkillDirectory> {
  const directory = join(root, `source-${name}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} description`, "---", "", body].join("\n"),
  );
  return packSkillDirectory(directory);
}

function manifestEntry(packed: PackedSkillDirectory, name: string): RuntimeSkillManifest["skills"][number] {
  return {
    id: randomUUID(),
    name,
    archiveSha256: packed.sha256,
    archiveBytes: packed.archive.byteLength,
  };
}

function fakeApi(
  manifests: RuntimeSkillManifest[],
  bundles: Map<string, Uint8Array>,
  overrides: { manifestError?: unknown; bundleError?: unknown } = {},
): {
  api: {
    getComputerSkillManifest: ReturnType<typeof vi.fn>;
    openComputerSkillBundle: ReturnType<typeof vi.fn>;
  };
  downloads: string[];
} {
  const downloads: string[] = [];
  let call = 0;
  const api = {
    getComputerSkillManifest: vi.fn(async () => {
      if (overrides.manifestError) throw overrides.manifestError;
      const value = manifests[Math.min(call, manifests.length - 1)];
      call += 1;
      return value ?? { skills: [] };
    }),
    openComputerSkillBundle: vi.fn(async (_token: string, _agentId: string, skillId: string) => {
      if (overrides.bundleError) throw overrides.bundleError;
      const bytes = bundles.get(skillId);
      if (!bytes) return new Response("missing", { status: 404 });
      downloads.push(skillId);
      return new Response(bytes, { status: 200 });
    }),
  };
  return { api, downloads };
}

function managerFor(
  api: ReturnType<typeof fakeApi>["api"],
  records: LogRecord[],
  now: () => number = () => 1_700_000_000_000,
): SkillSyncManager {
  return new SkillSyncManager({
    api: api as never,
    machineToken: async () => "machine-token",
    logger: recordingLogger(records),
    now,
  });
}

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

  it("abandons a stalled bundle body once the sync budget elapses", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const entry = { id: randomUUID(), name: "my-skill", archiveSha256: "a".repeat(64), archiveBytes: 1 };
    let bundleClosed = false;
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/bundle")) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write("x");
        response.on("close", () => {
          bundleClosed = true;
        });
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ skills: [entry] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const api = new OpenTagApi(`http://127.0.0.1:${address.port}`);
    const records: LogRecord[] = [];
    const manager = new SkillSyncManager({
      api: api as never,
      machineToken: async () => "machine-token",
      logger: recordingLogger(records),
      budgetMs: 150,
      now: () => Date.now(),
    });

    const started = Date.now();
    const result = await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    const elapsed = Date.now() - started;

    expect(result.status).toBe("unavailable");
    expect(elapsed).toBeLessThan(1_000);
    expect(records.some((record) => record.fields.code === "skill_sync_unavailable")).toBe(true);
    await vi.waitFor(() => expect(bundleClosed).toBe(true));
  });

  it("refuses a symlinked skills root without deleting another workspace's Skills", async () => {
    const root = await temporaryRoot();
    const workspaceB = join(root, "workspace-b");
    await mkdir(workspaceB, { recursive: true });
    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const { api: apiB } = fakeApi([{ skills: [entry] }], new Map([[entry.id, packed.archive]]));
    await managerFor(apiB, []).ensureAgent({ agentId: randomUUID(), cwd: workspaceB, provider: "codex" });
    const installed = join(workspaceB, ".agents", "skills", "my-skill");
    expect(await stat(join(installed, "SKILL.md"))).toBeDefined();

    const workspaceA = join(root, "workspace-a");
    await mkdir(join(workspaceA, ".agents"), { recursive: true });
    await symlink(join(workspaceB, ".agents", "skills"), join(workspaceA, ".agents", "skills"));

    const { api: apiA } = fakeApi([{ skills: [] }], new Map());
    const records: LogRecord[] = [];
    const result = await managerFor(apiA, records).ensureAgent({
      agentId: randomUUID(),
      cwd: workspaceA,
      provider: "codex",
    });

    expect(result.status).toBe("unavailable");
    expect(result.skillPaths).toEqual([]);
    expect(await stat(join(installed, "SKILL.md"))).toBeDefined();
    expect(records.some((record) => record.fields.code === "skill_root_unsafe")).toBe(true);
  });

  it("refuses a symlinked provider parent directory", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(workspace, ".agents"));

    const { api } = fakeApi([{ skills: [] }], new Map());
    const records: LogRecord[] = [];
    const result = await managerFor(api, records).ensureAgent({
      agentId: randomUUID(),
      cwd: workspace,
      provider: "codex",
    });
    expect(result.status).toBe("unavailable");
    expect(records.some((record) => record.fields.code === "skill_root_unsafe")).toBe(true);
  });

  it("refuses a symlinked .opentag staging parent", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(workspace, ".opentag"));

    const { api } = fakeApi([{ skills: [] }], new Map());
    const records: LogRecord[] = [];
    const result = await managerFor(api, records).ensureAgent({
      agentId: randomUUID(),
      cwd: workspace,
      provider: "claude-code",
    });
    expect(result.status).toBe("unavailable");
    expect(records.some((record) => record.fields.code === "skill_root_unsafe")).toBe(true);
  });

  it("stages outside the discovered skill root and sweeps stale staging only", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const stagingRoot = join(cwd, ".opentag", "skill-staging");
    await mkdir(join(stagingRoot, "stale"), { recursive: true });
    await mkdir(join(stagingRoot, "fresh"), { recursive: true });
    const past = new Date(Date.now() - 60_000);
    await utimes(join(stagingRoot, "stale"), past, past);

    const packed = await buildSkill(root, "my-skill");
    const entry = manifestEntry(packed, "my-skill");
    const { api } = fakeApi([{ skills: [entry] }], new Map([[entry.id, packed.archive]]));
    await managerFor(api, [], () => Date.now()).ensureAgent({
      agentId: randomUUID(),
      cwd,
      provider: "claude-code",
    });

    const skills = await readdir(join(cwd, ".claude", "skills"));
    expect(skills).toEqual(["my-skill"]);
    expect(await readdir(stagingRoot)).toEqual(["fresh"]);
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
});
