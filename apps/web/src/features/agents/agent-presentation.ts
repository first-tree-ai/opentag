import type { AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import { messagingProviderChoices, messagingProviderLabel } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import type { StatusTone } from "../../ui/design-system.js";
import type { AgentAvailability, AgentDetailView, AgentListItem, AgentStatusSource } from "./agent-model.js";
import { type AgentSettingsSectionLink, agentSettingsSectionLink } from "./agent-routes.js";
import type { AgentSettingsSection } from "./agent-settings/sections.js";

export const agentAvatarTones = ["brand", "amber", "blue", "neutral"] as const;

export function agentAvatarTone(agentId: string): (typeof agentAvatarTones)[number] {
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  }
  return agentAvatarTones[hash % agentAvatarTones.length] ?? "brand";
}

/**
 * The card states what is true and how urgent it is; it carries no exit of its own. Opening the
 * Agent is the single follow-up, and the Agent page is where each failed dependency is explained.
 */
export function agentCardStatus(agent: AgentListItem): {
  detail?: string;
  label: string;
  priority: number;
  tone: StatusTone;
} {
  const status = agentStatusPresentation(agent);
  if (agent.status === "suspended") return { label: status.label, priority: 4, tone: status.tone };
  if (!agent.evidenceConfirmed) {
    return { detail: "Unable to refresh", label: "Unconfirmed", priority: 1, tone: "neutral" };
  }
  if (agent.availability.state === "unconfirmed") {
    return { detail: "Unable to confirm readiness", label: status.label, priority: 1, tone: status.tone };
  }
  if (agent.availability.state === "action_required") {
    /*
     * No recovery exit on the card. What to do about a stuck Agent depends on which dependency
     * failed, and that explanation lives on the Agent itself; the card states the problem and
     * lets its own open-the-Agent target carry the viewer to where it can be fixed.
     */
    return { detail: "Cannot receive new work", label: status.label, priority: 0, tone: status.tone };
  }
  if (agent.availability.state === "setting_up") {
    return { detail: "Messaging setup in progress", label: status.label, priority: 2, tone: status.tone };
  }
  if (agent.availability.state === "not_connected") {
    return { detail: "Cannot receive new work", label: status.label, priority: 2, tone: status.tone };
  }
  if (agent.activity.state === "working") {
    return {
      label: status.label,
      priority: 2,
      tone: status.tone,
    };
  }
  return { label: status.label, priority: 3, tone: status.tone };
}

/**
 * Names the machine-level action that resolves the failure. Recovery is stated against the Computer
 * rather than a person: the Workspace has no authoritative operator field, and issue #125 makes the
 * Agent creator audit-only while stating that enrollment implies no control of the physical host.
 */
export function computerRecoveryMessage(agent: AgentDetailView): string {
  if (!agent.computer) {
    return m.agents_computer_not_bound_recovery();
  }
  const computerName = agent.computer.displayName;
  if (agent.availability.reason === "runtime_unavailable") {
    const { provider, status } = agent.availability.dependencies.runtime;
    const providerName = provider === "codex" ? "Codex" : "Claude Code";
    if (status === "install") return `${providerName} is not installed on ${computerName}.`;
    if (status === "sign-in") return `${providerName} is not signed in on ${computerName}.`;
    if (status === "checking") return `OpenTag is still checking ${providerName} on ${computerName}.`;
    return `${providerName} is unavailable on ${computerName}.`;
  }
  if (agent.availability.dependencies.computer.state !== "action_required") {
    return "OpenTag could not confirm this Computer's current connection.";
  }
  return `OpenTag is not running on ${computerName}. Start it there to bring it back online.`;
}

export function imBindingStateLabel(binding: ImBindingSummary): string {
  return {
    active: m.im_connected(),
    provisioning: m.im_connecting(),
    reauthorization_required: m.im_permissions_required(),
    error: m.im_connection_error(),
    disabled: m.im_disconnected(),
  }[binding.bindingState];
}

export function imBindingTone(binding: ImBindingSummary): StatusTone {
  const tones: Record<ImBindingSummary["bindingState"], StatusTone> = {
    active: "success",
    provisioning: "info",
    reauthorization_required: "warning",
    error: "danger",
    disabled: "neutral",
  };
  return tones[binding.bindingState];
}

export function messagingConnectionLabel(binding: ImBindingSummary): string {
  return imBindingStateLabel(binding);
}

export function messagingConnectionTone(binding: ImBindingSummary): StatusTone {
  return imBindingTone(binding);
}

export function titleCase(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function platformLabel(platform: NonNullable<AgentSummary["computer"]>["platform"]): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}

export function runtimeProviderName(provider: AgentSummary["runtimeProvider"]): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

/**
 * Presents the exact Agent-level state the viewer can act on. Channel authorization is deliberately
 * excluded: a connected Slack or Feishu App can coexist with an offline Computer or unavailable
 * runtime, and collapsing those facts into one warning made the old status impossible to interpret.
 */
export function agentStatusPresentation(agent: AgentStatusSource): { label: string; tone: StatusTone } {
  const { availability } = agent;
  if (availability.state === "ready") {
    return agent.activity.state === "working"
      ? { label: "Working", tone: "info" }
      : { label: "Ready", tone: "success" };
  }
  if (availability.state === "suspended") return { label: "Suspended", tone: "neutral" };

  /*
   * Unreadable evidence is one situation to a viewer -- nothing to act on, retried automatically --
   * so it is named for the dependency it covers rather than for which read failed.
   */
  if (availability.state === "unconfirmed") {
    if (availability.reason === "computer_unconfirmed" || availability.reason === "runtime_unconfirmed") {
      return { label: "Computer unknown", tone: "neutral" };
    }
    return { label: "Status unknown", tone: "neutral" };
  }

  if (availability.reason === "computer_not_bound") {
    return { label: m.agents_computer_not_bound_label(), tone: "warning" };
  }
  if (availability.reason === "computer_offline") return { label: "Computer offline", tone: "warning" };
  if (availability.reason === "runtime_unavailable") {
    // The Provider-specific wording tells a viewer what to do; a single "runtime not available" does not.
    const { provider, status } = availability.dependencies.runtime;
    const providerName = runtimeProviderName(provider);
    if (status === "checking") return { label: `Checking ${providerName}`, tone: "info" };
    if (status === "install") return { label: `${providerName} not installed`, tone: "warning" };
    if (status === "sign-in") return { label: `${providerName} sign-in required`, tone: "warning" };
    return { label: `${providerName} unavailable`, tone: "warning" };
  }
  /*
   * Messaging failures are collapsed to as few labels as stay true. "Disconnected" covers the states
   * where no usable binding exists; a binding still being created, and one that is connected while
   * its delivery is not, each get the label that matches what the messaging page says about them.
   */
  if (availability.reason === "im_provisioning" || availability.state === "setting_up") {
    return { label: "Messaging setting up", tone: "info" };
  }
  if (availability.reason === "im_reauthorization_required") {
    return { label: "Messaging needs re-authorization", tone: "warning" };
  }
  if (availability.reason === "handoff_unavailable") {
    return { label: "Cannot receive messages", tone: "warning" };
  }
  if (availability.state === "not_connected") return { label: "Messaging disconnected", tone: "neutral" };
  return { label: "Messaging disconnected", tone: "warning" };
}

export function sharedConversationLabel(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? "Group chats" : "Channels";
}

/**
 * The brand comes from `messagingProviderLabel`; only the noun is chosen here. Writing "Feishu" and
 * "Slack" out by hand read as harmless -- the words were correct -- but it made this a second place
 * a channel gets named, which is the thing this file stopped doing everywhere else. A brand spelled
 * at the call site cannot follow a rename, and it is invisible to a search for a provider id
 * reaching a reader, because no id is ever converted: the literal was simply chosen by a branch.
 */
export function sharedConversationDestination(provider: ImBindingSummary["provider"], plural = false): string {
  const brand = messagingProviderLabel(provider);
  const noun = provider === "feishu" ? "group chat" : "channel";
  return plural ? `connected ${brand} ${noun}s` : `a ${brand} ${noun}`;
}

/**
 * Feishu gives each Agent its own bot, so the handle addresses it. Slack routes one workspace Bot,
 * so the verified Bot name is used and no per-Agent handle is synthesized.
 */
export function messagingChannelLabel(agent: AgentDetailView, binding: ImBindingSummary): string {
  const provider = messagingProviderLabel(binding.provider);
  if (binding.provider === "feishu") return `${provider} · @${agent.name}`;
  return binding.bot.displayName ? `${provider} · ${binding.bot.displayName}` : provider;
}

export function agentUseInstruction(agent: AgentDetailView, provider: ImBindingSummary["provider"]): string {
  if (agent.receiveMode === "all_message") {
    return `Send @${agent.name} a direct message. It can also receive every message in ${sharedConversationDestination(provider, true)}.`;
  }
  return `Send @${agent.name} a direct message, or mention it in ${sharedConversationDestination(provider)}.`;
}

export function agentAvailabilitySummary(agent: AgentDetailView): string {
  if (agent.availability.state === "ready") {
    const provider = agent.availability.dependencies.channel.provider;
    return provider ? `Available in ${messagingProviderLabel(provider)}` : "Ready for new work";
  }
  return {
    action_required: "Cannot receive new work",
    setting_up: "Messaging setup in progress",
    not_connected: "Messaging is not connected",
    suspended: "Not receiving new work",
    unconfirmed: "Status temporarily unavailable",
  }[agent.availability.state];
}

export function messagingAgentStatusDescription(
  agent: AgentDetailView,
  provider: ImBindingSummary["provider"],
): string {
  if (agent.availability.state === "ready") {
    return agent.activity.state === "working"
      ? "This Agent is handling a request and remains connected for new messages."
      : `Ready to receive new messages from ${messagingProviderLabel(provider)}.`;
  }
  if (agent.availability.reason === "computer_offline" || agent.availability.reason === "runtime_unavailable") {
    return computerRecoveryMessage(agent);
  }
  if (agent.availability.reason === "handoff_unavailable") {
    return `${messagingProviderLabel(provider)} is connected, but messages cannot currently be handed off to this Agent.`;
  }
  return agentRecoveryMessage(agent);
}

export function agentAvailabilityRecovery(
  agent: AgentDetailView,
): { label: string; link: AgentSettingsSectionLink } | undefined {
  if (agent.availability.state === "ready") return undefined;
  if (agent.availability.reason === "agent_suspended") {
    return { label: m.agent_settings_pause_or_delete(), link: agentSettingsSectionLink(agent.id, "manage") };
  }
  if (
    agent.availability.reason === "im_not_connected" ||
    agent.availability.reason === "im_provisioning" ||
    agent.availability.reason === "im_reauthorization_required" ||
    agent.availability.reason === "im_error" ||
    agent.availability.reason === "im_disabled"
  ) {
    return { label: "View messaging", link: agentSettingsSectionLink(agent.id, "messaging") };
  }
  if (agent.availability.reason === "handoff_unavailable") {
    return { label: "View messaging", link: agentSettingsSectionLink(agent.id, "messaging") };
  }
  if (agent.availability.state === "unconfirmed") return undefined;
  // Naming the action for the state it exits: there is no Computer here to view.
  if (agent.availability.reason === "computer_not_bound") {
    return { label: m.agents_computer_not_bound_action(), link: agentSettingsSectionLink(agent.id, "computer") };
  }
  return { label: "View Computer", link: agentSettingsSectionLink(agent.id, "computer") };
}

export function agentRecoveryMessage(agent: AgentDetailView): string {
  const messages: Record<NonNullable<AgentAvailability["reason"]>, string> = {
    agent_suspended: "This Agent is paused. Resume it to start receiving messages again.",
    agent_unconfirmed: "Could not refresh this Agent's status. Retrying automatically.",
    handoff_unconfirmed: "Could not refresh this Agent's status. Retrying automatically.",
    computer_unconfirmed: "Could not confirm the assigned Computer. Retrying automatically.",
    runtime_unconfirmed: "Could not confirm the assigned Computer. Retrying automatically.",
    computer_not_bound: m.agents_computer_not_bound_detail(),
    computer_offline: "This agent's computer is offline. Retrying automatically.",
    runtime_unavailable: runtimeRecoveryMessage(agent),
    im_not_connected: `Connect ${messagingProviderChoices()} so teammates can send this Agent work.`,
    im_provisioning: "The messaging connection is still being set up.",
    im_reauthorization_required: "The messaging connection needs to be re-authorized before it can receive messages.",
    im_error: `The messaging connection failed. Reconnect ${messagingProviderChoices()} to receive messages.`,
    im_disabled: `Messaging is turned off for this Agent. Reconnect ${messagingProviderChoices()} to receive messages.`,
    handoff_unavailable: "Messages cannot be sent to this Agent.",
  };
  return agent.availability.reason ? messages[agent.availability.reason] : agentAvailabilitySummary(agent);
}

/**
 * The Provider-specific wording tells a viewer what to do on the Computer; one "runtime not
 * available" sentence does not.
 */
function runtimeRecoveryMessage(agent: AgentDetailView): string {
  const { provider, status } = agent.availability.dependencies.runtime;
  const providerName = runtimeProviderName(provider);
  if (status === "checking") return `Still checking ${providerName} on this agent's computer.`;
  if (status === "install") return `Install ${providerName} on this agent's computer.`;
  if (status === "sign-in") return `Sign in to ${providerName} on this agent's computer.`;
  return `${providerName} is not available on this agent's computer.`;
}
/**
 * The two dependencies an Agent needs to do any work, each presented on its own terms. They are
 * deliberately not collapsed into one verdict: a connected channel can coexist with an offline
 * Computer, and a viewer repairing one needs to see the other's state unchanged while they do it.
 */
export type AgentDependencyStatus = {
  action?: { label: string; section: AgentSettingsSection };
  label: string;
  tone: StatusTone;
};

export function agentComputerStatus(agent: AgentDetailView): AgentDependencyStatus {
  const { computer, runtime } = agent.availability.dependencies;
  const providerName = runtimeProviderName(runtime.provider);
  /*
   * The status is derived from these dependency fields rather than the Agent-wide reason. A
   * higher-ranked reason such as `agent_suspended` can mask a runtime problem, but it must not make
   * this row contradict the Computer evidence. Healthy and self-resolving states stay quiet;
   * actionable states name the exact next step instead of adding an explanatory sentence.
   */
  /*
   * An Agent with no Computer is answered first, and with its own exit. Every branch below reads a
   * fact about a machine -- its connection, its Provider -- and there is no machine here to read
   * one from: falling through would label the Agent "Unknown" and explain that the Provider could
   * not be confirmed on a Computer that does not exist. That is the conflation this row exists to
   * avoid, and it is invisible to the type checker, because an unmatched state still returns.
   */
  if (computer.state === "not_bound") {
    return {
      action: { label: m.agents_computer_not_bound_action(), section: "computer" as const },
      label: m.agents_computer_not_bound_label(),
      tone: "warning",
    };
  }
  if (computer.state === "unconfirmed") {
    return {
      action: { label: m.agents_status_action_view_computer(), section: "computer" },
      label: m.agents_status_unknown(),
      tone: "neutral",
    };
  }
  if (computer.state === "action_required") {
    return {
      action: { label: m.agents_status_action_open_computer_setup(), section: "computer" },
      label: m.agents_status_computer_offline(),
      tone: "warning",
    };
  }
  if (!runtime.status) {
    return {
      action: { label: m.agents_status_action_view_computer(), section: "computer" },
      label: m.agents_status_unknown(),
      tone: "neutral",
    };
  }
  if (runtime.status === "checking") {
    return {
      label: m.agents_status_computer_checking_runtime({ providerName }),
      tone: "info",
    };
  }
  if (runtime.status === "install") {
    return {
      action: { label: m.agents_status_action_set_up_runtime({ providerName }), section: "computer" },
      label: m.agents_status_computer_runtime_not_installed({ providerName }),
      tone: "warning",
    };
  }
  if (runtime.status === "sign-in") {
    return {
      action: { label: m.agents_status_action_sign_in_to_runtime({ providerName }), section: "computer" },
      label: m.agents_status_computer_runtime_sign_in_required({ providerName }),
      tone: "warning",
    };
  }
  if (runtime.status !== "ready") {
    return {
      action: { label: m.agents_status_action_troubleshoot_runtime({ providerName }), section: "computer" },
      label: m.agents_status_computer_runtime_unavailable({ providerName }),
      tone: "warning",
    };
  }
  return { label: m.agents_status_computer_ready(), tone: "success" };
}

export function agentMessagingStatus(agent: AgentDetailView): AgentDependencyStatus {
  if (agent.messaging.kind === "unconfirmed") {
    return {
      action: { label: m.agents_status_action_view_channel(), section: "messaging" },
      label: m.agents_status_unknown(),
      tone: "neutral",
    };
  }
  const binding = agent.messaging.value;
  if (!binding) {
    return {
      action: { label: m.agents_status_action_connect_channel(), section: "messaging" },
      label: m.agents_status_channel_not_connected(),
      tone: "neutral",
    };
  }
  const handoff = agent.availability.dependencies.handoff;
  if (binding.bindingState === "active" && handoff.state === "action_required") {
    return {
      action: { label: m.agents_status_action_fix_messaging(), section: "messaging" },
      label: m.agents_status_channel_cannot_receive_messages(),
      tone: "warning",
    };
  }
  /*
   * An active binding whose delivery evidence could not be read is `handoff_unconfirmed`. The
   * channel may well be fine, but this row states what is known, and "Connected" is not known.
   */
  if (binding.bindingState === "active" && handoff.state === "unconfirmed") {
    return {
      action: { label: m.agents_status_action_view_channel(), section: "messaging" },
      label: m.agents_status_unknown(),
      tone: "neutral",
    };
  }
  const actions: Partial<Record<ImBindingSummary["bindingState"], AgentDependencyStatus["action"]>> = {
    provisioning: { label: m.agents_status_action_view_setup(), section: "messaging" },
    reauthorization_required: { label: m.agents_status_action_update_permissions(), section: "messaging" },
    error: { label: m.agents_status_action_reconnect_channel(), section: "messaging" },
    disabled: { label: m.agents_status_action_reconnect_channel(), section: "messaging" },
  };
  // Healthy channels stay quiet; Settings remains the place to change an already working binding.
  return {
    action: actions[binding.bindingState],
    label: agentMessagingConnectionLabel(binding),
    tone: messagingConnectionTone(binding),
  };
}

function agentMessagingConnectionLabel(binding: ImBindingSummary): string {
  const labels: Record<ImBindingSummary["bindingState"], string> = {
    active: m.agents_status_channel_connected(),
    provisioning: m.agents_status_channel_setting_up(),
    reauthorization_required: m.agents_status_channel_permissions_update_required(),
    error: m.agents_status_channel_connection_error(),
    disabled: m.agents_status_channel_disabled(),
  };
  return labels[binding.bindingState];
}
