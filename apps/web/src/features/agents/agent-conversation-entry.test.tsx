import type { AccountComputerSummary, AgentSetupSnapshot, ImBindingAdminDetail } from "@opentag/shared/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSummary } from "../../__tests__/support/app-fixtures.js";
import { renderInRouter } from "../../__tests__/support/router.js";
import { withLocaleAsync } from "../../__tests__/support/with-locale.js";
import { browserApi } from "../../api.js";
import { botConversationUrl } from "../../im/bot-conversation.js";
import { AgentConversationEntry } from "./agent-conversation-entry.js";
import type { AgentDetailView } from "./agent-model.js";
import { projectAgentAvailability } from "./agent-model.js";
import { AgentStatusCard } from "./agent-status-card.js";

function binding(provider: "feishu" | "slack" = "feishu"): ImBindingAdminDetail {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    agentId: agentSummary.id,
    provider,
    bindingState: "active",
    bot: { displayName: "Actual team Bot", avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastValidatedAt: "2026-11-05T00:00:00.000Z",
    lastRuntimeObservationAt: null,
    identity:
      provider === "feishu"
        ? { provider, appId: "cli_current", teamId: null, botOpenId: "ou_current", teamBrand: "feishu" }
        : {
            provider,
            appId: "A_CURRENT",
            teamId: "T_CURRENT",
            botUserId: "U_CURRENT",
            enterpriseId: null,
            appIdEvidence: "configured",
          },
    credentialGeneration: 2,
    grantedCapabilities: [],
    reauthorizationRequired: false,
    lastErrorCode: null,
  };
}

function view(current = binding()): AgentDetailView {
  const agent = { ...agentSummary, activity: { state: "idle" as const } };
  if (!agent.computer) throw new Error("Expected bound fixture");
  const computer: AccountComputerSummary = {
    ...agent.computer,
    connectionStatus: "online",
    providerReadiness: [{ provider: agent.runtimeProvider, status: "ready", observedAt: agent.updatedAt }],
    connectedAt: agent.updatedAt,
    lastSeenAt: agent.updatedAt,
    observedAt: agent.updatedAt,
    createdAt: agent.createdAt,
    agentIds: [agent.id],
  };
  return {
    ...agent,
    availability: projectAgentAvailability(
      agent,
      computer,
      current,
      { bindingState: "active", handoffReady: true },
      true,
      true,
    ),
    messaging: { kind: "ready", value: current },
  };
}

function snapshot(current = binding()): AgentSetupSnapshot {
  // Only these snapshot fields are consumed by the identity fence; status remains the overview's concern.
  return {
    agent: agentSummary,
    messaging: {
      kind: "ready",
      provider: current.provider,
      bindingId: current.id,
      credentialGeneration: current.credentialGeneration,
    },
  } as AgentSetupSnapshot;
}

function reads(current = binding()) {
  const setup = vi.spyOn(browserApi, "agentSetup").mockResolvedValue(snapshot(current));
  const config = vi.spyOn(browserApi, "imBindingConfig").mockResolvedValue(current);
  return { setup, config };
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("returning to the overview's Bot", () => {
  it.each([
    ["en", "feishu", "Open in Feishu", "https://applink.feishu.cn/client/bot/open?appId=cli_current"],
    ["zh", "feishu", "在飞书中打开", "https://applink.feishu.cn/client/bot/open?appId=cli_current"],
    ["en", "slack", "Open in Slack", "https://slack.com/app_redirect?app=A_CURRENT&team=T_CURRENT"],
    ["zh", "slack", "在 Slack 中打开", "https://slack.com/app_redirect?app=A_CURRENT&team=T_CURRENT"],
  ] as const)("offers the %s %s provider entry with folded help", async (locale, provider, label, href) => {
    await withLocaleAsync(locale, async () => {
      const current = binding(provider);
      const { setup, config } = reads(current);
      const writeText = vi.fn();
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      await renderInRouter(<AgentConversationEntry agent={view(current)} />);
      const link = await screen.findByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(screen.queryByRole("button", { name: /Copy Bot name|复制 Bot 名称/ })).toBeNull();
      expect(setup).toHaveBeenCalledExactlyOnceWith(agentSummary.id);
      expect(config).toHaveBeenCalledExactlyOnceWith(agentSummary.id);
      expect(writeText).not.toHaveBeenCalled();
    });
  });

  it.each(["lark", "unknown", null])("never guesses a route for brand %j", async (brand) => {
    const current = binding();
    if (current.identity.provider !== "feishu") throw new Error("Expected Feishu fixture");
    current.identity.teamBrand = brand;
    reads(current);
    await renderInRouter(<AgentConversationEntry agent={view(current)} />);
    const help = await screen.findByRole("button", { name: "Find the Bot" });
    expect(screen.queryByRole("link")).toBeNull();
    expect(help.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(help);
    expect(await screen.findByText("Search for “Actual team Bot” in Lark.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Bot name" })).toBeTruthy();
  });

  it.each([false, true])("reports clipboard outcome honestly (failure=%s)", async (fails) => {
    reads();
    const writeText = fails ? vi.fn().mockRejectedValue(new Error("denied")) : vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderInRouter(<AgentConversationEntry agent={view()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Can’t open it?" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy Bot name" }));
    expect(
      await screen.findByText(
        fails ? "Couldn’t copy. Select and copy the Bot name above manually." : "Bot name copied.",
      ),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Actual team Bot");
    expect(screen.getByText("Search for “Actual team Bot” in Feishu.")).toBeTruthy();
  });

  it("keeps a valid entry when the Bot name is missing, without inventing a search name", async () => {
    const current = { ...binding(), bot: { displayName: null, avatarUrl: null } };
    reads(current);
    await renderInRouter(<AgentConversationEntry agent={view(current)} />);
    expect(await screen.findByRole("link", { name: "Open in Feishu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Can’t open it?" }));
    expect(await screen.findByText("The Bot name is unavailable.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy Bot name" })).toBeNull();
    expect(screen.getByRole("link", { name: "Messaging settings" }).getAttribute("href")).toBe(
      `/agents/${agentSummary.id}/settings/messaging`,
    );
  });

  it.each(["agent", "binding", "provider", "identity", "generation", "inactive", "reauthorization"])(
    "refuses mismatched %s identity instead of exposing an old Bot entry",
    async (field) => {
      const returned = binding();
      if (field === "agent") returned.agentId = "other-agent";
      if (field === "binding") returned.id = "other-binding";
      if (field === "provider") returned.provider = "slack";
      if (field === "identity") returned.identity = binding("slack").identity;
      if (field === "generation") returned.credentialGeneration = 1;
      if (field === "inactive") returned.bindingState = "disabled";
      if (field === "reauthorization") returned.reauthorizationRequired = true;
      const { config } = reads();
      config.mockResolvedValue(returned);
      await renderInRouter(<AgentConversationEntry agent={view()} />);
      expect(await screen.findByText("The Bot entry is unavailable.")).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Open in Feishu" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy Bot name" })).toBeNull();
    },
  );

  it("keeps identity-read failure separate from the overview status", async () => {
    const { config } = reads();
    config.mockRejectedValue(new Error("unavailable"));
    await renderInRouter(<AgentStatusCard agent={view()} />);
    expect(await screen.findByText("The Bot entry is unavailable.")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Lark · Actual team Bot")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Messaging settings" })).toBeTruthy();
  });

  it("retires an in-flight old generation when the overview target changes", async () => {
    const first = binding();
    let release!: (value: ImBindingAdminDetail) => void;
    const { setup, config } = reads(first);
    config.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const mounted = await renderInRouter(<AgentConversationEntry agent={view(first)} />);
    await waitFor(() => expect(config).toHaveBeenCalledTimes(1));
    const next = { ...binding(), credentialGeneration: 3, lastValidatedAt: "2026-11-05T00:01:00.000Z" };
    if (next.identity.provider !== "feishu") throw new Error("Expected Feishu fixture");
    next.identity = { ...next.identity, appId: "cli_new" };
    setup.mockResolvedValue(snapshot(next));
    config.mockResolvedValue(next);
    mounted.rerender(<AgentConversationEntry agent={view(next)} />);
    expect((await screen.findByRole("link", { name: "Open in Feishu" })).getAttribute("href")).toContain("cli_new");
    await act(async () => release(first));
    expect(screen.getByRole("link", { name: "Open in Feishu" }).getAttribute("href")).toContain("cli_new");
  });

  it("keeps the entry and folded-help state when only the runtime observation advances", async () => {
    const current = binding();
    const { setup, config } = reads(current);
    const mounted = await renderInRouter(<AgentConversationEntry agent={view(current)} />);
    const link = await screen.findByRole("link", { name: "Open in Feishu" });
    const help = screen.getByRole("button", { name: "Can’t open it?" });
    fireEvent.click(help);
    await screen.findByRole("button", { name: "Copy Bot name" });
    help.focus();
    mounted.rerender(
      <AgentConversationEntry agent={view({ ...current, lastRuntimeObservationAt: "2026-11-05T00:02:00.000Z" })} />,
    );
    expect(screen.getByRole("link", { name: "Open in Feishu" })).toBe(link);
    expect(help.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(help);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledTimes(1);
  });

  it("retains one fault-repair action without offering use as a repair", async () => {
    const { setup, config } = reads();
    const agent = view();
    agent.availability = {
      ...agent.availability,
      state: "action_required",
      reason: "handoff_unavailable",
      dependencies: {
        ...agent.availability.dependencies,
        handoff: { state: "action_required", lastConfirmedAt: null },
      },
    };
    await renderInRouter(<AgentStatusCard agent={agent} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Open in Feishu" })).toBeNull();
    expect(setup).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
  });

  it("refuses empty routing targets", () => {
    const current = binding("slack").identity;
    if (current.provider !== "slack") throw new Error("Expected Slack fixture");
    expect(botConversationUrl({ ...current, appId: " " })).toBeUndefined();
    expect(botConversationUrl({ ...current, teamId: " " })).toBeUndefined();
  });
});
