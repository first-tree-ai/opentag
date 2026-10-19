import * as m from "../../../paraglide/messages.js";

export function soulPresets() {
  return [
    {
      id: "engineering",
      avatarPath: "/bot-avatars/v1/developer.png",
      title: m.agent_settings_soul_preset_engineering_title(),
      instructions: m.agent_settings_soul_preset_engineering_manifest(),
    },
    {
      id: "design",
      avatarPath: "/bot-avatars/v1/artist.png",
      title: m.agent_settings_soul_preset_design_title(),
      instructions: m.agent_settings_soul_preset_design_manifest(),
    },
    {
      id: "product",
      avatarPath: "/bot-avatars/v1/architect.png",
      title: m.agent_settings_soul_preset_product_title(),
      instructions: m.agent_settings_soul_preset_product_manifest(),
    },
    {
      id: "growth",
      avatarPath: "/bot-avatars/v1/sales.png",
      title: m.agent_settings_soul_preset_growth_title(),
      instructions: m.agent_settings_soul_preset_growth_manifest(),
    },
    {
      id: "operations",
      avatarPath: "/bot-avatars/v1/businessman.png",
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
