import * as m from "../../../paraglide/messages.js";

export function soulPresets() {
  return [
    {
      id: "engineering",
      title: m.agent_settings_soul_preset_engineering_title(),
      instructions: m.agent_settings_soul_preset_engineering_manifest(),
    },
    {
      id: "design",
      title: m.agent_settings_soul_preset_design_title(),
      instructions: m.agent_settings_soul_preset_design_manifest(),
    },
    {
      id: "product",
      title: m.agent_settings_soul_preset_product_title(),
      instructions: m.agent_settings_soul_preset_product_manifest(),
    },
    {
      id: "growth",
      title: m.agent_settings_soul_preset_growth_title(),
      instructions: m.agent_settings_soul_preset_growth_manifest(),
    },
    {
      id: "operations",
      title: m.agent_settings_soul_preset_operations_title(),
      instructions: m.agent_settings_soul_preset_operations_manifest(),
    },
    {
      id: "scratch",
      title: m.agent_settings_soul_preset_scratch_title(),
      instructions: "",
    },
  ] as const;
}
