import type { AgentAdminConfig } from "@opentag/shared/browser";
import type { IconName } from "../../../ui/design-system.js";
import type { AgentDetailView } from "../agent-model.js";
import { messagingChannelLabel, messagingConnectionLabel, platformLabel, titleCase } from "../agent-presentation.js";

export type AgentSettingsSection = "instructions" | "execution" | "messaging" | "identity" | "computer" | "manage";

export type AgentSettingsGroup = "setup" | "danger";

export const agentSettingsSections: ReadonlyArray<{
  key: AgentSettingsSection;
  label: string;
  group: AgentSettingsGroup;
  icon: IconName;
}> = [
  {
    key: "identity",
    label: "Name",
    group: "setup",
    icon: "user",
  },
  {
    key: "messaging",
    label: "Messaging",
    group: "setup",
    icon: "message",
  },
  {
    key: "computer",
    label: "Computer",
    group: "setup",
    icon: "laptop",
  },
  {
    key: "instructions",
    label: "Instructions",
    group: "setup",
    icon: "instructions",
  },
  {
    key: "execution",
    label: "Model & reasoning",
    group: "setup",
    icon: "model",
  },
  {
    key: "manage",
    label: "Pause or delete",
    group: "danger",
    icon: "shield",
  },
];

/*
 * One list in the order a viewer thinks about an Agent -- who it is, how it is reached, where it
 * runs, how it works -- with the irreversible actions held apart rather than sorted among them.
 */
export const agentSettingsGroups = [
  { key: "setup", label: null },
  { key: "danger", label: "Danger zone" },
] as const;

export function agentSettingsSummary(
  agent: AgentDetailView,
  config: AgentAdminConfig,
  section: AgentSettingsSection,
): string {
  if (section === "instructions") {
    return config.runtimeConfig.instructions.trim() ? "Custom instructions" : "Not configured";
  }
  if (section === "execution") {
    const provider = config.runtimeProvider === "codex" ? "Codex" : "Claude Code";
    if (!config.runtimeConfig.model && !config.runtimeConfig.reasoningEffort) return `${provider} · Provider defaults`;
    const model = config.runtimeConfig.model ?? "Default model";
    const reasoning = config.runtimeConfig.reasoningEffort
      ? titleCase(config.runtimeConfig.reasoningEffort)
      : "Default reasoning";
    return `${provider} · ${model} · ${reasoning}`;
  }
  if (section === "messaging") {
    if (agent.messaging.kind === "unconfirmed") return "Messaging status is temporarily unavailable";
    const binding = agent.messaging.value;
    if (!binding) return "No messaging channel connected";
    const status = messagingConnectionLabel(binding);
    return `${messagingChannelLabel(agent, binding)} · ${status}`;
  }
  if (section === "identity") return config.displayName;
  if (section === "computer") {
    const computer = agent.computer;
    if (!computer) return "No Computer connected";
    const state = agent.availability.dependencies.computer.state;
    const status = state === "ready" ? "Online" : state === "action_required" ? "Offline" : "Unconfirmed";
    return `${computer.displayName} · ${platformLabel(computer.platform)} · ${status}`;
  }
  return config.status === "active" ? "Active" : "Paused";
}
