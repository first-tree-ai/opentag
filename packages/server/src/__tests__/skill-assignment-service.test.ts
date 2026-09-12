import {
  AgentSkillsResponseSchema,
  computeAgentSkillsDigest,
  EMPTY_AGENT_SKILLS_DIGEST,
  RuntimeSkillsManifestSchema,
} from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import type { DatabaseClient } from "../db/client.js";
import { agents, computers, users } from "../db/schema/index.js";
import { MemorySkillBlobStore, SkillAssignmentService, SkillService } from "../services/skills/index.js";
import { validSkillZip } from "./support/skill-fixtures.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unitDatabase: UnitDatabase;
let database: DatabaseClient;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
  database = unitDatabase.database;
}, 60_000);

afterAll(async () => unitDatabase?.close());

beforeEach(async () => unitDatabase.reset());

async function account(email = "owner@example.com") {
  const { userId } = await bootstrapInitialAdmin(database, { displayName: email, email });
  return userId;
}

async function otherAccount(email = "other@example.com") {
  const [user] = await database.insert(users).values({ displayName: email, email }).returning();
  if (!user) throw new Error("user fixture");
  return user.id;
}

async function computer(ownerAccountId: string) {
  const [row] = await database
    .insert(computers)
    .values({
      ownerAccountId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!row) throw new Error("computer fixture");
  return row.id;
}

async function agent(
  ownerId: string,
  name: string,
  options: { computerId?: string; status?: "active" | "suspended" | "deleted" } = {},
) {
  const [row] = await database
    .insert(agents)
    .values({
      createdByUserId: ownerId,
      name,
      displayName: `Agent ${name}`,
      runtimeProvider: "codex",
      computerId: options.computerId ?? null,
      status: options.status ?? "active",
    })
    .returning();
  if (!row) throw new Error("agent fixture");
  return row.id;
}

async function seedSkills(owner: string, names: string[]) {
  const service = new SkillService(database, new MemorySkillBlobStore());
  const digests = new Map<string, string>();
  for (const name of names) {
    const { skill } = await service.upsertFromArchive(owner, validSkillZip(name), {
      onConflict: "fail",
      updatedBy: { kind: "user", id: owner },
    });
    digests.set(name, skill.digest);
  }
  return { service, digests };
}

describe("SkillAssignmentService", () => {
  it("replaces an agent's assignment set idempotently and reports the digest", async () => {
    const owner = await account();
    const agentId = await agent(owner, "assistant");
    const { digests } = await seedSkills(owner, ["alpha", "bravo", "charlie"]);
    const service = new SkillAssignmentService(database);

    const empty = await service.listForAgent(owner, agentId);
    expect(AgentSkillsResponseSchema.parse(empty)).toEqual({ agentId, digest: EMPTY_AGENT_SKILLS_DIGEST, skills: [] });

    const assigned = await service.replaceForAgent(owner, agentId, ["charlie", "alpha"]);
    expect(assigned.skills.map((skill) => skill.name)).toEqual(["alpha", "charlie"]);
    expect(assigned.skills.every((skill) => skill.agentCount === 1)).toBe(true);
    expect(assigned.digest).toBe(
      computeAgentSkillsDigest([
        { name: "alpha", digest: digests.get("alpha") ?? "" },
        { name: "charlie", digest: digests.get("charlie") ?? "" },
      ]),
    );
    expect(await service.agentDigest(agentId)).toBe(assigned.digest);

    const again = await service.replaceForAgent(owner, agentId, ["alpha", "charlie"]);
    expect(again.digest).toBe(assigned.digest);
    const reduced = await service.replaceForAgent(owner, agentId, ["bravo"]);
    expect(reduced.skills.map((skill) => skill.name)).toEqual(["bravo"]);
    expect(reduced.digest).not.toBe(assigned.digest);
    expect((await service.replaceForAgent(owner, agentId, [])).digest).toBe(EMPTY_AGENT_SKILLS_DIGEST);
  });

  it("rejects unknown names with the sorted missing list and leaves the assignment untouched", async () => {
    const owner = await account();
    const agentId = await agent(owner, "assistant");
    await seedSkills(owner, ["alpha"]);
    const service = new SkillAssignmentService(database);
    await service.replaceForAgent(owner, agentId, ["alpha"]);
    await expect(service.replaceForAgent(owner, agentId, ["zulu", "alpha", "mike"])).rejects.toMatchObject({
      code: "SKILL_NOT_FOUND",
      statusCode: 400,
      details: { missing: ["mike", "zulu"] },
    });
    expect((await service.listForAgent(owner, agentId)).skills.map((skill) => skill.name)).toEqual(["alpha"]);
  });

  it("returns 404 for agents the caller does not own, deleted agents, and skills owned by others", async () => {
    const owner = await account();
    const other = await otherAccount();
    const foreignAgent = await agent(other, "foreign");
    const deleted = await agent(owner, "gone", { status: "deleted" });
    await seedSkills(other, ["theirs"]);
    await seedSkills(owner, ["mine"]);
    const service = new SkillAssignmentService(database);
    await expect(service.listForAgent(owner, foreignAgent)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(service.replaceForAgent(owner, foreignAgent, [])).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(service.listForAgent(owner, deleted)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const ownAgent = await agent(owner, "assistant");
    await expect(service.replaceForAgent(owner, ownAgent, ["theirs"])).rejects.toMatchObject({
      code: "SKILL_NOT_FOUND",
      details: { missing: ["theirs"] },
    });
    await expect(service.agentsForSkill(owner, "theirs")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("lists the agents a skill is assigned to and drops deleted agents", async () => {
    const owner = await account();
    const first = await agent(owner, "alpha-agent");
    const second = await agent(owner, "beta-agent");
    const deleted = await agent(owner, "gone", { status: "deleted" });
    await seedSkills(owner, ["shared"]);
    const service = new SkillAssignmentService(database);
    for (const agentId of [second, first, deleted])
      await service.replaceForAgent(owner, agentId, ["shared"]).catch(() => undefined);
    expect(await service.agentsForSkill(owner, "shared")).toEqual({
      agents: [
        { agentId: first, name: "alpha-agent", displayName: "Agent alpha-agent" },
        { agentId: second, name: "beta-agent", displayName: "Agent beta-agent" },
      ],
    });
  });

  it("builds the runtime manifest for every active agent on a computer and scopes archive access to it", async () => {
    const owner = await account();
    const mine = await computer(owner);
    const theirs = await computer(owner);
    const onMine = await agent(owner, "on-mine", { computerId: mine });
    const suspended = await agent(owner, "suspended", { computerId: mine, status: "suspended" });
    const elsewhere = await agent(owner, "elsewhere", { computerId: theirs });
    const { digests } = await seedSkills(owner, ["alpha", "bravo"]);
    const service = new SkillAssignmentService(database);
    await service.replaceForAgent(owner, onMine, ["alpha"]);
    await service.replaceForAgent(owner, suspended, ["bravo"]);
    await service.replaceForAgent(owner, elsewhere, ["bravo"]);

    const manifest = await service.manifestForComputer(mine);
    expect(RuntimeSkillsManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest?.agents).toHaveLength(1);
    expect(manifest?.agents[0]).toMatchObject({
      agentId: onMine,
      digest: computeAgentSkillsDigest([{ name: "alpha", digest: digests.get("alpha") ?? "" }]),
    });
    expect(manifest?.agents[0]?.skills[0]).toMatchObject({
      name: "alpha",
      digest: digests.get("alpha"),
      manifest: {
        schemaVersion: 1,
        name: "alpha",
        files: expect.arrayContaining([expect.objectContaining({ path: "SKILL.md" })]),
      },
    });
    expect(await service.manifestForComputer(mine, onMine)).toEqual(manifest);
    expect(await service.manifestForComputer(mine, elsewhere)).toBeUndefined();
    expect(await service.manifestForComputer(mine, suspended)).toBeUndefined();

    await expect(service.assertSkillAssignedOnComputer(mine, "alpha")).resolves.toEqual({
      skillId: expect.any(String),
    });
    await expect(service.assertSkillAssignedOnComputer(mine, "bravo")).rejects.toMatchObject({
      code: "SKILL_NOT_FOUND",
    });
    await expect(service.assertSkillAssignedOnComputer(theirs, "bravo")).resolves.toBeDefined();
  });

  it("resolves the owning account of an active agent only", async () => {
    const owner = await account();
    const active = await agent(owner, "active");
    const suspended = await agent(owner, "suspended", { status: "suspended" });
    const service = new SkillAssignmentService(database);
    expect(await service.resolveAgentOwner(active)).toEqual({ id: active, ownerAccountId: owner });
    expect(await service.resolveAgentOwner(suspended)).toBeUndefined();
  });
});
