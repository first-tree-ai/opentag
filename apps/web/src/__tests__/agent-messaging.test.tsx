import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { App } from "../app.js";
import { pendingSlackConfiguration, setupSlackConfiguration } from "../onboarding-v2/agent-setup-test-fixtures.js";
import { createMemorySetupAdapter } from "../onboarding-v2/setup-memory-adapter.js";
import { agentId, computerId, installApi, json, resetWebAppState } from "./support/app-fixtures.js";
import { withLocaleAsync } from "./support/with-locale.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetWebAppState();
  });

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
      if (state.detail) {
        expect(within(row).getByText(state.detail)).toBeTruthy();
      } else {
        const trigger = within(row).getByRole("link");
        expect(trigger.hasAttribute("title")).toBe(false);
        expect(trigger.hasAttribute("aria-description")).toBe(false);
        expect(trigger.getAttribute("aria-label")).toBe(`Messaging: ${state.label}. ${state.exit}`);
      }
      if (state.exit) {
        expect(
          within(row)
            .getByRole("link", { name: (name) => name.endsWith(state.exit ?? "") })
            .getAttribute("href"),
        ).toBe(state.href);
      } else {
        expect(within(row).queryByRole("link")).toBeNull();
      }
      rendered.unmount();
    }
  });

  it("offers a new Agent instead of connection buttons for a disconnected identity", async () => {
    installApi({ bound: false });
    const original = browserApi.agentSetup.bind(browserApi);
    vi.spyOn(browserApi, "agentSetup").mockImplementation(async (id) => {
      const { agent } = await original(id);
      const { adapter } = createMemorySetupAdapter({
        agent,
        messaging: { kind: "bound", provider: "feishu", reachable: true },
      });
      const snapshot = await adapter.readSnapshot(id);
      if (snapshot.messaging.kind !== "ready") throw new Error("Missing messaging fixture");
      await adapter.unbindMessaging(id, "feishu", snapshot.messaging.bindingId);
      return adapter.readSnapshot(id);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByRole("link", { name: "New Agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Slack" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Lark" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change bot" })).toBeNull();
  });

  it.each(["feishu", "slack"] as const)(
    "shows a paused %s connection and blocks messaging writes",
    async (provider) => {
      installApi({ bound: true, provider, initialStatus: "suspended" });
      window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
      render(<App />);
      expect(
        await screen.findByText("This Agent is paused. Messaging settings are read-only until it resumes."),
      ).toBeTruthy();
      expect(await screen.findByText("Connected")).toBeTruthy();
      for (const name of ["Mentions only", "Every message"]) {
        expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
        fireEvent.click(screen.getByRole("button", { name }));
      }
      if (provider === "feishu") {
        expect(screen.queryByRole("button", { name: "Change bot" })).toBeNull();
        for (const name of ["Disconnect Lark"]) {
          expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
          fireEvent.click(screen.getByRole("button", { name }));
        }
      } else {
        fireEvent.click(await screen.findByRole("button", { name: "More" }));
        fireEvent.click(await screen.findByRole("button", { name: "Help" }));
        expect(screen.getByRole("button", { name: "Update credentials" })).toHaveProperty("disabled", true);
        expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Disconnect Slack" })).toBeNull();
      }
      expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(0);
    },
  );

  it("shows saved Feishu authorization while paused without enabling activation or cancellation", async () => {
    installApi({ bound: true, initialStatus: "suspended" });
    const attempt = {
      id: "f645f26d-9184-4f2f-98a1-4ee83ae6a603",
      agentId,
      intent: "reauthorize" as const,
      state: "pending_activation" as const,
      qrUrl: null,
      expiresAt: "2030-01-01T00:00:00.000Z",
      errorCode: null,
      completedAt: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      activation: {
        appId: "cli_readonly",
        reason: "permissions_pending" as const,
        missingScopes: ["im:message"],
        lastCheckedAt: null,
        nextCheckAt: "2030-01-01T00:00:00.000Z",
      },
    };
    vi.spyOn(browserApi, "currentFeishuSetupAttempt").mockResolvedValue(attempt);
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt);
    const check = vi.spyOn(browserApi, "checkFeishuSetupAttempt");
    const cancel = vi.spyOn(browserApi, "cancelFeishuSetupAttempt");
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    for (const name of ["Check latest status", "Cancel connection request"]) {
      const button = await screen.findByRole("button", { name });
      expect(button).toHaveProperty("disabled", true);
      fireEvent.click(button);
    }
    expect(check).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps an unbound paused Agent read-only and localizes the reason", async () => {
    await withLocaleAsync("zh", async () => {
      installApi({ bound: false, initialStatus: "suspended" });
      window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
      render(<App />);
      expect(await screen.findByText("Agent 已暂停，消息设置仅供查看。恢复运行后可修改。")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "连接飞书" })).toHaveProperty("disabled", true);
      expect(await screen.findByRole("button", { name: "连接 Slack" })).toHaveProperty("disabled", true);
    });
  });

  it.each(["/settings", ""])("shows the paused Agent's real channel state at %s", async (suffix) => {
    installApi({ bound: true, provider: "slack", initialStatus: "suspended", handoffEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}${suffix}`);
    render(<App />);
    if (suffix) expect(await screen.findByText("Slack · Reviewer · Connected")).toBeTruthy();
    else
      expect(
        await within(await screen.findByRole("region", { name: "Agent status" })).findByText("Connected"),
      ).toBeTruthy();
    expect(screen.queryByText("Status unavailable")).toBeNull();
  });

  it("offers messaging app setup only when the missing binding is confirmed", async () => {
    installApi({ bound: false, slackOAuthAvailable: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Connect Slack" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Lark" })).toBeTruthy();
    // Nothing is connected yet; the page carries no subtitle restating its title.
    expect(screen.queryByText(/digital coworker/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Messaging app" })).toBeNull();
  });

  it("presents both messaging channels as equal choices rather than a recommendation", async () => {
    /*
     * Which app a team already lives in decides this, so neither channel gets the emphasis styling
     * that would read as our recommendation. Each carries its own mark instead, and Slack leads.
     */
    installApi({ bound: false, slackOAuthAvailable: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    await screen.findByRole("button", { name: "Connect Slack" });
    const connect = screen.getAllByRole("button").filter((button) => button.textContent?.startsWith("Connect"));
    expect(connect.map((button) => button.textContent)).toEqual(["Connect Slack", "Connect Lark"]);
    // A mark that is merely present could still be the other channel's, so read which one it depicts.
    expect(connect.map(markProvider)).toEqual(["Slack", "Feishu"]);
    // One neutral surface for both: identical classes, and `secondary`'s white card and default text
    // rather than the emphasis fill or the destructive text that would single a channel out.
    await waitFor(() =>
      expect(
        new Set(
          screen
            .getAllByRole("button")
            .filter((button) => button.textContent?.startsWith("Connect"))
            .map((button) => button.className),
        ).size,
      ).toBe(1),
    );
    for (const button of connect) {
      expect(button.className).toContain("bg-kumo-base");
      expect(button.className).toContain("!text-kumo-default");
    }
  });

  it("offers dedicated Slack setup when the deployment has no Slack OAuth", async () => {
    installApi({ bound: false, slackOAuthAvailable: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Connect Lark" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeTruthy();
  });

  it.each(["active", "suspended"] as const)("shows a stopped Lark binding for a %s Agent", async (initialStatus) => {
    installApi({ bound: true, bindingConnectionFailure: "credentials_rejected", initialStatus });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByText("Connection failed")).toBeTruthy();
    expect(
      screen.getByText("The application credentials are no longer valid. Reconnect to authorize it again."),
    ).toBeTruthy();
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect(reconnect).toHaveProperty("disabled", initialStatus === "suspended");
    if (initialStatus === "suspended") {
      fireEvent.click(reconnect);
      expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(0);
    }
  });

  it("names the provider when a stopped app is disabled, in both languages", async () => {
    installApi({ bound: true, bindingConnectionFailure: "app_unavailable" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    const rendered = render(<App />);
    expect(
      await screen.findByText(
        "This application is disabled or not installed in Lark. Enable it there, then reconnect.",
      ),
    ).toBeTruthy();
    rendered.unmount();
    await withLocaleAsync("zh", async () => {
      resetWebAppState();
      installApi({ bound: true, bindingConnectionFailure: "app_unavailable" });
      window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
      render(<App />);
      expect(await screen.findByText("此应用在飞书中已停用或未安装。启用后请重新连接。")).toBeTruthy();
      expect(screen.getByText("连接失败")).toBeTruthy();
    });
  });

  it("keeps an existing Slack binding manageable when OAuth is unavailable", async () => {
    installApi({ bound: true, provider: "slack", slackOAuthAvailable: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Disconnect Slack" })).toBeTruthy();
  });

  it.each(
    [false, true, undefined].flatMap((available) =>
      ["credentials", "oauth"].map((preferredRecovery) => ({ available, preferredRecovery })),
    ),
  )(
    "restricts OAuth recovery to official bindings ($preferredRecovery, $available)",
    async ({ available, preferredRecovery }) => {
      installApi({ bound: true, provider: "slack", slackOAuthAvailable: available });
      const binding = await browserApi.imBinding(agentId);
      if (!binding) throw new Error("Missing Slack fixture");
      vi.spyOn(browserApi, "slackConfiguration").mockResolvedValue({
        agentDisplayName: "Reviewer",
        eventsUrl: "https://opentag.example/events",
        allowedIntent: "reauthorize",
        blockedReason: null,
        expectedMessaging: { kind: "bound", provider: "slack", bindingId: binding.id, credentialGeneration: 1 },
        preferredRecovery: preferredRecovery as "credentials" | "oauth",
        binding: {
          ...binding,
          identity: {
            provider: "slack",
            appId: "A1",
            teamId: "T1",
            botUserId: "U1",
            enterpriseId: null,
            appIdEvidence: "configured",
          },
          credentialGeneration: 1,
          grantedCapabilities: [],
          reauthorizationRequired: false,
          lastErrorCode: null,
        },
        identityClosure: { status: "verified", verifiedAt: "2026-08-20T00:00:00.000Z" },
        handoff: { bindingState: "active", handoffReady: true },
      });
      window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "More" }));
      fireEvent.click(screen.getByText("Help"));
      fireEvent.click(screen.getByRole("button", { name: "Help" }));
      expect(Boolean(screen.queryByRole("button", { name: "Reauthorize" }))).toBe(
        available !== false && preferredRecovery === "oauth",
      );
      expect(screen.getByRole("button", { name: "Update credentials" })).toBeTruthy();
    },
  );

  it("spaces a brand name correctly when the page itself renders in Chinese", async () => {
    /*
     * Composing the sentence in a test proves only that the catalogue and the spacing rule fit
     * together; it cannot see whether this page still puts them together that way. Reading the
     * rendered page is what observes the call site, and only Chinese shows the difference — the
     * boundary rule is a no-op in English, so the English assertions above would survive its loss.
     * Both brands are read, because a hard-coded space would be right for exactly one of them.
     */
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    await withLocaleAsync("zh", async () => {
      installApi({ bound: true });
      const feishu = render(<App />);
      expect(await screen.findByRole("button", { name: "断开飞书" })).toBeTruthy();
      feishu.unmount();

      installApi({ bound: true, provider: "slack" });
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "更多" }));
      expect(await screen.findByRole("menuitem", { name: "断开 Slack" })).toBeTruthy();
    });
  });

  it("separates the connected channel from the trigger mode that acts on it", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.queryByText(/digital coworker/)).toBeNull();
    const identity = document.querySelector('[data-ui="messaging-app-identity"]') as HTMLElement;
    expect(identity).toBeTruthy();
    // The mark and the bot name already say which channel this is, and the state reads under the name.
    expect(identity.className).toContain("grid-cols-[auto_minmax(0,1fr)]");
    expect(within(identity).queryByText("Lark · @reviewer")).toBeNull();
    const connected = within(identity).getByText("Connected").closest("[data-state]") as HTMLElement;
    expect(connected.className).not.toContain("justify-self-end");
    expect(connected.parentElement).toBe(within(identity).getByText("Reviewer").parentElement);
    expect(screen.queryByText(/Validated/)).toBeNull();
    // The channel identity is reported, not edited, so it carries no fields of its own.
    expect(screen.queryByText("Contact")).toBeNull();
    expect(screen.queryByText("How to use")).toBeNull();
    // The section is the receive mode, not the messages it acts on.
    expect(screen.getByRole("heading", { name: "Receive mode" })).toBeTruthy();
    expect(
      screen.getByText("This Agent always receives direct messages. Choose when it receives messages in group chats."),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "Receive mode" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change bot" })).toBeNull();
    const disconnect = screen.getByRole("button", { name: "Disconnect Lark" });
    expect(disconnect.className).toContain("ui-button");
    expect(disconnect.className).toContain("text-kumo-danger");
  });

  it("needs no approval account-linking step", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link my account" })).toBeNull();
  });

  it("names a Slack channel by its verified Bot rather than by an invented Agent handle", async () => {
    installApi({ bound: true, handoffReady: true, provider: "slack" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    const messaging = render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
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

  it("does not overlap focus refreshes while a Computer read is still pending", async () => {
    let computerReads = 0;
    let computerStatus: "online" | "offline" = "online";
    let releaseComputerRead = () => {};
    const pendingComputerRead = new Promise<void>((resolve) => {
      releaseComputerRead = resolve;
    });
    installApi({
      bound: true,
      computerStatus: () => computerStatus,
      computers: async () => {
        computerReads += 1;
        if (computerReads > 1) await pendingComputerRead;
        return [
          {
            id: computerId,
            displayName: "Ada's Mac",
            platform: "darwin",
            connectionStatus: computerStatus,
            providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
            connectedAt: "2026-08-20T00:00:00.000Z",
            lastSeenAt: "2026-08-20T00:00:00.000Z",
          },
        ];
      },
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(computerReads).toBe(2));
    expect(computerReads).toBe(2);

    releaseComputerRead();
    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Restore connection$/ })).toBeTruthy();
  });

  it("invalidates a stale Agent detail after a background not-found response", async () => {
    let gone = false;
    installApi({
      agentListStatus: () => (gone ? 404 : undefined),
      agentReadStatus: () => (gone ? 404 : undefined),
      bound: true,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Reviewer" })).toBeTruthy();

    gone = true;
    fireEvent(window, new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent unavailable");
    expect(screen.queryByRole("heading", { level: 1, name: "Reviewer" })).toBeNull();
  });

  it("marks retained Agent status unavailable after a failed primary refresh", async () => {
    let agentListStatus: number | undefined;
    installApi({ agentListStatus: () => agentListStatus, bound: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    expect(await screen.findByText("Ready")).toBeTruthy();
    const listReads = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([input, init]) => String(input) === "/api/v1/agents" && (init?.method ?? "GET") === "GET")
        .length;
    const readsBefore = listReads();

    agentListStatus = 503;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(listReads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(screen.getByText("Status unavailable")).toBeTruthy());
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("changes Slack receive mode on the click, with nothing to confirm", async () => {
    installApi({ bound: true, provider: "slack" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Every message" }));
    expect(screen.queryByRole("dialog")).toBeNull();
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
            ([input, init]) => String(input) === "/api/v1/agents" && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) =>
              String(input) === `/api/v1/agents/${agentId}/im-binding` && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Every message" }).getAttribute("aria-pressed")).toBe("true"),
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
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn’t update the message setting");

    fireEvent.click(await screen.findByRole("button", { name: "Every message" }));
    await waitFor(() => expect(screen.queryByText("Couldn’t update the message setting. Try again.")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Receive mode" })));
  });

  it("keeps disconnect failures inside the active dialog and allows retry", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failDisconnect = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/disable") && init?.method === "POST" && failDisconnect) {
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
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Lark" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Lark?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect Lark" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Couldn’t disconnect Lark");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) =>
            String(input) === `/api/v1/agents/${agentId}/im-binding` && (init?.method ?? "GET") === "GET",
        ),
    ).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect Lark" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Disconnect Lark?" })).toBeNull());
    expect(screen.queryByText("Couldn’t disconnect Lark. Try again.")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Messaging" })));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) =>
              String(input) === `/api/v1/agents/${agentId}/im-binding` && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
    expect(await screen.findByRole("button", { name: "Connect Lark" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect Lark" })).toBeNull();
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
    expect(await screen.findByText("Messaging permissions need updating")).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
    expect(screen.getByRole("button", { name: /Update permissions$/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change bot" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Update permissions$/ }));
    expect(await screen.findByRole("dialog", { name: "Update Lark permissions" })).toBeTruthy();
    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
      );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ intent: "reauthorize" });
  });

  it("keeps Agent delivery state separate from its connected messaging app", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
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

    expect(await screen.findByRole("heading", { name: "Messaging app" })).toBeTruthy();
    expect(screen.queryByText(/Messages wait until/)).toBeNull();
    expect(screen.queryByRole("link", { name: "View Computer" })).toBeNull();
  });

  it("keeps occupied-App recovery on the original first-connection intent", async () => {
    installApi({ bound: false, setupFailureCode: "FEISHU_APP_ALREADY_BOUND" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Lark" }));
    const setupNotice = await screen.findByRole("dialog", { name: "Connect Lark" });
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
        { intent: "create" },
        { intent: "create" },
      ]);
    });
  });

  it.each(["local", "cloud"] as const)(
    "opens dedicated Slack setup without starting official OAuth (%s)",
    async (computerKind) => {
      installApi({
        bound: false,
        ...(computerKind === "cloud"
          ? {
              computers: [
                {
                  id: computerId,
                  kind: "cloud",
                  displayName: "openTag Cloud",
                  platform: "linux",
                  connectionStatus: "offline",
                  providerReadiness: [],
                  connectedAt: null,
                  lastSeenAt: null,
                },
              ],
            }
          : {}),
      });
      window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
      render(<App />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Connect Slack" })).not.toHaveProperty("disabled", true),
      );
      fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
      if (computerKind === "cloud") {
        expect(await screen.findByRole("link", { name: "View Apps" })).toHaveProperty(
          "href",
          "https://api.slack.com/apps",
        );
        expect(
          vi
            .mocked(fetch)
            .mock.calls.filter(
              ([input, init]) =>
                String(input).endsWith("/im-binding/slack/configuration/auto") && init?.method === "POST",
            ),
        ).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "Create App" }));
      }
      expect(await screen.findByLabelText("Code")).toBeTruthy();
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input).endsWith("/im-binding/slack/oauth/start") && init?.method === "POST",
          ),
      ).toHaveLength(0);
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) =>
              String(input).endsWith("/im-binding/slack/configuration/auto") && init?.method === "POST",
          ),
      ).toHaveLength(1);
    },
  );
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

it("keeps manual Slack verification open when settings refresh to a bound Agent", async () => {
  vi.restoreAllMocks();
  resetWebAppState();
  installApi({ bound: false });
  let view = setupSlackConfiguration();
  vi.spyOn(browserApi, "slackConfiguration").mockImplementation(async () => view);
  const binding = vi.spyOn(browserApi, "imBinding").mockImplementation(async () => view.binding ?? undefined);
  const save = vi.spyOn(browserApi, "saveSlackConfiguration").mockImplementation(async () => {
    view = pendingSlackConfiguration();
    return {
      agentId,
      imBindingId: agentId,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      credentialGeneration: 1,
      bindingState: "active",
      identityClosure: { status: "pending", verifiedAt: null },
    };
  });
  window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Slack" })).not.toHaveProperty("disabled", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
  fireEvent.click(await screen.findByRole("button", { name: "Manual setup" }));
  fireEvent.change(screen.getByLabelText("Bot Token"), { target: { value: "test-token" } });
  fireEvent.change(screen.getByLabelText("Signing Secret"), { target: { value: "test-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(binding.mock.calls.length).toBeGreaterThan(1));
  expect(document.querySelector('[data-ui="messaging-app-identity"]')).toBeTruthy();
  const dialog = await screen.findByRole("dialog", { name: "Connect Slack" });
  expect(
    within(dialog).getByText(
      "In Event Subscriptions, confirm Verified and select Save Changes. Then open the Bot’s chat, send “Hello” and check for a reply.",
    ),
  ).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "Open settings" })).toHaveProperty(
    "href",
    "https://api.slack.com/apps/A1/event-subscriptions",
  );
  expect(within(dialog).queryByLabelText("Bot Token")).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
});
