import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentSkills } from "../db/schema/index.js";
import { SkillObjectGc, SkillObjectStoreError, SkillService, skillObjectKey } from "../services/skills/index.js";
import { FakeSkillObjectStore } from "./support/fake-skill-object-store.js";
import { createSkillHarness, type SkillHarness } from "./support/skill-service-harness.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * Behaviour of the deferred orphan-object collector against the in-memory store and PGlite: the
 * three eligibility rules (a Skill key, past the grace period, unreferenced), the safety re-check,
 * the per-run bounds, the prefix binding that keeps two deployments sharing a bucket apart, and the
 * fact that a replace no longer deletes inline.
 */

let unit: UnitDatabase;
let h: SkillHarness;
/**
 * A second, independent deployment: its own migrated database and its own nested prefix. It shares
 * one bucket with `h`, so a collector that matched by key tail alone would delete its live objects —
 * this database's rows are invisible to `h`'s reference queries, which is exactly the data loss G1.
 */
let stagingUnit: UnitDatabase;
let stagingH: SkillHarness;

const NOW = new Date("2026-06-01T00:00:00.000Z");
const GRACE_MS = 60_000;
const OLD = new Date(NOW.getTime() - GRACE_MS - 1000);
const YOUNG = new Date(NOW.getTime() - GRACE_MS + 1000);

beforeAll(async () => {
  unit = await createUnitDatabase();
  h = createSkillHarness(unit);
  stagingUnit = await createUnitDatabase();
  stagingH = createSkillHarness(stagingUnit);
}, 120_000);
afterAll(async () => {
  await stagingUnit?.close();
  await unit?.close();
});
beforeEach(async () => {
  await unit.reset();
  await stagingUnit.reset();
});

function objectKey(accountId: string, agentId: string, sha256 = "a".repeat(64)): string {
  return skillObjectKey({ prefix: "skills", accountId, agentId, skillId: randomUUID(), sha256 });
}

function gc(store: FakeSkillObjectStore, options: Partial<ConstructorParameters<typeof SkillObjectGc>[0]> = {}) {
  return new SkillObjectGc({
    database: h.database,
    store,
    prefix: "skills",
    graceMs: GRACE_MS,
    now: () => NOW,
    ...options,
  });
}

describe("SkillObjectGc", () => {
  it("deletes an unreferenced object past the grace period", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const key = objectKey(accountId, agentId);
    store.plant(key, new Uint8Array([1]));
    store.setLastModified(key, OLD);

    const summary = await gc(store).runOnce();

    expect(summary).toMatchObject({ scanned: 1, deleted: 1 });
    expect(store.keys()).toEqual([]);
  });

  it("keeps an unreferenced object inside the grace period", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const key = objectKey(accountId, agentId);
    store.plant(key, new Uint8Array([1]));
    store.setLastModified(key, YOUNG);

    const summary = await gc(store).runOnce();

    expect(summary).toMatchObject({ deleted: 0, skippedYoung: 1 });
    expect(store.stored(key)).toBeDefined();
  });

  it("keeps an old object a row still references", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const detail = await h.upload(h.serviceWith(store), accountId, agentId, "kept");
    const key = (await h.objectKeyOf(detail.id)) as string;
    store.setLastModified(key, OLD);

    const summary = await gc(store).runOnce();

    expect(summary).toMatchObject({ deleted: 0, skippedReferenced: 1 });
    expect(store.stored(key)).toBeDefined();
  });

  it("keeps a key that becomes referenced between listing and deletion", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const key = objectKey(accountId, agentId);
    store.plant(key, new Uint8Array([1]));
    store.setLastModified(key, OLD);
    // The row appears after the object was listed as a candidate; the reference check must still win.
    store.onList = async () => {
      await unit.database.insert(agentSkills).values({
        agentId,
        name: "appeared",
        description: "seeded",
        source: "web_upload",
        objectKey: key,
        archiveSha256: "a".repeat(64),
        archiveBytes: 1,
        fileCount: 1,
      });
    };

    const summary = await gc(store).runOnce();

    expect(summary).toMatchObject({ deleted: 0, skippedReferenced: 1 });
    expect(store.stored(key)).toBeDefined();
  });

  it("leaves non-skill keys under the prefix untouched", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const foreign = `skills/${randomUUID()}/README.txt`;
    const wrongShape = `skills/accounts/${accountId}/agents/${agentId}/skills/not-a-uuid/${"b".repeat(64)}.tar.gz`;
    for (const key of [foreign, wrongShape]) {
      store.plant(key, new Uint8Array([1]));
      store.setLastModified(key, OLD);
    }

    const summary = await gc(store).runOnce();

    expect(summary).toMatchObject({ deleted: 0, skippedForeign: 2 });
    expect(store.keys()).toEqual([foreign, wrongShape].sort());
  });

  it("pages through the listing", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    for (let index = 0; index < 5; index += 1) {
      const key = objectKey(accountId, agentId, `${index}`.repeat(64));
      store.plant(key, new Uint8Array([index]));
      store.setLastModified(key, OLD);
    }

    const summary = await gc(store, { pageSize: 2 }).runOnce();

    expect(summary.deleted).toBe(5);
    expect(store.lists).toBeGreaterThanOrEqual(3);
    expect(store.keys()).toEqual([]);
  });

  it("stops at the per-run delete cap", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    for (let index = 0; index < 3; index += 1) {
      const key = objectKey(accountId, agentId, `${index}`.repeat(64));
      store.plant(key, new Uint8Array([index]));
      store.setLastModified(key, OLD);
    }

    const summary = await gc(store, { maxDeletesPerRun: 1 }).runOnce();

    expect(summary.deleted).toBe(1);
    expect(store.keys()).toHaveLength(2);
  });

  it("logs a failed delete and continues the run", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    for (let index = 0; index < 2; index += 1) {
      const key = objectKey(accountId, agentId, `${index}`.repeat(64));
      store.plant(key, new Uint8Array([index]));
      store.setLastModified(key, OLD);
    }
    store.failNextDeleteWith = new SkillObjectStoreError("unavailable", "transient delete failure");
    const { logger, warns } = h.capturingLogger();

    const summary = await gc(store, { logger }).runOnce();

    expect(summary.deleted).toBe(1);
    expect(warns.some((entry) => entry.code === "unavailable")).toBe(true);
  });

  it("no longer deletes the replaced object inline, and collects it on a later pass", async () => {
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const store = new FakeSkillObjectStore();
    const service = h.serviceWith(store);
    const first = await h.upload(service, accountId, agentId, "replaced");
    const oldKey = (await h.objectKeyOf(first.id)) as string;
    const replaced = await h.upload(service, accountId, agentId, "replaced", {
      replace: true,
      files: { "a.txt": "a" },
    });
    const newKey = (await h.objectKeyOf(replaced.id)) as string;

    expect(newKey).not.toBe(oldKey);
    expect(store.deletes).toBe(0);
    expect(store.keys()).toHaveLength(2);

    store.setLastModified(oldKey, OLD);
    store.setLastModified(newKey, OLD);
    const summary = await gc(store).runOnce();

    expect(summary).toMatchObject({ deleted: 1, skippedReferenced: 1 });
    expect(store.stored(oldKey)).toBeUndefined();
    expect(store.stored(newKey)).toBeDefined();
  });

  it("keeps a live object that belongs to a nested deployment sharing the bucket", async () => {
    const store = new FakeSkillObjectStore();
    const stagingAccountId = await stagingH.createUser();
    const stagingAgentId = await stagingH.createAgent(stagingAccountId);
    const stagingService = new SkillService({ database: stagingUnit.database, store, keyPrefix: "skills/staging" });
    const staging = await stagingH.upload(stagingService, stagingAccountId, stagingAgentId, "staging-skill");
    const stagingKey = (await stagingH.objectKeyOf(staging.id)) as string;
    expect(stagingKey.startsWith("skills/staging/")).toBe(true);
    store.setLastModified(stagingKey, OLD);

    // The `skills` deployment's GC lists `skills/` and so sees the staging key, but it must treat it
    // as foreign: the staging row lives in a different database this GC cannot reference-check.
    const summary = await gc(store).runOnce();

    expect(summary).toMatchObject({ deleted: 0, skippedForeign: 1 });
    expect(store.stored(stagingKey)).toBeDefined();
    const bundle = await stagingService.openBundle(stagingAccountId, stagingAgentId, staging.id);
    expect(bundle.sha256).toBe(staging.archiveSha256);
  });

  it("keeps an outer-prefix object when a nested deployment's GC runs", async () => {
    const store = new FakeSkillObjectStore();
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const outer = await h.upload(h.serviceWith(store), accountId, agentId, "outer-skill");
    const outerKey = (await h.objectKeyOf(outer.id)) as string;
    store.setLastModified(outerKey, OLD);
    const nestedGc = new SkillObjectGc({
      database: stagingUnit.database,
      store,
      prefix: "skills/staging",
      graceMs: GRACE_MS,
      now: () => NOW,
    });

    const summary = await nestedGc.runOnce();

    expect(summary.deleted).toBe(0);
    expect(store.stored(outerKey)).toBeDefined();
  });

  it("leaves a sibling prefix untouched", async () => {
    const store = new FakeSkillObjectStore();
    const accountId = await h.createUser();
    const agentId = await h.createAgent(accountId);
    const siblingKey = skillObjectKey({
      prefix: "skills-staging",
      accountId,
      agentId,
      skillId: randomUUID(),
      sha256: "d".repeat(64),
    });
    store.plant(siblingKey, new Uint8Array([1]));
    store.setLastModified(siblingKey, OLD);

    const summary = await gc(store).runOnce();

    expect(summary.deleted).toBe(0);
    expect(store.stored(siblingKey)).toBeDefined();
  });
});
