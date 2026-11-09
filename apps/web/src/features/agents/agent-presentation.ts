import type { AgentStatusReason, AgentStatusSnapshot, AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import { formatElapsedCompact, spaceScriptBoundary } from "../../i18n/format.js";
import { messagingProviderLabel } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import type { StatusTone } from "../../ui/design-system.js";
import type { AgentAvailability, AgentDetailView, AgentListItem, AgentStatusSource } from "./agent-model.js";
import {
  type AgentSettingsSectionLink,
  type AgentSetupLink,
  accountComputerLink,
  agentSettingsSectionLink,
  agentSetupLink,
  agentSetupSignInLink,
} from "./agent-routes.js";
import type { AgentSettingsSection } from "./agent-settings/sections.js";

/**
 * The card states what is true and how urgent it is. Its single next step, when the reader can fix
 * the state, comes separately from `agentRowAction`.
 */
type AgentCardStatus = {
  detail?: string;
  label: string;
  tone: StatusTone;
};

export function agentCardStatus(agent: AgentListItem): AgentCardStatus {
  const status = serverStatusPresentation(agent) ?? agentAvailabilityCardStatus(agent);
  const detail = agentActivityDetail(agent);
  return detail ? { ...status, detail } : status;
}

function agentAvailabilityCardStatus(agent: AgentListItem): AgentCardStatus {
  if (agent.status === "suspended" || agent.availability.state === "suspended") {
    return { label: m.agents_card_status_paused(), tone: "neutral" };
  }
  if (!agent.evidenceConfirmed || agent.availability.state === "unconfirmed") {
    return { label: m.agents_card_status_unavailable(), tone: "neutral" };
  }
  if (agent.availability.state === "ready") {
    return { label: m.agents_card_status_ready(), tone: "success" };
  }
  // A delivery check the Computer is still running resolves by itself, like a runtime check does.
  if (agent.availability.reason === "handoff_checking") {
    return { label: m.agents_card_status_checking_messaging(), tone: "info" };
  }
  if (agent.availability.state === "setting_up") {
    return { label: m.agents_card_status_setting_up_messaging(), tone: "info" };
  }
  if (agent.availability.state === "not_connected") {
    return { label: m.agents_card_status_messaging_not_connected(), tone: "neutral" };
  }
  return blockedAgentCardStatus(agent);
}

/**
 * How many Tasks the Agent is running and how many are queued for it. Work in progress and queued
 * work are facts whatever the Agent's status, so they show on every row; queued Tasks beside an
 * offline Computer are how an admin sees work piling up. An idle Agent with nothing queued says
 * nothing beside its status: "Waiting" beside Ready only repeated what Ready already says, and read
 * as the Agent being stuck. An unknown activity says nothing about running work.
 */
export function agentActivityDetail(agent: Pick<AgentListItem, "activity">): string | undefined {
  const { activity } = agent;
  const queued = queuedTasksDetail(activity.queuedTaskCount);
  if (activity.state === "working") {
    const running = runningTasksDetail(activity);
    return queued ? `${running} · ${queued}` : running;
  }
  return queued;
}

function runningTasksDetail(activity: Extract<AgentListItem["activity"], { state: "working" }>): string {
  const count = activity.runningTaskCount;
  if (count === undefined) {
    // A Server without the count still reports when the work started.
    return m.agents_card_activity_working({ elapsed: formatElapsedCompact(activity.startedAt) });
  }
  return count === 1
    ? m.agents_card_activity_running_tasks_single({ count })
    : m.agents_card_activity_running_tasks_plural({ count });
}

function queuedTasksDetail(count: number | undefined): string | undefined {
  if (!count) return undefined;
  return count === 1
    ? m.agents_card_activity_queued_tasks_single({ count })
    : m.agents_card_activity_queued_tasks_plural({ count });
}

function blockedAgentCardStatus(agent: AgentListItem): AgentCardStatus {
  if (agent.availability.reason === "computer_not_bound") {
    return { label: m.agents_card_status_no_computer(), tone: "neutral" };
  }
  if (agent.availability.reason === "computer_offline") {
    // The same word the computer's own card uses, so one computer never reads as two states.
    return agent.availability.dependencies.computer.disconnected
      ? { label: m.agents_card_status_computer_disconnected(), tone: "warning" }
      : { label: m.agents_card_status_computer_offline(), tone: "warning" };
  }
  if (agent.availability.reason === "runtime_unavailable") {
    return runtimeAgentCardStatus(agent);
  }
  if (agent.availability.reason === "im_reauthorization_required") {
    return { label: m.agents_card_status_messaging_permissions_required(), tone: "warning" };
  }
  if (agent.availability.reason === "im_disabled") {
    return { label: m.agents_card_status_messaging_disconnected(), tone: "neutral" };
  }
  if (agent.availability.reason === "handoff_unavailable") {
    return { label: m.agents_card_status_cannot_receive_messages(), tone: "warning" };
  }
  return { label: m.agents_card_status_messaging_connection_failed(), tone: "warning" };
}

function runtimeAgentCardStatus(agent: AgentListItem): AgentCardStatus {
  const { provider, status } = agent.availability.dependencies.runtime;
  const providerName = runtimeProviderName(provider);
  if (status === "checking") {
    return { label: m.agents_card_status_runtime_checking({ providerName }), tone: "info" };
  }
  if (status === "install") {
    return { label: m.agents_card_status_runtime_not_installed({ providerName }), tone: "warning" };
  }
  if (status === "sign-in") {
    return {
      label: m.agents_card_status_runtime_sign_in_required({ providerName }),
      tone: "warning",
    };
  }
  return { label: m.agents_card_status_runtime_unavailable({ providerName }), tone: "warning" };
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
    const providerName = runtimeProviderName(provider);
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
    // One wording for this state everywhere it is shown.
    reauthorization_required: m.agents_card_status_messaging_permissions_required(),
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
  if (provider === "codex") return "Codex";
  if (provider === "claude-code") return "Claude Code";
  return "Pi";
}

/**
 * Presents the exact Agent-level state the viewer can act on. Channel authorization is deliberately
 * excluded: a connected Slack or Feishu App can coexist with an offline Computer or unavailable
 * runtime, and collapsing those facts into one warning made the old status impossible to interpret.
 */
export function agentStatusPresentation(agent: AgentStatusSource): { label: string; tone: StatusTone } {
  return serverStatusPresentation(agent) ?? legacyAgentStatusPresentation(agent);
}

function legacyAgentStatusPresentation(agent: AgentStatusSource): { label: string; tone: StatusTone } {
  const { availability } = agent;
  if (availability.state === "ready") {
    return agent.activity.state === "working"
      ? { label: "Working", tone: "info" }
      : { label: "Ready", tone: "success" };
  }
  if (availability.state === "suspended") return { label: m.agents_card_status_paused(), tone: "neutral" };

  /*
   * Unreadable evidence is one situation to a viewer -- nothing to act on, retried automatically --
   * so it is named for the dependency it covers rather than for which read failed.
   */
  if (availability.state === "unconfirmed") return unconfirmedStatus(availability);

  if (availability.reason === "computer_not_bound") {
    return { label: m.agents_computer_not_bound_label(), tone: "warning" };
  }
  if (availability.reason === "computer_offline") return { label: "Computer offline", tone: "warning" };
  if (availability.reason === "runtime_unavailable") {
    return runtimeStatusPresentation(availability.dependencies.runtime);
  }
  /*
   * Messaging failures are collapsed to as few labels as stay true. "Disconnected" covers the states
   * where no usable binding exists; a binding still being created, and one that is connected while
   * its delivery is not, each get the label that matches what the messaging page says about them.
   */
  if (availability.reason === "handoff_checking") {
    return { label: m.agents_card_status_checking_messaging(), tone: "info" };
  }
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

/** The Provider-specific wording tells a viewer what to do; a single "runtime not available" does not. */
function unconfirmedStatus(availability: AgentAvailability): { label: string; tone: StatusTone } {
  return {
    label:
      availability.reason === "computer_unconfirmed" || availability.reason === "runtime_unconfirmed"
        ? "Computer unknown"
        : "Status unknown",
    tone: "neutral",
  };
}

function runtimeStatusPresentation({ provider, status }: AgentAvailability["dependencies"]["runtime"]): {
  label: string;
  tone: StatusTone;
} {
  const providerName = runtimeProviderName(provider);
  if (status === "checking") return { label: `Checking ${providerName}`, tone: "info" };
  if (status === "install") return { label: `${providerName} not installed`, tone: "warning" };
  if (status === "sign-in") return { label: `${providerName} sign-in required`, tone: "warning" };
  return { label: `${providerName} unavailable`, tone: "warning" };
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
 * Feishu gives each Agent its own bot, so the handle addresses it. Slack uses the bound Bot identity,
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
  if (agent.availability.reason === "handoff_checking") return m.agents_card_status_checking_messaging();
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
  // Nothing to recover from: the check finishes on its own.
  if (agent.availability.reason === "handoff_checking") return undefined;
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
 * The dependencies an Agent needs to do any work, each presented on its own terms. They are
 * deliberately not collapsed into one verdict: a connected channel can coexist with an offline
 * Computer, and a viewer repairing one needs to see the other's state unchanged while they do it.
 */
export type AgentDependencyStatus = {
  action?: { label: string; link: AgentSettingsSectionLink | AgentSetupLink | ReturnType<typeof accountComputerLink> };
  label: string;
  tone: StatusTone;
};

/**
 * The one setup link for an Agent. A runtime that only needs signing in gets "Sign in", which opens
 * the same setup step with its sign-in steps shown; every other setup reason continues setup.
 */
function continueSetupAction(agent: {
  availability: AgentAvailability;
  id: string;
}): NonNullable<AgentDependencyStatus["action"]> {
  const runtime = agent.availability.dependencies.runtime;
  if (agent.availability.reason === "runtime_unavailable" && runtime.status === "sign-in") {
    return { label: m.agents_runtime_sign_in_action(), link: agentSetupSignInLink(agent.id) };
  }
  return { label: m.agents_continue_setup(), link: agentSetupLink(agent.id) };
}

/**
 * The reasons Agent Setup still owns, and so the ones it can still answer for. They are the same
 * set the Agent page routes to setup rather than to Settings: a Computer, the chosen runtime on
 * that Computer, and a messaging app that is connected but not yet finished — a connect left
 * mid-scan, or a provider CLI the Computer could not make ready.
 *
 * `computer_offline` is deliberately absent. Its subject is the machine rather than the flow, and
 * repeating setup does not reach it; the Computer row opens Account maintenance.
 * `handoff_checking` is absent for the opposite reason: the Computer is still working on it, and
 * the answer arrives on its own within seconds, so there is nothing for the reader to continue.
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
  serverStatus?: AgentStatusSnapshot;
}): AgentDependencyStatus["action"] {
  // Setup owns a reason only while no Server verdict says the dependency was set up and broke since.
  const owned = SETUP_REASONS.has(agent.availability.reason) && serverStatusRepair(agent) === undefined;
  return owned ? continueSetupAction(agent) : undefined;
}

/**
 * Server verdicts about a dependency that setup already finished. The Server reports each of them
 * only after the messaging binding is active and the runtime answered, so the legacy reason they
 * project to (`handoff_unavailable`, `runtime_unavailable`) must not be read as setup left
 * unfinished: the card names the verdict, and its action has to repair that verdict.
 *
 * `null` marks a verdict that resolves on its own -- a check that timed out, was rate limited or could
 * not reach the provider is retried by the Computer, and an expired report is replaced by the next one -- so it offers nothing.
 */
const SERVER_REPAIRS: Partial<Record<AgentStatusReason, { label: () => string } | null>> = {
  credential_validation_failed: { label: m.agents_status_action_reconnect_channel },
  messaging_cli_unavailable: { label: m.agents_status_action_fix_messaging },
  credential_validation_timeout: null,
  credential_rate_limited: null,
  credential_provider_unreachable: null,
  messaging_cli_check_timed_out: null,
  runtime_check_timed_out: null,
  self_check_report_stale: null,
};

/**
 * The repair a Server verdict asks for: an action, `null` when the verdict asks for none, or
 * `undefined` when the verdict is not one of these and the legacy reason still decides.
 */
function serverStatusRepair(agent: {
  availability: AgentAvailability;
  id: string;
  serverStatus?: AgentStatusSnapshot;
}): AgentDependencyStatus["action"] | null {
  const reason = agent.serverStatus?.reason;
  if (!reason || agent.availability.state === "unconfirmed" || !(reason in SERVER_REPAIRS)) return undefined;
  const repair = SERVER_REPAIRS[reason];
  return repair ? settingsAction(agent.id, repair.label(), "messaging") : null;
}

/**
 * The one action a list row offers: the place where the state it shows gets fixed.
 *
 * Every blocked state the reader can repair carries the same single link, so no fixable row reads as
 * a dead end beside one that offers a way out. Setup-owned reasons continue setup; messaging that
 * needs new permissions or a reconnect opens the Agent's messaging settings; an offline Computer
 * opens its connection recovery. A paused Agent was paused on purpose and states that fact without
 * an action, and states that resolve on their own (checks, unknown evidence) offer nothing.
 *
 * A Server verdict the card names is answered first, so the action never contradicts the label: a
 * credential check that failed on a finished setup opens messaging settings, never setup.
 */
export function agentRowAction(agent: {
  availability: AgentAvailability;
  computer: AgentListItem["computer"];
  id: string;
  serverStatus?: AgentStatusSnapshot;
}): AgentDependencyStatus["action"] {
  const repair = serverStatusRepair(agent);
  if (repair !== undefined) return repair ?? undefined;
  const setup = agentSetupContinuation(agent);
  if (setup) return setup;
  const { reason } = agent.availability;
  if (reason === "im_reauthorization_required") {
    return settingsAction(agent.id, m.agents_status_action_update_permissions(), "messaging");
  }
  if (reason === "im_error" || reason === "im_disabled") {
    return settingsAction(agent.id, m.agents_status_action_reconnect_channel(), "messaging");
  }
  if (reason === "computer_offline") {
    return { label: m.computer_recovery_heading(), link: accountComputerLink(agent.computer?.computerId, agent.id) };
  }
  return undefined;
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
  if (agent.availability.reason !== setupReason) return maintenance;
  const repair = serverStatusRepair(agent);
  if (repair !== undefined) return repair ?? undefined;
  return continueSetupAction(agent);
}

export function agentComputerStatus(agent: AgentDetailView): AgentDependencyStatus {
  const { computer } = agent.availability.dependencies;
  /*
   * The status is derived from these dependency fields rather than the Agent-wide reason. A
   * higher-ranked reason such as `agent_suspended` can mask a connection problem, but it must not make
   * this row contradict the Computer evidence. Healthy and self-resolving states stay quiet;
   * actionable states name the exact next step instead of adding an explanatory sentence.
   */
  /*
   * An Agent with no Computer is answered first, and with its own exit. Every branch below reads a
   * fact about a machine’s connection, and there is no machine here to read
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
      action: { label: m.computer_recovery_heading(), link: accountComputerLink(agent.computer?.computerId, agent.id) },
      label: m.agents_status_computer_offline(),
      tone: "warning",
    };
  }
  return {
    label: m.agents_status_computer_ready(),
    tone: "success",
  };
}

/** Only report runtime exceptions while the Computer can provide current evidence. */
export function agentRuntimeIssue(agent: AgentDetailView): (AgentDependencyStatus & { guidance?: string }) | undefined {
  const { computer, runtime } = agent.availability.dependencies;
  if (computer.state !== "ready" || runtime.status === "ready") return undefined;
  const providerName = runtimeProviderName(runtime.provider);
  if (!runtime.status) {
    return {
      label: m.agents_runtime_status_unavailable({ providerName }),
      tone: "neutral",
    };
  }
  if (runtime.status === "checking") {
    return {
      label: m.agents_status_computer_checking_runtime({ providerName }),
      tone: "info",
    };
  }
  const localComputer = agent.computerKind !== "cloud" ? agent.computer : null;
  const context = { providerName, computerName: localComputer?.displayName ?? "" };
  const labels = {
    install: () => m.agents_status_computer_runtime_not_installed({ providerName }),
    "sign-in": () => m.agents_status_computer_runtime_sign_in_required({ providerName }),
    unavailable: () => m.agents_status_computer_runtime_unavailable({ providerName }),
  };
  const guidance = {
    install: () => m.computer_runtime_install_help(context),
    "sign-in": () => m.computer_runtime_sign_in_help(context),
    unavailable: () => m.computer_runtime_unavailable_help(context),
  };
  return {
    action: setupOrMaintenanceAction(agent, "runtime_unavailable"),
    label: labels[runtime.status](),
    guidance: localComputer ? guidance[runtime.status]() : undefined,
    tone: "warning",
  };
}

export function agentMessagingStatus(agent: AgentDetailView): AgentDependencyStatus {
  if (agent.status === "suspended" && agent.serverStatus?.state !== "computer_offline") {
    return storedMessagingStatus(agent);
  }
  if (agent.serverStatus && agent.availability.dependencies.handoff.state === "unconfirmed") {
    return { label: m.agents_status_unknown(), tone: "neutral" };
  }
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
  const handoff = agent.status === "suspended" ? undefined : agent.availability.dependencies.handoff;
  /*
   * The Computer is re-verifying delivery on a connected channel. The phase names what it is doing
   * so the row reads as progress rather than as a verdict; there is no action because none is asked.
   */
  if (binding.bindingState === "active" && handoff?.state === "checking") {
    return {
      label:
        handoff.providerCli?.phase === "preparing_cli"
          ? m.agents_status_channel_preparing_cli()
          : m.agents_status_channel_checking_credentials(),
      tone: "info",
    };
  }
  if (binding.bindingState === "active" && handoff?.state === "action_required") {
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
   * A running Agent whose delivery evidence could not be read is `handoff_unconfirmed`. The
   * channel may well be fine, but this row states what is known, and "Connected" is not known.
   */
  if (binding.bindingState === "active" && handoff?.state === "unconfirmed") {
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

function storedMessagingStatus(agent: AgentDetailView): AgentDependencyStatus {
  if (agent.messaging.kind === "unconfirmed") return { label: m.agents_status_unknown(), tone: "neutral" };
  const binding = agent.messaging.value;
  return binding
    ? { label: agentMessagingConnectionLabel(binding), tone: messagingConnectionTone(binding) }
    : { label: m.agents_status_channel_not_connected(), tone: "neutral" };
}

function agentMessagingConnectionLabel(binding: ImBindingSummary): string {
  const labels: Record<ImBindingSummary["bindingState"], string> = {
    active: m.agents_status_channel_connected(),
    provisioning: m.agents_status_channel_setting_up(),
    reauthorization_required: m.agents_card_status_messaging_permissions_required(),
    error: m.agents_status_channel_connection_error(),
    disabled: m.agents_status_channel_disabled(),
  };
  return labels[binding.bindingState];
}

function serverStatusPresentation(
  agent: Pick<AgentStatusSource, "serverStatus" | "availability">,
): AgentCardStatus | undefined {
  const status = agent.serverStatus;
  if (!status || agent.availability.state === "unconfirmed") return undefined;
  if (status.state === "computer_offline") return { label: m.agents_card_status_computer_offline(), tone: "warning" };
  if (status.state === "initializing") return { label: m.agents_status_initializing(), tone: "neutral" };
  const labels: Partial<Record<NonNullable<typeof status.reason>, () => string>> = {
    runtime_check_timed_out: m.agents_status_runtime_timeout,
    self_check_report_stale: m.agents_status_report_stale,
    messaging_cli_check_timed_out: m.agents_status_cli_timeout,
    messaging_cli_unavailable: m.agents_status_cli_unavailable,
    credential_validation_failed: m.agents_status_credential_failed,
    credential_validation_timeout: m.agents_status_credential_timeout,
    credential_rate_limited: m.agents_status_credential_rate_limited,
    credential_provider_unreachable: m.agents_status_credential_provider_unreachable,
    computer_access_required: m.agents_status_computer_access,
  };
  const label = status.reason ? labels[status.reason]?.() : undefined;
  return label ? { label, tone: "warning" } : undefined;
}
