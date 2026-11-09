import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type ListAgentSkillsResponse,
  type ReadSkillFileQuery,
  type ReadSkillFileResponse,
  type RuntimeSkillManifest,
  SKILL_MAX_PER_AGENT,
  type Skill,
  type SkillArchiveFormat,
  type SkillDetail,
  type SkillSource,
} from "@opentag/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agentSkills, agents } from "../../db/schema/index.js";
import { isUniqueViolation } from "../../db/unique-violation.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { SessionCliProofService, SessionCliSourceContext } from "../sessions/session-cli-proof-service.js";
import {
  skillHashMismatch,
  skillLimitReached,
  skillNameConflict,
  skillNotFound,
  skillRevisionConflict,
  skillStorageUnavailable,
} from "./errors.js";
import { type NormalizedSkillArchive, normalizeSkillArchive } from "./skill-archive.js";
import type { SkillReadLimits } from "./skill-archive-reader.js";
import { readSkillFile } from "./skill-file-reader.js";
import {
  bestEffortDeleteSkillObject,
  discardUnreferencedObject,
  ensureObjectPresent,
  mapSkillStoreError,
} from "./skill-object-lifecycle.js";
import { type SkillObjectStore, skillObjectKey } from "./skill-object-store.js";

/**
 * Agent Skills service: the single place Skills are created, replaced, enabled, removed, listed,
 * and streamed.
 *
 * Two invariants shape this module:
 *
 * 1. **A Skill belongs to exactly one Agent.** There is no `account_id` column; ownership is resolved
 *    by joining `agents.created_by_user_id` and excluding soft-deleted Agents, so a caller from
 *    another Account and a missing Agent are deliberately indistinguishable (`SKILL_NOT_FOUND`).
 * 2. **Object keys are derived, never supplied.** The key is built from the Agent's owner, the Agent,
 *    the Skill id, and a fresh random object id for every write. Prepare the object outside SQL,
 *    guard authority and revision when updating the row, and leave the old object for GC.
 */

type SkillReadScope =
  | { accountId: string; source?: SessionCliSourceContext }
  | { computerId: string }
  | { source: SessionCliSourceContext };
type SkillExecutor = DatabaseClient | DatabaseTransaction;

export interface SkillServiceOptions {
  database: DatabaseClient;
  proofs?: Pick<SessionCliProofService, "assertCurrentSource" | "lockCurrentSource">;
  /** Absent when the deployment has no object storage; listing still works, bundles degrade. */
  store?: SkillObjectStore;
  keyPrefix: string;
  logger?: ServiceLogger;
  now?: () => Date;
  /** Overrides the archive read ceilings; production callers leave it unset for the real limits. */
  readLimits?: SkillReadLimits;
}

export interface SkillUploadInput {
  bytes: Uint8Array;
  format: SkillArchiveFormat;
  declaredSha256: string;
  replace: boolean;
  source: SkillSource;
  /**
   * The row a `replace` was decided against, for callers that decided from an earlier read.
   *
   * `replace: true` alone means "whatever currently holds this name may be overwritten", which is
   * correct for a user acting on what they see but wrong for a caller replaying an older decision:
   * the row can move on between that read and this write, and a plain `replace` would then overwrite
   * the newer content and stamp its own provenance over it. Passing the read row turns the write into
   * "replace exactly this row": a row that is gone, was replaced, or changed provenance loses the
   * race as `SKILL_REVISION_CONFLICT` instead. The check runs inside the write path against the same
   * read its conditional update uses, so no caller-side re-check can leave a window open.
   */
  expectedRow?: SkillRowExpectation;
}

/** Identity of the row an upload planned its replace against: what a write must still be looking at. */
export interface SkillRowExpectation {
  id: string;
  revision: number;
  source: SkillSource;
}

export interface SkillBundle {
  skill: SkillDetail;
  stream: ReadableStream<Uint8Array>;
  sha256: string;
  bytes: number;
}

type SkillRow = typeof agentSkills.$inferSelect;
type AgentOwner = { id: string; accountId: string };

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    source: row.source,
    archiveSha256: row.archiveSha256,
    archiveBytes: row.archiveBytes,
    fileCount: row.fileCount,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSkillDetail(row: SkillRow): SkillDetail {
  return { ...toSkill(row), files: row.files, filesTruncated: row.filesTruncated };
}

/**
 * Whether the row an upload planned against is still the row it read. Any interleaved write path
 * bumps `revision`, and provenance is compared as well so a future writer that changes `source`
 * without touching content still invalidates the plan.
 */
function matchesExpectedRow(row: SkillRow | undefined, expected: SkillRowExpectation): boolean {
  return (
    row !== undefined && row.id === expected.id && row.revision === expected.revision && row.source === expected.source
  );
}

export class SkillService {
  readonly #database: DatabaseClient;
  readonly #proofs: SkillServiceOptions["proofs"];
  readonly #store?: SkillObjectStore;
  readonly #keyPrefix: string;
  readonly #logger?: ServiceLogger;
  readonly #now: () => Date;
  readonly #readLimits?: SkillReadLimits;

  constructor(options: SkillServiceOptions) {
    this.#database = options.database;
    this.#proofs = options.proofs;
    if (options.store) this.#store = options.store;
    this.#keyPrefix = options.keyPrefix;
    if (options.logger) this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    if (options.readLimits) this.#readLimits = options.readLimits;
  }

  // ------------------------------------------------------------------ account

  async list(callerUserId: string, agentId: string): Promise<ListAgentSkillsResponse> {
    return this.#readAgent(agentId, { accountId: callerUserId }, (transaction) =>
      this.#listSkills(agentId, transaction),
    );
  }

  async get(callerUserId: string, agentId: string, skillId: string): Promise<SkillDetail> {
    const row = await this.#readAgent(agentId, { accountId: callerUserId }, (transaction) =>
      this.#requireSkill(agentId, skillId, transaction),
    );
    return toSkillDetail(row);
  }

  async upload(callerUserId: string, agentId: string, input: SkillUploadInput): Promise<SkillDetail> {
    const agent = await this.#requireAgent(callerUserId, agentId);
    return this.#upload(agent.accountId, agentId, input);
  }

  async setEnabled(callerUserId: string, agentId: string, skillId: string, enabled: boolean): Promise<SkillDetail> {
    const row = await this.#database.transaction(async (transaction) => {
      await this.#lockAgent(transaction, callerUserId, agentId);
      const existing = await this.#requireSkill(agentId, skillId, transaction);
      const [updated] = await transaction
        .update(agentSkills)
        .set({ enabled, updatedAt: this.#now() })
        .where(and(eq(agentSkills.id, existing.id), eq(agentSkills.revision, existing.revision)))
        .returning();
      if (!updated) throw skillRevisionConflict();
      return updated;
    });
    this.#logger?.info(
      { agentId, enabled, skillId: row.id, name: row.name },
      enabled ? "Skill enabled" : "Skill disabled",
    );
    return toSkillDetail(row);
  }

  async remove(callerUserId: string, agentId: string, skillId: string): Promise<void> {
    const row = await this.#database.transaction(async (transaction) => {
      await this.#lockAgent(transaction, callerUserId, agentId);
      const existing = await this.#requireSkill(agentId, skillId, transaction);
      const [deleted] = await transaction
        .delete(agentSkills)
        .where(and(eq(agentSkills.id, existing.id), eq(agentSkills.revision, existing.revision)))
        .returning();
      if (!deleted) throw skillRevisionConflict();
      return deleted;
    });
    if (this.#store) {
      await bestEffortDeleteSkillObject(this.#store, row.objectKey, "removed Skill", this.#logger, {
        agentId: row.agentId,
        skillId: row.id,
      });
    } else {
      this.#logger?.warn(
        { agentId, skillId: row.id, name: row.name },
        "Skill storage is unavailable; the removed Skill's object cannot be cleaned up",
      );
    }
    this.#logger?.info({ agentId, skillId: row.id, name: row.name }, "Skill removed");
  }

  async openBundle(callerUserId: string, agentId: string, skillId: string): Promise<SkillBundle> {
    const row = await this.#readAgent(agentId, { accountId: callerUserId }, (transaction) =>
      this.#requireSkill(agentId, skillId, transaction),
    );
    return this.#openBundle(row);
  }

  async readFile(
    callerUserId: string,
    agentId: string,
    skillId: string,
    query: ReadSkillFileQuery,
  ): Promise<ReadSkillFileResponse> {
    const row = await this.#readAgent(agentId, { accountId: callerUserId }, (transaction) =>
      this.#requireSkill(agentId, skillId, transaction),
    );
    if (query.archiveSha256 !== row.archiveSha256) throw skillRevisionConflict();
    return readSkillFile(await this.#openBundle(row), query.path, this.#readLimits);
  }

  // ----------------------------------------------------------------- computer

  async manifestForComputer(computerId: string, agentId: string): Promise<RuntimeSkillManifest> {
    const rows = await this.#readAgent(agentId, { computerId }, (transaction) =>
      transaction
        .select()
        .from(agentSkills)
        .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.enabled, true)))
        .orderBy(asc(agentSkills.name)),
    );
    return {
      skills: rows.map((row) => ({
        id: row.id,
        name: row.name,
        archiveSha256: row.archiveSha256,
        archiveBytes: row.archiveBytes,
      })),
    };
  }

  async openBundleForComputer(computerId: string, agentId: string, skillId: string): Promise<SkillBundle> {
    const row = await this.#readAgent(agentId, { computerId }, (transaction) =>
      this.#requireSkill(agentId, skillId, transaction),
    );
    if (!row.enabled) throw skillNotFound();
    return this.#openBundle(row);
  }

  // -------------------------------------------------------------- agent (cli)

  async listForAgent(source: SessionCliSourceContext): Promise<ListAgentSkillsResponse> {
    return this.#readAgent(source.agentId, { source }, (transaction) => this.#listSkills(source.agentId, transaction));
  }

  async uploadForAgent(
    runtimeSource: SessionCliSourceContext,
    input: Omit<SkillUploadInput, "source">,
    source: SkillSource = "agent_upload",
  ): Promise<SkillDetail> {
    const agent = await this.#readAgent(
      runtimeSource.agentId,
      { source: runtimeSource },
      async (_transaction, owner) => owner,
    );
    return this.#upload(agent.accountId, agent.id, { ...input, source }, runtimeSource);
  }

  async openBundleForAgent(source: SessionCliSourceContext, name: string): Promise<SkillBundle> {
    const row = await this.#readAgent(source.agentId, { source }, (transaction) =>
      this.#findByName(source.agentId, name, transaction),
    );
    if (!row) throw skillNotFound();
    return this.#openBundle(row);
  }

  // ------------------------------------------------------------------ shared

  async #listSkills(agentId: string, executor: SkillExecutor = this.#database): Promise<ListAgentSkillsResponse> {
    const rows = await executor
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
      .orderBy(asc(agentSkills.name));
    return { skills: rows.map(toSkill), storage: this.#store ? "available" : "unavailable" };
  }

  async #upload(
    accountId: string,
    agentId: string,
    input: SkillUploadInput,
    runtimeSource?: SessionCliSourceContext,
  ): Promise<SkillDetail> {
    const actual = createHash("sha256").update(input.bytes).digest("hex");
    if (actual !== input.declaredSha256) throw skillHashMismatch();
    const normalizeStartedAtMs = Date.now();
    const normalized = await normalizeSkillArchive(input.bytes, input.format, this.#readLimits);
    this.#logger?.debug(
      {
        agentId,
        bytes: normalized.archive.byteLength,
        fileCount: normalized.fileCount,
        source: input.source,
        normalizeDurationMs: Math.max(0, Date.now() - normalizeStartedAtMs),
      },
      "Skill archive validated",
    );
    const existing = await this.#readAgent(
      agentId,
      { accountId, ...(runtimeSource ? { source: runtimeSource } : {}) },
      async (transaction) => {
        const row = await this.#findByName(agentId, normalized.manifest.name, transaction);
        if (!row && (await this.#countSkills(agentId, transaction)) >= SKILL_MAX_PER_AGENT) throw skillLimitReached();
        return row;
      },
    );
    if (existing && !input.replace) throw skillNameConflict();
    if (input.expectedRow !== undefined && !matchesExpectedRow(existing, input.expectedRow)) {
      throw skillRevisionConflict("The Skill changed concurrently; retry the upload");
    }
    return existing
      ? this.#replaceSkill(accountId, existing, input, normalized, runtimeSource)
      : this.#insertSkill(accountId, agentId, input, normalized, runtimeSource);
  }

  async #insertSkill(
    accountId: string,
    agentId: string,
    input: SkillUploadInput,
    normalized: NormalizedSkillArchive,
    runtimeSource?: SessionCliSourceContext,
  ): Promise<SkillDetail> {
    const store = this.#requireStore();
    const skillId = randomUUID();
    const objectKey = skillObjectKey({
      prefix: this.#keyPrefix,
      accountId,
      agentId,
      skillId,
      objectId: randomBytes(32).toString("hex"),
    });
    await this.#putObject(store, objectKey, normalized.archive, normalized.sha256);
    const now = this.#now();
    let row: SkillRow | undefined;
    try {
      // The try covers only final admission. Nothing after a committed insert may ever delete its object:
      // the row would be left pointing at a missing object, which no retry could repair. The catch's
      // cleanup is therefore conditional — it deletes only when the row is absent.
      [row] = await this.#database.transaction(async (transaction) => {
        await this.#lockSkillAdmission(transaction, accountId, agentId, normalized.manifest.name, runtimeSource);
        return transaction
          .insert(agentSkills)
          .values({
            id: skillId,
            agentId,
            name: normalized.manifest.name,
            description: normalized.manifest.description,
            enabled: true,
            source: input.source,
            objectKey,
            archiveSha256: normalized.sha256,
            archiveBytes: normalized.archive.byteLength,
            fileCount: normalized.fileCount,
            files: normalized.files,
            filesTruncated: normalized.filesTruncated,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
      });
      if (!row) throw new Error("The Skill insert returned no row");
    } catch (error) {
      // The insert may have committed before the failure surfaced — a dropped connection returns no
      // result even though the row landed — so the guard re-reads the row by id and deletes the
      // object only while it is ABSENT. An unreadable row is treated as do-not-delete.
      await discardUnreferencedObject(this.#database, store, objectKey, skillId, this.#logger);
      if (isUniqueViolation(error, "agent_skills_agent_name_unique")) throw skillNameConflict();
      throw error;
    }
    // No `ensureObjectPresent`: no other writer can hold a key under a brand-new skill id, so there
    // is no concurrent delete to repair — only an extra failure mode after the row already committed.
    this.#logUpload("Skill uploaded", row, normalized.sha256);
    return toSkillDetail(row);
  }

  async #replaceSkill(
    accountId: string,
    existing: SkillRow,
    input: SkillUploadInput,
    normalized: NormalizedSkillArchive,
    runtimeSource?: SessionCliSourceContext,
  ): Promise<SkillDetail> {
    const store = this.#requireStore();
    const objectKey = skillObjectKey({
      prefix: this.#keyPrefix,
      accountId,
      agentId: existing.agentId,
      skillId: existing.id,
      objectId: randomBytes(32).toString("hex"),
    });
    await this.#putObject(store, objectKey, normalized.archive, normalized.sha256);
    let row: SkillRow | undefined;
    try {
      [row] = await this.#database.transaction(async (transaction) => {
        await this.#lockAgent(transaction, accountId, existing.agentId, runtimeSource);
        return (
          transaction
            .update(agentSkills)
            .set({
              description: normalized.manifest.description,
              source: input.source,
              objectKey,
              archiveSha256: normalized.sha256,
              archiveBytes: normalized.archive.byteLength,
              fileCount: normalized.fileCount,
              files: normalized.files,
              filesTruncated: normalized.filesTruncated,
              revision: sql`${agentSkills.revision} + 1`,
              updatedAt: this.#now(),
            })
            // Optimistic concurrency: a replace built on a stale read changes nothing. If another writer
            // moved the row since we read it, this matches zero rows and we must not touch its object.
            .where(and(eq(agentSkills.id, existing.id), eq(agentSkills.revision, existing.revision)))
            .returning()
        );
      });
    } catch (error) {
      // A failed acknowledgement can follow a committed write; retain its referenced object.
      await discardUnreferencedObject(this.#database, store, objectKey, existing.id, this.#logger);
      throw error;
    }
    if (!row) {
      await discardUnreferencedObject(this.#database, store, objectKey, existing.id, this.#logger);
      throw skillRevisionConflict("The Skill changed concurrently; retry the upload");
    }
    // Leave previous objects to GC's grace period and reference checks, including legacy keys that
    // an older writer can reuse during a rolling deployment.
    // Deliberately outside the update's try/catch: the row is already committed, so a failure here
    // surfaces as SKILL_STORAGE_UNAVAILABLE and must never trigger cleanup of `objectKey`.
    await ensureObjectPresent(this.#database, store, objectKey, row.id, normalized, this.#logger);
    this.#logUpload("Skill replaced", row, normalized.sha256);
    return toSkillDetail(row);
  }

  async #openBundle(row: SkillRow): Promise<SkillBundle> {
    const store = this.#requireStore();
    const startedAtMs = Date.now();
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await store.get(row.objectKey);
    } catch (error) {
      throw mapSkillStoreError(error);
    }
    this.#logger?.info(
      {
        agentId: row.agentId,
        bytes: row.archiveBytes,
        skillId: row.id,
        name: row.name,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      },
      "Skill bundle opened",
    );
    return { skill: toSkillDetail(row), stream, sha256: row.archiveSha256, bytes: row.archiveBytes };
  }

  #requireStore(): SkillObjectStore {
    if (!this.#store) throw skillStorageUnavailable();
    return this.#store;
  }

  async #putObject(store: SkillObjectStore, key: string, body: Uint8Array, sha256: string): Promise<void> {
    try {
      await store.put(key, body, { sha256 });
    } catch (error) {
      throw mapSkillStoreError(error);
    }
  }

  #logUpload(message: string, row: SkillRow, sha256: string): void {
    this.#logger?.info(
      {
        agentId: row.agentId,
        bytes: row.archiveBytes,
        fileCount: row.fileCount,
        name: row.name,
        revision: row.revision,
        sha256: sha256.slice(0, 12),
        skillId: row.id,
        source: row.source,
      },
      message,
    );
  }

  async #findByName(
    agentId: string,
    name: string,
    executor: SkillExecutor = this.#database,
  ): Promise<SkillRow | undefined> {
    const [row] = await executor
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), sql`lower(${agentSkills.name}) = ${name.toLowerCase()}`))
      .limit(1);
    return row;
  }

  async #requireSkill(agentId: string, skillId: string, executor: SkillExecutor = this.#database): Promise<SkillRow> {
    const [row] = await executor
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.id, skillId), eq(agentSkills.agentId, agentId)))
      .limit(1);
    if (!row) throw skillNotFound();
    return row;
  }

  async #countSkills(agentId: string, executor: SkillExecutor = this.#database): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId));
    return row?.count ?? 0;
  }

  async #lockSkillAdmission(
    transaction: DatabaseTransaction,
    accountId: string,
    agentId: string,
    name: string,
    runtimeSource?: SessionCliSourceContext,
  ) {
    await this.#lockAgent(transaction, accountId, agentId, runtimeSource);
    const [current] = await transaction
      .select({
        count: sql<number>`count(*)::int`,
        nameExists: sql<boolean>`coalesce(bool_or(lower(${agentSkills.name}) = ${name.toLowerCase()}), false)`,
      })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId));
    if (current?.nameExists) throw skillNameConflict();
    if ((current?.count ?? 0) >= SKILL_MAX_PER_AGENT) throw skillLimitReached();
  }

  /** An Agent is owned by the Account that created it, and a deleted Agent is not addressable. */
  async #requireAgent(callerUserId: string, agentId: string): Promise<AgentOwner> {
    const [row] = await this.#database
      .select({ id: agents.id, createdByUserId: agents.createdByUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, callerUserId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw skillNotFound("The Agent was not found");
    return { id: row.id, accountId: row.createdByUserId };
  }

  async #readAgent<T>(
    agentId: string,
    access: SkillReadScope,
    read: (transaction: DatabaseTransaction, owner: AgentOwner) => Promise<T>,
  ): Promise<T> {
    return this.#database.transaction(
      async (transaction) => {
        const conditions = [eq(agents.id, agentId), ne(agents.status, "deleted")];
        if ("accountId" in access) conditions.push(eq(agents.createdByUserId, access.accountId));
        if ("computerId" in access) conditions.push(eq(agents.computerId, access.computerId));
        if ("source" in access && access.source) conditions.push(eq(agents.id, access.source.agentId));
        const [row] = await transaction
          .select({ id: agents.id, accountId: agents.createdByUserId })
          .from(agents)
          .where(and(...conditions))
          .limit(1);
        if (!row) throw skillNotFound("The Agent was not found");
        if ("source" in access && access.source)
          await this.#proofAuthority().assertCurrentSource(transaction, access.source);
        return read(transaction, row);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async #lockAgent(
    transaction: DatabaseTransaction,
    accountId: string,
    agentId: string,
    source?: SessionCliSourceContext,
  ): Promise<void> {
    const [agent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.createdByUserId, accountId),
          ne(agents.status, "deleted"),
          source ? eq(agents.id, source.agentId) : undefined,
        ),
      )
      .for("no key update");
    if (!agent) throw skillNotFound("The Agent was not found");
    if (source) await this.#proofAuthority().lockCurrentSource(transaction, source);
  }

  #proofAuthority() {
    if (!this.#proofs) throw new Error("Session proof authority is not configured");
    return this.#proofs;
  }
}
