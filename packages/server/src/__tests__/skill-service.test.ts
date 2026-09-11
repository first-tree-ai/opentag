import { computeAgentSkillsDigest, SKILLS_PER_ACCOUNT_MAX, SkillDetailSchema } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import type { DatabaseClient } from "../db/client.js";
import { agentSkills, agents, skillFiles, skills, users } from "../db/schema/index.js";
import { MemorySkillBlobStore, SkillService, type UpsertSkillOptions } from "../services/skills/index.js";
import { buildSkillZip, skillMarkdown, validSkillZip } from "./support/skill-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unitDatabase: UnitDatabase;
let database: DatabaseClient;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
  database = unitDatabase.database;
}, 60_000);

afterAll(async () => unitDatabase?.close());

beforeEach(async () => unitDatabase.reset());

async function account(email = "owner@example.com") {
  const { userId } = await bootstrapInitialAdmin(database, { displayName: email, email });
  return userId;
}

async function otherAccount(email = "other@example.com") {
  const [user] = await database.insert(users).values({ displayName: email, email }).returning();
  if (!user) throw new Error("user fixture");
  return user.id;
}

async function agent(ownerId: string, name = "assistant") {
  const [row] = await database
    .insert(agents)
    .values({ createdByUserId: ownerId, name, displayName: name, runtimeProvider: "codex" })
    .returning();
  if (!row) throw new Error("agent fixture");
  return row.id;
}

function byUser(userId: string, overrides: Partial<UpsertSkillOptions> = {}): UpsertSkillOptions {
  return { onConflict: "fail", updatedBy: { kind: "user", id: userId }, ...overrides };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("SkillService", () => {
  it("creates a skill, stores the archive content-addressed, and returns a schema-valid detail", async () => {
    const owner = await account();
    const store = new MemorySkillBlobStore();
    const service = new SkillService(database, store);
    const result = await service.upsertFromArchive(owner, validSkillZip("my-skill"), byUser(owner));
    expect(result.created).toBe(true);
    expect(result.affectedAgentIds).toEqual([]);
    expect(SkillDetailSchema.parse(result.skill)).toEqual(result.skill);
    expect(result.skill).toMatchObject({
      name: "my-skill",
      description: "Does something useful",
      fileCount: 2,
      agentCount: 0,
      updatedBy: { kind: "user", id: owner },
    });
    const [row] = await database.select().from(skills).where(eq(skills.ownerAccountId, owner));
    expect(row?.archiveKey).toBe(`${owner}/${row?.id}/${result.skill.digest}.zip`);
    expect(store.objects.get(row?.archiveKey ?? "")?.sha256).toBe(result.skill.archiveSha256);
    expect(row?.skillMd.startsWith("---\nname: my-skill")).toBe(true);
    expect(
      await database
        .select()
        .from(skillFiles)
        .where(eq(skillFiles.skillId, row?.id ?? "")),
    ).toHaveLength(2);
  });

  it("refuses a same-name upload by default and replaces it in place on request", async () => {
    const owner = await account();
    const store = new MemorySkillBlobStore();
    const service = new SkillService(database, store);
    const first = await service.upsertFromArchive(owner, validSkillZip("my-skill"), byUser(owner));
    const [firstRow] = await database.select().from(skills);
    await expect(service.upsertFromArchive(owner, validSkillZip("my-skill"), byUser(owner))).rejects.toMatchObject({
      code: "SKILL_ALREADY_EXISTS",
      statusCode: 409,
    });
    expect(store.objects.size).toBe(1);

    const changed = validSkillZip("my-skill", { "references/new.md": "# New" });
    const second = await service.upsertFromArchive(owner, changed, byUser(owner, { onConflict: "replace" }));
    const [secondRow] = await database.select().from(skills);
    expect(second.created).toBe(false);
    expect(secondRow?.id).toBe(firstRow?.id);
    expect(second.skill.digest).not.toBe(first.skill.digest);
    expect(second.skill.fileCount).toBe(3);
    expect(store.objects.size).toBe(1);
    expect(store.objects.has(firstRow?.archiveKey ?? "")).toBe(false);
    expect(store.objects.has(secondRow?.archiveKey ?? "")).toBe(true);
    expect((await service.list(owner, { limit: 50 })).skills).toHaveLength(1);
  });

  it("keeps the database untouched and removes the new object when the write fails", async () => {
    const owner = await account();
    const store = new MemorySkillBlobStore();
    const service = new SkillService(database, store);
    await expect(
      service.upsertFromArchive(owner, validSkillZip("my-skill"), {
        ...byUser(owner),
        autoAssignAgentId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(await database.select().from(skills)).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it("lists by name with cursor pagination and hides other accounts' skills", async () => {
    const owner = await account();
    const other = await otherAccount();
    const service = new SkillService(database, new MemorySkillBlobStore());
    for (const name of ["charlie", "alpha", "bravo"]) {
      await service.upsertFromArchive(owner, validSkillZip(name), byUser(owner));
    }
    await service.upsertFromArchive(other, validSkillZip("alpha"), byUser(other));
    const first = await service.list(owner, { limit: 2 });
    expect(first.skills.map((skill) => skill.name)).toEqual(["alpha", "bravo"]);
    expect(first.nextCursor).toBe("bravo");
    const second = await service.list(owner, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.skills.map((skill) => skill.name)).toEqual(["charlie"]);
    expect(second.nextCursor).toBeNull();
    expect((await service.list(other, { limit: 50 })).skills.map((skill) => skill.name)).toEqual(["alpha"]);
    await expect(service.get(other, "bravo")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND", statusCode: 404 });
    await expect(service.getSkillMd(other, "bravo")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    await expect(service.openArchive(other, "bravo")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    await expect(service.delete(other, "bravo")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("returns only SKILL.md text and streams the canonical archive that unpacks to the same files", async () => {
    const owner = await account();
    const service = new SkillService(database, new MemorySkillBlobStore());
    const upload = validSkillZip("my-skill", { "references/secret.md": "internal" });
    await service.upsertFromArchive(owner, upload, byUser(owner));
    const markdown = await service.getSkillMd(owner, "my-skill");
    expect(markdown).toEqual({ name: "my-skill", markdown: skillMarkdown("my-skill") });
    const archive = await service.openArchive(owner, "my-skill");
    const opened = await archive.open();
    const bytes = await collect(opened.stream);
    expect(bytes.byteLength).toBe(opened.contentLength);
    expect(bytes.byteLength).toBe(archive.archiveBytes);
    const unpacked = unzipSync(new Uint8Array(bytes));
    expect(Object.keys(unpacked)).toEqual(["SKILL.md", "references/secret.md", "scripts/run.sh"]);
    expect(new TextDecoder().decode(unpacked["references/secret.md"])).toBe("internal");
  });

  it("deletes the row, cascades files and assignments, removes the object, and reports affected agents", async () => {
    const owner = await account();
    const agentId = await agent(owner);
    const store = new MemorySkillBlobStore();
    const service = new SkillService(database, store);
    const { skill } = await service.upsertFromArchive(owner, validSkillZip("my-skill"), {
      ...byUser(owner),
      autoAssignAgentId: agentId,
    });
    expect(skill.agentCount).toBe(1);
    const result = await service.delete(owner, "my-skill");
    expect(result.affectedAgentIds).toEqual([agentId]);
    expect(await database.select().from(skills)).toHaveLength(0);
    expect(await database.select().from(skillFiles)).toHaveLength(0);
    expect(await database.select().from(agentSkills)).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it("auto-assigns in-session uploads to the pushing agent and records the session as the author", async () => {
    const owner = await account();
    const agentId = await agent(owner);
    const service = new SkillService(database, new MemorySkillBlobStore());
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const result = await service.upsertFromArchive(owner, validSkillZip("pushed"), {
      onConflict: "fail",
      updatedBy: { kind: "session", id: sessionId },
      autoAssignAgentId: agentId,
    });
    expect(result.affectedAgentIds).toEqual([agentId]);
    expect(result.skill.updatedBy).toEqual({ kind: "session", id: sessionId });
    expect(result.skill.agentCount).toBe(1);
    const rows = await database.select().from(agentSkills);
    expect(rows).toEqual([expect.objectContaining({ agentId })]);
    const replaced = await service.upsertFromArchive(owner, validSkillZip("pushed", { "x.txt": "1" }), {
      onConflict: "replace",
      updatedBy: { kind: "session", id: sessionId },
      autoAssignAgentId: agentId,
    });
    expect(replaced.affectedAgentIds).toEqual([agentId]);
    expect(await database.select().from(agentSkills)).toHaveLength(1);
    expect(computeAgentSkillsDigest([{ name: "pushed", digest: replaced.skill.digest }])).not.toBe(
      computeAgentSkillsDigest([{ name: "pushed", digest: result.skill.digest }]),
    );
  });

  it("rejects an agent from another account as the auto-assignment target", async () => {
    const owner = await account();
    const other = await otherAccount();
    const foreignAgent = await agent(other, "foreign");
    const service = new SkillService(database, new MemorySkillBlobStore());
    await expect(
      service.upsertFromArchive(owner, validSkillZip("my-skill"), {
        ...byUser(owner),
        autoAssignAgentId: foreignAgent,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("enforces the per-account quota and lets replacement through at the limit", async () => {
    const owner = await account();
    const service = new SkillService(database, new MemorySkillBlobStore());
    const now = new Date("2026-09-11T00:00:00.000Z");
    await database.insert(skills).values(
      Array.from({ length: SKILLS_PER_ACCOUNT_MAX }, (_, index) => ({
        ownerAccountId: owner,
        name: `filler-${index}`,
        description: "filler",
        skillMd: "---\nname: filler\ndescription: filler\n---\n",
        digest: "a".repeat(64),
        archiveKey: `${owner}/filler/${index}.zip`,
        archiveBytes: 1,
        archiveSha256: "b".repeat(64),
        fileCount: 1,
        totalBytes: 1,
        updatedByKind: "user" as const,
        updatedById: owner,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await expect(service.upsertFromArchive(owner, validSkillZip("one-more"), byUser(owner))).rejects.toMatchObject({
      code: "SKILL_QUOTA_EXCEEDED",
      statusCode: 400,
    });
    await expect(
      service.upsertFromArchive(owner, validSkillZip("filler-3"), byUser(owner, { onConflict: "replace" })),
    ).resolves.toMatchObject({ created: false });
  });

  it("surfaces archive validation failures without touching storage or the database", async () => {
    const owner = await account();
    const store = new MemorySkillBlobStore();
    const service = new SkillService(database, store);
    await expect(
      service.upsertFromArchive(
        owner,
        buildSkillZip({ "../evil": "x", "SKILL.md": skillMarkdown("x") }),
        byUser(owner),
      ),
    ).rejects.toMatchObject({ code: "SKILL_ARCHIVE_INVALID_PATH" });
    expect(store.objects.size).toBe(0);
    expect(await database.select().from(skills)).toHaveLength(0);
  });

  it("logs and continues when the old object cannot be deleted", async () => {
    const owner = await account();
    const store = new MemorySkillBlobStore();
    const failingDelete = vi.spyOn(store, "delete").mockRejectedValue(new Error("s3 down"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new SkillService(database, store, { logger });
    await service.upsertFromArchive(owner, validSkillZip("my-skill"), byUser(owner));
    await service.upsertFromArchive(
      owner,
      validSkillZip("my-skill", { "b.txt": "b" }),
      byUser(owner, { onConflict: "replace" }),
    );
    expect(failingDelete).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ archiveKey: expect.any(String) }),
      expect.stringContaining("sweeper"),
    );
  });
});
