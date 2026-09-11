import {
  type AgentSkillsResponse,
  computeAgentSkillsDigest,
  type RuntimeAgentSkills,
  type RuntimeSkillsManifest,
  type SkillAgentsResponse,
} from "@opentag/shared";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentSkills, agents, skills } from "../../db/schema/index.js";
import { skillNotFound, skillResourceNotFound } from "./errors.js";
import {
  loadSkillManifests,
  type SkillDatabase,
  type SkillSummaryRow,
  selectSkillSummaryRows,
  toSkillSummary,
} from "./skill-rows.js";

interface OwnedAgent {
  id: string;
  ownerAccountId: string;
}

/**
 * Which skills each agent receives. Assignment is per agent within one Account: the caller must own both the agent
 * and every named skill, and every read is scoped by the agent's owner so a cross-account name never resolves.
 */
export class SkillAssignmentService {
  readonly #database: DatabaseClient;

  constructor(database: DatabaseClient) {
    this.#database = database;
  }

  async listForAgent(callerUserId: string, agentId: string): Promise<AgentSkillsResponse> {
    const agent = await this.#requireOwnedAgent(callerUserId, agentId);
    return this.#agentResponse(this.#database, agent);
  }

  async replaceForAgent(
    callerUserId: string,
    agentId: string,
    skillNames: readonly string[],
  ): Promise<AgentSkillsResponse> {
    const agent = await this.#requireOwnedAgent(callerUserId, agentId);
    const skillIds = await this.#resolveSkillIds(agent.ownerAccountId, skillNames);
    await this.#database.transaction(async (transaction) => {
      await transaction.delete(agentSkills).where(eq(agentSkills.agentId, agent.id));
      if (skillIds.length > 0) {
        await transaction.insert(agentSkills).values(skillIds.map((skillId) => ({ agentId: agent.id, skillId })));
      }
    });
    return this.#agentResponse(this.#database, agent);
  }

  async agentsForSkill(callerUserId: string, name: string): Promise<SkillAgentsResponse> {
    const [skill] = await this.#database
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.ownerAccountId, callerUserId), eq(skills.name, name)))
      .limit(1);
    if (!skill) throw skillNotFound();
    const rows = await this.#database
      .select({ agentId: agents.id, name: agents.name, displayName: agents.displayName })
      .from(agentSkills)
      .innerJoin(agents, eq(agents.id, agentSkills.agentId))
      .where(and(eq(agentSkills.skillId, skill.id), ne(agents.status, "deleted")))
      .orderBy(asc(agents.name), asc(agents.id));
    return { agents: rows };
  }

  /** Digest of the agent's current assignment set; the empty-set constant when nothing is assigned. */
  async agentDigest(agentId: string): Promise<string> {
    const rows = await this.#assignedRows(this.#database, agentId);
    return computeAgentSkillsDigest(rows);
  }

  /** Every active agent on the computer with its digest and full skill manifests, optionally one agent only. */
  async manifestForComputer(computerId: string, agentId?: string): Promise<RuntimeSkillsManifest | undefined> {
    const where = agentId
      ? and(eq(agents.computerId, computerId), eq(agents.status, "active"), eq(agents.id, agentId))
      : and(eq(agents.computerId, computerId), eq(agents.status, "active"));
    const computerAgents = await this.#database
      .select({ id: agents.id })
      .from(agents)
      .where(where)
      .orderBy(asc(agents.id));
    if (agentId && computerAgents.length === 0) return undefined;
    const entries: RuntimeAgentSkills[] = [];
    for (const agent of computerAgents) entries.push(await this.#runtimeAgentSkills(agent.id));
    return { agents: entries };
  }

  /** The skill id when `name` is assigned to an active agent on the computer; a 404 otherwise. */
  async assertSkillAssignedOnComputer(computerId: string, name: string): Promise<{ skillId: string }> {
    const [row] = await this.#database
      .select({ skillId: skills.id })
      .from(agentSkills)
      .innerJoin(agents, eq(agents.id, agentSkills.agentId))
      .innerJoin(skills, eq(skills.id, agentSkills.skillId))
      .where(and(eq(agents.computerId, computerId), eq(agents.status, "active"), eq(skills.name, name)))
      .limit(1);
    if (!row) throw skillNotFound();
    return row;
  }

  /** The Account an active agent belongs to; used to scope an in-session push to the session's owner. */
  async resolveAgentOwner(agentId: string): Promise<OwnedAgent | undefined> {
    const [row] = await this.#database
      .select({ id: agents.id, ownerAccountId: agents.createdByUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.status, "active")))
      .limit(1);
    return row;
  }

  async #requireOwnedAgent(callerUserId: string, agentId: string): Promise<OwnedAgent> {
    const [row] = await this.#database
      .select({ id: agents.id, ownerAccountId: agents.createdByUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, callerUserId), ne(agents.status, "deleted")))
      .limit(1);
    if (!row) throw skillResourceNotFound();
    return row;
  }

  async #resolveSkillIds(ownerAccountId: string, skillNames: readonly string[]): Promise<string[]> {
    if (skillNames.length === 0) return [];
    const rows = await this.#database
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .where(and(eq(skills.ownerAccountId, ownerAccountId), inArray(skills.name, [...skillNames])));
    const byName = new Map(rows.map((row) => [row.name, row.id]));
    const missing = skillNames.filter((name) => !byName.has(name));
    if (missing.length > 0) throw skillNotFound([...missing].sort());
    return skillNames.map((name) => byName.get(name) as string);
  }

  async #assignedRows(database: SkillDatabase, agentId: string): Promise<SkillSummaryRow[]> {
    const assigned = await database
      .select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId));
    if (assigned.length === 0) return [];
    return selectSkillSummaryRows(
      database,
      inArray(
        skills.id,
        assigned.map((row) => row.skillId),
      ),
    );
  }

  async #agentResponse(database: SkillDatabase, agent: OwnedAgent): Promise<AgentSkillsResponse> {
    const rows = await this.#assignedRows(database, agent.id);
    return { agentId: agent.id, digest: computeAgentSkillsDigest(rows), skills: rows.map(toSkillSummary) };
  }

  async #runtimeAgentSkills(agentId: string): Promise<RuntimeAgentSkills> {
    const rows = await this.#assignedRows(this.#database, agentId);
    const manifests = await loadSkillManifests(this.#database, rows);
    return {
      agentId,
      digest: computeAgentSkillsDigest(rows),
      skills: rows.flatMap((row) => {
        const manifest = manifests.get(row.id);
        return manifest
          ? [
              {
                name: row.name,
                digest: row.digest,
                archiveSha256: row.archiveSha256,
                archiveBytes: row.archiveBytes,
                manifest,
              },
            ]
          : [];
      }),
    };
  }
}
