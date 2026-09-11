import { canonicalizeSkillManifest, type SkillManifest, type SkillSummary } from "@opentag/shared";
import { asc, inArray, type SQL, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agentSkills, skillFiles, skills } from "../../db/schema/index.js";

export type SkillDatabase = DatabaseClient | DatabaseTransaction;

export interface SkillSummaryRow {
  id: string;
  ownerAccountId: string;
  name: string;
  description: string;
  digest: string;
  archiveKey: string;
  archiveBytes: number;
  archiveSha256: string;
  fileCount: number;
  totalBytes: number;
  agentCount: number;
  updatedByKind: "user" | "session";
  updatedById: string;
  updatedAt: Date;
}

const summaryProjection = {
  id: skills.id,
  ownerAccountId: skills.ownerAccountId,
  name: skills.name,
  description: skills.description,
  digest: skills.digest,
  archiveKey: skills.archiveKey,
  archiveBytes: skills.archiveBytes,
  archiveSha256: skills.archiveSha256,
  fileCount: skills.fileCount,
  totalBytes: skills.totalBytes,
  agentCount: sql<number>`(select count(*)::int from ${agentSkills} where ${agentSkills.skillId} = ${skills.id})`,
  updatedByKind: skills.updatedByKind,
  updatedById: skills.updatedById,
  updatedAt: skills.updatedAt,
};

/** Skill rows with their live assignment count, ordered by name. */
export async function selectSkillSummaryRows(
  database: SkillDatabase,
  where: SQL,
  limit?: number,
): Promise<SkillSummaryRow[]> {
  const query = database.select(summaryProjection).from(skills).where(where).orderBy(asc(skills.name));
  const rows = limit === undefined ? await query : await query.limit(limit);
  return rows.map((row) => ({ ...row, agentCount: Number(row.agentCount) }));
}

export function toSkillSummary(row: SkillSummaryRow): SkillSummary {
  return {
    name: row.name,
    description: row.description,
    digest: row.digest,
    archiveSha256: row.archiveSha256,
    archiveBytes: row.archiveBytes,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    agentCount: row.agentCount,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: { kind: row.updatedByKind, id: row.updatedById },
  };
}

/** Canonical manifests for a set of skills, keyed by skill id. */
export async function loadSkillManifests(
  database: SkillDatabase,
  rows: ReadonlyArray<{ id: string; name: string }>,
): Promise<Map<string, SkillManifest>> {
  const manifests = new Map<string, SkillManifest>();
  if (rows.length === 0) return manifests;
  const files = await database
    .select({
      skillId: skillFiles.skillId,
      path: skillFiles.path,
      sha256: skillFiles.sha256,
      size: skillFiles.size,
      mode: skillFiles.mode,
    })
    .from(skillFiles)
    .where(
      inArray(
        skillFiles.skillId,
        rows.map((row) => row.id),
      ),
    );
  for (const row of rows) {
    const entries = files
      .filter((file) => file.skillId === row.id)
      .map(({ path, sha256, size, mode }) => ({ path, sha256, size, mode }));
    manifests.set(row.id, canonicalizeSkillManifest({ schemaVersion: 1, name: row.name, files: entries }));
  }
  return manifests;
}
