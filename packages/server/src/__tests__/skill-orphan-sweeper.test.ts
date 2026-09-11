import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { MemorySkillBlobStore, SkillOrphanSweeper, SkillService } from "../services/skills/index.js";
import { validSkillZip } from "./support/skill-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unitDatabase: UnitDatabase;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => unitDatabase?.close());

beforeEach(async () => unitDatabase.reset());

const OLD = new Date("2026-09-10T00:00:00.000Z");
const NOW = new Date("2026-09-11T12:00:00.000Z");
const RECENT = new Date("2026-09-11T11:30:00.000Z");

describe("SkillOrphanSweeper", () => {
  it("deletes only unreferenced objects older than the grace period", async () => {
    const { userId } = await bootstrapInitialAdmin(unitDatabase.database, { displayName: "A", email: "a@example.com" });
    let clock = OLD;
    const store = new MemorySkillBlobStore({ now: () => clock });
    const service = new SkillService(unitDatabase.database, store);
    await service.upsertFromArchive(userId, validSkillZip("kept"), {
      onConflict: "fail",
      updatedBy: { kind: "user", id: userId },
    });
    await store.put(`${userId}/orphan/old.zip`, Uint8Array.from([1]), "a");
    clock = RECENT;
    await store.put(`${userId}/orphan/recent.zip`, Uint8Array.from([2]), "b");

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sweeper = new SkillOrphanSweeper({ database: unitDatabase.database, store, now: () => NOW, logger });
    expect(await sweeper.sweepOnce()).toEqual({ scanned: 3, deleted: 1, failed: 0 });
    const kept = await service.get(userId, "kept");
    expect(store.objects.size).toBe(2);
    expect([...store.objects.keys()].some((key) => key.endsWith(`/${kept.digest}.zip`))).toBe(true);
    expect(store.objects.has(`${userId}/orphan/old.zip`)).toBe(false);
    expect(store.objects.has(`${userId}/orphan/recent.zip`)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith({ scanned: 3, deleted: 1, failed: 0 }, "Skill orphan sweep finished");
  });

  it("counts and logs objects it could not delete without aborting the sweep", async () => {
    const store = new MemorySkillBlobStore({ now: () => OLD });
    await store.put("a.zip", Uint8Array.from([1]), "a");
    await store.put("b.zip", Uint8Array.from([2]), "b");
    const failing = {
      list: (prefix: string) => store.list(prefix),
      delete: vi.fn(async (key: string) => {
        if (key === "a.zip") throw new Error("boom");
        await store.delete(key);
      }),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sweeper = new SkillOrphanSweeper({ database: unitDatabase.database, store: failing, now: () => NOW, logger });
    expect(await sweeper.sweepOnce()).toEqual({ scanned: 2, deleted: 1, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: "a.zip" }),
      "Orphaned skill archive could not be deleted",
    );
  });

  it("runs on its interval without keeping the process alive and coalesces overlapping sweeps", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemorySkillBlobStore({ now: () => OLD });
      await store.put("stale.zip", Uint8Array.from([1]), "a");
      const list = vi.fn((prefix: string) => store.list(prefix));
      const sweeper = new SkillOrphanSweeper({
        database: unitDatabase.database,
        store: { list, delete: (key) => store.delete(key) },
        now: () => NOW,
        intervalMs: 1_000,
      });
      const first = sweeper.sweepOnce();
      const second = sweeper.sweepOnce();
      expect(second).toBe(first);
      await first;
      expect(list).toHaveBeenCalledTimes(1);
      sweeper.start();
      sweeper.start();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(list).toHaveBeenCalledTimes(3);
      sweeper.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
