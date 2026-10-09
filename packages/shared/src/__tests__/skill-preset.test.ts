import { describe, expect, it } from "vitest";
import { SKILL_ARCHIVE_MAX_BYTES, SKILL_MAX_ENTRIES } from "../skill.js";
import {
  InstallSkillPresetResponseSchema,
  ListSkillPresetsResponseSchema,
  SKILL_PRESET_CATALOG_MAX_BYTES,
  SKILL_PRESET_CATEGORY_IDS,
  SKILL_PRESET_MAX_CATEGORIES,
  SKILL_PRESET_MAX_ENTRIES,
  SkillPresetCategoryIdSchema,
  SkillPresetCategorySchema,
  SkillPresetSchema,
  SkillPresetStateSchema,
} from "../skill-preset.js";

const SKILL_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SHA = "a".repeat(64);

function validPreset(overrides: Record<string, unknown> = {}) {
  return {
    name: "mcp-onboarding",
    description: "Teach an Agent to find and mount an MCP Server for itself",
    category: "getting-started",
    order: 10,
    archiveSha256: SHA,
    archiveBytes: 4096,
    fileCount: 3,
    state: "not_installed",
    ...overrides,
  };
}

function validSkill() {
  return {
    id: SKILL_ID,
    agentId: AGENT_ID,
    name: "mcp-onboarding",
    description: "Teach an Agent to find and mount an MCP Server for itself",
    enabled: true,
    source: "preset",
    archiveSha256: SHA,
    archiveBytes: 4096,
    fileCount: 3,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("preset category taxonomy", () => {
  it("exposes the documented category ids and a schema that admits exactly those", () => {
    expect(SKILL_PRESET_CATEGORY_IDS).toEqual(["getting-started", "engineering"]);
    for (const id of SKILL_PRESET_CATEGORY_IDS) {
      expect(SkillPresetCategoryIdSchema.safeParse(id).success).toBe(true);
    }
    expect(SkillPresetCategoryIdSchema.safeParse("operations").success).toBe(false);
  });

  it("bounds a category entry", () => {
    expect(SkillPresetCategorySchema.safeParse({ id: "engineering", order: 0 }).success).toBe(true);
    expect(SkillPresetCategorySchema.safeParse({ id: "engineering", order: 1_000_000 }).success).toBe(true);
    expect(SkillPresetCategorySchema.safeParse({ id: "engineering", order: 1_000_001 }).success).toBe(false);
    expect(SkillPresetCategorySchema.safeParse({ id: "engineering", order: -1 }).success).toBe(false);
    expect(SkillPresetCategorySchema.safeParse({ id: "engineering", order: 1.5 }).success).toBe(false);
    expect(SkillPresetCategorySchema.safeParse({ id: "engineering", order: 0, label: "Engineering" }).success).toBe(
      false,
    );
  });
});

describe("preset resource schema", () => {
  it("round-trips a well-formed preset", () => {
    const parsed = SkillPresetSchema.parse(validPreset());
    expect(parsed.name).toBe("mcp-onboarding");
    expect(parsed.category).toBe("getting-started");
  });

  it("accepts every documented state and rejects an unknown one", () => {
    for (const state of ["not_installed", "installed", "update_available", "name_conflict"]) {
      expect(SkillPresetStateSchema.parse(state)).toBe(state);
      expect(SkillPresetSchema.parse(validPreset({ state })).state).toBe(state);
    }
    expect(SkillPresetSchema.safeParse(validPreset({ state: "pending" })).success).toBe(false);
  });

  it("rejects invalid names, categories, hashes, sizes, and orders", () => {
    expect(SkillPresetSchema.safeParse(validPreset({ name: "Mcp" })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ category: "operations" })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ archiveSha256: "XYZ" })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ archiveBytes: 0 })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ archiveBytes: SKILL_ARCHIVE_MAX_BYTES + 1 })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ fileCount: 0 })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ fileCount: SKILL_MAX_ENTRIES + 1 })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ order: -1 })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ order: 1_000_001 })).success).toBe(false);
    expect(SkillPresetSchema.safeParse(validPreset({ description: "" })).success).toBe(false);
  });

  it("rejects unknown keys on a preset", () => {
    expect(SkillPresetSchema.safeParse(validPreset({ title: "MCP onboarding" })).success).toBe(false);
  });
});

describe("preset list response schema", () => {
  it("round-trips categories and presets", () => {
    const response = {
      categories: [
        { id: "getting-started", order: 0 },
        { id: "engineering", order: 1 },
      ],
      presets: [validPreset()],
    };
    expect(ListSkillPresetsResponseSchema.safeParse(response).success).toBe(true);
  });

  it("requires a non-empty catalog", () => {
    const response = { categories: [{ id: "engineering", order: 0 }], presets: [validPreset()] };
    expect(ListSkillPresetsResponseSchema.safeParse({ ...response, categories: [] }).success).toBe(false);
    expect(ListSkillPresetsResponseSchema.safeParse({ ...response, presets: [] }).success).toBe(false);
  });

  it("bounds the catalog size", () => {
    const preset = validPreset();
    expect(
      ListSkillPresetsResponseSchema.safeParse({
        categories: [{ id: "engineering", order: 0 }],
        presets: Array.from({ length: SKILL_PRESET_MAX_ENTRIES + 1 }, () => preset),
      }).success,
    ).toBe(false);
    expect(
      ListSkillPresetsResponseSchema.safeParse({
        categories: Array.from({ length: SKILL_PRESET_MAX_CATEGORIES + 1 }, (_, order) => ({
          id: "engineering",
          order,
        })),
        presets: [preset],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown response keys", () => {
    expect(
      ListSkillPresetsResponseSchema.safeParse({
        categories: [{ id: "engineering", order: 0 }],
        presets: [validPreset()],
        storage: "available",
      }).success,
    ).toBe(false);
  });
});

describe("preset install response schema", () => {
  it("round-trips every install action with the resulting Skill", () => {
    for (const action of ["installed", "updated", "unchanged"]) {
      const response = { action, skill: validSkill() };
      expect(InstallSkillPresetResponseSchema.parse(response)).toEqual(response);
    }
  });

  it("rejects an unknown action and a malformed Skill", () => {
    expect(InstallSkillPresetResponseSchema.safeParse({ action: "skipped", skill: validSkill() }).success).toBe(false);
    expect(InstallSkillPresetResponseSchema.safeParse({ action: "installed", skill: {} }).success).toBe(false);
    expect(InstallSkillPresetResponseSchema.safeParse({ action: "installed" }).success).toBe(false);
  });
});

describe("preset constants", () => {
  it("exposes the documented budgets", () => {
    expect(SKILL_PRESET_MAX_ENTRIES).toBe(128);
    expect(SKILL_PRESET_MAX_CATEGORIES).toBe(16);
    expect(SKILL_PRESET_CATALOG_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});
