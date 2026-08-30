import type { AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
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
 * rather than a person: the Account model keeps the Agent creator audit-only, and owning a Computer
 * implies no control of the physical host.
 */
export function computerRecoveryMessage(agent: AgentDetailView, computerName = agent.computer.displayName): string {
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
  if (binding.bindingState === "reauthorization_required" && binding.provider === "feishu") {
    return "Permissions update required";
  }
  return {
    active: "Connected",
    provisioning: "Setting up",
    reauthorization_required: "Permissions update required",
    error: "Connection error",
    disabled: "Disabled",
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

export function platformLabel(platform: AgentSummary["computer"]["platform"]): string {
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

export function sharedConversationDestination(provider: ImBindingSummary["provider"], plural = false): string {
  if (provider === "feishu") return plural ? "connected Feishu group chats" : "a Feishu group chat";
  return plural ? "connected Slack channels" : "a Slack channel";
}

/**
 * Feishu gives each Agent its own bot, so the handle addresses it. Slack routes one workspace Bot,
 * so the verified Bot name is used and no per-Agent handle is synthesized.
 */
export function messagingChannelLabel(agent: AgentDetailView, binding: ImBindingSummary): string {
  const provider = titleCase(binding.provider);
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
    return provider ? `Available in ${titleCase(provider)}` : "Ready for new work";
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
      : `Ready to receive new messages from ${titleCase(provider)}.`;
  }
  if (agent.availability.reason === "computer_offline" || agent.availability.reason === "runtime_unavailable") {
    return computerRecoveryMessage(agent);
  }
  if (agent.availability.reason === "handoff_unavailable") {
    return `${titleCase(provider)} is connected, but messages cannot currently be handed off to this Agent.`;
  }
  return agentRecoveryMessage(agent);
}

export function agentAvailabilityRecovery(
  agent: AgentDetailView,
): { label: string; link: AgentSettingsSectionLink } | undefined {
  if (agent.availability.state === "ready") return undefined;
  if (agent.availability.reason === "agent_suspended") {
    return { label: "Manage Agent", link: agentSettingsSectionLink(agent.id, "manage") };
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
  return { label: "View Computer", link: agentSettingsSectionLink(agent.id, "computer") };
}

export function agentRecoveryMessage(agent: AgentDetailView): string {
  const messages: Record<NonNullable<AgentAvailability["reason"]>, string> = {
    agent_suspended: "This Agent is paused. Resume it to start receiving messages again.",
    agent_unconfirmed: "Could not refresh this Agent's status. Retrying automatically.",
    handoff_unconfirmed: "Could not refresh this Agent's status. Retrying automatically.",
    computer_unconfirmed: "Could not confirm the assigned Computer. Retrying automatically.",
    runtime_unconfirmed: "Could not confirm the assigned Computer. Retrying automatically.",
    computer_offline: "This agent's computer is offline. Retrying automatically.",
    runtime_unavailable: runtimeRecoveryMessage(agent),
    im_not_connected: "Connect Feishu or Slack so teammates can send this Agent work.",
    im_provisioning: "The messaging connection is still being set up.",
    im_reauthorization_required: "The messaging connection needs to be re-authorized before it can receive messages.",
    im_error: "The messaging connection failed. Reconnect Feishu or Slack to receive messages.",
    im_disabled: "Messaging is turned off for this Agent. Reconnect Feishu or Slack to receive messages.",
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
  detail?: string;
  label: string;
  tone: StatusTone;
};

export function agentComputerStatus(agent: AgentDetailView): AgentDependencyStatus {
  const { computer, runtime } = agent.availability.dependencies;
  const providerName = runtimeProviderName(runtime.provider);
  /*
   * Every branch carries the exit, including the healthy one. This card is the only Computer
   * recovery surface on the Agent home now that the banner is gone, so a state without an exit
   * leaves the Computer reachable only by hunting through Settings.
   *
   * The wording is derived from these two dependency fields rather than from
   * `computerRecoveryMessage`, which answers a different question: it branches on the Agent-wide
   * `availability.reason`, and a higher-ranked reason such as `agent_suspended` masks the runtime
   * one -- which made this row label a Provider as "Checking" while its sentence claimed the
   * connection was unconfirmed, about a Computer that was online.
   */
  const action = { label: "View Computer", section: "computer" as const };
  if (computer.state === "unconfirmed") {
    return {
      action,
      detail: "OpenTag could not confirm this Computer's current connection.",
      label: "Unknown",
      tone: "neutral",
    };
  }
  if (computer.state === "action_required") {
    return {
      action,
      detail: "OpenTag is not running on this Computer. Start it there to bring it back online.",
      label: "Offline",
      tone: "warning",
    };
  }
  if (!runtime.status) {
    return {
      action,
      detail: `OpenTag could not confirm ${providerName} on this Computer.`,
      label: "Unknown",
      tone: "neutral",
    };
  }
  if (runtime.status === "checking") {
    return {
      action,
      detail: `OpenTag is still checking ${providerName} on this Computer.`,
      label: `Checking ${providerName}`,
      tone: "info",
    };
  }
  if (runtime.status === "install") {
    return {
      action,
      detail: `${providerName} is not installed on this Computer.`,
      label: `${providerName} not installed`,
      tone: "warning",
    };
  }
  if (runtime.status === "sign-in") {
    return {
      action,
      detail: `${providerName} is not signed in on this Computer.`,
      label: `${providerName} sign-in required`,
      tone: "warning",
    };
  }
  if (runtime.status !== "ready") {
    return {
      action,
      detail: `${providerName} is unavailable on this Computer.`,
      label: `${providerName} unavailable`,
      tone: "warning",
    };
  }
  return { action, label: "Online", tone: "success" };
}

export function agentMessagingStatus(agent: AgentDetailView): AgentDependencyStatus {
  const action = { label: "View messaging", section: "messaging" as const };
  if (agent.messaging.kind === "unconfirmed") {
    return {
      action,
      detail: "OpenTag could not read this Agent's messaging connection.",
      label: "Unknown",
      tone: "neutral",
    };
  }
  const binding = agent.messaging.value;
  if (!binding) {
    return {
      action: { label: "Connect messaging", section: "messaging" },
      detail: "Connect a chat app so teammates can send this Agent work.",
      label: "Not connected",
      tone: "neutral",
    };
  }
  const handoff = agent.availability.dependencies.handoff;
  if (binding.bindingState === "active" && handoff.state === "action_required") {
    return {
      action,
      detail: "Messages cannot be delivered to this Agent right now.",
      label: "Cannot receive messages",
      tone: "warning",
    };
  }
  /*
   * An active binding whose delivery evidence could not be read is `handoff_unconfirmed`. The
   * channel may well be fine, but this row states what is known, and "Connected" is not known.
   */
  if (binding.bindingState === "active" && handoff.state === "unconfirmed") {
    return {
      action,
      detail: "OpenTag could not confirm whether messages reach this Agent.",
      label: "Unknown",
      tone: "neutral",
    };
  }
  const detail: Record<ImBindingSummary["bindingState"], string | undefined> = {
    active: undefined,
    provisioning: "The messaging connection is still being set up.",
    reauthorization_required: "The messaging connection needs to be re-authorized before it can receive messages.",
    error: "The messaging connection failed. Reconnect it to receive messages.",
    disabled: "Messaging is turned off for this Agent. Reconnect it to receive messages.",
  };
  /*
   * The exit stays even when the channel is healthy. This card replaced the header's messaging
   * control, so dropping it on success would leave changing the bound bot reachable only by
   * hunting through Settings.
   */
  return {
    action,
    detail: detail[binding.bindingState],
    label: messagingConnectionLabel(binding),
    tone: messagingConnectionTone(binding),
  };
}
