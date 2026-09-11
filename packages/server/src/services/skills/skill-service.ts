import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  type ListSkillsResponse,
  SKILLS_PER_ACCOUNT_MAX,
  type SkillDetail,
  type SkillListQuery,
  type SkillOnConflict,
  type SkillUpdatedBy,
} from "@opentag/shared";
import { and, count, eq, gt, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agentSkills, agents, skillFiles, skills } from "../../db/schema/index.js";
import { isUniqueViolation } from "../../db/unique-violation.js";
import type { ServiceLogger } from "../../observability/index.js";
import {
  skillAlreadyExists,
  skillNotFound,
  skillQuotaExceeded,
  skillResourceNotFound,
  skillStorageUnavailable,
} from "./errors.js";
import { type ExtractedSkillArchive, extractSkillArchive, repackSkillArchive } from "./skill-archive.js";
import type { SkillBlobStore } from "./skill-blob-store.js";
import { type BuiltSkillManifest, buildSkillManifest } from "./skill-manifest.js";
import { loadSkillManifests, type SkillSummaryRow, selectSkillSummaryRows, toSkillSummary } from "./skill-rows.js";

export interface UpsertSkillOptions {
  onConflict: SkillOnConflict;
  updatedBy: SkillUpdatedBy;
  /** Assign the skill to this agent in the same transaction; used by in-session pushes. */
  autoAssignAgentId?: string;
}

export interface UpsertSkillResult {
  skill: SkillDetail;
  created: boolean;
  /** Agents whose assigned set changed content or membership; the notifier fans these out. */
  affectedAgentIds: string[];
}

export interface OpenedSkillArchive {
  name: string;
  archiveSha256: string;
  archiveBytes: number;
  /** Fetches the object lazily so a conditional request that hits the ETag never touches storage. */
  open(): Promise<{ stream: Readable; contentLength: number }>;
}

export interface SkillServiceOptions {
  logger?: ServiceLogger;
  now?: () => Date;
}

const SKILLS_OWNER_NAME_UNIQUE = "skills_owner_name_unique";
const noopLogger: ServiceLogger = { debug() {}, info() {}, warn() {}, error() {} };

interface PreparedUpload {
  extracted: ExtractedSkillArchive;
  built: BuiltSkillManifest;
  archive: { bytes: Uint8Array; sha256: string };
}

function prepareUpload(bytes: Uint8Array): PreparedUpload {
  const extracted = extractSkillArchive(bytes);
  const built = buildSkillManifest(extracted.name, extracted.files);
  return { extracted, built, archive: repackSkillArchive(extracted.files) };
}

export class SkillService {
  readonly #database: DatabaseClient;
  readonly #store: SkillBlobStore;
  readonly #logger: ServiceLogger;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, store: SkillBlobStore, options: SkillServiceOptions = {}) {
    this.#database = database;
    this.#store = store;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
  }

  async list(ownerAccountId: string, query: SkillListQuery): Promise<ListSkillsResponse> {
    const where = query.cursor
      ? and(eq(skills.ownerAccountId, ownerAccountId), gt(skills.name, query.cursor))
      : eq(skills.ownerAccountId, ownerAccountId);
    const rows = await selectSkillSummaryRows(
      this.#database,
      where ?? eq(skills.ownerAccountId, ownerAccountId),
      query.limit + 1,
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      skills: page.map(toSkillSummary),
      nextCursor: rows.length > query.limit && last ? last.name : null,
    };
  }

  async get(ownerAccountId: string, name: string): Promise<SkillDetail> {
    return this.#detail(await this.#requireRow(ownerAccountId, name));
  }

  async getSkillMd(ownerAccountId: string, name: string): Promise<{ name: string; markdown: string }> {
    const [row] = await this.#database
      .select({ name: skills.name, markdown: skills.skillMd })
      .from(skills)
      .where(and(eq(skills.ownerAccountId, ownerAccountId), eq(skills.name, name)))
      .limit(1);
    if (!row) throw skillNotFound();
    return row;
  }

  async upsertFromArchive(
    ownerAccountId: string,
    bytes: Uint8Array,
    options: UpsertSkillOptions,
  ): Promise<UpsertSkillResult> {
    const prepared = prepareUpload(bytes);
    const name = prepared.extracted.name;
    const existing = await this.#findRow(ownerAccountId, name);
    if (existing && options.onConflict === "fail") throw skillAlreadyExists(name);
    if (!existing) await this.#assertQuota(ownerAccountId);
    const skillId = existing?.id ?? randomUUID();
    const archiveKey = `${ownerAccountId}/${skillId}/${prepared.built.digest}.zip`;
    await this.#store.put(archiveKey, prepared.archive.bytes, prepared.archive.sha256);
    try {
      await this.#writeSkill({ ownerAccountId, skillId, archiveKey, prepared, existing, options });
    } catch (error) {
      if (existing?.archiveKey !== archiveKey) await this.#deleteObjectBestEffort(archiveKey);
      throw error;
    }
    if (existing && existing.archiveKey !== archiveKey) await this.#deleteObjectBestEffort(existing.archiveKey);
    const skill = await this.get(ownerAccountId, name);
    const affectedAgentIds = await this.#assignedAgentIds(skillId);
    this.#logger.info(
      {
        ownerAccountId,
        skillId,
        name,
        digest: prepared.built.digest,
        replaced: Boolean(existing),
        updatedBy: options.updatedBy,
      },
      existing ? "Skill replaced" : "Skill created",
    );
    return { skill, created: !existing, affectedAgentIds };
  }

  async delete(ownerAccountId: string, name: string): Promise<{ affectedAgentIds: string[] }> {
    const row = await this.#requireRow(ownerAccountId, name);
    const affectedAgentIds = await this.#assignedAgentIds(row.id);
    await this.#database.delete(skills).where(eq(skills.id, row.id));
    await this.#deleteObjectBestEffort(row.archiveKey);
    this.#logger.info({ ownerAccountId, skillId: row.id, name }, "Skill deleted");
    return { affectedAgentIds };
  }

  async openArchive(ownerAccountId: string, name: string): Promise<OpenedSkillArchive> {
    return this.#openRow(await this.#requireRow(ownerAccountId, name));
  }

  /** For runtime downloads, after the caller has already proven the skill is assigned to one of its agents. */
  async openArchiveById(skillId: string): Promise<OpenedSkillArchive> {
    const [row] = await selectSkillSummaryRows(this.#database, eq(skills.id, skillId), 1);
    if (!row) throw skillNotFound();
    return this.#openRow(row);
  }

  #openRow(row: SkillSummaryRow): OpenedSkillArchive {
    return {
      name: row.name,
      archiveSha256: row.archiveSha256,
      archiveBytes: row.archiveBytes,
      open: async () => {
        const opened = await this.#store.open(row.archiveKey);
        if (!opened) {
          this.#logger.error({ skillId: row.id, archiveKey: row.archiveKey }, "Skill archive object is missing");
          throw skillStorageUnavailable();
        }
        return opened;
      },
    };
  }

  async #detail(row: SkillSummaryRow): Promise<SkillDetail> {
    const manifests = await loadSkillManifests(this.#database, [row]);
    const manifest = manifests.get(row.id);
    if (!manifest) throw skillNotFound();
    return { ...toSkillSummary(row), manifest };
  }

  async #findRow(ownerAccountId: string, name: string): Promise<SkillSummaryRow | undefined> {
    const [row] = await selectSkillSummaryRows(
      this.#database,
      and(eq(skills.ownerAccountId, ownerAccountId), eq(skills.name, name)) ?? eq(skills.name, name),
      1,
    );
    return row;
  }

  async #requireRow(ownerAccountId: string, name: string): Promise<SkillSummaryRow> {
    const row = await this.#findRow(ownerAccountId, name);
    if (!row) throw skillNotFound();
    return row;
  }

  async #assertQuota(ownerAccountId: string): Promise<void> {
    const [row] = await this.#database
      .select({ total: count() })
      .from(skills)
      .where(eq(skills.ownerAccountId, ownerAccountId));
    if ((row?.total ?? 0) >= SKILLS_PER_ACCOUNT_MAX) throw skillQuotaExceeded(SKILLS_PER_ACCOUNT_MAX);
  }

  async #assignedAgentIds(skillId: string): Promise<string[]> {
    const rows = await this.#database
      .select({ agentId: agentSkills.agentId })
      .from(agentSkills)
      .where(eq(agentSkills.skillId, skillId));
    return rows.map((row) => row.agentId);
  }

  async #writeSkill(input: {
    ownerAccountId: string;
    skillId: string;
    archiveKey: string;
    prepared: PreparedUpload;
    existing: SkillSummaryRow | undefined;
    options: UpsertSkillOptions;
  }): Promise<void> {
    try {
      await this.#database.transaction(async (transaction) => {
        await this.#upsertRow(transaction, input);
        await transaction.delete(skillFiles).where(eq(skillFiles.skillId, input.skillId));
        await transaction
          .insert(skillFiles)
          .values(input.prepared.built.manifest.files.map((file) => ({ skillId: input.skillId, ...file })));
        if (input.options.autoAssignAgentId) {
          await this.#assignInTransaction(
            transaction,
            input.ownerAccountId,
            input.options.autoAssignAgentId,
            input.skillId,
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, SKILLS_OWNER_NAME_UNIQUE)) throw skillAlreadyExists(input.prepared.extracted.name);
      throw error;
    }
  }

  async #upsertRow(
    transaction: DatabaseTransaction,
    input: {
      ownerAccountId: string;
      skillId: string;
      archiveKey: string;
      prepared: PreparedUpload;
      existing: SkillSummaryRow | undefined;
      options: UpsertSkillOptions;
    },
  ): Promise<void> {
    const { prepared, options } = input;
    const now = this.#now();
    const values = {
      description: prepared.extracted.description,
      skillMd: prepared.extracted.skillMd,
      digest: prepared.built.digest,
      archiveKey: input.archiveKey,
      archiveBytes: prepared.archive.bytes.byteLength,
      archiveSha256: prepared.archive.sha256,
      fileCount: prepared.built.fileCount,
      totalBytes: prepared.built.totalBytes,
      updatedByKind: options.updatedBy.kind,
      updatedById: options.updatedBy.id,
      updatedAt: now,
    };
    if (input.existing) {
      await transaction.update(skills).set(values).where(eq(skills.id, input.skillId));
      return;
    }
    await transaction.insert(skills).values({
      id: input.skillId,
      ownerAccountId: input.ownerAccountId,
      name: prepared.extracted.name,
      createdAt: now,
      ...values,
    });
  }

  async #assignInTransaction(
    transaction: DatabaseTransaction,
    ownerAccountId: string,
    agentId: string,
    skillId: string,
  ): Promise<void> {
    const [agent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, ownerAccountId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw skillResourceNotFound();
    await transaction.insert(agentSkills).values({ agentId, skillId }).onConflictDoNothing();
  }

  async #deleteObjectBestEffort(archiveKey: string): Promise<void> {
    try {
      await this.#store.delete(archiveKey);
    } catch (error) {
      this.#logger.warn(
        { archiveKey, err: error },
        "Skill archive object could not be deleted; the sweeper will retry",
      );
    }
  }
}
