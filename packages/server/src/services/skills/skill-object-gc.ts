import { eq, inArray } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentSkills } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import {
  isSkillObjectKey,
  type SkillObjectListEntry,
  type SkillObjectStore,
  SkillObjectStoreError,
} from "./skill-object-store.js";

/**
 * Deferred collection of orphaned Skill objects.
 *
 * A replace writes a new content-addressed key and updates the row; it no longer deletes the old key
 * inline, because that check-then-act could still delete an object another writer had just made the
 * row's current key. The old object is left as an orphan instead, and this worker sweeps it after a
 * grace period — long enough that a concurrent request can no longer be holding a reference to it.
 *
 * The safety rules are what matter, so they are stated once here:
 *
 * - **Only a Skill object key is a candidate.** The bucket may hold other prefixes; a key that does
 *   not parse as `…/accounts/<uuid>/agents/<uuid>/skills/<uuid>/<sha256>.tar.gz` is never touched.
 * - **Only an object past the grace period is a candidate**, so a just-written object is never swept.
 * - **An object any row references is never deleted.** References are checked in batches, then the
 *   single key is re-checked immediately before its delete, because a row can appear in between.
 * - **A failed delete is logged and skipped**, never fatal: the next pass retries it.
 */

export const SKILL_GC_DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
export const SKILL_GC_DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
export const SKILL_GC_DEFAULT_PAGE_SIZE = 200;
export const SKILL_GC_DEFAULT_MAX_DELETES_PER_RUN = 500;
/** Bounded `inArray` chunk so one pass cannot build an unbounded SQL statement. */
const REFERENCE_CHUNK = 200;

export interface SkillObjectGcSummary {
  scanned: number;
  deleted: number;
  skippedYoung: number;
  skippedReferenced: number;
  skippedForeign: number;
  durationMs: number;
}

export interface SkillObjectGcOptions {
  database: DatabaseClient;
  store: SkillObjectStore;
  /** The deployment object-key prefix; only `<prefix>/…` is listed. */
  prefix: string;
  graceMs?: number;
  intervalMs?: number;
  pageSize?: number;
  maxDeletesPerRun?: number;
  now?: () => Date;
  logger?: ServiceLogger;
  onError?: (error: unknown) => void;
}

export class SkillObjectGc {
  readonly #database: DatabaseClient;
  readonly #store: SkillObjectStore;
  readonly #prefix: string;
  readonly #graceMs: number;
  readonly #intervalMs: number;
  readonly #pageSize: number;
  readonly #maxDeletesPerRun: number;
  readonly #now: () => Date;
  readonly #logger?: ServiceLogger;
  readonly #onError: (error: unknown) => void;
  #running = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SkillObjectGcOptions) {
    this.#database = options.database;
    this.#store = options.store;
    this.#prefix = options.prefix;
    this.#graceMs = options.graceMs ?? SKILL_GC_DEFAULT_GRACE_MS;
    this.#intervalMs = options.intervalMs ?? SKILL_GC_DEFAULT_INTERVAL_MS;
    this.#pageSize = options.pageSize ?? SKILL_GC_DEFAULT_PAGE_SIZE;
    this.#maxDeletesPerRun = options.maxDeletesPerRun ?? SKILL_GC_DEFAULT_MAX_DELETES_PER_RUN;
    this.#now = options.now ?? (() => new Date());
    if (options.logger) this.#logger = options.logger;
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.runOnce().catch(this.#onError);
    }, this.#intervalMs);
    // A maintenance timer must not hold the process open on its own.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One pass: page through the prefix, delete the old unreferenced Skill objects, and report the
   * counts. Never throws a store or database failure at the caller — the wrapper logs it.
   */
  async runOnce(): Promise<SkillObjectGcSummary> {
    const summary: SkillObjectGcSummary = {
      scanned: 0,
      deleted: 0,
      skippedYoung: 0,
      skippedReferenced: 0,
      skippedForeign: 0,
      durationMs: 0,
    };
    const startedAt = Date.now();
    if (this.#running) return summary;
    this.#running = true;
    try {
      let cursor: string | undefined;
      do {
        const page = await this.#store.list(`${this.#prefix}/`, {
          limit: this.#pageSize,
          ...(cursor === undefined ? {} : { cursor }),
        });
        cursor = page.nextCursor;
        const candidates = this.#candidates(page.objects, summary);
        const referenced = await this.#referencedKeys(candidates.map((candidate) => candidate.key));
        for (const candidate of candidates) {
          if (summary.deleted >= this.#maxDeletesPerRun) break;
          // Re-check the single key immediately before deleting: a row can be inserted after the
          // batch above, and that new reference must win over this delete.
          if (referenced.has(candidate.key) || (await this.#isReferenced(candidate.key))) {
            summary.skippedReferenced += 1;
            continue;
          }
          await this.#deleteOne(candidate.key, summary);
        }
      } while (cursor !== undefined && summary.deleted < this.#maxDeletesPerRun);
    } finally {
      this.#running = false;
    }
    summary.durationMs = Date.now() - startedAt;
    this.#logger?.info({ ...summary, prefix: this.#prefix }, "Skill object GC run completed");
    return summary;
  }

  /** Applies the three eligibility rules, counting the objects that are not candidates. */
  #candidates(objects: SkillObjectListEntry[], summary: SkillObjectGcSummary): SkillObjectListEntry[] {
    const cutoff = this.#now().getTime() - this.#graceMs;
    const candidates: SkillObjectListEntry[] = [];
    for (const object of objects) {
      summary.scanned += 1;
      if (!isSkillObjectKey(object.key)) {
        summary.skippedForeign += 1;
        continue;
      }
      if (object.lastModified.getTime() >= cutoff) {
        summary.skippedYoung += 1;
        continue;
      }
      candidates.push(object);
    }
    return candidates;
  }

  async #referencedKeys(keys: string[]): Promise<Set<string>> {
    const referenced = new Set<string>();
    for (let index = 0; index < keys.length; index += REFERENCE_CHUNK) {
      const chunk = keys.slice(index, index + REFERENCE_CHUNK);
      if (chunk.length === 0) continue;
      const rows = await this.#database
        .select({ objectKey: agentSkills.objectKey })
        .from(agentSkills)
        .where(inArray(agentSkills.objectKey, chunk));
      for (const row of rows) referenced.add(row.objectKey);
    }
    return referenced;
  }

  async #isReferenced(key: string): Promise<boolean> {
    const [row] = await this.#database
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.objectKey, key))
      .limit(1);
    return row !== undefined;
  }

  async #deleteOne(key: string, summary: SkillObjectGcSummary): Promise<void> {
    try {
      await this.#store.delete(key);
      summary.deleted += 1;
      this.#logger?.debug({ key }, "Skill object deleted by GC");
    } catch (error) {
      this.#logger?.warn(
        { key, code: error instanceof SkillObjectStoreError ? error.code : "unknown" },
        "Skill object GC delete failed; leaving it for the next pass",
      );
    }
  }
}
