import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agentSkills } from "../../db/schema/index.js";
import { SkillObjectGc, SkillService } from "../../services/skills/index.js";
import { deferred } from "../support/deferred.js";
import { FakeSkillObjectStore } from "../support/fake-skill-object-store.js";
import { createSkillHarness } from "../support/skill-service-harness.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
const NOW = new Date("2026-10-20T08:00:00.000Z");
const OLD = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function fixture() {
  const client = createDatabaseClient(testDatabase.databaseUrl);
  const h = createSkillHarness(client);
  const accountId = await h.createUser();
  const agentId = await h.createAgent(accountId);
  const store = new FakeSkillObjectStore();
  store.defaultLastModified = NOW;
  return { client, h, accountId, agentId, store, service: h.serviceWith(store) };
}

async function expectReadable(f: Awaited<ReturnType<typeof fixture>>, id: string, sha256: string) {
  const bundle = await f.service.openBundle(f.accountId, f.agentId, id);
  const bytes = new Uint8Array(await new Response(bundle.stream).arrayBuffer());
  expect(bundle.sha256).toBe(sha256);
  expect(f.h.sha256(bytes)).toBe(sha256);
  expect(bytes.byteLength).toBe(bundle.bytes);
}

it("keeps a same-content replacement readable after an already-issued GC delete completes", async () => {
  const f = await fixture();
  const resumeDelete = deferred();
  const deleting = vi.fn();
  const pending: Promise<unknown>[] = [];
  try {
    const first = await f.h.upload(f.service, f.accountId, f.agentId, "gc-race", { files: { "script.txt": "A" } });
    const oldKey = (await f.h.objectKeyOf(first.id)) as string;
    await f.h.upload(f.service, f.accountId, f.agentId, "gc-race", { replace: true, files: { "script.txt": "B" } });
    f.store.setLastModified(oldKey, OLD);
    const remove = f.store.delete.bind(f.store);
    f.store.delete = async (key) => {
      if (key === oldKey) {
        deleting();
        await resumeDelete.promise;
      }
      return remove(key);
    };
    const gc = new SkillObjectGc({ database: f.client.database, store: f.store, prefix: "skills", now: () => NOW });
    const collecting = gc.runOnce();
    pending.push(collecting);
    await vi.waitFor(() => expect(deleting).toHaveBeenCalledOnce());
    const replacement = await f.h.upload(f.service, f.accountId, f.agentId, "gc-race", {
      replace: true,
      files: { "script.txt": "A" },
    });
    const currentKey = await f.h.objectKeyOf(first.id);
    expect(replacement.archiveSha256).toBe(first.archiveSha256);
    expect(f.store.heads).toBe(2);
    await expectReadable(f, replacement.id, first.archiveSha256);
    resumeDelete.resolve();
    expect(await collecting).toMatchObject({ deleted: 1 });
    expect(f.store.stored(oldKey)).toBeUndefined();
    expect(await f.h.objectKeyOf(first.id)).toBe(currentKey);
    await expectReadable(f, replacement.id, first.archiveSha256);
    expect(currentKey).not.toBe(oldKey);
  } finally {
    resumeDelete.resolve();
    await Promise.allSettled(pending);
    await f.client.sql.end();
  }
});

it("keeps a newer same-content archive when a stale writer's cleanup delete finishes last", async () => {
  const f = await fixture();
  const staleClient = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const atUpdate = vi.fn();
  const resumeUpdate = deferred();
  const atDelete = vi.fn();
  const resumeDelete = deferred();
  const pending: Promise<unknown>[] = [];
  try {
    const first = await f.h.upload(f.service, f.accountId, f.agentId, "cleanup-race", { files: { "script.txt": "A" } });
    await f.service.setEnabled(f.accountId, f.agentId, first.id, false);
    await f.h.upload(f.service, f.accountId, f.agentId, "cleanup-race", {
      replace: true,
      files: { "script.txt": "B" },
    });
    const put = vi.spyOn(f.store, "put");
    const staleHarness = createSkillHarness(staleClient);
    const database = staleHarness.databasePausingFirstReturning(async () => {
      atUpdate();
      await resumeUpdate.promise;
    });
    const staleService = new SkillService({ database, store: f.store, keyPrefix: "skills" });
    const stale = Promise.allSettled([
      f.h.upload(staleService, f.accountId, f.agentId, "cleanup-race", { replace: true, files: { "script.txt": "A" } }),
    ]);
    pending.push(stale);
    await vi.waitFor(() => expect(atUpdate).toHaveBeenCalledOnce());
    const staleKey = put.mock.calls[0]?.[0];
    if (!staleKey) throw new Error("Missing stale upload key");
    const remove = f.store.delete.bind(f.store);
    f.store.delete = async (key) => {
      if (key === staleKey) {
        atDelete();
        await resumeDelete.promise;
      }
      return remove(key);
    };
    await f.h.upload(f.service, f.accountId, f.agentId, "cleanup-race", {
      replace: true,
      files: { "script.txt": "C" },
    });
    resumeUpdate.resolve();
    await vi.waitFor(() => expect(atDelete).toHaveBeenCalledOnce());
    const replacement = await f.h.upload(f.service, f.accountId, f.agentId, "cleanup-race", {
      replace: true,
      source: "agent_upload",
      files: { "script.txt": "A" },
    });
    const currentKey = await f.h.objectKeyOf(first.id);
    expect(replacement).toMatchObject({ id: first.id, revision: 4, enabled: false, source: "agent_upload" });
    await expectReadable(f, replacement.id, first.archiveSha256);
    resumeDelete.resolve();
    expect(await stale).toMatchObject([{ status: "rejected", reason: { code: "SKILL_REVISION_CONFLICT" } }]);
    expect(f.store.stored(staleKey)).toBeUndefined();
    expect(await f.h.objectKeyOf(first.id)).toBe(currentKey);
    await expectReadable(f, replacement.id, first.archiveSha256);
    expect(currentKey).not.toBe(staleKey);
  } finally {
    resumeUpdate.resolve();
    resumeDelete.resolve();
    await Promise.allSettled(pending);
    await Promise.all([f.client.sql.end(), staleClient.sql.end()]);
  }
});

it("admits one same-content replacement and deletes only the losing writer's independent object", async () => {
  const f = await fixture();
  const clients = [0, 1].map(() => createDatabaseClient(testDatabase.databaseUrl, { max: 1 }));
  const resume = deferred();
  const arrived = vi.fn();
  const pending: Promise<unknown>[] = [];
  try {
    const first = await f.h.upload(f.service, f.accountId, f.agentId, "same-content");
    const firstKey = await f.h.objectKeyOf(first.id);
    const put = f.store.put.bind(f.store);
    const keys: string[] = [];
    f.store.put = async (...args) => {
      await put(...args);
      keys.push(args[0]);
      arrived();
      await resume.promise;
    };
    const writes = Promise.allSettled(
      clients.map((client) =>
        f.h.upload(
          new SkillService({ database: client.database, store: f.store, keyPrefix: "skills" }),
          f.accountId,
          f.agentId,
          "same-content",
          { replace: true },
        ),
      ),
    );
    pending.push(writes);
    await vi.waitFor(() => expect(arrived).toHaveBeenCalledTimes(2));
    expect(new Set([firstKey, ...keys]).size).toBe(3);
    resume.resolve();
    const results = await writes;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "SKILL_REVISION_CONFLICT" } },
    ]);
    const currentKey = await f.h.objectKeyOf(first.id);
    expect(keys).toContain(currentKey);
    expect(f.store.keys()).toEqual([firstKey, currentKey].sort());
    expect(f.store.deletes).toBe(1);
    expect(await f.service.get(f.accountId, f.agentId, first.id)).toMatchObject({
      revision: 2,
      archiveSha256: first.archiveSha256,
    });
    await expectReadable(f, first.id, first.archiveSha256);
  } finally {
    resume.resolve();
    await Promise.allSettled(pending);
    await Promise.all([f.client.sql.end(), ...clients.map((client) => client.sql.end())]);
  }
});

it("reads legacy hash keys and collects them only after replacement makes them old orphans", async () => {
  const f = await fixture();
  try {
    const first = await f.h.upload(f.service, f.accountId, f.agentId, "legacy");
    const initialKey = (await f.h.objectKeyOf(first.id)) as string;
    const legacyKey = initialKey.replace(/[^/]+$/, `${first.archiveSha256}.tar.gz`);
    f.store.plant(legacyKey, f.store.stored(initialKey) as Uint8Array);
    await f.client.database.update(agentSkills).set({ objectKey: legacyKey }).where(eq(agentSkills.id, first.id));
    await f.store.delete(initialKey);
    f.store.setLastModified(legacyKey, OLD);
    const gc = new SkillObjectGc({ database: f.client.database, store: f.store, prefix: "skills", now: () => NOW });
    expect(await gc.runOnce()).toMatchObject({ deleted: 0, skippedReferenced: 1 });
    await expectReadable(f, first.id, first.archiveSha256);
    const replacement = await f.h.upload(f.service, f.accountId, f.agentId, "legacy", { replace: true });
    const currentKey = (await f.h.objectKeyOf(first.id)) as string;
    expect(currentKey).not.toBe(legacyKey);
    expect(currentKey).toMatch(
      new RegExp(`^skills/accounts/${f.accountId}/agents/${f.agentId}/skills/${first.id}/[a-f0-9]{64}\\.tar\\.gz$`),
    );
    expect(replacement.archiveSha256).toBe(first.archiveSha256);
    expect(await gc.runOnce()).toMatchObject({ deleted: 1, skippedYoung: 1 });
    expect(f.store.keys()).toEqual([currentKey]);
    await expectReadable(f, first.id, first.archiveSha256);
  } finally {
    await f.client.sql.end();
  }
});
