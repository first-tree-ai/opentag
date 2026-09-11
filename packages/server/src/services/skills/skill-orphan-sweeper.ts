import type { DatabaseClient } from "../../db/client.js";
import { skills } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/index.js";
import type { SkillBlobStore } from "./skill-blob-store.js";

export interface SkillOrphanSweeperOptions {
  database: DatabaseClient;
  store: Pick<SkillBlobStore, "list" | "delete">;
  logger?: ServiceLogger;
  now?: () => Date;
  /** Objects younger than this are left alone: an upload may have written them and not yet committed its row. */
  minAgeMs?: number;
  /** How often `start()` sweeps. */
  intervalMs?: number;
}

export interface SkillOrphanSweepResult {
  scanned: number;
  deleted: number;
  failed: number;
}

export const SKILL_ORPHAN_MIN_AGE_MS = 60 * 60 * 1_000;
export const SKILL_ORPHAN_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const noopLogger: ServiceLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Deletes archive objects no `skills.archive_key` references. Uploads write the object before the row and deletes
 * remove the row before the object, so an interrupted operation can leave an unreferenced object behind; this is the
 * daily backstop for those, and for a best-effort delete that failed.
 */
export class SkillOrphanSweeper {
  readonly #options: SkillOrphanSweeperOptions;
  readonly #logger: ServiceLogger;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<SkillOrphanSweepResult> | undefined;

  constructor(options: SkillOrphanSweeperOptions) {
    this.#options = options;
    this.#logger = options.logger ?? noopLogger;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () => void this.sweepOnce().catch(() => undefined),
      this.#options.intervalMs ?? SKILL_ORPHAN_SWEEP_INTERVAL_MS,
    );
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  sweepOnce(): Promise<SkillOrphanSweepResult> {
    if (this.#inFlight) return this.#inFlight;
    const pending = this.#sweep().finally(() => {
      if (this.#inFlight === pending) this.#inFlight = undefined;
    });
    this.#inFlight = pending;
    return pending;
  }

  async #sweep(): Promise<SkillOrphanSweepResult> {
    const now = (this.#options.now ?? (() => new Date()))().getTime();
    const cutoff = now - (this.#options.minAgeMs ?? SKILL_ORPHAN_MIN_AGE_MS);
    const objects = await this.#options.store.list("");
    const referenced = new Set(
      (await this.#options.database.select({ archiveKey: skills.archiveKey }).from(skills)).map(
        (row) => row.archiveKey,
      ),
    );
    const result: SkillOrphanSweepResult = { scanned: objects.length, deleted: 0, failed: 0 };
    for (const object of objects) {
      if (referenced.has(object.key) || object.lastModified.getTime() > cutoff) continue;
      await this.#deleteOrphan(object.key, result);
    }
    this.#logger.info({ ...result }, "Skill orphan sweep finished");
    return result;
  }

  async #deleteOrphan(key: string, result: SkillOrphanSweepResult): Promise<void> {
    try {
      await this.#options.store.delete(key);
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;
      this.#logger.warn({ key, err: error }, "Orphaned skill archive could not be deleted");
    }
  }
}
