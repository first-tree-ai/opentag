import { SKILL_ERROR_CODES } from "@opentag/shared";
import type { PresetSkill } from "@opentag/skill-presets";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SkillPresetService } from "../services/skills/index.js";
import { FakeSkillObjectStore } from "./support/fake-skill-object-store.js";
import { createSkillHarness, type SkillHarness } from "./support/skill-service-harness.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/**
 * Domain behaviour of `SkillPresetService`: per-Agent state, install/update semantics, provenance,
 * ownership, and the runtime surface. The service speaks to a real `SkillService` over PGlite, so
 * every write goes through the same archive validation and storage path production uses.
 */

let unit: UnitDatabase;
let h: SkillHarness;

beforeAll(async () => {
  unit = await createUnitDatabase();
  h = createSkillHarness(unit);
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

const CATEGORIES = [
  { id: "getting-started", order: 10 },
  { id: "engineering", order: 20 },
] as const;

/** A preset whose archive is a real bundle the harness packer produces. */
async function preset(name: string, content = "v1"): Promise<PresetSkill> {
  const bytes = await h.archive(name, { "notes.md": `${name} ${content}` });
  return {
    name,
    description: `Preset ${name}`,
    category: "getting-started",
    order: 10,
    archiveSha256: h.sha256(bytes),
    archiveBytes: bytes.byteLength,
    fileCount: 2,
    archive: bytes,
  };
}

function serviceFor(presets: readonly PresetSkill[], store?: FakeSkillObjectStore): SkillPresetService {
  return new SkillPresetService({ skills: h.serviceWith(store), presets, categories: [...CATEGORIES] });
}

async function agentFor(): Promise<{ accountId: string; agentId: string }> {
  const accountId = await h.createUser();
  const agentId = await h.createAgent(accountId);
  return { accountId, agentId };
}

describe("SkillPresetService catalog", () => {
  it("reports not_installed, then installed, and serves the canonical archive identity", async () => {
    const { accountId, agentId } = await agentFor();
    const catalog = [await preset("demo-preset")];
    const service = serviceFor(catalog, new FakeSkillObjectStore());

    const before = await service.list(accountId, agentId);
    expect(before.categories).toEqual([...CATEGORIES]);
    expect(before.presets).toHaveLength(1);
    expect(before.presets[0]).toMatchObject({ name: "demo-preset", state: "not_installed" });

    const installed = await service.install(accountId, agentId, "demo-preset");
    expect(installed.action).toBe("installed");
    expect(installed.skill).toMatchObject({ name: "demo-preset", source: "preset", enabled: true, revision: 1 });
    expect(installed.skill).not.toHaveProperty("files");

    const after = await service.list(accountId, agentId);
    expect(after.presets[0]).toMatchObject({ state: "installed" });
    expect(after.presets[0]?.archiveSha256).toBe(installed.skill.archiveSha256);

    const again = await service.install(accountId, agentId, "demo-preset");
    expect(again.action).toBe("unchanged");
    expect(again.skill.revision).toBe(1);
    expect(again.skill.archiveSha256).toBe(installed.skill.archiveSha256);
  });

  it("offers an update when the packaged content changed and replaces in place", async () => {
    const { accountId, agentId } = await agentFor();
    const store = new FakeSkillObjectStore();
    const v1 = serviceFor([await preset("demo-preset", "v1")], store);
    const first = await v1.install(accountId, agentId, "demo-preset");

    const v2 = serviceFor([await preset("demo-preset", "v2")], store);
    const catalog = await v2.list(accountId, agentId);
    expect(catalog.presets[0]).toMatchObject({ state: "update_available" });
    expect(catalog.presets[0]?.archiveSha256).not.toBe(first.skill.archiveSha256);

    const updated = await v2.install(accountId, agentId, "demo-preset");
    expect(updated.action).toBe("updated");
    expect(updated.skill.id).toBe(first.skill.id);
    expect(updated.skill.revision).toBe(2);
    expect(updated.skill.archiveSha256).toBe(catalog.presets[0]?.archiveSha256);
    expect((await v2.list(accountId, agentId)).presets[0]).toMatchObject({ state: "installed" });
  });

  it("classifies a same-named Skill from another source as a conflict and refuses to overwrite it", async () => {
    const { accountId, agentId } = await agentFor();
    const store = new FakeSkillObjectStore();
    const skills = h.serviceWith(store);
    const uploaded = await h.upload(skills, accountId, agentId, "demo-preset", { source: "web_upload" });

    const service = new SkillPresetService({
      skills,
      presets: [await preset("demo-preset")],
      categories: [...CATEGORIES],
    });
    expect((await service.list(accountId, agentId)).presets[0]).toMatchObject({ state: "name_conflict" });
    await expect(service.install(accountId, agentId, "demo-preset")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NAME_CONFLICT,
    });
    expect((await skills.list(accountId, agentId)).skills[0]).toMatchObject({
      id: uploaded.id,
      source: "web_upload",
      revision: 1,
    });
  });

  it("turns a preset install into a conflict once a user replaces its content", async () => {
    const { accountId, agentId } = await agentFor();
    const store = new FakeSkillObjectStore();
    const skills = h.serviceWith(store);
    const service = new SkillPresetService({
      skills,
      presets: [await preset("demo-preset")],
      categories: [...CATEGORIES],
    });
    await service.install(accountId, agentId, "demo-preset");

    await h.upload(skills, accountId, agentId, "demo-preset", { replace: true, source: "web_upload" });
    expect((await service.list(accountId, agentId)).presets[0]).toMatchObject({ state: "name_conflict" });
  });

  it("fails with SKILL_PRESET_NOT_FOUND for an unknown preset", async () => {
    const { accountId, agentId } = await agentFor();
    const service = serviceFor([await preset("demo-preset")], new FakeSkillObjectStore());
    await expect(service.install(accountId, agentId, "not-a-preset")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.PRESET_NOT_FOUND,
    });
  });

  it("treats another Account's Agent as missing on both catalog reads and installs", async () => {
    const { agentId } = await agentFor();
    const foreignAccount = await h.createUser();
    const service = serviceFor([await preset("demo-preset")], new FakeSkillObjectStore());
    await expect(service.list(foreignAccount, agentId)).rejects.toMatchObject({ code: SKILL_ERROR_CODES.NOT_FOUND });
    await expect(service.install(foreignAccount, agentId, "demo-preset")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.NOT_FOUND,
    });
  });

  it("surfaces unavailable storage without creating a Skill", async () => {
    const { accountId, agentId } = await agentFor();
    const service = serviceFor([await preset("demo-preset")]);
    await expect(service.install(accountId, agentId, "demo-preset")).rejects.toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
    });
    expect((await service.list(accountId, agentId)).presets[0]).toMatchObject({ state: "not_installed" });
  });
});

describe("SkillPresetService runtime surface", () => {
  it("lists and installs for the proof's Agent with preset provenance", async () => {
    const { agentId } = await agentFor();
    const service = serviceFor([await preset("demo-preset")], new FakeSkillObjectStore());

    expect((await service.listForAgent(agentId)).presets[0]).toMatchObject({ state: "not_installed" });
    const installed = await service.installForAgent(agentId, "demo-preset");
    expect(installed.action).toBe("installed");
    expect(installed.skill).toMatchObject({ agentId, source: "preset" });
    expect((await service.listForAgent(agentId)).presets[0]).toMatchObject({ state: "installed" });
  });
});

describe("SkillPresetService concurrency", () => {
  it("converges two racing installs into one Skill", async () => {
    const { accountId, agentId } = await agentFor();
    const store = new FakeSkillObjectStore();
    const skills = h.serviceWith(store);
    const service = new SkillPresetService({
      skills,
      presets: [await preset("demo-preset")],
      categories: [...CATEGORIES],
    });

    const results = await Promise.all([
      service.install(accountId, agentId, "demo-preset"),
      service.install(accountId, agentId, "demo-preset"),
    ]);
    expect(results.map((result) => result.action).sort()).toEqual(["installed", "unchanged"]);
    const { skills: rows } = await skills.list(accountId, agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "preset", revision: 1 });
    expect((await service.list(accountId, agentId)).presets[0]).toMatchObject({ state: "installed" });
  });
});
