import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { agentId, computerId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("keeps placement and runtime separate in Agent settings", async () => {
    installApi({
      bound: true,
      computerProviderReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.getByRole("link", { name: "Manage computer" }).getAttribute("href")).toContain(
      `/agents/computers?computerId=${computerId}`,
    );
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
  });

  it("opens Account recovery for the exact computer and preserves the return to the Agent", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: /Restore connection$/ }));
    expect(await screen.findByRole("button", { name: "Copy for AI assistant" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Reviewer settings" }).getAttribute("href")).toBe(
      `/agents/${agentId}/settings/computer`,
    );
    await waitFor(() => {
      const requests = vi
        .mocked(fetch)
        .mock.calls.filter(([path, init]) => path === "/api/v1/computer-connect-codes" && init?.method === "POST");
      expect(requests).toHaveLength(1);
      expect(JSON.parse(String(requests[0]?.[1]?.body))).toEqual({ mode: "repair", targetComputerId: computerId });
    });
  });

  it("automatically retires Account recovery when the computer reconnects", async () => {
    let status: "online" | "offline" = "offline";
    installApi({ bound: true, computerStatus: () => status });
    window.history.replaceState({}, "", "/agents/computers");
    render(<App />);
    expect(await screen.findByRole("button", { name: "Copy for AI assistant" })).toBeTruthy();
    status = "online";
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Get connection help" })).toBeNull();
    expect(screen.queryByText(/Last online/)).toBeNull();
  });

  it("refreshes Agent availability when the page regains focus", async () => {
    let computerStatus: "online" | "offline" = "online";
    installApi({ bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect(within(await screen.findByRole("region", { name: "Agent status" })).getByText("Online")).toBeTruthy();

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    await screen.findByText("Offline");
    const computerRow = screen
      .getByRole("region", { name: "Agent status" })
      .querySelector('[data-ui="agent-status-computer"]') as HTMLElement;
    expect(computerRow).toBeTruthy();
    expect(within(computerRow).getByText("Offline")).toBeTruthy();
    expect(within(computerRow).getByRole("link", { name: /Restore connection$/ })).toBeTruthy();
  });

  it("keeps Agent cards useful when Computer status cannot be confirmed", async () => {
    installApi({ bound: true, computerEvidenceFails: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByText("Computer unknown")).toBeNull();
    expect(screen.queryByText("Unable to confirm readiness")).toBeNull();
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/computers"))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/agents/${agentId}/im-binding`))).toBe(
      false,
    );
  });

  it("requires the selected runtime Provider to be ready before an Agent card is Available", async () => {
    installApi({
      bound: true,
      runtimeProvider: "claude-code",
      computerProviderReadiness: [
        { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
        { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
      ],
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Claude Code sign-in required")).toBeTruthy();
    expect(screen.queryByText("Cannot receive new work")).toBeNull();
    expect(screen.queryByRole("link", { name: "View Computer" })).toBeNull();
    expect(screen.queryByText("Available")).toBeNull();
  });

  it("shows a user-facing recovery without readiness implementation details", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    // The detail status names the same state as the Agent list, so one failure has one name.
    // The channel is connected here; only delivery is not, and the label has to say which.
    expect(screen.getAllByText("Cannot receive messages").length).toBeGreaterThan(0);
    expect(screen.queryByText("Messaging disconnected")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByText("Action required")).toBeNull();
    const messagingRow = screen
      .getByRole("region", { name: "Agent status" })
      .querySelector('[data-ui="agent-status-message-channel"]') as HTMLElement;
    expect(within(messagingRow).queryByText("Messages cannot be delivered to this Agent right now.")).toBeNull();
    expect(
      within(messagingRow)
        .getByRole("link", { name: /Continue setup$/ })
        .getAttribute("href"),
    ).toBe(`/agents/setup?agentId=${agentId}`);
    expect(screen.getByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.getByText("Ada's Mac")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("does not infer an empty contact when messaging evidence cannot be confirmed", async () => {
    installApi({ bound: true, bindingEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const messagingRow = screen
      .getByRole("region", { name: "Agent status" })
      .querySelector('[data-ui="agent-status-message-channel"]') as HTMLElement;
    // Unreadable evidence says so; it must not be reported as "no channel connected".
    expect(within(messagingRow).getByText("Status unavailable")).toBeTruthy();
    expect(within(messagingRow).queryByText("openTag could not read this Agent's messaging connection.")).toBeNull();
    expect(
      within(messagingRow)
        .getByRole("link", { name: /View channel$/ })
        .getAttribute("href"),
    ).toBe(`/agents/${agentId}/settings/messaging`);
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(screen.queryByRole("link", { name: "Connect messaging" })).toBeNull();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still names a paused Agent and its resume exit on the Agent home", async () => {
    /*
     * A pause is not a dependency failure, so no dependency row speaks for it: a suspended Agent
     * can have a healthy Computer and a live channel, and `projectAgentAvailability` ranks the
     * pause first while still filling both dependencies. Without an Agent-level notice the home
     * reads Ready / Connected and never says the Agent is off.
     */
    installApi({ bound: true, initialStatus: "suspended" });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const notice = screen.getByRole("region", { name: "Agent status: Suspended" });
    expect(within(notice).getByText("Suspended")).toBeTruthy();
    expect(within(notice).getByText("This Agent is paused. Resume it to start receiving messages again.")).toBeTruthy();
    expect(within(notice).getByRole("link", { name: "Pause or delete Agent" }).getAttribute("href")).toBe(
      `/agents/${agentId}/settings/manage`,
    );
  });

  it("keeps unreadable Computer and Messaging evidence out of the success states", async () => {
    /*
     * Both rows used to fall through to Online / Connected when the evidence behind them could not
     * be read -- a reachable Computer with no Provider readiness, and an active binding whose
     * delivery could not be confirmed. Missing evidence is not a working Agent.
     */
    installApi({ bound: true, computerProviderReadiness: [] });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    const unconfirmedRuntime = render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const computerRow = screen
      .getByRole("region", { name: "Agent status" })
      .querySelector('[data-ui="agent-status-computer"]') as HTMLElement;
    expect(within(computerRow).queryByText("Online")).toBeNull();
    expect(within(computerRow).getByText("Codex status unavailable")).toBeTruthy();
    expect(within(computerRow).queryByRole("link")).toBeNull();
    expect(within(computerRow).queryByText("openTag could not confirm Codex on this Computer.")).toBeNull();
    unconfirmedRuntime.unmount();

    installApi({ bound: true, handoffEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const messagingRow = screen
      .getByRole("region", { name: "Agent status" })
      .querySelector('[data-ui="agent-status-message-channel"]') as HTMLElement;
    expect(within(messagingRow).queryByText("Connected")).toBeNull();
    expect(within(messagingRow).getByText("Status unavailable")).toBeTruthy();
    expect(within(messagingRow).queryByText("openTag could not confirm whether messages reach this Agent.")).toBeNull();
  });

  it("keeps Computer status concise and offers a precise exit only when action is useful", async () => {
    /*
     * Status and link copy carry the complete meaning. Healthy and self-resolving states stay
     * quiet; a state needing the viewer names the action instead of repeating itself in a sentence.
     */
    const readiness = (status: "checking" | "install" | "sign-in" | "unavailable" | "ready") =>
      [{ observedAt: "2026-08-20T00:00:00.000Z", provider: "codex" as const, status }] as const;
    const states = [
      {
        /*
         * No computer assigned at all. It leads the table because every row below reads a fact about a
         * machine, and this is the state where there is none to read: without its own branch it
         * falls through to the Provider sentence and reports a Computer that does not exist.
         * Its exit differs too -- there is nothing here to view.
         */
        exit: "Continue setup",
        href: `/agents/setup?agentId=${agentId}`,
        label: "No computer assigned",
        options: { agentUnbound: true },
      },
      {
        exit: "View computer",
        href: `/agents/${agentId}/settings/computer`,
        label: "Status unavailable",
        options: { computerEvidenceFails: true },
      },
      {
        exit: "Restore connection",
        href: `/agents/computers?computerId=${computerId}&fromAgent=${agentId}`,
        label: "Offline",
        options: { computerStatus: () => "offline" as const },
      },
      {
        exit: undefined,
        href: undefined,
        label: "Checking Codex",
        options: { computerProviderReadiness: readiness("checking") },
      },
      {
        exit: "Continue setup",
        href: `/agents/setup?agentId=${agentId}`,
        label: "Codex not installed",
        options: { computerProviderReadiness: readiness("install") },
      },
      {
        exit: "Continue setup",
        href: `/agents/setup?agentId=${agentId}`,
        label: "Codex sign-in required",
        options: { computerProviderReadiness: readiness("sign-in") },
      },
      {
        exit: "Continue setup",
        href: `/agents/setup?agentId=${agentId}`,
        label: "Codex unavailable",
        options: { computerProviderReadiness: readiness("unavailable") },
      },
    ];
    for (const state of states) {
      installApi({ bound: true, ...state.options });
      window.history.replaceState({}, "", `/agents/${agentId}`);
      const rendered = render(<App />);

      expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
      const row = screen
        .getByRole("region", { name: "Agent status" })
        .querySelector('[data-ui="agent-status-computer"]') as HTMLElement;
      expect(row).toBeTruthy();
      expect(within(screen.getByRole("region", { name: "Agent status" })).getAllByRole("listitem")).toHaveLength(2);
      expect(within(row).getByText(state.label)).toBeTruthy();
      // The unbound row names no machine, because there is none to name.
      if (!("agentUnbound" in state.options)) {
        expect(within(row).getByText("Ada's Mac")).toBeTruthy();
      }
      expectRecoveryLink(row, state.exit, state.href);
      rendered.unmount();
    }
  });

  it.each([
    { status: "install" as const, label: "Codex not installed", guidance: "Install Codex on Ada's Mac." },
    { status: "sign-in" as const, label: "Codex sign-in required", guidance: "Sign in to Codex on Ada's Mac." },
    {
      status: "unavailable" as const,
      label: "Codex unavailable",
      guidance: "Open Codex on Ada's Mac and check for errors.",
    },
  ])(
    "opens $status guidance for a paused Agent without linking to unavailable setup",
    async ({ status, label, guidance }) => {
      installApi({
        bound: true,
        initialStatus: "suspended",
        computerProviderReadiness: [{ provider: "codex", status, observedAt: "2026-08-20T00:00:00.000Z" }],
      });
      window.history.replaceState({}, "", `/agents/${agentId}`);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
      const card = screen.getByRole("region", { name: "Agent status" });
      expect(within(card).getAllByRole("listitem")).toHaveLength(2);
      expect(card.querySelector('[data-ui="agent-status-runtime"]')).toBeNull();
      const row = card.querySelector('[data-ui="agent-status-computer"]') as HTMLElement;
      expect(within(row).getByText(label)).toBeTruthy();
      expect(within(row).queryByRole("link")).toBeNull();
      fireEvent.click(within(row).getByRole("button", { name: /^Computer:/ }));
      const details = await screen.findByRole("dialog", { name: "Computer" });
      expect(within(details).getByText(guidance)).toBeTruthy();
      expect(within(details).getByText(label)).toBeTruthy();
      expect(within(card).getAllByRole("listitem")).toHaveLength(2);
      expect(within(row).getByText("Codex")).toBeTruthy();
    },
  );

  it.each(["online", "offline"] as const)(
    "hides cached runtime failures while computer status is %s",
    async (status) => {
      installApi({
        bound: true,
        computerStatus: () => status,
        computerEvidenceFails: status === "online",
        computerProviderReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
      });
      window.history.replaceState({}, "", `/agents/${agentId}`);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
      const card = screen.getByRole("region", { name: "Agent status" });
      expect(within(card).getAllByRole("listitem")).toHaveLength(2);
      expect(within(card).queryByText("Codex sign-in required")).toBeNull();
      expect(within(card).getByText(status === "offline" ? "Offline" : "Status unavailable")).toBeTruthy();
      expect(screen.queryByText("Sign in to Codex on Ada's Mac.")).toBeNull();
    },
  );

  it.each([
    { provider: "codex" as const, name: "Codex" },
    { provider: "claude-code" as const, name: "Claude Code" },
    { provider: "pi" as const, name: "Pi" },
  ])("always identifies the selected $name Provider and makes full identity available", async ({ provider, name }) => {
    installApi({
      bound: true,
      runtimeProvider: provider,
      computerProviderReadiness: [{ provider, status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const card = screen.getByRole("region", { name: "Agent status" });
    expect(card.querySelector('[data-ui="agent-status-provider"]')?.textContent).toBe(name);
    const details = within(card).getByRole("button", { name: /^Computer: Online/ });
    expect(details.getAttribute("aria-label")).toContain(`Ada's Mac · macOS · ${name}`);
    fireEvent.click(details);
    expect(await screen.findByText(`Ada's Mac · macOS · ${name}`)).toBeTruthy();
  });

  it("does not let a paused Agent make the Computer row contradict itself", async () => {
    /*
     * `agent_suspended` outranks every dependency reason, so a row deriving its sentence from the
     * Agent-wide reason described a masked state: "Checking Codex" beside "could not confirm this
     * Computer's current connection", about a Computer that was online and confirmed.
     */
    installApi({
      bound: true,
      initialStatus: "suspended",
      computerProviderReadiness: [{ observedAt: "2026-08-20T00:00:00.000Z", provider: "codex", status: "checking" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const row = screen
      .getByRole("region", { name: "Agent status" })
      .querySelector('[data-ui="agent-status-computer"]') as HTMLElement;
    expect(within(row).getByText("Checking Codex")).toBeTruthy();
    expect(within(row).queryByText("openTag is still checking Codex on this Computer.")).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
  });
});

function expectRecoveryLink(row: HTMLElement, label: string | undefined, href: string | undefined) {
  if (label)
    expect(
      within(row)
        .getByRole("link", { name: (name) => name.endsWith(label) })
        .getAttribute("href"),
    ).toBe(href);
  else expect(within(row).queryByRole("link")).toBeNull();
}
