import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { agentId, installApi, json, resetWebAppState } from "./support/app-fixtures.js";
import { withLocaleAsync } from "./support/with-locale.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("names the channel and keeps messaging status concise", async () => {
    /*
     * The channel identity, status, and a precise action are enough. A healthy channel stays quiet,
     * while missing or unreadable state keeps the path that can address it.
     */
    const states = [
      {
        detail: "Slack · Reviewer",
        label: "Connected",
        exit: undefined,
        href: undefined,
        options: { bound: true, provider: "slack" as const },
      },
      {
        detail: undefined,
        label: "Not connected",
        exit: "Continue setup",
        href: `/agents/setup?agentId=${agentId}`,
        options: { bound: false },
      },
      {
        detail: undefined,
        label: "Status unavailable",
        exit: "View channel",
        href: `/agents/${agentId}/settings/messaging`,
        options: { bound: true, bindingEvidenceFails: true },
      },
    ];
    for (const state of states) {
      installApi(state.options);
      window.history.replaceState({}, "", `/agents/${agentId}`);
      const rendered = render(<App />);

      expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
      const row = screen
        .getByRole("region", { name: "Agent status" })
        .querySelector('[data-ui="agent-status-message-channel"]') as HTMLElement;
      expect(row).toBeTruthy();
      expect(within(row).getByText(state.label)).toBeTruthy();
      if (state.detail) expect(within(row).getByText(state.detail)).toBeTruthy();
      if (state.exit) {
        expect(within(row).getByRole("link", { name: state.exit }).getAttribute("href")).toBe(state.href);
      } else {
        expect(within(row).queryByRole("link")).toBeNull();
      }
      rendered.unmount();
    }
  });

  it("offers messaging app setup only when the missing binding is confirmed", async () => {
    installApi({ bound: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.getByText("Connect Slack or Lark so teammates can send messages to this Agent.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Lark" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeTruthy();
  });

  it("presents both messaging channels as equal choices rather than a recommendation", async () => {
    /*
     * Which app a team already lives in decides this, so neither channel gets the emphasis styling
     * that would read as our recommendation. Each carries its own mark instead, and Slack leads.
     */
    installApi({ bound: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    await screen.findByRole("button", { name: "Connect Slack" });
    const connect = screen.getAllByRole("button").filter((button) => button.textContent?.startsWith("Connect"));
    expect(connect.map((button) => button.textContent)).toEqual(["Connect Slack", "Connect Lark"]);
    // A mark that is merely present could still be the other channel's, so read which one it depicts.
    expect(connect.map(markProvider)).toEqual(["Slack", "Feishu"]);
    // One neutral surface for both: identical classes, and `secondary`'s white card and default text
    // rather than the emphasis fill or the destructive text that would single a channel out.
    expect(new Set(connect.map((button) => button.className)).size).toBe(1);
    for (const button of connect) {
      expect(button.className).toContain("bg-kumo-base");
      expect(button.className).toContain("!text-kumo-default");
    }
  });

  it("spaces both brand names correctly when the page itself renders in Chinese", async () => {
    /*
     * Composing the sentence in a test proves only that the catalogue and the spacing rule fit
     * together; it cannot see whether this page still puts them together that way. Reading the
     * rendered page is what observes the call site, and only Chinese shows the difference — the
     * boundary rule is a no-op in English, so the English assertion above would survive its loss.
     */
    installApi({ bound: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    await withLocaleAsync("zh", async () => {
      render(<App />);
      expect(await screen.findByText("连接 Slack 或飞书，让团队成员可以向此 Agent 发送消息。")).toBeTruthy();
    });
  });

  it("separates the connected channel from the trigger mode that acts on it", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.getByText("Lark · @reviewer")).toBeTruthy();
    const identity = document.querySelector('[data-ui="messaging-app-identity"]') as HTMLElement;
    expect(identity).toBeTruthy();
    expect(identity.className).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    const connected = within(identity).getByText("Connected").closest("[data-state]") as HTMLElement;
    expect(connected.className).toContain("justify-self-end");
    expect(screen.queryByText(/Validated/)).toBeNull();
    // The channel identity is reported, not edited, so it carries no fields of its own.
    expect(screen.queryByText("Contact")).toBeNull();
    expect(screen.queryByText("How to use")).toBeNull();
    expect(screen.getByRole("heading", { name: "Group chat messages" })).toBeTruthy();
    expect(
      screen.getByText(
        "Direct messages are always checked. Choose when this Agent should check messages in group chats.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "Group chat messages" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change bot" }).className).toContain("h-9");
    const disconnect = screen.getByRole("button", { name: "Disconnect Lark" });
    expect(disconnect.className).toContain("h-9");
    expect(disconnect.className).toContain("text-kumo-danger");
  });

  it("names a Slack channel by its verified Bot rather than by an invented Agent handle", async () => {
    installApi({ bound: true, handoffReady: true, provider: "slack" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    const messaging = render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Slack · @/)).toBeNull();
    expect(screen.queryByText("@reviewer")).toBeNull();
    messaging.unmount();

    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    const status = await screen.findByRole("region", { name: "Agent status" });
    expect(within(status).getByText("Slack · Reviewer")).toBeTruthy();
    expect(within(status).queryByText(/Slack · @reviewer/)).toBeNull();
  });

  it("keeps Computer and runtime state out of Messaging when the Provider is not ready", async () => {
    installApi({
      bound: true,
      handoffReady: false,
      computerProviderReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.queryByText(/Messages wait until/)).toBeNull();
    expect(screen.queryByText(/Computer/)).toBeNull();
  });

  it("does not add delivery diagnostics when no blocker is observable", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.queryByText(/messages cannot be delivered/i)).toBeNull();
    expect(screen.queryByText(/Computer/)).toBeNull();
  });

  it("keeps an offline Computer out of the Messaging app configuration", async () => {
    installApi({ bound: true, handoffReady: false, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.queryByText(/computer/i)).toBeNull();
  });

  it("shows a Messaging error instead of inferring an empty channel", async () => {
    installApi({ bindingEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain("Binding evidence unavailable");
    expect(screen.queryByRole("heading", { name: "No messaging channel" })).toBeNull();
  });

  it("does not overlap focus refreshes while an Agent read is still pending", async () => {
    let agentReads = 0;
    let computerStatus: "online" | "offline" = "online";
    let releaseAgentRead = () => {};
    const pendingAgentRead = new Promise<void>((resolve) => {
      releaseAgentRead = resolve;
    });
    installApi({
      agentRead: () => {
        agentReads += 1;
        return agentReads === 1 ? undefined : pendingAgentRead;
      },
      bound: true,
      computerStatus: () => computerStatus,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(agentReads).toBe(2));
    expect(agentReads).toBe(2);

    releaseAgentRead();
    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open computer setup" })).toBeTruthy();
  });

  it("invalidates a stale Agent detail after a background not-found response", async () => {
    let agentReadStatus: number | undefined;
    installApi({ agentReadStatus: () => agentReadStatus, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    agentReadStatus = 404;
    fireEvent(window, new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent unavailable");
    expect(within(screen.getByRole("main")).queryByText("Ready")).toBeNull();
  });

  it("marks retained Agent rows unconfirmed after a transient primary refresh failure", async () => {
    let agentListStatus: number | undefined;
    installApi({ agentListStatus: () => agentListStatus, bound: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    expect(await screen.findByText("Ready for new work")).toBeTruthy();

    agentListStatus = 503;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Status unavailable")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("changes Slack receive mode locally after a clear confirmation", async () => {
    installApi({ bound: true, provider: "slack" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Every message" }));
    const dialog = await screen.findByRole("dialog", { name: "Check every message?" });
    expect(within(dialog).getByText(/may use more tokens/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use every message" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && init?.method === "PATCH",
          ),
      ).toHaveLength(1),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input).endsWith("/im-binding/slack/oauth/start") && init?.method === "POST",
        ),
    ).toHaveLength(0);
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
  });

  it("reports a failed trigger-mode change on the page and clears it before retry", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failReceiveMode = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}` && init?.method === "PATCH" && failReceiveMode) {
        failReceiveMode = false;
        return json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              category: "transient",
              message: "Unable to update message access",
            },
          },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Every message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use every message" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn’t update the message setting");

    fireEvent.click(await screen.findByRole("button", { name: "Use every message" }));
    await waitFor(() => expect(screen.queryByText("Couldn’t update the message setting. Try again.")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Group chat messages" })),
    );
  });

  it("keeps disconnect failures inside the active dialog and allows retry", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failDisconnect = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/disable") && init?.method === "POST") {
        if (failDisconnect) {
          failDisconnect = false;
          return json(
            {
              error: {
                code: "SERVICE_UNAVAILABLE",
                category: "transient",
                message: "Unable to disconnect messaging",
              },
            },
            503,
          );
        }
        return new Response(null, { status: 204 });
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Lark" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Lark?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect Lark" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Couldn’t disconnect Lark");

    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect Lark" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Disconnect Lark?" })).toBeNull());
    expect(screen.queryByText("Couldn’t disconnect Lark. Try again.")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Messaging" })));
  });

  it("does not create an IM setup attempt while rendering Agent detail", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Connect Lark" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("creates a Lark setup attempt only after an explicit admin click", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Lark" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Lark" });
    expect(within(dialog).getByText(/Scan with Lark on your phone/)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "Scan this QR code in Lark" })).toBeTruthy();
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
          ),
      ).toBe(true),
    );
  });

  it("offers a legacy Lark Bot permission update without claiming live connectivity", async () => {
    installApi({ bindingReauth: true, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByText("Permissions required")).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
    expect(screen.getByRole("button", { name: "Update permissions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change bot" }));
    expect(await screen.findByRole("dialog", { name: "Change Lark bot" })).toBeTruthy();
    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
      );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ intent: "replace" });
  });

  it("keeps Agent delivery state separate from its connected messaging app", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByText("Lark · @reviewer")).toBeTruthy();
    expect(screen.queryByText(/messages cannot be delivered/i)).toBeNull();
    expect(screen.queryByText(/Needs attention/)).toBeNull();
    expect(screen.queryByText(/Online/)).toBeNull();
  });

  it("does not show the selected runtime state beside a connected Slack app", async () => {
    installApi({
      bound: true,
      provider: "slack",
      runtimeProvider: "codex",
      computerProviderReadiness: [{ provider: "codex", status: "checking", observedAt: "2026-08-20T00:00:00.000Z" }],
      handoffReady: false,
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByText("Slack")).toBeTruthy();
    expect(screen.queryByText(/Messages wait until/)).toBeNull();
    expect(screen.queryByRole("link", { name: "View Computer" })).toBeNull();
  });

  it("shows a safe occupied-App recovery and retries the original replacement intent", async () => {
    installApi({ bound: true, setupFailureCode: "FEISHU_APP_ALREADY_BOUND" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Change bot" }));
    const setupNotice = await screen.findByRole("dialog", { name: "Change Lark bot" });
    expect(setupNotice?.textContent).toContain(
      "This Lark bot is already connected to another Agent. Choose a different bot and try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      const requests = vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
        );
      expect(requests).toHaveLength(2);
      expect(requests.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
        { intent: "replace" },
        { intent: "replace" },
      ]);
    });
  });

  it("starts first-party OpenTag Slack OAuth from the Agent IM tab", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect Slack" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input).endsWith("/im-binding/slack/oauth/start") && init?.method === "POST",
          ),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        String(
          vi
            .mocked(fetch)
            .mock.calls.find(
              ([input, init]) => String(input).endsWith("/im-binding/slack/oauth/start") && init?.method === "POST",
            )?.[1]?.body,
        ),
      ),
    ).toEqual({ intent: "create" });
    expect(screen.queryByRole("button", { name: "Connect Slack App" })).toBeNull();
    expect(screen.queryByLabelText("Slack App ID")).toBeNull();
    expect(screen.queryByLabelText("Bot User OAuth Token")).toBeNull();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
  });
});

/**
 * Which provider a decorative button mark actually depicts.
 *
 * The marks are inlined as data URIs, so the rendered `src` carries the whole SVG — including the
 * `<title>` each asset names itself with. That is the one thing in the DOM that distinguishes one
 * mark from the other, since both are `alt=""` and `aria-hidden` by design.
 */
function markProvider(button: HTMLElement): string | undefined {
  const src = button.querySelector("img")?.getAttribute("src");
  return src ? /<title>([^<]+)<\/title>/.exec(decodeURIComponent(src))?.[1] : undefined;
}
