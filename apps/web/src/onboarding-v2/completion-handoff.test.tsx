import type { AgentSetupMessagingState, ImBindingAdminDetail } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSetupPage } from "./agent-setup-page.js";
import { SETUP_AGENT_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import { CompletionHandoff, completionHandoff } from "./completion-handoff.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";
import { DoneStep } from "./steps.js";

const BINDING_ID = "44444444-4444-4444-8444-444444444444";
const READY = { kind: "ready", provider: "slack", bindingId: BINDING_ID, credentialGeneration: 1 } as const;

function binding(overrides: Partial<ImBindingAdminDetail> = {}): ImBindingAdminDetail {
  return {
    id: BINDING_ID,
    agentId: SETUP_AGENT_ID,
    provider: "slack",
    bindingState: "active",
    bot: { displayName: "Actual team Bot", avatarUrl: null },
    receiveMode: "all_message",
    lastInboundAt: null,
    lastValidatedAt: null,
    lastRuntimeObservationAt: null,
    identity: {
      provider: "slack",
      appId: "A_DEMO",
      teamId: "T_DEMO",
      enterpriseId: null,
      botUserId: "U_DEMO",
      appIdEvidence: "configured",
    },
    credentialGeneration: 1,
    grantedCapabilities: [],
    reauthorizationRequired: false,
    lastErrorCode: null,
    ...overrides,
  };
}

function feishuBinding(teamBrand: string | null) {
  return binding({
    provider: "feishu",
    identity: { provider: "feishu", appId: "cli_demo", teamId: null, botOpenId: "ou_demo", teamBrand },
  });
}

function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("completion Bot handoff", () => {
  it("loads completion identity through the setup page's injected adapter", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    if (snapshot.messaging.kind !== "ready") throw new Error("Expected ready fixture");
    const readMessagingBinding = vi.fn().mockResolvedValue(binding({ id: snapshot.messaging.bindingId }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AgentSetupPage agentId={SETUP_AGENT_ID} adapter={{ ...memory.adapter, readMessagingBinding }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("link", { name: "Open Bot in Slack" })).toBeTruthy();
    expect(readMessagingBinding).toHaveBeenCalledExactlyOnceWith(SETUP_AGENT_ID);
    view.unmount();
    queryClient.clear();
  });

  it("uses the connected Slack App and Team, retains exact management navigation, and never sends on its own", async () => {
    const readBinding = vi.fn().mockResolvedValue(binding());
    const writeText = stubClipboard();
    const onOpenAgent = vi.fn();
    render(
      <DoneStep
        name="internal-handle"
        provider="slack"
        action={{ label: "View agent", onClick: onOpenAgent }}
        handoff={completionHandoff(SETUP_AGENT_ID, READY, readBinding, false)}
      />,
    );
    const link = await screen.findByRole("link", { name: "Open Bot in Slack" });
    expect(link.getAttribute("href")).toBe("https://slack.com/app_redirect?app=A_DEMO&team=T_DEMO");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("Actual team Bot")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy request|Action list|Short update/ })).toBeNull();
    expect(screen.queryByText(/Hello|verify delivery|Try a small task/)).toBeNull();
    expect(readBinding).toHaveBeenCalledExactlyOnceWith(SETUP_AGENT_ID);
    expect(writeText).not.toHaveBeenCalled();
    expect(onOpenAgent).not.toHaveBeenCalled();
    const actions = within(screen.getByRole("group", { name: "Next steps" }));
    expect(actions.getByRole("link", { name: "Open Bot in Slack" })).toBe(link);
    expect(actions.getByRole("button", { name: "View agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View agent" }));
    expect(onOpenAgent).toHaveBeenCalledOnce();
  });

  it("offers the documented Feishu App link and an explicit real-name search fallback", async () => {
    const writeText = stubClipboard();
    render(
      <CompletionHandoff
        agentId={SETUP_AGENT_ID}
        messaging={{ ...READY, provider: "feishu" }}
        readBinding={async () => feishuBinding("feishu")}
      />,
    );
    const link = await screen.findByRole("link", { name: "Open Bot in Lark" });
    expect(link.getAttribute("href")).toBe("https://applink.feishu.cn/client/bot/open?appId=cli_demo");
    fireEvent.click(screen.getByRole("button", { name: "Can’t open the Bot?" }));
    expect(await screen.findByText(/Search for “Actual team Bot”/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy Bot name" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Actual team Bot"));
  });

  it.each(["lark", "unknown", null])("uses search without guessing a Bot URL for brand %s", async (brand) => {
    render(
      <CompletionHandoff
        agentId={SETUP_AGENT_ID}
        messaging={{ ...READY, provider: "feishu" }}
        readBinding={async () => feishuBinding(brand)}
      />,
    );
    expect(await screen.findByRole("button", { name: "Copy Bot name" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Search for “Actual team Bot” in Lark/)).toBeTruthy();
  });

  it.each([
    { agentId: "77777777-7777-4777-8777-777777777777" },
    { id: "77777777-7777-4777-8777-777777777777" },
    { credentialGeneration: 2 },
    { provider: "feishu" },
    { identity: feishuBinding("feishu").identity },
    { bindingState: "error" },
    { reauthorizationRequired: true },
  ] satisfies Partial<ImBindingAdminDetail>[])("does not offer stale or unusable identity: %j", async (overrides) => {
    render(
      <CompletionHandoff agentId={SETUP_AGENT_ID} messaging={READY} readBinding={async () => binding(overrides)} />,
    );
    expect(await screen.findByText(/details could not be loaded/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Actual team Bot")).toBeNull();
  });

  it.each([undefined, null, new Error("unavailable")])(
    "keeps a useful next step when the detail read is absent or fails: %s",
    async (outcome) => {
      const readBinding =
        outcome === null
          ? undefined
          : async () => {
              if (outcome instanceof Error) throw outcome;
              return outcome;
            };
      render(<CompletionHandoff agentId={SETUP_AGENT_ID} messaging={READY} readBinding={readBinding} />);
      expect(await screen.findByText(/View this Agent and check its messaging settings/)).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
    },
  );

  it("keeps exact Agent navigation available while the Bot identity is loading or unavailable", async () => {
    let resolve: (value: ImBindingAdminDetail | undefined) => void = () => undefined;
    const readBinding = vi.fn(
      () =>
        new Promise<ImBindingAdminDetail | undefined>((done) => {
          resolve = done;
        }),
    );
    const onOpenAgent = vi.fn();
    render(
      <DoneStep
        name="my-agent"
        provider="slack"
        action={{ label: "View agent", onClick: onOpenAgent }}
        handoff={completionHandoff(SETUP_AGENT_ID, READY, readBinding, false)}
      />,
    );
    expect(screen.getByRole("heading", { name: "my-agent is ready." })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Finding the connected Bot…");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Connected")).toBeNull();
    const actions = within(screen.getByRole("group", { name: "Next steps" }));
    fireEvent.click(actions.getByRole("button", { name: "View agent" }));
    expect(onOpenAgent).toHaveBeenCalledOnce();
    await waitFor(() => expect(readBinding).toHaveBeenCalledOnce());
    await act(async () => resolve(undefined));
    expect(screen.getByRole("status").textContent).toContain("details could not be loaded");
    expect(actions.getByRole("button", { name: "View agent" }).hasAttribute("disabled")).toBe(false);
  });

  it.each([null, "", "   "])(
    "keeps a verified entry without inventing a name or search when displayName is missing: %j",
    async (displayName) => {
      render(
        <CompletionHandoff
          agentId={SETUP_AGENT_ID}
          messaging={READY}
          readBinding={async () => binding({ bot: { displayName, avatarUrl: null } })}
        />,
      );
      const link = await screen.findByRole("link", { name: "Open Bot in Slack" });
      expect(link.getAttribute("href")).toBe("https://slack.com/app_redirect?app=A_DEMO&team=T_DEMO");
      expect(screen.getByText("Bot")).toBeTruthy();
      expect(screen.queryByText(/details could not be loaded|Search for/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy Bot name" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Can’t open the Bot?" })).toBeNull();
      expect(screen.getByText("Connected")).toBeTruthy();
    },
  );

  it("keeps a nameless unknown-brand binding connected without guessing a link or a search identity", async () => {
    render(
      <CompletionHandoff
        agentId={SETUP_AGENT_ID}
        messaging={{ ...READY, provider: "feishu" }}
        readBinding={async () => ({ ...feishuBinding("unknown"), bot: { displayName: null, avatarUrl: null } })}
      />,
    );
    expect(await screen.findByText("Bot")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText(/Bot name is unavailable/)).toBeTruthy();
    expect(screen.queryByText(/details could not be loaded|Search for/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy Bot name" })).toBeNull();
  });

  it("retains complete long Agent and Bot names and the search-only action beside management", async () => {
    const name = "项目交付与客户反馈归纳助理".repeat(5);
    const agentName = "agent-with-a-long-but-complete-identity";
    const writeText = stubClipboard();
    render(
      <DoneStep
        name={agentName}
        provider="feishu"
        action={{ label: "View agent", onClick: vi.fn() }}
        handoff={completionHandoff(
          SETUP_AGENT_ID,
          { ...READY, provider: "feishu" },
          async () => ({ ...feishuBinding("lark"), bot: { displayName: name, avatarUrl: null } }),
          false,
        )}
      />,
    );
    expect(screen.getByRole("heading", { name: `${agentName} is ready.` })).toBeTruthy();
    expect(await screen.findByText(name)).toBeTruthy();
    const actions = within(screen.getByRole("group", { name: "Next steps" }));
    fireEvent.click(actions.getByRole("button", { name: "Copy Bot name" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(name));
    expect(actions.getByRole("button", { name: "View agent" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([
    { state: "ready", label: "Finish re-board", disabled: false },
    { state: "pending", label: "Finishing…", disabled: true },
    { state: "failed", label: "Try again", disabled: false },
  ] as const)("preserves explicit re-board completion in the $state state", ({ state, label, disabled }) => {
    const onFinish = vi.fn();
    const readBinding = vi.fn();
    render(
      <DoneStep
        name="my-agent"
        provider="slack"
        completion={{ state, onFinish }}
        handoff={completionHandoff(SETUP_AGENT_ID, READY, readBinding, true)}
      />,
    );
    const finish = within(screen.getByRole("group", { name: "Next steps" })).getByRole("button", { name: label });
    expect(finish.hasAttribute("disabled")).toBe(disabled);
    expect(onFinish).not.toHaveBeenCalled();
    fireEvent.click(finish);
    expect(onFinish).toHaveBeenCalledTimes(disabled ? 0 : 1);
    expect(readBinding).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("retires late identity reads and immediately hides the old link on a generation change", async () => {
    let resolveOld: (value: ImBindingAdminDetail) => void = () => undefined;
    const oldRead = new Promise<ImBindingAdminDetail>((resolve) => {
      resolveOld = resolve;
    });
    const readBinding = vi
      .fn()
      .mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce(binding({ credentialGeneration: 2, bot: { displayName: "New Bot", avatarUrl: null } }))
      .mockReturnValueOnce(new Promise(() => undefined));
    const view = render(<CompletionHandoff agentId={SETUP_AGENT_ID} messaging={READY} readBinding={readBinding} />);
    await waitFor(() => expect(readBinding).toHaveBeenCalledOnce());
    view.rerender(
      <CompletionHandoff
        agentId={SETUP_AGENT_ID}
        messaging={{ ...READY, credentialGeneration: 2 }}
        readBinding={readBinding}
      />,
    );
    expect(await screen.findByText("New Bot")).toBeTruthy();
    await act(async () => resolveOld(binding()));
    expect(screen.queryByText("Actual team Bot")).toBeNull();
    view.rerender(
      <CompletionHandoff
        agentId={SETUP_AGENT_ID}
        messaging={{ ...READY, credentialGeneration: 3 }}
        readBinding={readBinding}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("New Bot")).toBeNull();
  });

  it("copies the real Bot name only on request and offers manual copying after clipboard failure", async () => {
    const writeText = stubClipboard();
    writeText.mockRejectedValueOnce(new Error("clipboard refused"));
    render(
      <CompletionHandoff
        agentId={SETUP_AGENT_ID}
        messaging={{ ...READY, provider: "feishu" }}
        readBinding={async () => feishuBinding("lark")}
      />,
    );
    const copy = await screen.findByRole("button", { name: "Copy Bot name" });
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(copy);
    expect(await screen.findByText("Could not copy. Select the name and copy it manually.")).toBeTruthy();
    expect(screen.getByText("Actual team Bot")).toBeTruthy();
    fireEvent.click(copy);
    expect(await screen.findByText("Copied.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls.every(([value]) => value === "Actual team Bot")).toBe(true);
  });

  it("does not mount the handoff during preparation or explicit reboard review", () => {
    const readBinding = vi.fn();
    const notReady: AgentSetupMessagingState = { kind: "not-configured" };
    expect(completionHandoff(SETUP_AGENT_ID, notReady, readBinding, false)).toBeUndefined();
    expect(completionHandoff(SETUP_AGENT_ID, READY, readBinding, true)).toBeUndefined();
    expect(readBinding).not.toHaveBeenCalled();
  });
});
