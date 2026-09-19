import { createHash, randomUUID } from "node:crypto";
import { SKILL_ERROR_CODES, SKILL_MAX_PER_AGENT, type SkillSource } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { agentSkills, agents, computers, users } from "../db/schema/index.js";
import { SkillService, type SkillUploadInput } from "../services/skills/index.js";
import { FakeSkillObjectStore } from "./support/fake-skill-object-store.js";
import { skillManifest, tarGz } from "./support/skill-archive-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  await unit.database.insert(users).values({ id, email: `${id}@example.test`, displayName: "Skill owner" });
  return id;
}

async function createComputer(ownerAccountId: string): Promise<string> {
  const id = randomUUID();
  await unit.database.insert(computers).values({
    id,
    ownerAccountId,
    currentInstallationId: randomUUID(),
    displayName: "Test Computer",
    platform: "darwin",
    arch: "arm64",
    clientVersion: "0.0.0",
  });
  return id;
}

async function createAgent(createdByUserId: string, computerId?: string): Promise<string> {
  const id = randomUUID();
  await unit.database.insert(agents).values({
    id,
    createdByUserId,
    computerId: computerId ?? null,
    name: `skill-agent-${id.slice(0, 8)}`,
    displayName: "Skill Agent",
    runtimeProvider: "pi",
  });
  return id;
}

async function archive(name: string, files: Record<string, string> = {}): Promise<Uint8Array> {
  return tarGz([
    { name: "SKILL.md", body: skillManifest(name) },
    ...Object.entries(files).map(([path, body]) => ({ name: path, body })),
  ]);
}

async function uploadInput(
  service: SkillService,
  accountId: string,
  agentId: string,
  name: string,
  options: { replace?: boolean; source?: SkillSource; files?: Record<string, string>; declared?: string } = {},
) {
  const bytes = await archive(name, options.files ?? {});
  const input: SkillUploadInput = {
    bytes,
    format: "tar.gz",
    declaredSha256: options.declared ?? sha256(bytes),
    replace: options.replace ?? false,
    source: options.source ?? "web_upload",
  };
  return service.upload(accountId, agentId, input);
}

function serviceWith(store?: FakeSkillObjectStore): SkillService {
  return new SkillService({ database: unit.database, ...(store ? { store } : {}), keyPrefix: "skills" });
}

/**
 * Pauses the first terminal `returning()` of an update, delete, or insert so a test can land another
 * writer while that write is in flight. The hook runs once, before the delayed statement executes.
 */
function databasePausingFirstReturning(database: DatabaseClient, beforeReturn: () => Promise<void>): DatabaseClient {
  let armed = true;
  const gate = async () => {
    if (!armed) return;
    armed = false;
    await beforeReturn();
  };
  const wrap = (builder: unknown): unknown =>
    new Proxy(builder as object, {
      get(target, property, receiver) {
        if (property === "returning") {
          return async (...args: unknown[]) => {
            await gate();
            return (target as { returning: (...input: unknown[]) => unknown }).returning(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (...args: unknown[]) => wrap(value.apply(target, args)) : value;
      },
    });
  return new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === "update" || property === "delete" || property === "insert") && typeof value === "function") {
        return (...args: unknown[]) => wrap(value.apply(target, args));
      }
      return value;
    },
  }) as DatabaseClient;
}

async function objectKeyOf(skillId: string): Promise<string | undefined> {
  const [row] = await unit.database
    .select({ objectKey: agentSkills.objectKey })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId))
    .limit(1);
  return row?.objectKey;
}

async function bumpRevision(skillId: string): Promise<void> {
  await unit.database
    .update(agentSkills)
    .set({ revision: sql`${agentSkills.revision} + 1` })
    .where(eq(agentSkills.id, skillId));
}

/** Wraps the client so a Skill row insert fails, exercising the object-cleanup compensation path. */
function failingInsertDatabase(database: DatabaseClient): DatabaseClient {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "insert") {
        return (table: unknown) => {
          if (table === agentSkills) {
            return {
              values: () => ({
                returning: async () => {
                  throw new Error("forced Skill row write failure");
                },
              }),
            };
          }
          const insert = Reflect.get(target, "insert", receiver) as (value: unknown) => unknown;
          return insert.call(target, table);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("SkillService", () => {
  it("makes another Account's or a deleted Agent indistinguishable from missing", async () => {
    const ownerAccount = await createUser();
    const foreignAccount = await createUser();
    const agentId = await createAgent(ownerAccount);
    const service = serviceWith(new FakeSkillObjectStore());

    await expect(service.list(foreignAccount, agentId)).rejects.toMatchObject({ code: SKILL_ERROR_CODES.NOT_FOUND });
    await expect(uploadInput(service, foreignAccount, agentId, "nope")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NOT_FOUND,
    });

    await unit.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, agentId));
    await expect(service.list(ownerAccount, agentId)).rejects.toMatchObject({ code: SKILL_ERROR_CODES.NOT_FOUND });
  });

  it("round-trips upload, list, get, and openBundle", async () => {
    const accountId = await createUser();
    const agentId = await createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = serviceWith(store);

    const detail = await uploadInput(service, accountId, agentId, "round-trip", { files: { "lib/x.txt": "x" } });
    expect(detail).toMatchObject({ name: "round-trip", enabled: true, source: "web_upload", revision: 1 });
    expect(detail.files.map((file) => file.path)).toEqual(["SKILL.md", "lib/x.txt"]);

    expect(await service.list(accountId, agentId)).toMatchObject({ storage: "available" });
    expect((await service.get(accountId, agentId, detail.id)).id).toBe(detail.id);

    const bundle = await service.openBundle(accountId, agentId, detail.id);
    expect(bundle.sha256).toBe(detail.archiveSha256);
    expect(bundle.bytes).toBe(detail.archiveBytes);
    const body = Buffer.from(await new Response(bundle.stream).arrayBuffer());
    expect(sha256(body)).toBe(detail.archiveSha256);
    expect(store.keys()).toHaveLength(1);
  });

  it("rejects a declared sha256 that does not match the received bytes", async () => {
    const accountId = await createUser();
    const agentId = await createAgent(accountId);
    const service = serviceWith(new FakeSkillObjectStore());
    const bytes = await archive("mismatch");
    await expect(
      service.upload(accountId, agentId, {
        bytes,
        format: "tar.gz",
        declaredSha256: sha256(new TextEncoder().encode("other")),
        replace: false,
        source: "web_upload",
      }),
    ).rejects.toMatchObject({ code: SKILL_ERROR_CODES.HASH_MISMATCH });
  });

  it("reports a name conflict and replaces only with the replace flag", async () => {
    const accountId = await createUser();
    const agentId = await createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = serviceWith(store);

    const first = await uploadInput(service, accountId, agentId, "same-name");
    await expect(
      uploadInput(service, accountId, agentId, "same-name", { files: { "a.txt": "a" } }),
    ).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NAME_CONFLICT,
    });

    const replaced = await uploadInput(service, accountId, agentId, "same-name", {
      files: { "b.txt": "b" },
      replace: true,
    });
    expect(replaced.id).toBe(first.id);
    expect(replaced.revision).toBe(first.revision + 1);
    expect(replaced.archiveSha256).not.toBe(first.archiveSha256);
    expect(store.keys()).toHaveLength(1);
    const bundle = await service.openBundle(accountId, agentId, replaced.id);
    expect(bundle.sha256).toBe(replaced.archiveSha256);
  });

  it("deletes the new object when the row write fails", async () => {
    const accountId = await createUser();
    const agentId = await createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = new SkillService({ database: failingInsertDatabase(unit.database), store, keyPrefix: "skills" });

    await expect(uploadInput(service, accountId, agentId, "rollback")).rejects.toThrow(
      "forced Skill row write failure",
    );
    expect(store.puts).toBe(1);
    expect(store.deletes).toBe(1);
    expect(store.keys()).toEqual([]);
  });

  it("enforces the per-Agent limit", async () => {
    const accountId = await createUser();
    const agentId = await createAgent(accountId);
    const max = SKILL_MAX_PER_AGENT;
    for (let index = 0; index < max; index += 1) {
      await unit.database.insert(agentSkills).values({
        agentId,
        name: `skill-${index}`,
        description: "seeded",
        source: "web_upload",
        objectKey: `skills/accounts/${accountId}/agents/${agentId}/skills/${randomUUID()}/${"a".repeat(64)}.tar.gz`,
        archiveSha256: "a".repeat(64),
        archiveBytes: 1,
        fileCount: 1,
      });
    }
    const service = serviceWith(new FakeSkillObjectStore());
    await expect(uploadInput(service, accountId, agentId, "one-too-many")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.LIMIT_REACHED,
    });
  });

  it("reflects enable and disable in the computer manifest and requires the bound computer", async () => {
    const accountId = await createUser();
    const boundComputer = await createComputer(accountId);
    const otherComputer = await createComputer(accountId);
    const agentId = await createAgent(accountId, boundComputer);
    const service = serviceWith(new FakeSkillObjectStore());

    const detail = await uploadInput(service, accountId, agentId, "manifest-skill");
    expect((await service.manifestForComputer(boundComputer, agentId)).skills).toHaveLength(1);

    await service.setEnabled(accountId, agentId, detail.id, false);
    expect((await service.manifestForComputer(boundComputer, agentId)).skills).toEqual([]);
    await service.setEnabled(accountId, agentId, detail.id, true);
    expect((await service.manifestForComputer(boundComputer, agentId)).skills[0]).toMatchObject({
      id: detail.id,
      name: "manifest-skill",
    });

    await expect(service.manifestForComputer(otherComputer, agentId)).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NOT_FOUND,
    });
    const bundle = await service.openBundleForComputer(boundComputer, agentId, detail.id);
    expect(bundle.bytes).toBe(detail.archiveBytes);
  });

  it("tags agent-surface uploads and keeps sibling Agents isolated", async () => {
    const accountId = await createUser();
    const first = await createAgent(accountId);
    const sibling = await createAgent(accountId);
    const service = serviceWith(new FakeSkillObjectStore());

    const bytes = await archive("agent-made");
    const detail = await service.uploadForAgent(first, {
      bytes,
      format: "tar.gz",
      declaredSha256: sha256(bytes),
      replace: false,
    });
    expect(detail.source).toBe("agent_upload");
    expect((await service.listForAgent(first)).skills.map((skill) => skill.name)).toEqual(["agent-made"]);
    expect((await service.listForAgent(sibling)).skills).toEqual([]);
    await expect(service.openBundleForAgent(sibling, "agent-made")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NOT_FOUND,
    });
    const bundle = await service.openBundleForAgent(first, "agent-made");
    expect(bundle.sha256).toBe(detail.archiveSha256);
  });

  it("degrades without storage while row operations keep working", async () => {
    const accountId = await createUser();
    const boundComputer = await createComputer(accountId);
    const agentId = await createAgent(accountId, boundComputer);
    const service = serviceWith();

    await expect(uploadInput(service, accountId, agentId, "no-store")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });

    await unit.database.insert(agentSkills).values({
      agentId,
      name: "row-only",
      description: "seeded",
      source: "cli_upload",
      objectKey: `skills/accounts/${accountId}/agents/${agentId}/skills/${randomUUID()}/${"b".repeat(64)}.tar.gz`,
      archiveSha256: "b".repeat(64),
      archiveBytes: 1,
      fileCount: 1,
    });
    expect(await service.list(accountId, agentId)).toMatchObject({ storage: "unavailable" });
    expect((await service.listForAgent(agentId)).skills).toHaveLength(1);
    expect((await service.manifestForComputer(boundComputer, agentId)).skills).toHaveLength(1);

    const [row] = await service.list(accountId, agentId).then((response) => response.skills);
    expect(row).toBeDefined();
    const skillId = row?.id as string;
    expect((await service.get(accountId, agentId, skillId)).name).toBe("row-only");
    await expect(service.openBundle(accountId, agentId, skillId)).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });
    await expect(service.openBundleForComputer(boundComputer, agentId, skillId)).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });
    await expect(service.openBundleForAgent(agentId, "row-only")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });

    expect((await service.setEnabled(accountId, agentId, skillId, false)).enabled).toBe(false);
    await service.remove(accountId, agentId, skillId);
    expect((await service.list(accountId, agentId)).skills).toEqual([]);
  });

  it("keeps the object when the replacement content is identical", async () => {
    const accountId = await createUser();
    const agentId = await createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = serviceWith(store);

    const first = await uploadInput(service, accountId, agentId, "same-bytes");
    const replaced = await uploadInput(service, accountId, agentId, "same-bytes", { replace: true });
    expect(replaced.revision).toBe(first.revision + 1);
    expect(replaced.archiveSha256).toBe(first.archiveSha256);
    expect(store.keys()).toHaveLength(1);
    const bundle = await service.openBundle(accountId, agentId, replaced.id);
    expect(bundle.sha256).toBe(replaced.archiveSha256);
    expect(bundle.bytes).toBe(replaced.archiveBytes);
  });

  it("leaves the row's object intact when a replace races another writer", async () => {
    const accountId = await createUser();
    const agentId = await createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const original = await uploadInput(serviceWith(store), accountId, agentId, "race");
    const originalKey = (await objectKeyOf(original.id)) as string;

    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalPause!: () => void;
    const pauseReached = new Promise<void>((resolve) => {
      signalPause = resolve;
    });
    const database = databasePausingFirstReturning(unit.database, async () => {
      signalPause();
      await paused;
    });
    const service = new SkillService({ database, store, keyPrefix: "skills" });

    // A reads revision 1 and writes a new key, but its row update is held just before it executes.
    const winner = uploadInput(service, accountId, agentId, "race", { replace: true, files: { "a.txt": "a" } });
    await pauseReached;
    // B re-uploads the ORIGINAL content while A is held; it lands on the original key.
    const late = await uploadInput(service, accountId, agentId, "race", { replace: true });
    release();
    await expect(winner).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NAME_CONFLICT,
      message: expect.stringContaining("concurrently"),
    });

    expect(late.archiveSha256).toBe(original.archiveSha256);
    expect(await objectKeyOf(original.id)).toBe(originalKey);
    expect(store.stored(originalKey)).toBeDefined();
    expect(store.keys()).toEqual([originalKey]);
  });

  it("rejects a stale setEnabled and a stale remove", async () => {
    for (const operation of ["setEnabled", "remove"] as const) {
      const accountId = await createUser();
      const agentId = await createAgent(accountId);
      const store = new FakeSkillObjectStore();
      const seeded = await uploadInput(
        serviceWith(store),
        accountId,
        agentId,
        operation === "setEnabled" ? "stale-enable" : "stale-remove",
      );

      let signalRevved!: () => void;
      const revved = new Promise<void>((resolve) => {
        signalRevved = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const database = databasePausingFirstReturning(unit.database, async () => {
        await bumpRevision(seeded.id);
        signalRevved();
        await held;
      });
      const service = new SkillService({ database, store, keyPrefix: "skills" });

      const call =
        operation === "setEnabled"
          ? service.setEnabled(accountId, agentId, seeded.id, false)
          : service.remove(accountId, agentId, seeded.id);
      const outcome = expect(call).rejects.toMatchObject({
        code: SKILL_ERROR_CODES.NAME_CONFLICT,
        message: expect.stringContaining("concurrently"),
      });
      await revved;
      release();
      await outcome;
      // The stale write changed nothing: the row and its object are untouched.
      const key = (await objectKeyOf(seeded.id)) as string;
      expect((await service.get(accountId, agentId, seeded.id)).revision).toBe(seeded.revision + 1);
      expect(store.stored(key)).toBeDefined();
    }
  });
});
