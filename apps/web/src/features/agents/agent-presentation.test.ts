import {
  type AccountComputerSummary,
  type AgentDetail,
  type AgentStatusReason,
  AgentStatusReasonSchema,
  type AgentStatusSnapshot,
  type ImBindingSummary,
} from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import type { AgentAvailability, AgentDetailView, AgentListItem } from "./agent-model.js";
import { applyAgentStatus, projectAgentAvailability } from "./agent-model.js";
import {
  agentAvailabilityRecovery,
  agentAvailabilitySummary,
  agentCardStatus,
  agentComputerStatus,
  agentMessagingStatus,
  agentRowAction,
  agentRuntimeIssue,
  agentSetupContinuation,
  agentStatusPresentation,
  computerRecoveryMessage,
} from "./agent-presentation.js";

const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";

function agentWithoutComputer(): AgentDetail {
  return {
    id: agentId,
    name: "reviewer",
    displayName: "Reviewer",
    createdBy: { userId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d", displayName: "Ada" },
    computer: null,
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    activity: { state: "idle" },
  };
}

function unbound(): AgentDetailView {
  const agent = agentWithoutComputer();
  return {
    ...agent,
    availability: projectAgentAvailability(agent, undefined, undefined, undefined, true, true),
    messaging: { kind: "ready", value: undefined },
  };
}

describe("An Agent with no Computer, as the viewer reads it", () => {
  it("names the state and gives its status row one canonical setup exit", () => {
    const agent = unbound();

    expect(agentStatusPresentation(agent)).toEqual({ label: "No computer assigned", tone: "warning" });
    expect(agentComputerStatus(agent)).toEqual({
      action: {
        label: "Continue setup",
        link: { search: { agentId }, to: "/agents/setup" },
      },
      label: "No computer assigned",
      tone: "warning",
    });
    // The broader recovery helper still names the Settings operation; the detail status row owns
    // the one user-facing setup entry.
    expect(agentAvailabilityRecovery(agent)).toEqual({
      label: "Choose computer",
      link: { params: { agentId, section: "computer" }, to: "/agents/$agentId/settings/$section" },
    });
    // The Computer panel says the same thing without naming a machine, because there is none to name.
    expect(computerRecoveryMessage(agent)).toBe("Choose the computer this Agent will use before it can start working.");
  });
});

const computerId = "b71f9c2a-3d4e-4f5a-8b6c-7d8e9f0a1b2c";

function boundAgent(): AgentDetail {
  return { ...agentWithoutComputer(), computer: { computerId, displayName: "Studio", platform: "darwin" } };
}

function onlineComputer(runtimeStatus: "ready" | "install" | "sign-in"): AccountComputerSummary {
  return {
    computerId,
    displayName: "Studio",
    platform: "darwin",
    connectionStatus: "online",
    providerReadiness: [{ provider: "codex", status: runtimeStatus, observedAt: "2026-08-20T00:00:00.000Z" }],
    connectedAt: "2026-08-20T00:00:00.000Z",
    lastSeenAt: "2026-08-20T00:00:00.000Z",
    observedAt: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
    agentIds: [agentId],
  };
}

function messagingBinding(bindingState: ImBindingSummary["bindingState"]): ImBindingSummary {
  return {
    id: "6a2a3f0e-7c1b-4a9d-9f2e-1b3c4d5e6f70",
    agentId,
    provider: "feishu",
    bindingState,
    bot: { displayName: "Reviewer", avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastValidatedAt: "2026-08-20T00:00:00.000Z",
    lastRuntimeObservationAt: null,
  };
}

function bound(
  connectionStatus: "online" | "offline" | "disconnected",
  runtimeStatus: "ready" | "install" | "sign-in",
): AgentAvailability {
  const computer: AccountComputerSummary = { ...onlineComputer(runtimeStatus), connectionStatus };
  return projectAgentAvailability(boundAgent(), computer, undefined, undefined, true, true);
}

describe("A computer whose access was revoked, on the Agent list", () => {
  it("uses the computer card's word, disconnected, rather than offline", () => {
    const base = { ...boundAgent(), status: "active" as const };
    const view = (connection: "offline" | "disconnected") =>
      ({
        ...base,
        availability: bound(connection, "ready"),
        messaging: { kind: "ready", value: undefined },
      }) as unknown as AgentDetailView;
    expect(agentCardStatus(listed(view("disconnected")))).toEqual({ label: "Computer disconnected", tone: "warning" });
    expect(agentCardStatus(listed(view("offline")))).toEqual({ label: "Computer offline", tone: "warning" });
  });
});

describe("Finishing setup, offered from the Agent list", () => {
  const setupLink = { label: "Continue setup", link: { search: { agentId }, to: "/agents/setup" } };

  it("offers the setup page for every reason setup still owns", () => {
    expect(agentSetupContinuation(unbound())).toEqual(setupLink);
    expect(agentSetupContinuation({ availability: bound("online", "install"), id: agentId })).toEqual(setupLink);
    expect(agentSetupContinuation({ availability: bound("online", "ready"), id: agentId })).toEqual(setupLink);
  });

  it("covers the same reasons the Agent page sends to setup rather than to Settings", () => {
    /*
     * A messaging connect left mid-scan, and a connected channel whose Computer has not made the
     * provider CLI ready, are both the messaging step unfinished. The Agent page already routes
     * them to setup; a list that stayed narrower would hide the same exit from the same state.
     */
    const provisioning = projectAgentAvailability(
      boundAgent(),
      onlineComputer("ready"),
      messagingBinding("provisioning"),
      undefined,
      true,
      true,
    );
    const handoffUnavailable = projectAgentAvailability(
      boundAgent(),
      onlineComputer("ready"),
      messagingBinding("active"),
      { bindingState: "active", handoffReady: false },
      true,
      true,
    );

    expect(provisioning.reason).toBe("im_provisioning");
    expect(handoffUnavailable.reason).toBe("handoff_unavailable");
    expect(agentSetupContinuation({ availability: provisioning, id: agentId })).toEqual(setupLink);
    expect(agentSetupContinuation({ availability: handoffUnavailable, id: agentId })).toEqual(setupLink);
  });

  it("stays silent when setup finished and a dependency broke afterwards", () => {
    // An unreachable machine is not an unfinished setup: the answer is that Agent's own page, where
    // the dependency that broke is named. Sending this reader back to setup would restate a flow
    // they have already been through, for a problem it does not describe.
    expect(agentSetupContinuation({ availability: bound("offline", "ready"), id: agentId })).toBeUndefined();
  });
});

describe("The single action a list row offers", () => {
  const settings = (label: string) => ({
    label,
    link: { params: { agentId, section: "messaging" }, to: "/agents/$agentId/settings/$section" },
  });
  function row(availability: AgentAvailability) {
    const agent = boundAgent();
    return { availability, computer: agent.computer, id: agent.id };
  }
  function messaging(state: "reauthorization_required" | "error" | "disabled") {
    return projectAgentAvailability(
      boundAgent(),
      onlineComputer("ready"),
      messagingBinding(state),
      undefined,
      true,
      true,
    );
  }

  it("names where each fixable blocked state gets fixed", () => {
    expect(agentRowAction(row(bound("online", "install")))).toMatchObject({ label: "Continue setup" });
    expect(agentRowAction(row(bound("online", "sign-in")))).toMatchObject({
      label: "Sign in",
      link: { hash: "sign-in", to: "/agents/setup" },
    });
    expect(agentRowAction(row(messaging("reauthorization_required")))).toMatchObject(settings("Update permissions"));
    expect(agentRowAction(row(messaging("error")))).toMatchObject(settings("Reconnect channel"));
    expect(agentRowAction(row(messaging("disabled")))).toMatchObject(settings("Reconnect channel"));
    const agent = boundAgent();
    expect(agentRowAction(row(bound("offline", "ready")))).toEqual({
      label: "Restore connection",
      link: { search: { computerId: agent.computer?.computerId, fromAgent: agentId }, to: "/agents/computers" },
    });
  });

  it("offers nothing for a ready, paused, or self-resolving Agent", () => {
    const ready = projectAgentAvailability(
      boundAgent(),
      onlineComputer("ready"),
      messagingBinding("active"),
      { bindingState: "active", handoffReady: true },
      true,
      true,
    );
    expect(agentRowAction(row(ready))).toBeUndefined();
    expect(agentRowAction(row({ ...ready, state: "suspended", reason: "agent_suspended" }))).toBeUndefined();
    expect(agentRowAction(row({ ...ready, state: "unconfirmed", reason: "agent_unconfirmed" }))).toBeUndefined();
    expect(agentRowAction(reverifying("checking_credentials"))).toBeUndefined();
  });
});

/** An active channel whose delivery the Computer is re-verifying, exactly as the pages receive it. */
function reverifying(phase: "preparing_cli" | "checking_credentials" | "needs_attention"): AgentDetailView {
  const agent = boundAgent();
  const binding = messagingBinding("active");
  return {
    ...agent,
    availability: projectAgentAvailability(
      agent,
      onlineComputer("ready"),
      binding,
      { bindingState: "active", handoffReady: false, providerCli: { phase } },
      true,
      true,
    ),
    messaging: { kind: "ready", value: binding },
  };
}

function listed(agent: AgentDetailView): AgentListItem {
  return { ...agent, evidenceConfirmed: true, usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 } };
}

describe("A messaging check still in progress, as the viewer reads it", () => {
  /*
   * The Server re-verifies delivery on demand and answers "not ready" until the Computer reports
   * back, which takes seconds. Naming that as a failure sent readers to the settings page and to
   * reloading; the check resolves on its own, so it is presented the way a runtime check is.
   */
  it("is named as a check on the list, with nothing to fix and no setup to continue", () => {
    const agent = reverifying("checking_credentials");
    expect(agentCardStatus(listed(agent))).toEqual({ label: "Checking messaging", tone: "info" });
    expect(agentSetupContinuation(agent)).toBeUndefined();
    expect(agentStatusPresentation(agent)).toEqual({ label: "Checking messaging", tone: "info" });
    expect(agentAvailabilitySummary(agent)).toBe("Checking messaging");
    expect(agentAvailabilityRecovery(agent)).toBeUndefined();
  });

  it.each([
    ["preparing_cli", "Preparing CLI"],
    ["checking_credentials", "Checking credentials"],
  ] as const)("names the %s phase on the Messaging row without offering an action", (phase, label) => {
    expect(agentMessagingStatus(reverifying(phase))).toEqual({ label, tone: "info" });
  });

  it("keeps the failure wording and its exits once the check ended in needs_attention", () => {
    const agent = reverifying("needs_attention");
    expect(agentCardStatus(listed(agent))).toEqual({ label: "Cannot receive messages", tone: "warning" });
    expect(agentMessagingStatus(agent)).toMatchObject({ label: "Cannot receive messages", tone: "warning" });
    expect(agentSetupContinuation(agent)).toEqual({
      label: "Continue setup",
      link: { search: { agentId }, to: "/agents/setup" },
    });
  });
});

describe("Server status reasons across the list and dependency rows", () => {
  const states: Record<AgentStatusReason, AgentAvailability["dependencies"]["handoff"]["state"]> = {
    computer_not_bound: "unconfirmed",
    computer_access_required: "unconfirmed",
    computer_offline: "unconfirmed",
    agent_paused: "unconfirmed",
    runtime_unavailable: "unconfirmed",
    runtime_check_timed_out: "unconfirmed",
    self_check_report_stale: "unconfirmed",
    first_validation: "unconfirmed",
    legacy_checking: "unconfirmed",
    im_not_connected: "not_connected",
    im_provisioning: "setting_up",
    im_reauthorization_required: "action_required",
    im_error: "action_required",
    messaging_cli_unavailable: "action_required",
    messaging_cli_check_timed_out: "action_required",
    credential_validation_failed: "action_required",
    credential_validation_timeout: "action_required",
    credential_rate_limited: "action_required",
    credential_provider_unreachable: "action_required",
  };
  const cases = AgentStatusReasonSchema.options.flatMap((reason) =>
    (states[reason] === "unconfirmed" ? [false, true] : [reason !== "im_not_connected"]).map((hasBinding) => ({
      reason,
      hasBinding,
    })),
  );
  function statusForReason(agent: AgentDetail, reason: AgentStatusReason, hasBinding: boolean): AgentStatusSnapshot {
    const bindingStates: Partial<Record<AgentStatusReason, ImBindingSummary["bindingState"]>> = {
      im_provisioning: "provisioning",
      im_reauthorization_required: "reauthorization_required",
      im_error: "error",
    };
    const phases: Partial<Record<AgentStatusReason, AgentStatusSnapshot["state"]>> = {
      computer_offline: "computer_offline",
      first_validation: "initializing",
      legacy_checking: "initializing",
    };
    return {
      agentId: agent.id,
      agentRevision: 1,
      agentUpdatedAt: agent.updatedAt,
      agentStatus: reason === "agent_paused" ? "suspended" : "active",
      observedAt: agent.updatedAt,
      checkedAt: agent.updatedAt,
      state: phases[reason] ?? "problem",
      reason,
      computer:
        reason === "computer_not_bound" || reason === "computer_access_required"
          ? null
          : {
              computerId: agent.computer?.computerId ?? computerId,
              kind: "local",
              displayName: "Computer",
              platform: "darwin",
              online: reason !== "computer_offline",
              lastSeenAt: agent.updatedAt,
            },
      runtimeProvider: "codex",
      runtimeStatus: reason.startsWith("runtime_") || reason === "self_check_report_stale" ? "unavailable" : "ready",
      messaging: hasBinding ? messagingBinding(bindingStates[reason] ?? "active") : null,
    };
  }
  function unconfirmedMessaging(reason: AgentStatusReason, hasBinding: boolean) {
    if (reason !== "agent_paused") return { label: "Status unavailable", tone: "neutral" };
    return { label: hasBinding ? "Connected" : "Not connected", tone: hasBinding ? "success" : "neutral" };
  }
  it("voids stored paused messaging state while its Computer is offline", () => {
    const agent = boundAgent();
    const status = { ...statusForReason(agent, "computer_offline", true), agentStatus: "suspended" as const };
    expect(agentMessagingStatus(applyAgentStatus(agent, status))).toEqual({
      label: "Status unavailable",
      tone: "neutral",
    });
  });
  it.each(cases)(
    "projects $reason with binding=$hasBinding without inventing another failure",
    ({ reason, hasBinding }) => {
      const agent = boundAgent();
      const status = statusForReason(agent, reason, hasBinding);
      const detail = applyAgentStatus(agent, status);
      const list = listed(detail);
      expect(detail.availability.dependencies.handoff.state).toBe(states[reason]);
      const messaging = agentMessagingStatus(detail);
      if (states[reason] === "unconfirmed") {
        expect(messaging).toEqual(unconfirmedMessaging(reason, hasBinding));
        expect(detail.availability.dependencies.channel.state).toBe("unconfirmed");
        expect(agentCardStatus(list).label).not.toBe("Cannot receive messages");
        expect(agentStatusPresentation(detail).label).not.toBe("Cannot receive messages");
        expect(agentRowAction(list)?.link).not.toMatchObject({ params: { section: "messaging" } });
      }
      if (reason === "im_not_connected") {
        expect(detail.availability.state).toBe("not_connected");
        expect(messaging).toMatchObject({ label: "Not connected", tone: "neutral" });
        expect(agentCardStatus(list).tone).toBe("neutral");
        expect(agentStatusPresentation(detail).tone).toBe("neutral");
      }
      if (states[reason] === "action_required") expect(["warning", "danger"]).toContain(messaging.tone);
    },
  );

  /*
   * The action each Server verdict offers on a list row. The card names the Server verdict, so the
   * action must answer that verdict rather than the legacy reason it projects to: a credential check
   * that failed after setup finished projects to `handoff_unavailable`, which setup also owns.
   */
  const rowActions: Record<AgentStatusReason, string | undefined> = {
    computer_not_bound: "Continue setup",
    computer_access_required: undefined,
    computer_offline: "Restore connection",
    agent_paused: undefined,
    runtime_unavailable: "Continue setup",
    runtime_check_timed_out: undefined,
    self_check_report_stale: undefined,
    first_validation: undefined,
    legacy_checking: undefined,
    im_not_connected: "Continue setup",
    im_provisioning: "Continue setup",
    im_reauthorization_required: "Update permissions",
    im_error: "Reconnect channel",
    messaging_cli_unavailable: "Fix messaging",
    messaging_cli_check_timed_out: undefined,
    credential_validation_failed: "Reconnect channel",
    credential_validation_timeout: undefined,
    credential_rate_limited: undefined,
    credential_provider_unreachable: undefined,
  };
  const messagingRepairs = new Set<AgentStatusReason>([
    "im_reauthorization_required",
    "im_error",
    "messaging_cli_unavailable",
    "credential_validation_failed",
  ]);
  const finishedSetupVerdicts = new Set<AgentStatusReason>([
    "runtime_check_timed_out",
    "self_check_report_stale",
    "messaging_cli_unavailable",
    "messaging_cli_check_timed_out",
    "credential_validation_failed",
    "credential_validation_timeout",
    "credential_rate_limited",
    "credential_provider_unreachable",
  ]);
  it.each(cases)("offers the row action that matches $reason with binding=$hasBinding", ({ reason, hasBinding }) => {
    const agent = boundAgent();
    const detail = applyAgentStatus(agent, statusForReason(agent, reason, hasBinding));
    const action = agentRowAction(listed(detail));
    expect(action?.label).toBe(rowActions[reason]);
    if (messagingRepairs.has(reason)) {
      expect(action?.link).toEqual({
        params: { agentId, section: "messaging" },
        to: "/agents/$agentId/settings/$section",
      });
    }
    if (finishedSetupVerdicts.has(reason)) {
      // Neither the list nor the Agent page may send a finished setup back to setup.
      expect(agentSetupContinuation(detail)).toBeUndefined();
      expect(agentMessagingStatus(detail).action?.label).not.toBe("Continue setup");
      expect(agentMessagingStatus(detail).action?.label).toBe(
        rowActions[reason] === "Restore connection" ? undefined : rowActions[reason],
      );
      expect(agentRuntimeIssue(detail)?.action).toBeUndefined();
    }
  });

  it.each(["feishu", "slack"] as const)(
    "repairs a failed credential check on a %s Agent that finished setup, instead of continuing setup",
    (provider) => {
      // Reproduces the reported list: an Agent connected long ago whose credential check failed.
      const agent = boundAgent();
      const status = statusForReason(agent, "credential_validation_failed", true);
      const binding = status.messaging ? { ...status.messaging, provider } : null;
      const detail = applyAgentStatus(agent, { ...status, messaging: binding });
      const list = listed(detail);
      expect(agentCardStatus(list)).toMatchObject({ label: "Messaging credential check failed", tone: "warning" });
      expect(agentRowAction(list)).toEqual({
        label: "Reconnect channel",
        link: { params: { agentId, section: "messaging" }, to: "/agents/$agentId/settings/$section" },
      });
      expect(agentMessagingStatus(detail)).toMatchObject({
        action: { label: "Reconnect channel" },
        label: "Cannot receive messages",
      });
    },
  );

  it("names an unreachable messaging provider without asking the user to reconnect", () => {
    const agent = boundAgent();
    const detail = applyAgentStatus(agent, statusForReason(agent, "credential_provider_unreachable", true));
    const list = listed(detail);
    expect(agentCardStatus(list)).toMatchObject({ label: "Messaging provider unreachable", tone: "warning" });
    expect(agentRowAction(list)).toBeUndefined();
    expect(agentMessagingStatus(detail).action).toBeUndefined();
  });

  it("keeps continuing setup for an Agent whose messaging was never connected", () => {
    const agent = boundAgent();
    const list = listed(applyAgentStatus(agent, statusForReason(agent, "im_not_connected", false)));
    expect(agentCardStatus(list)).toMatchObject({ label: "Messaging not connected" });
    expect(agentRowAction(list)).toEqual({
      label: "Continue setup",
      link: { search: { agentId }, to: "/agents/setup" },
    });
  });
});
