import { eq, inArray } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentSkills } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { normalizeSkillObjectPrefix } from "./skill-object-prefix.js";
import {
  isSkillObjectKeyUnder,
  type SkillObjectListEntry,
  type SkillObjectStore,
  SkillObjectStoreError,
} from "./skill-object-store.js";

/**
 * Deferred collection of orphaned Skill objects.
 *
 * A replace writes an independently identified object and updates the row. The previous object is
 * left for this worker's grace period and reference checks, including legacy keys that older
 * writers can still reuse during a rolling deployment.
 *
 * The safety rules are what matter, so they are stated once here:
 *
 * - **Only a key exactly under this deployment's normalized prefix is a candidate.** The bucket may
 *   be shared, including with a nested prefix (`skills/staging`) or a sibling, and the other
 *   deployment's rows live in a database this one cannot reference-check. A key whose tail merely
 *   looks like a Skill object is never touched.
 * - **Only an object past the grace period is a candidate**, so a just-written object is never swept.
 * - **An object any row references is never deleted.** References are checked in batches, then the
 *   single key is re-checked immediately before its delete, because a row can appear in between.
 * - **A failed delete is logged and skipped**, never fatal: the next pass retries it.
 */

export const SKILL_GC_DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
export const SKILL_GC_DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
export const SKILL_GC_DEFAULT_PAGE_SIZE = 200;
export const SKILL_GC_DEFAULT_MAX_DELETES_PER_RUN = 500;
export const SKILL_GC_DEFAULT_MAX_PAGES_PER_RUN = 10;
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
  /** The deployment object-key prefix, normalized once; only `<prefix>/…` is listed and matched. */
  prefix: string;
  graceMs?: number;
  intervalMs?: number;
  pageSize?: number;
  maxDeletesPerRun?: number;
  maxPagesPerRun?: number;
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
  readonly #maxPagesPerRun: number;
  readonly #now: () => Date;
  readonly #logger?: ServiceLogger;
  readonly #onError: (error: unknown) => void;
  #inflight: Promise<SkillObjectGcSummary> | undefined;
  #stopped = false;
  #cursor: string | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SkillObjectGcOptions) {
    this.#database = options.database;
    this.#store = options.store;
    this.#prefix = normalizeSkillObjectPrefix(options.prefix);
    this.#graceMs = options.graceMs ?? SKILL_GC_DEFAULT_GRACE_MS;
    this.#intervalMs = options.intervalMs ?? SKILL_GC_DEFAULT_INTERVAL_MS;
    this.#pageSize = options.pageSize ?? SKILL_GC_DEFAULT_PAGE_SIZE;
    this.#maxDeletesPerRun = options.maxDeletesPerRun ?? SKILL_GC_DEFAULT_MAX_DELETES_PER_RUN;
    this.#maxPagesPerRun = options.maxPagesPerRun ?? SKILL_GC_DEFAULT_MAX_PAGES_PER_RUN;
    if (!Number.isSafeInteger(this.#maxPagesPerRun) || this.#maxPagesPerRun < 1)
      throw new Error("Skill GC page quota must be a positive safe integer");
    this.#now = options.now ?? (() => new Date());
    if (options.logger) this.#logger = options.logger;
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.runOnce().catch(this.#onError);
    }, this.#intervalMs);
    // A maintenance timer must not hold the process open on its own.
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#inflight;
  }

  runOnce(): Promise<SkillObjectGcSummary> {
    const summary: SkillObjectGcSummary = {
      scanned: 0,
      deleted: 0,
      skippedYoung: 0,
      skippedReferenced: 0,
      skippedForeign: 0,
      durationMs: 0,
    };
    if (this.#inflight || this.#stopped) return Promise.resolve(summary);
    const task = this.#run(summary).finally(() => {
      if (this.#inflight === task) this.#inflight = undefined;
    });
    this.#inflight = task;
    return task;
  }

  async #run(summary: SkillObjectGcSummary): Promise<SkillObjectGcSummary> {
    const startedAt = Date.now();
    for (let page = 0; page < this.#maxPagesPerRun && !this.#stopped; page += 1) {
      if (!(await this.#collectPage(summary))) break;
    }
    summary.durationMs = Date.now() - startedAt;
    this.#logger?.info({ ...summary, prefix: this.#prefix }, "Skill object GC run completed");
    return summary;
  }

  async #collectPage(summary: SkillObjectGcSummary): Promise<boolean> {
    const page = await this.#store
      .list(`${this.#prefix}/`, {
        limit: this.#pageSize,
        ...(this.#cursor === undefined ? {} : { cursor: this.#cursor }),
      })
      .catch((error) => {
        this.#cursor = undefined;
        throw error;
      });
    if (this.#stopped) return false;
    const candidates = this.#candidates(page.objects, summary);
    const referenced = await this.#referencedKeys(candidates.map((candidate) => candidate.key));
    for (const candidate of candidates) {
      if (this.#stopped || summary.deleted >= this.#maxDeletesPerRun) break;
      if (referenced.has(candidate.key) || (await this.#isReferenced(candidate.key))) {
        summary.skippedReferenced += 1;
        continue;
      }
      if (this.#stopped) break;
      await this.#deleteOne(candidate.key, summary);
    }
    this.#cursor = page.nextCursor;
    return !this.#stopped && this.#cursor !== undefined && summary.deleted < this.#maxDeletesPerRun;
  }

  /** Applies the three eligibility rules, counting the objects that are not candidates. */
  #candidates(objects: SkillObjectListEntry[], summary: SkillObjectGcSummary): SkillObjectListEntry[] {
    const cutoff = this.#now().getTime() - this.#graceMs;
    const candidates: SkillObjectListEntry[] = [];
    for (const object of objects) {
      summary.scanned += 1;
      if (!isSkillObjectKeyUnder(this.#prefix, object.key)) {
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
      if (this.#stopped) break;
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
