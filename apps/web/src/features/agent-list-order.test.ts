import type {
  AgentAdminConfig,
  AgentSummary,
  ImBindingHandoffStatus,
  ImBindingSummary,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { formatCompactNumber, formatElapsedCompact, formatRelativeTime, initials } from "../i18n/format.js";
import { orderAgentIds } from "./agent-list-order.js";
import {
  type AgentAvailability,
  type AgentDetailView,
  type AgentListItem,
  markAgentDetailUnconfirmed,
  markAgentListUnconfirmed,
  projectAgentAvailability,
} from "./agents/agent-model.js";
import {
  agentAvailabilityRecovery,
  agentAvailabilitySummary,
  agentCardStatus,
  agentRecoveryMessage,
  agentStatusPresentation,
  agentUseInstruction,
  computerRecoveryMessage,
  messagingAgentStatusDescription,
  messagingChannelLabel,
  messagingConnectionLabel,
  messagingConnectionTone,
  platformLabel,
  runtimeProviderName,
  sharedConversationDestination,
  sharedConversationLabel,
  titleCase,
} from "./agents/agent-presentation.js";
import { agentDetailLink, agentSettingsLink, agentSettingsSectionLink, agentUsageLink } from "./agents/agent-routes.js";
import { agentSettingsSummary } from "./agents/agent-settings/sections.js";

describe("Agent list order", () => {
  it("takes the incoming priority order on the first render", () => {
    expect(orderAgentIds(["c", "a", "b"], [])).toEqual(["c", "a", "b"]);
  });

  it("keeps the shown order when a status change would resort the list", () => {
    expect(orderAgentIds(["c", "a", "b"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("adds Agents created since the first render at the end", () => {
    expect(orderAgentIds(["d", "a", "c", "b"], ["a", "b"])).toEqual(["a", "b", "d", "c"]);
  });

  it("drops Agents that have left the list", () => {
    expect(orderAgentIds(["c", "a"], ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  it("returns the same order when applied to its own result", () => {
    const once = orderAgentIds(["c", "a", "b"], ["a", "b"]);
    expect(orderAgentIds(["c", "a", "b"], once)).toEqual(once);
  });
});

describe("Agent availability model and presentation", () => {
  const boundComputerId = "22222222-2222-4222-8222-222222222222";
  const agent = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "reviewer",
    displayName: "Code Reviewer",
    runtimeProvider: "codex",
    status: "active",
    updatedAt: "2026-08-20T00:00:00.000Z",
    activity: { state: "idle" },
    computer: { computerId: boundComputerId, displayName: "Desk Mac", platform: "darwin" },
  } as unknown as AgentSummary;
  const computer = {
    computerId: boundComputerId,
    connectionStatus: "online",
    lastSeenAt: "2026-08-20T00:00:00.000Z",
    providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
  } as unknown as WorkspaceComputerSummary;
  const binding = (bindingState: string, provider = "feishu", displayName: string | null = "OpenTag") =>
    ({
      id: "33333333-3333-4333-8333-333333333333",
      agentId: agent.id,
      provider,
      bindingState,
      bot: { displayName, avatarUrl: null },
      receiveMode: "mention_only",
      lastInboundAt: null,
      lastValidatedAt: "2026-08-20T00:00:00.000Z",
      lastRuntimeObservationAt: null,
    }) as unknown as ImBindingSummary;
  const handoff = (handoffReady: boolean, bindingState = "active") =>
    ({ bindingState, handoffReady }) as ImBindingHandoffStatus;
  const detail = (availability: AgentAvailability): AgentDetailView =>
    ({ ...agent, availability, messaging: { kind: "ready", value: binding("active") } }) as never;

  it("projects every Computer, runtime, binding, and handoff state", () => {
    expect(
      projectAgentAvailability(
        { ...agent, status: "suspended" },
        computer,
        binding("active"),
        handoff(true),
        true,
        true,
      ).state,
    ).toBe("suspended");
    expect(projectAgentAvailability(agent, undefined, undefined, undefined, false, false)).toMatchObject({
      state: "unconfirmed",
      reason: "computer_unconfirmed",
    });
    expect(
      projectAgentAvailability(agent, { ...computer, connectionStatus: "offline" }, undefined, undefined, true, true),
    ).toMatchObject({
      state: "action_required",
      reason: "computer_offline",
    });
    expect(
      projectAgentAvailability(agent, { ...computer, providerReadiness: [] }, undefined, undefined, true, true),
    ).toMatchObject({
      state: "unconfirmed",
      reason: "runtime_unconfirmed",
    });
    for (const status of ["checking", "install", "sign-in", "unavailable"] as const) {
      expect(
        projectAgentAvailability(
          agent,
          { ...computer, providerReadiness: [{ provider: "codex", status, observedAt: null }] },
          undefined,
          undefined,
          true,
          true,
        ),
      ).toMatchObject({ state: "action_required", reason: "runtime_unavailable" });
    }
    expect(projectAgentAvailability(agent, computer, binding("active"), handoff(true), false, true).reason).toBe(
      "handoff_unconfirmed",
    );
    expect(projectAgentAvailability(agent, computer, undefined, undefined, true, true).reason).toBe("im_not_connected");
    expect(projectAgentAvailability(agent, computer, binding("provisioning"), handoff(false), true, true).state).toBe(
      "setting_up",
    );
    expect(
      projectAgentAvailability(agent, computer, binding("reauthorization_required"), handoff(false), true, true).reason,
    ).toBe("im_reauthorization_required");
    expect(projectAgentAvailability(agent, computer, binding("error"), handoff(false), true, true).reason).toBe(
      "im_error",
    );
    expect(projectAgentAvailability(agent, computer, binding("disabled"), handoff(false), true, true).reason).toBe(
      "im_disabled",
    );
    expect(projectAgentAvailability(agent, computer, binding("active"), handoff(false), true, true).reason).toBe(
      "handoff_unavailable",
    );
    expect(projectAgentAvailability(agent, computer, binding("active"), handoff(true), true, true)).toMatchObject({
      state: "ready",
      reason: null,
    });
  });

  it("marks stale list/detail evidence unconfirmed", () => {
    const listAgent = {
      ...agent,
      computer: { ...agent.computer },
      activity: { state: "idle" },
      usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
    };
    const listValue = {
      agents: [
        {
          ...listAgent,
          availability: projectAgentAvailability(agent, computer, binding("active"), handoff(true), true, true),
          evidenceConfirmed: true,
        } as never,
      ],
    } as { agents: AgentListItem[] };
    expect(markAgentListUnconfirmed(listValue).agents[0]).toMatchObject({
      evidenceConfirmed: false,
      availability: { reason: "agent_unconfirmed" },
    });
    const detailValue = detail(projectAgentAvailability(agent, computer, binding("active"), handoff(true), true, true));
    expect(markAgentDetailUnconfirmed(detailValue)).toMatchObject({
      messaging: { kind: "unconfirmed" },
      availability: { reason: "agent_unconfirmed", dependencies: { computer: { state: "unconfirmed" } } },
    });
  });

  it("presents provider, messaging, recovery, and formatting states", () => {
    const base = detail(projectAgentAvailability(agent, computer, binding("active"), handoff(true), true, true));
    expect(agentStatusPresentation(base)).toEqual({ label: "Ready", tone: "success" });
    expect(
      agentStatusPresentation({ ...base, activity: { state: "working", startedAt: "2026-08-20T00:00:00.000Z" } }),
    ).toEqual({
      label: "Working",
      tone: "info",
    });
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "suspended", reason: "agent_suspended" },
      }),
    ).toEqual({ label: "Suspended", tone: "neutral" });
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "unconfirmed", reason: "runtime_unconfirmed" },
      }),
    ).toEqual({ label: "Computer unknown", tone: "neutral" });
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "unconfirmed", reason: "agent_unconfirmed" },
      }),
    ).toEqual({ label: "Status unknown", tone: "neutral" });
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "action_required", reason: "computer_offline" },
      }),
    ).toEqual({ label: "Computer offline", tone: "warning" });
    for (const status of ["checking", "install", "sign-in", "unavailable"] as const) {
      expect(
        agentStatusPresentation({
          ...base,
          availability: {
            ...base.availability,
            state: "action_required",
            reason: "runtime_unavailable",
            dependencies: { ...base.availability.dependencies, runtime: { provider: "claude-code", status } },
          },
        }),
      ).toMatchObject({ label: expect.any(String) });
    }
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "setting_up", reason: "im_provisioning" },
      }),
    ).toMatchObject({ label: "Messaging setting up" });
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "action_required", reason: "im_reauthorization_required" },
      }),
    ).toMatchObject({ label: "Messaging needs re-authorization" });
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "action_required", reason: "handoff_unavailable" },
      }),
    ).toMatchObject({ label: "Cannot receive messages" });
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "not_connected", reason: "im_not_connected" },
      }),
    ).toMatchObject({ label: "Messaging disconnected", tone: "neutral" });
    expect(
      agentStatusPresentation({
        ...base,
        availability: { ...base.availability, state: "action_required", reason: null },
      }),
    ).toEqual({ label: "Messaging disconnected", tone: "warning" });

    for (const status of ["install", "sign-in", "checking", "unavailable"] as const) {
      expect(
        computerRecoveryMessage({
          ...base,
          availability: {
            ...base.availability,
            reason: "runtime_unavailable",
            dependencies: { ...base.availability.dependencies, runtime: { provider: "codex", status } },
          },
        }),
      ).toContain("Codex");
    }
    expect(
      computerRecoveryMessage({
        ...base,
        availability: {
          ...base.availability,
          reason: "computer_offline",
          dependencies: {
            ...base.availability.dependencies,
            computer: { state: "action_required", lastConfirmedAt: null },
          },
        },
      }),
    ).toContain("not running");
    expect(
      computerRecoveryMessage({
        ...base,
        availability: {
          ...base.availability,
          reason: "computer_offline",
          dependencies: {
            ...base.availability.dependencies,
            computer: { state: "unconfirmed", lastConfirmedAt: null },
          },
        },
      }),
    ).toContain("could not confirm");
    expect(messagingChannelLabel(base, binding("active", "feishu"))).toContain("@reviewer");
    expect(messagingChannelLabel(base, binding("active", "slack", "Team Bot"))).toContain("Team Bot");
    expect(messagingChannelLabel(base, binding("active", "slack", null))).toBe("Slack");
    expect(messagingConnectionLabel(binding("reauthorization_required", "feishu"))).toBe("Permissions update required");
    expect(messagingConnectionTone(binding("disabled"))).toBe("neutral");
    expect(sharedConversationLabel("feishu")).toBe("Group chats");
    expect(sharedConversationLabel("slack")).toBe("Channels");
    expect(sharedConversationDestination("feishu")).toContain("Feishu");
    expect(sharedConversationDestination("slack", true)).toContain("Slack");
    expect(agentAvailabilitySummary(base)).toBe("Available in Feishu");
    expect(
      agentAvailabilitySummary({
        ...base,
        availability: {
          ...base.availability,
          dependencies: {
            ...base.availability.dependencies,
            channel: { state: "connected", provider: null, botDisplayName: null },
          },
        },
      }),
    ).toBe("Ready for new work");
    expect(agentAvailabilitySummary({ ...base, availability: { ...base.availability, state: "suspended" } })).toBe(
      "Not receiving new work",
    );
    expect(
      agentRecoveryMessage({
        ...base,
        availability: { ...base.availability, reason: "im_not_connected", state: "not_connected" },
      }),
    ).toContain("Connect");
    expect(
      agentRecoveryMessage({ ...base, availability: { ...base.availability, reason: null, state: "ready" } }),
    ).toContain("Available");
    expect(agentUseInstruction(base, "feishu")).toContain("mention it in a Feishu group chat");
    expect(agentUseInstruction({ ...base, receiveMode: "all_message" }, "slack")).toContain(
      "every message in connected Slack channels",
    );
    expect(messagingAgentStatusDescription(base, "feishu")).toContain("Ready to receive");
    expect(
      messagingAgentStatusDescription(
        { ...base, activity: { state: "working", startedAt: "2026-08-20T00:00:00.000Z" } },
        "slack",
      ),
    ).toContain("handling a request");
    for (const reason of ["computer_offline", "runtime_unavailable"] as const) {
      expect(
        messagingAgentStatusDescription(
          { ...base, availability: { ...base.availability, state: "action_required", reason } },
          "feishu",
        ),
      ).toBeTruthy();
    }
    expect(
      messagingAgentStatusDescription(
        { ...base, availability: { ...base.availability, state: "action_required", reason: "handoff_unavailable" } },
        "slack",
      ),
    ).toContain("Slack is connected");
    expect(
      messagingAgentStatusDescription(
        { ...base, availability: { ...base.availability, state: "not_connected", reason: "im_not_connected" } },
        "feishu",
      ),
    ).toContain("Connect");
    expect(
      agentAvailabilityRecovery({
        ...base,
        availability: { ...base.availability, reason: "agent_suspended", state: "suspended" },
      }),
    ).toMatchObject({ label: "Manage Agent" });
    expect(
      agentAvailabilityRecovery({
        ...base,
        availability: { ...base.availability, reason: "im_error", state: "action_required" },
      }),
    ).toMatchObject({ label: "View messaging" });
    expect(
      agentAvailabilityRecovery({
        ...base,
        availability: { ...base.availability, reason: "computer_offline", state: "action_required" },
      }),
    ).toMatchObject({ label: "View Computer" });
    expect(
      agentAvailabilityRecovery({
        ...base,
        availability: { ...base.availability, reason: "agent_unconfirmed", state: "unconfirmed" },
      }),
    ).toBeUndefined();
    expect(agentCardStatus({ ...base, evidenceConfirmed: false } as never)).toMatchObject({ label: "Unconfirmed" });
    expect(
      agentCardStatus({
        ...base,
        evidenceConfirmed: true,
        availability: { ...base.availability, state: "not_connected" },
      } as never),
    ).toEqual({
      detail: "Cannot receive new work",
      label: "Messaging disconnected",
      priority: 2,
      tone: "neutral",
    });
    expect(
      agentCardStatus({
        ...base,
        evidenceConfirmed: true,
        availability: { ...base.availability, state: "action_required", reason: "runtime_unavailable" },
      } as never),
    ).toMatchObject({ detail: "Cannot receive new work", priority: 0, tone: "warning" });
    expect(
      agentCardStatus({
        ...base,
        evidenceConfirmed: true,
        availability: { ...base.availability, state: "action_required", reason: "im_error" },
      } as never),
    ).toEqual({
      detail: "Cannot receive new work",
      label: "Messaging disconnected",
      priority: 0,
      tone: "warning",
    });
    expect(
      agentCardStatus({
        ...base,
        evidenceConfirmed: true,
        availability: { ...base.availability, state: "setting_up", reason: "im_provisioning" },
      } as never),
    ).toMatchObject({ detail: "Messaging setup in progress" });
    expect(titleCase("runtime_unavailable")).toBe("Runtime Unavailable");
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(runtimeProviderName("codex")).toBe("Codex");
    expect(runtimeProviderName("claude-code")).toBe("Claude Code");
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials(" ")).toBe("OT");
    expect(formatCompactNumber(1_500)).toContain("1.5");
    expect(formatCompactNumber(12)).toBe("12");
    expect(formatElapsedCompact(new Date(Date.now() - 2 * 60_000).toISOString())).toBe("2m");
    expect(formatElapsedCompact(new Date(Date.now() - 2 * 60 * 60_000).toISOString())).toBe("2h");
    expect(formatElapsedCompact(new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString())).toBe("2d");
    expect(formatRelativeTime(new Date(Date.now() - 60_000).toISOString())).toBe("1 minute ago");
    expect(formatRelativeTime(new Date(Date.now() - 2 * 60 * 60_000).toISOString())).toBe("2 hours ago");
    expect(formatRelativeTime(new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString())).toBe("2 days ago");
  });

  it("builds typed Agent links and settings summaries", () => {
    const base = detail(projectAgentAvailability(agent, computer, binding("active"), handoff(true), true, true));
    expect(agentDetailLink(agent.id).to).toBe("/agents/$agentId");
    expect(agentUsageLink(agent.id).to).toBe("/agents/$agentId/usage");
    expect(agentSettingsLink(agent.id).to).toBe("/agents/$agentId/settings");
    expect(agentSettingsSectionLink(agent.id, "computer").params.section).toBe("computer");
    const config = {
      id: agent.id,
      createdByUserId: "user",
      computerId: boundComputerId,
      name: agent.name,
      displayName: agent.displayName,
      runtimeProvider: agent.runtimeProvider,
      receiveMode: agent.receiveMode,
      status: agent.status,
      revision: 1,
      runtimeConfig: { revision: 1, instructions: "Custom", model: null, reasoningEffort: null, maxDurationMs: null },
      createdAt: agent.updatedAt,
      updatedAt: agent.updatedAt,
    } satisfies AgentAdminConfig;
    expect(agentSettingsSummary(detail(base.availability), config, "instructions")).toBe("Custom instructions");
    expect(
      agentSettingsSummary(
        detail(base.availability),
        { ...config, runtimeConfig: { ...config.runtimeConfig, instructions: " " } },
        "instructions",
      ),
    ).toBe("Not configured");
    expect(agentSettingsSummary(detail(base.availability), config, "execution")).toContain("Provider defaults");
    expect(
      agentSettingsSummary(
        detail(base.availability),
        { ...config, runtimeConfig: { ...config.runtimeConfig, model: null, reasoningEffort: "high" } },
        "execution",
      ),
    ).toContain("Default model · High");
    expect(
      agentSettingsSummary(
        detail(base.availability),
        { ...config, runtimeConfig: { ...config.runtimeConfig, model: "custom", reasoningEffort: null } },
        "execution",
      ),
    ).toContain("Default reasoning");
    expect(
      agentSettingsSummary({ ...detail(base.availability), messaging: { kind: "unconfirmed" } }, config, "messaging"),
    ).toBe("Messaging status is temporarily unavailable");
    expect(
      agentSettingsSummary(
        { ...detail(base.availability), messaging: { kind: "ready", value: undefined } },
        config,
        "messaging",
      ),
    ).toBe("No messaging channel connected");
    expect(agentSettingsSummary(detail(base.availability), config, "identity")).toBe(agent.displayName);
    expect(agentSettingsSummary(detail(base.availability), config, "computer")).toContain("macOS");
    expect(agentSettingsSummary(detail(base.availability), config, "manage")).toBe("Active");
  });
});
