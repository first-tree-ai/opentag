import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { SKILL_PRESET_CATEGORY_IDS, SkillPresetSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { findSkillPreset, SKILL_PRESET_CATEGORIES, SKILL_PRESETS } from "../index.js";

describe("preset catalog shape", () => {
  it("exposes the shipped categories in tab order and within the shared taxonomy", () => {
    expect(SKILL_PRESET_CATEGORIES.length).toBeGreaterThan(0);
    const ids = SKILL_PRESET_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(SKILL_PRESET_CATEGORY_IDS).toContain(id);
    const orders = SKILL_PRESET_CATEGORIES.map((category) => category.order);
    expect([...orders].sort((left, right) => left - right)).toEqual(orders);
  });

  it("keeps every category referenced and every preset categorized", () => {
    const categoryIds = new Set(SKILL_PRESET_CATEGORIES.map((category) => category.id));
    const used = new Set(SKILL_PRESETS.map((preset) => preset.category));
    expect(SKILL_PRESETS.length).toBeGreaterThan(0);
    for (const preset of SKILL_PRESETS) expect(categoryIds.has(preset.category)).toBe(true);
    expect(used).toEqual(categoryIds);
  });

  it("orders presets by category order, then preset order", () => {
    const categoryOrder = new Map(SKILL_PRESET_CATEGORIES.map((category) => [category.id, category.order]));
    const keys = SKILL_PRESETS.map((preset) => (categoryOrder.get(preset.category) ?? 0) * 1_000_000 + preset.order);
    expect([...keys].sort((left, right) => left - right)).toEqual(keys);
  });
});

describe("preset archives", () => {
  it("matches the shared contract for every preset", () => {
    for (const preset of SKILL_PRESETS) {
      const entry = {
        name: preset.name,
        description: preset.description,
        category: preset.category,
        order: preset.order,
        archiveSha256: preset.archiveSha256,
        archiveBytes: preset.archiveBytes,
        fileCount: preset.fileCount,
      };
      expect(SkillPresetSchema.omit({ state: true }).safeParse(entry).success).toBe(true);
    }
  });

  it("binds each archive to its recorded size and hash", () => {
    for (const preset of SKILL_PRESETS) {
      expect(preset.archive.byteLength).toBe(preset.archiveBytes);
      expect(createHash("sha256").update(preset.archive).digest("hex")).toBe(preset.archiveSha256);
    }
  });

  it("decodes every archive as a gzip tar holding the manifest", () => {
    for (const preset of SKILL_PRESETS) {
      expect([...preset.archive.slice(0, 2)]).toEqual([0x1f, 0x8b]);
      const unpacked = gunzipSync(preset.archive);
      expect(unpacked.includes(Buffer.from("SKILL.md"))).toBe(true);
    }
  });

  it("finds a preset by name and no other", () => {
    expect(findSkillPreset("mcp-onboarding")?.name).toBe("mcp-onboarding");
    expect(findSkillPreset("not-a-preset")).toBeUndefined();
  });
});
