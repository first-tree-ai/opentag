import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("keeps assigned Computer details in its own Settings page", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Reviewer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Execution" })).toBeNull();
    expect(screen.queryByText(/Turn timeout/i)).toBeNull();
    expect(screen.queryByText(/Last seen/i)).toBeNull();
  });

  it("names the machine-level recovery for an offline Computer instead of offering a dead retry", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/Last seen/)).toBeTruthy();
    expect(
      screen.getByText("OpenTag is not running on Ada's Mac. Start it there to bring it back online."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("offers machine recovery on the Connected computer page when the Computer is offline", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect this Computer" })).toBeTruthy();
  });

  it("withholds machine recovery when the Computer is reachable but its Provider is not", async () => {
    installApi({
      bound: true,
      computerProviderReadiness: [{ provider: "codex", status: "install", observedAt: "2026-08-20T00:00:00.000Z" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByText("Codex is not installed on Ada's Mac.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect this Computer" })).toBeNull();
  });

  it("generates a command naming the assigned Computer without leaving the Agent", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect this Computer" }));

    expect(screen.getByRole("heading", { name: "Reconnect Ada's Mac" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/settings/computer`);
  });

  it("observes a Computer coming back online from the recovery page itself", async () => {
    let computerStatus: "online" | "offline" = "offline";
    installApi({ bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(
      screen.getByText("OpenTag is not running on Ada's Mac. Start it there to bring it back online."),
    ).toBeTruthy();

    computerStatus = "online";
    fireEvent(window, new Event("focus"));

    expect(await screen.findByText("Online")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Start it there/)).toBeNull());
  });

  it("explains an unready Provider on the Computer page instead of the model settings", async () => {
    installApi({
      bound: true,
      runtimeProvider: "claude-code",
      computerProviderReadiness: [
        { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
        { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
      ],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Not ready")).toBeTruthy();
    expect(screen.getByText("Claude Code is not signed in on Ada's Mac.")).toBeTruthy();
  });

  it("refreshes Agent availability when the page regains focus", async () => {
    let computerStatus: "online" | "offline" = "online";
    installApi({ bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    await screen.findByText("Computer offline");
    const computerRow = screen
      .getByRole("region", { name: "Agent status" })
      .querySelector('[data-ui="agent-status-computer"]') as HTMLElement;
    expect(computerRow).toBeTruthy();
    expect(within(computerRow).getByText("Computer offline")).toBeTruthy();
    expect(within(computerRow).getByRole("link", { name: "Open computer setup" })).toBeTruthy();
  });

  it("keeps Agent cards useful when Computer status cannot be confirmed", async () => {
    installApi({ bound: true, computerEvidenceFails: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Computer unknown")).toBeTruthy();
    expect(screen.getByText("Unable to confirm readiness")).toBeTruthy();
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
    expect(screen.getByText("Cannot receive new work")).toBeTruthy();
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
    expect(within(messagingRow).getByRole("link", { name: "Fix messaging" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.queryByText("Ada's Mac")).toBeNull();
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
    expect(within(messagingRow).queryByText("OpenTag could not read this Agent's messaging connection.")).toBeNull();
    expect(within(messagingRow).getByRole("link", { name: "View channel" }).getAttribute("href")).toBe(
      `/agents/${agentId}/settings/messaging`,
    );
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
    expect(within(notice).getByRole("link", { name: "Manage Agent" }).getAttribute("href")).toBe(
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
    expect(within(computerRow).getByText("Status unavailable")).toBeTruthy();
    expect(within(computerRow).queryByText("OpenTag could not confirm Codex on this Computer.")).toBeNull();
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
    expect(within(messagingRow).queryByText("OpenTag could not confirm whether messages reach this Agent.")).toBeNull();
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
        exit: "View computer",
        label: "Status unavailable",
        options: { computerEvidenceFails: true },
      },
      {
        exit: "Open computer setup",
        label: "Computer offline",
        options: { computerStatus: () => "offline" as const },
      },
      {
        exit: undefined,
        label: "Checking Codex",
        options: { computerProviderReadiness: readiness("checking") },
      },
      {
        exit: "Set up Codex",
        label: "Codex not installed",
        options: { computerProviderReadiness: readiness("install") },
      },
      {
        exit: "Sign in to Codex",
        label: "Codex sign-in required",
        options: { computerProviderReadiness: readiness("sign-in") },
      },
      {
        exit: "Troubleshoot Codex",
        label: "Codex unavailable",
        options: { computerProviderReadiness: readiness("unavailable") },
      },
      { exit: undefined, label: "Ready", options: { computerProviderReadiness: readiness("ready") } },
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
      expect(within(row).getByText(state.label)).toBeTruthy();
      expect(within(row).getByText("Ada's Mac · macOS · Codex")).toBeTruthy();
      if (state.exit) {
        expect(within(row).getByRole("link", { name: state.exit }).getAttribute("href")).toBe(
          `/agents/${agentId}/settings/computer`,
        );
      } else {
        expect(within(row).queryByRole("link")).toBeNull();
      }
      rendered.unmount();
    }
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
    expect(within(row).queryByText("OpenTag is still checking Codex on this Computer.")).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
  });
});
