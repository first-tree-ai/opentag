import type { Skill, SkillPreset } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";

/**
 * Short, localized summaries for the Skills openTag ships. A bundled Skill's SKILL.md description is
 * written for the Agent (it tells the Agent when to use the Skill), so it is not product copy; the
 * admin sees this summary instead. Uploaded Skills keep their own description.
 */
const PRESET_SUMMARIES: Readonly<Record<string, () => string>> = {
  "mcp-onboarding": () => m.skills_preset_summary_mcp_onboarding(),
};

export function presetSummary(preset: Pick<SkillPreset, "name" | "description">): string {
  return PRESET_SUMMARIES[preset.name]?.() ?? preset.description;
}

export function skillSummary(skill: Pick<Skill, "name" | "description" | "source">): string {
  return skill.source === "preset" ? (PRESET_SUMMARIES[skill.name]?.() ?? skill.description) : skill.description;
}
