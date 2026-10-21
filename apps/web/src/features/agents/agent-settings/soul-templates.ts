import * as m from "../../../paraglide/messages.js";
import type { IconName } from "../../../ui/design-system.js";

/** Resolve catalog copy at render time; applying a template copies only its localized body. */
export function soulTemplates() {
  return [
    {
      id: "engineering",
      icon: "code" satisfies IconName,
      name: m.agent_settings_soul_template_engineering_name(),
      summary: m.agent_settings_soul_template_engineering_summary(),
      overview: m.agent_settings_soul_template_engineering_overview(),
      body: m.agent_settings_soul_template_engineering_body(),
    },
    {
      id: "design",
      icon: "palette" satisfies IconName,
      name: m.agent_settings_soul_template_design_name(),
      summary: m.agent_settings_soul_template_design_summary(),
      overview: m.agent_settings_soul_template_design_overview(),
      body: m.agent_settings_soul_template_design_body(),
    },
    {
      id: "product",
      icon: "compass" satisfies IconName,
      name: m.agent_settings_soul_template_product_name(),
      summary: m.agent_settings_soul_template_product_summary(),
      overview: m.agent_settings_soul_template_product_overview(),
      body: m.agent_settings_soul_template_product_body(),
    },
    {
      id: "research",
      icon: "search" satisfies IconName,
      name: m.agent_settings_soul_template_research_name(),
      summary: m.agent_settings_soul_template_research_summary(),
      overview: m.agent_settings_soul_template_research_overview(),
      body: m.agent_settings_soul_template_research_body(),
    },
    {
      id: "writing",
      icon: "pen-nib" satisfies IconName,
      name: m.agent_settings_soul_template_writing_name(),
      summary: m.agent_settings_soul_template_writing_summary(),
      overview: m.agent_settings_soul_template_writing_overview(),
      body: m.agent_settings_soul_template_writing_body(),
    },
    {
      id: "data-analysis",
      icon: "chart-bar" satisfies IconName,
      name: m.agent_settings_soul_template_data_analysis_name(),
      summary: m.agent_settings_soul_template_data_analysis_summary(),
      overview: m.agent_settings_soul_template_data_analysis_overview(),
      body: m.agent_settings_soul_template_data_analysis_body(),
    },
    {
      id: "growth",
      icon: "trend-up" satisfies IconName,
      name: m.agent_settings_soul_template_growth_name(),
      summary: m.agent_settings_soul_template_growth_summary(),
      overview: m.agent_settings_soul_template_growth_overview(),
      body: m.agent_settings_soul_template_growth_body(),
    },
    {
      id: "operations",
      icon: "list-checks" satisfies IconName,
      name: m.agent_settings_soul_template_operations_name(),
      summary: m.agent_settings_soul_template_operations_summary(),
      overview: m.agent_settings_soul_template_operations_overview(),
      body: m.agent_settings_soul_template_operations_body(),
    },
  ] as const;
}

export type SoulTemplate = ReturnType<typeof soulTemplates>[number];
