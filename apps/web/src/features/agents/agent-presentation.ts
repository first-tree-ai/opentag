import type { AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import type { StatusTone } from "../../ui/design-system.js";
import type { AgentAvailability, AgentDetailView, AgentListItem, AgentStatusSource } from "./agent-model.js";
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
 * Every state a viewer can act on carries the Settings section that explains it. A state without an
 * exit reads as a dead end: the card reports a failure the viewer cannot follow anywhere.
 */
export function agentCardStatus(agent: AgentListItem): {
  action?: { label: string; section: AgentSettingsSection };
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
    const action =
      agent.availability.reason === "computer_offline"
        ? { label: "View Computer", section: "computer" as const }
        : agent.availability.reason === "runtime_unavailable"
          ? // Provider readiness is observed per Computer, so the Computer page is where it is explained.
            { label: "View Computer", section: "computer" as const }
          : { label: "View messaging", section: "messaging" as const };
    return {
      action,
      detail: "Cannot receive new work",
      label: status.label,
      priority: 0,
      tone: status.tone,
    };
  }
  if (agent.availability.state === "setting_up") {
    return { detail: "Messaging setup in progress", label: status.label, priority: 2, tone: status.tone };
  }
  if (agent.availability.state === "not_connected") {
    return {
      action: { label: "Connect messaging", section: "messaging" },
      detail: "Cannot receive new work",
      label: status.label,
      priority: 2,
      tone: status.tone,
    };
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

export function formatElapsedCompact(value: string): string {
  const elapsedMinutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

export function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1_000 ? 1 : 0,
    notation: value >= 1_000 ? "compact" : "standard",
  }).format(value);
}

/**
 * Names the machine-level action that resolves the failure. Recovery is stated against the Computer
 * rather than a person: the Workspace has no authoritative operator field, and issue #125 makes the
 * Agent creator audit-only while stating that enrollment implies no control of the physical host.
 */
export function computerRecoveryMessage(agent: AgentDetailView): string {
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
  return `OpenTag is not running on ${computerName}. Start it there to bring this Computer back online.`;
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
  if (availability.state === "suspended") return { label: "Paused", tone: "neutral" };
  if (availability.state === "setting_up") return { label: "Messaging setup in progress", tone: "info" };
  if (availability.state === "not_connected") return { label: "Messaging not connected", tone: "neutral" };

  if (availability.state === "unconfirmed") {
    if (availability.reason === "computer_unconfirmed") {
      return { label: "Computer status unavailable", tone: "neutral" };
    }
    if (availability.reason === "runtime_unconfirmed") {
      return { label: "Runtime status unavailable", tone: "neutral" };
    }
    if (availability.reason === "handoff_unconfirmed") {
      return { label: "Messaging status unavailable", tone: "neutral" };
    }
    return { label: "Agent status unavailable", tone: "neutral" };
  }

  if (availability.reason === "computer_offline") return { label: "Computer offline", tone: "warning" };
  if (availability.reason === "runtime_unavailable") {
    const { provider, status } = availability.dependencies.runtime;
    const providerName = runtimeProviderName(provider);
    if (status === "checking") return { label: `Checking ${providerName}`, tone: "info" };
    if (status === "install") return { label: `${providerName} not installed`, tone: "warning" };
    if (status === "sign-in") return { label: `${providerName} sign-in required`, tone: "warning" };
    return { label: `${providerName} unavailable`, tone: "warning" };
  }
  if (availability.reason === "im_not_connected") return { label: "Messaging not connected", tone: "neutral" };
  if (availability.reason === "im_provisioning") return { label: "Messaging setup in progress", tone: "info" };
  if (availability.reason === "im_reauthorization_required") {
    return { label: "Messaging authorization required", tone: "warning" };
  }
  if (availability.reason === "im_error") return { label: "Messaging connection error", tone: "warning" };
  if (availability.reason === "handoff_unavailable") return { label: "Cannot receive messages", tone: "warning" };
  return { label: "Agent unavailable", tone: "warning" };
}

export function sharedConversationLabel(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? "Group chats" : "Channels";
}

export function sharedConversationDestination(provider: ImBindingSummary["provider"], plural = false): string {
  if (provider === "feishu") return plural ? "connected Feishu group chats" : "a Feishu group chat";
  return plural ? "connected Slack channels" : "a Slack channel";
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

export function agentAvailabilityRecovery(agent: AgentDetailView): { label: string; to: string } | undefined {
  if (!true || agent.availability.state === "ready") return undefined;
  if (agent.availability.reason === "agent_suspended") {
    return { label: "Manage Agent", to: `/agents/${agent.id}/settings/manage` };
  }
  if (
    agent.availability.reason === "im_not_connected" ||
    agent.availability.reason === "im_provisioning" ||
    agent.availability.reason === "im_reauthorization_required" ||
    agent.availability.reason === "im_error"
  ) {
    return { label: "View messaging", to: `/agents/${agent.id}/settings/messaging` };
  }
  if (agent.availability.reason === "handoff_unavailable") {
    return { label: "View messaging", to: `/agents/${agent.id}/settings/messaging` };
  }
  if (agent.availability.state === "unconfirmed") return undefined;
  return { label: "View Computer", to: `/agents/${agent.id}/settings/computer` };
}

export function agentRecoveryMessage(agent: AgentDetailView): string {
  const messages: Record<NonNullable<AgentAvailability["reason"]>, string> = {
    agent_suspended: "This Agent is paused and cannot accept new requests.",
    agent_unconfirmed: "OpenTag could not confirm this Agent's current status.",
    computer_offline: "The assigned Computer is offline, so new requests cannot start.",
    runtime_unavailable: "The assigned Computer is not ready to run this Agent.",
    runtime_unconfirmed: "OpenTag could not confirm whether the assigned Computer is ready.",
    im_not_connected: "Connect Feishu or Slack so teammates can assign work to this agent.",
    im_provisioning: "The messaging connection is still being set up.",
    im_reauthorization_required: "The messaging connection needs permission to continue receiving requests.",
    im_error: "The messaging connection has an error and cannot receive requests.",
    handoff_unavailable: "Messages cannot currently be handed off to this Agent.",
    computer_unconfirmed: "OpenTag could not confirm the assigned Computer's connection.",
    handoff_unconfirmed: "OpenTag could not confirm whether messaging is available.",
  };
  return agent.availability.reason ? messages[agent.availability.reason] : agentAvailabilitySummary(agent);
}

export function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "OT";
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatRelativeTime(value: string): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
  if (elapsedSeconds < 60) return "just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} ${elapsedMinutes === 1 ? "minute" : "minutes"} ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"} ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} ${elapsedDays === 1 ? "day" : "days"} ago`;
}
