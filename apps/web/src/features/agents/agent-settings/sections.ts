import type { AgentAdminConfig } from "@opentag/shared/browser";
import * as m from "../../../paraglide/messages.js";
import type { IconName } from "../../../ui/design-system.js";
import type { AgentDetailView } from "../agent-model.js";
import {
  messagingChannelLabel,
  messagingConnectionLabel,
  platformLabel,
  runtimeProviderName,
} from "../agent-presentation.js";

export type AgentSettingsSection = "execution" | "messaging" | "identity" | "computer" | "manage";

export type AgentSettingsGroup = "setup" | "danger";

/*
 * Labels are functions. Resolved here they would run at import, before `configureLocaleRuntime()`
 * replaces Paraglide's persisting resolver, writing a locale preference the reader never chose.
 */
export const agentSettingsSections: ReadonlyArray<{
  key: AgentSettingsSection;
  label: () => string;
  group: AgentSettingsGroup;
  icon: IconName;
}> = [
  {
    key: "identity",
    label: () => m.common_name(),
    group: "setup",
    icon: "user",
  },
  {
    key: "messaging",
    label: () => m.im_messaging_page_title(),
    group: "setup",
    icon: "message",
  },
  {
    key: "computer",
    label: () => m.agents_status_computer(),
    group: "setup",
    icon: "laptop",
  },
  {
    key: "execution",
    label: () => m.agent_settings_model(),
    group: "setup",
    icon: "model",
  },
  {
    key: "manage",
    label: () => m.agent_settings_pause_or_delete(),
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
  /*
   * A function, not a resolved string. A message called here would run at import, before
   * `configureLocaleRuntime()` replaces Paraglide's persisting resolver -- which writes a locale
   * preference the reader never chose and pins the language they happened to arrive with.
   */
  { key: "danger", label: () => m.agent_settings_danger_zone() },
] as const;

export function agentSettingsSummary(
  agent: AgentDetailView,
  config: AgentAdminConfig,
  section: AgentSettingsSection,
): string {
  if (section === "execution") {
    const provider = runtimeProviderName(config.runtimeProvider);
    const defaultLabel = runtimeDefaultLabel(agent);
    if (!config.runtimeConfig.model && !config.runtimeConfig.reasoningEffort) {
      return defaultRuntimeSummary(agent, provider);
    }
    return m.agent_settings_model_summary({
      providerName: provider,
      model: config.runtimeConfig.model ?? defaultLabel,
      reasoning: reasoningSummary(config.runtimeConfig.reasoningEffort, defaultLabel),
    });
  }
  if (section === "messaging") {
    if (agent.messaging.kind === "unconfirmed") return m.im_status_unavailable();
    const binding = agent.messaging.value;
    if (!binding) return m.im_no_messaging_app();
    const status = messagingConnectionLabel(binding);
    return `${messagingChannelLabel(agent, binding)} · ${status}`;
  }
  if (section === "identity") return config.displayName;
  if (section === "computer") {
    const computer = agent.computer;
    if (!computer) return m.agent_settings_computer_none_summary();
    const state = agent.availability.dependencies.computer.state;
    const status =
      state === "ready"
        ? m.agent_settings_computer_online()
        : state === "action_required"
          ? m.agent_settings_computer_offline()
          : m.agent_settings_computer_unconfirmed();
    return `${computer.displayName} · ${platformLabel(computer.platform)} · ${status}`;
  }
  return config.status === "active"
    ? m.agent_settings_active_accepting_requests()
    : m.agent_settings_paused_not_accepting_requests();
}

function runtimeDefaultLabel(agent: AgentDetailView): string {
  return agent.computerKind === "local" ? m.agent_settings_inherit_local() : m.agent_settings_provider_default();
}

function defaultRuntimeSummary(agent: AgentDetailView, providerName: string): string {
  return agent.computerKind === "local"
    ? `${providerName} · ${m.agent_settings_inherit_local()}`
    : m.agent_settings_provider_defaults_summary({ providerName });
}

function reasoningSummary(value: string | null, defaultLabel: string): string {
  if (!value) return defaultLabel;
  return (
    {
      off: m.agent_settings_reasoning_off(),
      minimal: m.agent_settings_reasoning_minimal(),
      low: m.agent_settings_reasoning_low(),
      medium: m.agent_settings_reasoning_medium(),
      high: m.agent_settings_reasoning_high(),
      xhigh: m.agent_settings_reasoning_extra_high(),
      max: m.agent_settings_reasoning_max(),
      ultra: m.agent_settings_reasoning_ultra(),
    }[value] ?? value
  );
}
