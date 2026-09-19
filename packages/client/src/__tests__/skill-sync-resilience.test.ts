import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, symlink, utimes } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenTagApi } from "../index.js";
import { SkillSyncManager } from "../skills/skill-sync.js";
import {
  buildSkill,
  cleanupSkillSyncHarness,
  fakeApi,
  type LogRecord,
  managerFor,
  manifestEntry,
  recordingLogger,
  registerServer,
  temporaryRoot,
} from "./support/skill-sync-harness.js";

afterEach(cleanupSkillSyncHarness);

describe("Skill sync resilience", () => {
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
    registerServer(server);
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
    expect(await readFile(join(installed, "SKILL.md"), "utf8")).toContain("my-skill");

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
    expect(await readFile(join(installed, "SKILL.md"), "utf8")).toContain("my-skill");
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

  it("keeps the old Skill when a hash-matching bundle cannot be extracted", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const good = await buildSkill(root, "my-skill", "# One\n");
    const oldEntry = manifestEntry(good, "my-skill");
    const { api: okApi } = fakeApi([{ skills: [oldEntry] }], new Map([[oldEntry.id, good.archive]]));
    await managerFor(okApi, []).ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    const installed = join(cwd, ".claude", "skills", "my-skill", "SKILL.md");
    expect(await readFile(installed, "utf8")).toContain("# One");

    // Size and sha match the manifest, but the bytes are not a tar.gz.
    const garbage = Buffer.from("not a gzip at all");
    const badEntry = {
      id: oldEntry.id,
      name: "my-skill",
      archiveSha256: createHash("sha256").update(garbage).digest("hex"),
      archiveBytes: garbage.byteLength,
    };
    const { api: badApi } = fakeApi([{ skills: [badEntry] }], new Map([[badEntry.id, new Uint8Array(garbage)]]));
    const records: LogRecord[] = [];
    const result = await managerFor(badApi, records).ensureAgent({
      agentId: randomUUID(),
      cwd,
      provider: "claude-code",
    });

    expect(result.status).toBe("unavailable");
    expect(result.skillPaths).toEqual([join(cwd, ".claude", "skills", "my-skill")]);
    expect(await readFile(installed, "utf8")).toContain("# One");
    expect(records.some((record) => record.fields.code === "skill_sync_unavailable")).toBe(true);
  });

  it("restores the old Skill when the staged rename into place fails", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const good = await buildSkill(root, "my-skill", "# One\n");
    const oldEntry = manifestEntry(good, "my-skill");
    const { api: okApi } = fakeApi([{ skills: [oldEntry] }], new Map([[oldEntry.id, good.archive]]));
    await managerFor(okApi, []).ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });
    const installed = join(cwd, ".claude", "skills", "my-skill", "SKILL.md");

    const updated = await buildSkill(root, "my-skill", "# Two\n");
    const newEntry = manifestEntry(updated, "my-skill");
    const { api: newApi } = fakeApi([{ skills: [newEntry] }], new Map([[newEntry.id, updated.archive]]));
    const records: LogRecord[] = [];
    const manager = new SkillSyncManager({
      api: newApi as never,
      machineToken: async () => "machine-token",
      logger: recordingLogger(records),
      rename: async (from, to) => {
        if (String(to).endsWith(`skills/my-skill`)) throw new Error("injected rename failure");
        await rename(from, to);
      },
    });
    const result = await manager.ensureAgent({ agentId: randomUUID(), cwd, provider: "claude-code" });

    expect(result.status).toBe("unavailable");
    expect(result.skillPaths).toEqual([join(cwd, ".claude", "skills", "my-skill")]);
    expect(await readFile(installed, "utf8")).toContain("# One");
  });

  it("stages outside the discovered skill root and sweeps only long-abandoned staging", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const stagingRoot = join(cwd, ".opentag", "skill-staging");
    await mkdir(join(stagingRoot, "abandoned"), { recursive: true });
    await mkdir(join(stagingRoot, "slow-concurrent"), { recursive: true });
    await mkdir(join(stagingRoot, "fresh"), { recursive: true });
    const abandoned = new Date(Date.now() - 11 * 60_000);
    await utimes(join(stagingRoot, "abandoned"), abandoned, abandoned);
    const slow = new Date(Date.now() - 60_000);
    await utimes(join(stagingRoot, "slow-concurrent"), slow, slow);

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
    // A slow concurrent install outlives the sync budget; only abandoned staging is swept.
    expect((await readdir(stagingRoot)).sort()).toEqual(["fresh", "slow-concurrent"]);
  });
});
