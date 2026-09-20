import { SKILL_ERROR_CODES } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SkillObjectStoreError, SkillService } from "../services/skills/index.js";
import { FakeSkillObjectStore } from "./support/fake-skill-object-store.js";
import { createSkillHarness, type SkillHarness } from "./support/skill-service-harness.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * Concurrency and failure behaviour of `SkillService`: the invariant under test is that a committed
 * row never points at a deleted object, even when a writer races another or the object store fails
 * partway through.
 */

let unit: UnitDatabase;
let h: SkillHarness;

beforeAll(async () => {
  unit = await createUnitDatabase();
  h = createSkillHarness(unit);
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

describe("SkillService object lifecycle", () => {
  it("deletes the new object when the insert itself fails", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = new SkillService({ database: h.failingInsertDatabase(), store, keyPrefix: "skills" });

    await expect(h.upload(service, accountId, agentId, "rollback")).rejects.toThrow("forced Skill row write failure");
    expect(store.puts).toBe(1);
    expect(store.deletes).toBe(1);
    expect(store.keys()).toEqual([]);
  });

  it("keeps the committed row's object when the insert throws after committing", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = new SkillService({
      database: h.committingThenThrowingInsertDatabase(),
      store,
      keyPrefix: "skills",
    });

    await expect(h.upload(service, accountId, agentId, "committed-then-throw")).rejects.toThrow(
      "forced insert commit-then-throw",
    );
    // The row committed before the failure surfaced, so the conditional cleanup must leave its
    // object alone: no delete, the row is listed, and its bundle still reads.
    expect(store.deletes).toBe(0);
    const listed = await service.list(accountId, agentId);
    expect(listed.skills).toHaveLength(1);
    expect(store.keys()).toHaveLength(1);
    const skillId = listed.skills[0]?.id as string;
    const bundle = await service.openBundle(accountId, agentId, skillId);
    expect(bundle.sha256).toBe(listed.skills[0]?.archiveSha256);
  });

  it("completes an insert without inspecting the object, even when head fails", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    store.failNextHeadWith = new SkillObjectStoreError("unavailable", "transient head failure");
    const service = h.serviceWith(store);

    const detail = await h.upload(service, accountId, agentId, "insert-no-head");
    expect(detail.name).toBe("insert-no-head");
    // The insert path must not call head at all: a failure after the row commit would otherwise
    // delete the object the committed row references.
    expect(store.heads).toBe(0);
    expect(store.stored((await h.objectKeyOf(detail.id)) as string)).toBeDefined();
    const bundle = await service.openBundle(accountId, agentId, detail.id);
    expect(bundle.sha256).toBe(detail.archiveSha256);
  });

  it("fails a replace whose post-commit check fails, without deleting the row's object", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = h.serviceWith(store);
    const seeded = await h.upload(service, accountId, agentId, "replace-head-fails");

    store.failNextHeadWith = new SkillObjectStoreError("unavailable", "transient head failure");
    await expect(
      h.upload(service, accountId, agentId, "replace-head-fails", { replace: true, files: { "a.txt": "a" } }),
    ).rejects.toMatchObject({ code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE });

    // The row committed before the failure, so its object must still exist and remain readable.
    const objectKey = (await h.objectKeyOf(seeded.id)) as string;
    expect(store.stored(objectKey)).toBeDefined();
    const bundle = await service.openBundle(accountId, agentId, seeded.id);
    expect(bundle.sha256).toBe((await service.get(accountId, agentId, seeded.id)).archiveSha256);
  });

  it("keeps the object when the replacement content is identical", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = h.serviceWith(store);

    const first = await h.upload(service, accountId, agentId, "same-bytes");
    const replaced = await h.upload(service, accountId, agentId, "same-bytes", { replace: true });
    expect(replaced.revision).toBe(first.revision + 1);
    expect(replaced.archiveSha256).toBe(first.archiveSha256);
    expect(store.keys()).toHaveLength(1);
    const bundle = await service.openBundle(accountId, agentId, replaced.id);
    expect(bundle.sha256).toBe(replaced.archiveSha256);
    expect(bundle.bytes).toBe(replaced.archiveBytes);
  });

  it("leaves the row's object intact when a replace races another writer", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const original = await h.upload(h.serviceWith(store), accountId, agentId, "race");
    const originalKey = (await h.objectKeyOf(original.id)) as string;

    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalPause!: () => void;
    const pauseReached = new Promise<void>((resolve) => {
      signalPause = resolve;
    });
    const database = h.databasePausingFirstReturning(async () => {
      signalPause();
      await paused;
    });
    const service = new SkillService({ database, store, keyPrefix: "skills" });

    // A reads revision 1 and writes a new key, but its row update is held just before it executes.
    const winner = h.upload(service, accountId, agentId, "race", { replace: true, files: { "a.txt": "a" } });
    await pauseReached;
    // B re-uploads the ORIGINAL content while A is held; it lands on the original key.
    const late = await h.upload(service, accountId, agentId, "race", { replace: true });
    release();
    await expect(winner).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.REVISION_CONFLICT,
      message: expect.stringContaining("concurrently"),
    });

    expect(late.archiveSha256).toBe(original.archiveSha256);
    expect(await h.objectKeyOf(original.id)).toBe(originalKey);
    expect(store.stored(originalKey)).toBeDefined();
    expect(store.keys()).toEqual([originalKey]);
  });

  it("rejects a stale setEnabled and a stale remove", async () => {
    for (const operation of ["setEnabled", "remove"] as const) {
      const accountId = await h.createUser();
      const agentId = await h.createAgent(accountId);
      const store = new FakeSkillObjectStore();
      const seeded = await h.upload(
        h.serviceWith(store),
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
      const database = h.databasePausingFirstReturning(async () => {
        await h.bumpRevision(seeded.id);
        signalRevved();
        await held;
      });
      const service = new SkillService({ database, store, keyPrefix: "skills" });

      const call =
        operation === "setEnabled"
          ? service.setEnabled(accountId, agentId, seeded.id, false)
          : service.remove(accountId, agentId, seeded.id);
      const outcome = expect(call).rejects.toMatchObject({
        code: SKILL_ERROR_CODES.REVISION_CONFLICT,
        message: expect.stringContaining("concurrently"),
      });
      await revved;
      release();
      await outcome;
      // The stale write changed nothing: the row and its object are untouched.
      const key = (await h.objectKeyOf(seeded.id)) as string;
      expect((await service.get(accountId, agentId, seeded.id)).revision).toBe(seeded.revision + 1);
      expect(store.stored(key)).toBeDefined();
    }
  });

  it("keeps the live object when a same-content replace fails its row write", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const seeded = await h.upload(h.serviceWith(store), accountId, agentId, "failed-replace");
    const objectKey = (await h.objectKeyOf(seeded.id)) as string;

    const service = new SkillService({ database: h.failingUpdateDatabase(), store, keyPrefix: "skills" });
    await expect(h.upload(service, accountId, agentId, "failed-replace", { replace: true })).rejects.toThrow(
      "forced Skill row update failure",
    );
    // The cleanup must not delete the key the unchanged row still references.
    expect(store.deletes).toBe(0);
    expect(store.stored(objectKey)).toBeDefined();
    const bundle = await h.serviceWith(store).openBundle(accountId, agentId, seeded.id);
    expect(bundle.sha256).toBe(seeded.archiveSha256);
  });

  it("restores the object an external cleanup removed before the post-commit check", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const { logger, warns } = h.capturingLogger();
    await h.upload(h.serviceWith(store), accountId, agentId, "restore");
    // A replace no longer deletes inline, so the remaining way this object can vanish in the window
    // is an external cleanup (the GC). Simulate that: the first `head` the replace's post-commit
    // check makes removes the object, and the check must put it back rather than strand the row.
    const realHead = store.head.bind(store);
    let removed = false;
    store.head = async (key) => {
      if (!removed) {
        removed = true;
        await store.delete(key);
      }
      return realHead(key);
    };
    const service = new SkillService({ database: h.database, store, keyPrefix: "skills", logger });

    const replaced = await h.upload(service, accountId, agentId, "restore", {
      replace: true,
      files: { "a.txt": "a" },
    });

    expect(store.stored((await h.objectKeyOf(replaced.id)) as string)).toBeDefined();
    expect(warns.filter((entry) => entry.code === "skill_object_restored")).toHaveLength(1);
    const bundle = await service.openBundle(accountId, agentId, replaced.id);
    expect(bundle.sha256).toBe(replaced.archiveSha256);
  });

  it("does not re-put an object after a replace whose head reports it present", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    await h.upload(h.serviceWith(store), accountId, agentId, "present");
    const putsAfterInsert = store.puts;
    await h.upload(h.serviceWith(store), accountId, agentId, "present", { replace: true, files: { "a.txt": "a" } });
    // Only the replace's own PUT — the post-commit check found the object and restored nothing.
    expect(store.puts).toBe(putsAfterInsert + 1);
    expect(store.heads).toBeGreaterThanOrEqual(1);
  });
});
