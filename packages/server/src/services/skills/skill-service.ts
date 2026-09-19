import { createHash, randomUUID } from "node:crypto";
import {
  type ListAgentSkillsResponse,
  type RuntimeSkillManifest,
  SKILL_MAX_PER_AGENT,
  type Skill,
  type SkillArchiveFormat,
  type SkillDetail,
  type SkillSource,
} from "@opentag/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentSkills, agents } from "../../db/schema/index.js";
import { isUniqueViolation } from "../../db/unique-violation.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import {
  SkillServiceError,
  skillHashMismatch,
  skillLimitReached,
  skillNameConflict,
  skillNotFound,
  skillStorageFailure,
  skillStorageUnavailable,
} from "./errors.js";
import { type NormalizedSkillArchive, normalizeSkillArchive } from "./skill-archive.js";
import { type SkillObjectStore, SkillObjectStoreError, skillObjectKey } from "./skill-object-store.js";

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
 *    the Skill id, and the Server's own sha256, which is what makes a replace safe without a lock:
 *    write the new key, update the row, then best-effort delete the old key.
 */

export interface SkillServiceOptions {
  database: DatabaseClient;
  /** Absent when the deployment has no object storage; listing still works, bundles degrade. */
  store?: SkillObjectStore;
  keyPrefix: string;
  logger?: ServiceLogger;
  now?: () => Date;
}

export interface SkillUploadInput {
  bytes: Uint8Array;
  format: SkillArchiveFormat;
  declaredSha256: string;
  replace: boolean;
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

export class SkillService {
  readonly #database: DatabaseClient;
  readonly #store?: SkillObjectStore;
  readonly #keyPrefix: string;
  readonly #logger?: ServiceLogger;
  readonly #now: () => Date;

  constructor(options: SkillServiceOptions) {
    this.#database = options.database;
    if (options.store) this.#store = options.store;
    this.#keyPrefix = options.keyPrefix;
    if (options.logger) this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ account

  async list(callerUserId: string, agentId: string): Promise<ListAgentSkillsResponse> {
    await this.#requireAgent(callerUserId, agentId);
    return this.#listSkills(agentId);
  }

  async get(callerUserId: string, agentId: string, skillId: string): Promise<SkillDetail> {
    await this.#requireAgent(callerUserId, agentId);
    return toSkillDetail(await this.#requireSkill(agentId, skillId));
  }

  async upload(callerUserId: string, agentId: string, input: SkillUploadInput): Promise<SkillDetail> {
    const agent = await this.#requireAgent(callerUserId, agentId);
    return this.#upload(agent.accountId, agentId, input);
  }

  async setEnabled(callerUserId: string, agentId: string, skillId: string, enabled: boolean): Promise<SkillDetail> {
    await this.#requireAgent(callerUserId, agentId);
    const existing = await this.#requireSkill(agentId, skillId);
    const [row] = await this.#database
      .update(agentSkills)
      .set({ enabled, updatedAt: this.#now() })
      .where(eq(agentSkills.id, existing.id))
      .returning();
    if (!row) throw skillNotFound();
    this.#logger?.info(
      { agentId, enabled, skillId: row.id, name: row.name },
      enabled ? "Skill enabled" : "Skill disabled",
    );
    return toSkillDetail(row);
  }

  async remove(callerUserId: string, agentId: string, skillId: string): Promise<void> {
    await this.#requireAgent(callerUserId, agentId);
    const existing = await this.#requireSkill(agentId, skillId);
    await this.#database.delete(agentSkills).where(eq(agentSkills.id, existing.id));
    if (this.#store) {
      await this.#bestEffortDelete(this.#store, existing.objectKey, "removed Skill", existing);
    } else {
      this.#logger?.warn(
        { agentId, skillId: existing.id, name: existing.name },
        "Skill storage is unavailable; the removed Skill's object cannot be cleaned up",
      );
    }
    this.#logger?.info({ agentId, skillId: existing.id, name: existing.name }, "Skill removed");
  }

  async openBundle(callerUserId: string, agentId: string, skillId: string): Promise<SkillBundle> {
    await this.#requireAgent(callerUserId, agentId);
    return this.#openBundle(await this.#requireSkill(agentId, skillId));
  }

  // ----------------------------------------------------------------- computer

  async manifestForComputer(computerId: string, agentId: string): Promise<RuntimeSkillManifest> {
    await this.#requireComputerAgent(computerId, agentId);
    const rows = await this.#database
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.enabled, true)))
      .orderBy(asc(agentSkills.name));
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
    await this.#requireComputerAgent(computerId, agentId);
    return this.#openBundle(await this.#requireSkill(agentId, skillId));
  }

  // -------------------------------------------------------------- agent (cli)

  async listForAgent(agentId: string): Promise<ListAgentSkillsResponse> {
    await this.#requireActiveAgent(agentId);
    return this.#listSkills(agentId);
  }

  async uploadForAgent(agentId: string, input: Omit<SkillUploadInput, "source">): Promise<SkillDetail> {
    const agent = await this.#requireActiveAgent(agentId);
    return this.#upload(agent.accountId, agentId, { ...input, source: "agent_upload" });
  }

  async openBundleForAgent(agentId: string, name: string): Promise<SkillBundle> {
    await this.#requireActiveAgent(agentId);
    const row = await this.#findByName(agentId, name);
    if (!row) throw skillNotFound();
    return this.#openBundle(row);
  }

  // ------------------------------------------------------------------ shared

  async #listSkills(agentId: string): Promise<ListAgentSkillsResponse> {
    const rows = await this.#database
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
      .orderBy(asc(agentSkills.name));
    return { skills: rows.map(toSkill), storage: this.#store ? "available" : "unavailable" };
  }

  async #upload(accountId: string, agentId: string, input: SkillUploadInput): Promise<SkillDetail> {
    const actual = createHash("sha256").update(input.bytes).digest("hex");
    if (actual !== input.declaredSha256) throw skillHashMismatch();
    const normalized = await normalizeSkillArchive(input.bytes, input.format);
    this.#logger?.debug(
      { agentId, bytes: normalized.archive.byteLength, fileCount: normalized.fileCount, source: input.source },
      "Skill archive validated",
    );
    const existing = await this.#findByName(agentId, normalized.manifest.name);
    if (existing && !input.replace) throw skillNameConflict();
    return existing
      ? this.#replaceSkill(accountId, existing, input, normalized)
      : this.#insertSkill(accountId, agentId, input, normalized);
  }

  async #insertSkill(
    accountId: string,
    agentId: string,
    input: SkillUploadInput,
    normalized: NormalizedSkillArchive,
  ): Promise<SkillDetail> {
    if ((await this.#countSkills(agentId)) >= SKILL_MAX_PER_AGENT) throw skillLimitReached();
    const store = this.#requireStore();
    const skillId = randomUUID();
    const objectKey = skillObjectKey({
      prefix: this.#keyPrefix,
      accountId,
      agentId,
      skillId,
      sha256: normalized.sha256,
    });
    await this.#putObject(store, objectKey, normalized.archive, normalized.sha256);
    const now = this.#now();
    try {
      const [row] = await this.#database
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
      if (!row) throw new Error("The Skill insert returned no row");
      this.#logUpload("Skill uploaded", row, normalized.sha256);
      return toSkillDetail(row);
    } catch (error) {
      await this.#bestEffortDelete(store, objectKey, "new Skill object after a failed row write");
      if (isUniqueViolation(error, "agent_skills_agent_name_unique")) throw skillNameConflict();
      throw error;
    }
  }

  async #replaceSkill(
    accountId: string,
    existing: SkillRow,
    input: SkillUploadInput,
    normalized: NormalizedSkillArchive,
  ): Promise<SkillDetail> {
    const store = this.#requireStore();
    const objectKey = skillObjectKey({
      prefix: this.#keyPrefix,
      accountId,
      agentId: existing.agentId,
      skillId: existing.id,
      sha256: normalized.sha256,
    });
    await this.#putObject(store, objectKey, normalized.archive, normalized.sha256);
    let row: SkillRow | undefined;
    try {
      [row] = await this.#database
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
        .where(eq(agentSkills.id, existing.id))
        .returning();
    } catch (error) {
      await this.#bestEffortDelete(store, objectKey, "new Skill object after a failed replace write", existing);
      throw error;
    }
    if (!row) {
      await this.#bestEffortDelete(store, objectKey, "new Skill object after a missing replace row", existing);
      throw skillNotFound();
    }
    if (existing.objectKey !== objectKey) {
      await this.#bestEffortDelete(store, existing.objectKey, "replaced Skill object", existing);
    }
    this.#logUpload("Skill replaced", row, normalized.sha256);
    return toSkillDetail(row);
  }

  async #openBundle(row: SkillRow): Promise<SkillBundle> {
    const store = this.#requireStore();
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await store.get(row.objectKey);
    } catch (error) {
      throw this.#mapStoreError(error);
    }
    this.#logger?.info(
      { agentId: row.agentId, bytes: row.archiveBytes, skillId: row.id, name: row.name },
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
      throw this.#mapStoreError(error);
    }
  }

  /** Best-effort object cleanup: a failure is logged and never fails the request it belongs to. */
  async #bestEffortDelete(
    store: SkillObjectStore,
    key: string,
    context: string,
    row?: { agentId: string; id: string },
  ): Promise<void> {
    try {
      await store.delete(key);
    } catch (error) {
      this.#logger?.warn(
        {
          key,
          ...(row ? { agentId: row.agentId, skillId: row.id } : {}),
          code: error instanceof SkillObjectStoreError ? error.code : "unknown",
        },
        `Skill object cleanup failed: ${context}`,
      );
    }
  }

  #mapStoreError(error: unknown): SkillServiceError {
    if (error instanceof SkillServiceError) return error;
    if (error instanceof SkillObjectStoreError && error.code === "not_found") {
      return skillNotFound("The Skill bundle is missing from storage");
    }
    return skillStorageFailure();
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

  async #findByName(agentId: string, name: string): Promise<SkillRow | undefined> {
    const [row] = await this.#database
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), sql`lower(${agentSkills.name}) = ${name.toLowerCase()}`))
      .limit(1);
    return row;
  }

  async #requireSkill(agentId: string, skillId: string): Promise<SkillRow> {
    const [row] = await this.#database
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.id, skillId), eq(agentSkills.agentId, agentId)))
      .limit(1);
    if (!row) throw skillNotFound();
    return row;
  }

  async #countSkills(agentId: string): Promise<number> {
    const [row] = await this.#database
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId));
    return row?.count ?? 0;
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

  async #requireActiveAgent(agentId: string): Promise<AgentOwner> {
    const [row] = await this.#database
      .select({ id: agents.id, createdByUserId: agents.createdByUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw skillNotFound("The Agent was not found");
    return { id: row.id, accountId: row.createdByUserId };
  }

  async #requireComputerAgent(computerId: string, agentId: string): Promise<AgentOwner> {
    const [row] = await this.#database
      .select({ id: agents.id, createdByUserId: agents.createdByUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.computerId, computerId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw skillNotFound("The Agent was not found");
    return { id: row.id, accountId: row.createdByUserId };
  }
}
