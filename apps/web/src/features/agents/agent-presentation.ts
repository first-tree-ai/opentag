import type { AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import { formatElapsedCompact, spaceScriptBoundary } from "../../i18n/format.js";
import { messagingProviderLabel } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import type { StatusTone } from "../../ui/design-system.js";
import type { AgentAvailability, AgentDetailView, AgentListItem, AgentStatusSource } from "./agent-model.js";
import {
  type AgentSettingsSectionLink,
  type AgentSetupLink,
  agentSettingsSectionLink,
  agentSetupLink,
} from "./agent-routes.js";
import type { AgentSettingsSection } from "./agent-settings/sections.js";

/**
 * The card states what is true and how urgent it is. It carries no recovery of its own, because
 * what to do about a broken dependency depends on which one broke, and that explanation lives on
 * the Agent. The one exception is setup that never finished — see `agentSetupContinuation`.
 */
type AgentCardStatus = {
  detail?: string;
  label: string;
  priority: number;
  tone: StatusTone;
};

export function agentCardStatus(agent: AgentListItem): AgentCardStatus {
  if (agent.status === "suspended" || agent.availability.state === "suspended") {
    return { label: m.agents_card_status_paused(), priority: 4, tone: "neutral" };
  }
  if (!agent.evidenceConfirmed || agent.availability.state === "unconfirmed") {
    return { label: m.agents_card_status_unavailable(), priority: 1, tone: "neutral" };
  }
  if (agent.availability.state === "ready") {
    return readyAgentCardStatus(agent);
  }
  if (agent.availability.state === "setting_up") {
    return { label: m.agents_card_status_setting_up_messaging(), priority: 2, tone: "info" };
  }
  if (agent.availability.state === "not_connected") {
    return { label: m.agents_card_status_messaging_not_connected(), priority: 2, tone: "neutral" };
  }
  return blockedAgentCardStatus(agent);
}

function readyAgentCardStatus(agent: AgentListItem): AgentCardStatus {
  return {
    detail:
      agent.activity.state === "working"
        ? m.agents_card_activity_working({ elapsed: formatElapsedCompact(agent.activity.startedAt) })
        : undefined,
    label: m.agents_card_status_ready(),
    priority: 3,
    tone: "success",
  };
}

function blockedAgentCardStatus(agent: AgentListItem): AgentCardStatus {
  if (agent.availability.reason === "computer_not_bound") {
    return { label: m.agents_card_status_no_computer(), priority: 2, tone: "neutral" };
  }
  if (agent.availability.reason === "computer_offline") {
    return { label: m.agents_card_status_computer_offline(), priority: 0, tone: "warning" };
  }
  if (agent.availability.reason === "runtime_unavailable") {
    return runtimeAgentCardStatus(agent);
  }
  if (agent.availability.reason === "im_reauthorization_required") {
    return { label: m.agents_card_status_messaging_permissions_required(), priority: 0, tone: "warning" };
  }
  if (agent.availability.reason === "im_disabled") {
    return { label: m.agents_card_status_messaging_disconnected(), priority: 2, tone: "neutral" };
  }
  if (agent.availability.reason === "handoff_unavailable") {
    return { label: m.agents_card_status_cannot_receive_messages(), priority: 0, tone: "warning" };
  }
  return { label: m.agents_card_status_messaging_connection_failed(), priority: 0, tone: "warning" };
}

function runtimeAgentCardStatus(agent: AgentListItem): AgentCardStatus {
  const { provider, status } = agent.availability.dependencies.runtime;
  const providerName = runtimeProviderName(provider);
  if (status === "checking") {
    return { label: m.agents_card_status_runtime_checking({ providerName }), priority: 2, tone: "info" };
  }
  if (status === "install") {
    return { label: m.agents_card_status_runtime_not_installed({ providerName }), priority: 0, tone: "warning" };
  }
  if (status === "sign-in") {
    return {
      label: m.agents_card_status_runtime_sign_in_required({ providerName }),
      priority: 0,
      tone: "warning",
    };
  }
  return { label: m.agents_card_status_runtime_unavailable({ providerName }), priority: 0, tone: "warning" };
}

/**
 * Names the machine-level action that resolves the failure. Recovery is stated against the Computer
 * rather than a person: the Account model keeps the Agent creator audit-only, and owning a Computer
 * implies no control of the physical host.
 */
export function computerRecoveryMessage(agent: AgentDetailView): string {
  if (!agent.computer) {
    return m.agents_computer_not_bound_recovery();
  }
  const computerName = agent.computer.displayName;
  if (agent.availability.reason === "runtime_unavailable") {
    const { provider, status } = agent.availability.dependencies.runtime;
    const providerName = provider === "codex" ? "Codex" : "Claude Code";
    if (status === "install") {
      return m.agent_settings_computer_recovery_provider_not_installed({ computerName, providerName });
    }
    if (status === "sign-in") {
      return m.agent_settings_computer_recovery_provider_not_signed_in({ computerName, providerName });
    }
    if (status === "checking") {
      return m.agent_settings_computer_recovery_provider_checking({ computerName, providerName });
    }
    return m.agent_settings_computer_recovery_provider_unavailable({ computerName, providerName });
  }
  if (agent.availability.dependencies.computer.state !== "action_required") {
    return m.agent_settings_computer_recovery_unconfirmed();
  }
  return m.agent_settings_computer_recovery_offline({ computerName });
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
  if (provider === "feishu") {
    return spaceScriptBoundary(
      plural
        ? m.agents_shared_destination_group_chats({ provider: brand })
        : m.agents_shared_destination_group_chat({ provider: brand }),
    );
  }
  return spaceScriptBoundary(
    plural
      ? m.agents_shared_destination_channels({ provider: brand })
      : m.agents_shared_destination_channel({ provider: brand }),
  );
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
    return provider
      ? spaceScriptBoundary(m.agents_available_in_channel({ provider: messagingProviderLabel(provider) }))
      : m.agents_ready_for_new_work();
  }
  return {
    action_required: m.agents_cannot_receive_new_work(),
    setting_up: m.agents_messaging_setup_in_progress(),
    not_connected: m.agents_messaging_not_connected_summary(),
    suspended: m.agents_not_receiving_new_work(),
    unconfirmed: m.agents_status_temporarily_unavailable(),
  }[agent.availability.state];
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

/**
 * The one sentence the lifecycle notice can show.
 *
 * This used to map every `AgentAvailability["reason"]` to its own recovery sentence -- fourteen of
 * them. Only one could ever render: the notice returns null unless the Agent is `suspended`, and
 * `projectAgentAvailability` pairs that state with `agent_suspended` and nothing else. The other
 * thirteen read as live copy for years without a reader ever seeing them, and two private helpers
 * existed solely to build strings that were then discarded on every call.
 *
 * Nothing was lost by removing them: a Computer that is offline, a runtime that needs installing,
 * a channel that is not connected each surface on the detail page through their own dependency row,
 * which carries the action that repairs them rather than prose about it.
 */
export function agentRecoveryMessage(): string {
  return m.agents_recovery_suspended();
}

/**
 * The two dependencies an Agent needs to do any work, each presented on its own terms. They are
 * deliberately not collapsed into one verdict: a connected channel can coexist with an offline
 * Computer, and a viewer repairing one needs to see the other's state unchanged while they do it.
 */
export type AgentDependencyStatus = {
  action?: { label: string; link: AgentSettingsSectionLink | AgentSetupLink };
  label: string;
  tone: StatusTone;
};

function continueSetupAction(agentId: string): NonNullable<AgentDependencyStatus["action"]> {
  return { label: m.agents_continue_setup(), link: agentSetupLink(agentId) };
}

/**
 * The reasons Agent Setup still owns, and so the ones it can still answer for. They are the same
 * set the Agent page routes to setup rather than to Settings: a Computer, the chosen runtime on
 * that Computer, and a messaging app that is connected but not yet finished — a connect left
 * mid-scan, or a provider CLI the Computer has not made ready.
 *
 * `computer_offline` is deliberately absent. Its subject is the machine rather than the flow, and
 * repeating setup does not reach it; the Agent page sends it to Settings, and so does the list.
 */
const SETUP_REASONS: ReadonlySet<AgentAvailability["reason"]> = new Set([
  "computer_not_bound",
  "runtime_unavailable",
  "im_not_connected",
  "im_provisioning",
  "handoff_unavailable",
]);

/**
 * Finishing setup, offered from the list rather than only from the Agent.
 *
 * An Agent that was left part-way through setup is the one case where the list can act: whichever
 * of the three is missing, the answer is the same page, so naming the destination costs the reader
 * nothing and saves them from having to discover it. Every other failure keeps the list's rule —
 * open the Agent, where the specific dependency is explained.
 */
export function agentSetupContinuation(agent: {
  availability: AgentAvailability;
  id: string;
}): AgentDependencyStatus["action"] {
  return SETUP_REASONS.has(agent.availability.reason) ? continueSetupAction(agent.id) : undefined;
}

function settingsAction(
  agentId: string,
  label: string,
  section: AgentSettingsSection,
): NonNullable<AgentDependencyStatus["action"]> {
  return { label, link: agentSettingsSectionLink(agentId, section) };
}

/**
 * Only the dependency that currently owns the Agent-wide blocker may offer Setup. This keeps an
 * unbound Agent from showing a second Setup exit on its downstream Messaging row. Existing
 * configuration failures use their focused Settings section instead.
 */
function setupOrMaintenanceAction(
  agent: AgentDetailView,
  setupReason: NonNullable<AgentAvailability["reason"]>,
  maintenance?: NonNullable<AgentDependencyStatus["action"]>,
): AgentDependencyStatus["action"] {
  return agent.availability.reason === setupReason ? continueSetupAction(agent.id) : maintenance;
}

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
      action: setupOrMaintenanceAction(
        agent,
        "computer_not_bound",
        settingsAction(agent.id, m.agents_computer_not_bound_action(), "computer"),
      ),
      label: m.agents_computer_not_bound_label(),
      tone: "warning",
    };
  }
  if (computer.state === "unconfirmed") {
    return {
      action: settingsAction(agent.id, m.agents_status_action_view_computer(), "computer"),
      label: m.agents_status_unknown(),
      tone: "neutral",
    };
  }
  if (computer.state === "action_required") {
    return {
      action: settingsAction(agent.id, m.agents_status_action_open_computer_setup(), "computer"),
      label: m.agents_status_computer_offline(),
      tone: "warning",
    };
  }
  if (!runtime.status) {
    return {
      action: settingsAction(agent.id, m.agents_status_action_view_computer(), "computer"),
      label: m.agents_status_unknown(),
      tone: "neutral",
    };
  }
  if (runtime.status === "checking") {
    return {
      action: setupOrMaintenanceAction(agent, "runtime_unavailable"),
      label: m.agents_status_computer_checking_runtime({ providerName }),
      tone: "info",
    };
  }
  if (runtime.status === "install") {
    return {
      action: setupOrMaintenanceAction(
        agent,
        "runtime_unavailable",
        settingsAction(agent.id, m.agents_status_action_set_up_runtime({ providerName }), "computer"),
      ),
      label: m.agents_status_computer_runtime_not_installed({ providerName }),
      tone: "warning",
    };
  }
  if (runtime.status === "sign-in") {
    return {
      action: setupOrMaintenanceAction(
        agent,
        "runtime_unavailable",
        settingsAction(agent.id, m.agents_status_action_sign_in_to_runtime({ providerName }), "computer"),
      ),
      label: m.agents_status_computer_runtime_sign_in_required({ providerName }),
      tone: "warning",
    };
  }
  if (runtime.status !== "ready") {
    return {
      action: setupOrMaintenanceAction(
        agent,
        "runtime_unavailable",
        settingsAction(agent.id, m.agents_status_action_troubleshoot_runtime({ providerName }), "computer"),
      ),
      label: m.agents_status_computer_runtime_unavailable({ providerName }),
      tone: "warning",
    };
  }
  return { label: m.agents_status_computer_ready(), tone: "success" };
}

export function agentMessagingStatus(agent: AgentDetailView): AgentDependencyStatus {
  if (agent.messaging.kind === "unconfirmed") {
    return {
      action: settingsAction(agent.id, m.agents_status_action_view_channel(), "messaging"),
      label: m.agents_status_unknown(),
      tone: "neutral",
    };
  }
  const binding = agent.messaging.value;
  if (!binding) {
    return {
      action: setupOrMaintenanceAction(
        agent,
        "im_not_connected",
        settingsAction(agent.id, m.agents_status_action_connect_channel(), "messaging"),
      ),
      label: m.agents_status_channel_not_connected(),
      tone: "neutral",
    };
  }
  const handoff = agent.availability.dependencies.handoff;
  if (binding.bindingState === "active" && handoff.state === "action_required") {
    return {
      action: setupOrMaintenanceAction(
        agent,
        "handoff_unavailable",
        settingsAction(agent.id, m.agents_status_action_fix_messaging(), "messaging"),
      ),
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
      action: settingsAction(agent.id, m.agents_status_action_view_channel(), "messaging"),
      label: m.agents_status_unknown(),
      tone: "neutral",
    };
  }
  const actions: Partial<Record<ImBindingSummary["bindingState"], AgentDependencyStatus["action"]>> = {
    provisioning: setupOrMaintenanceAction(
      agent,
      "im_provisioning",
      settingsAction(agent.id, m.agents_status_action_view_setup(), "messaging"),
    ),
    reauthorization_required: settingsAction(agent.id, m.agents_status_action_update_permissions(), "messaging"),
    error: settingsAction(agent.id, m.agents_status_action_reconnect_channel(), "messaging"),
    disabled: settingsAction(agent.id, m.agents_status_action_reconnect_channel(), "messaging"),
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
