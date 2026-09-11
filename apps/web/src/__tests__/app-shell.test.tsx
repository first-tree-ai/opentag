import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  agentId,
  agentListItem,
  installApi,
  resetWebAppState,
  secondAgentId,
  secondAgentListItem,
  taskSessionId,
} from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);
  afterEach(() => vi.useRealTimers());

  it("keeps the Account Agents page local and opens Agent navigation only after selection", async () => {
    installApi();
    render(<App />);
    const pageHeading = await screen.findByRole("heading", { level: 1, name: "All Agents" });
    expect(pageHeading.classList.contains("text-xl")).toBe(true);
    expect(window.location.pathname).toBe("/agents");
    expect(screen.queryByText("Infrastructure")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agent runtime" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Computers" })).toBeNull();
    expect(screen.getByRole("main").classList.contains("decorative-page")).toBe(false);
    expect(screen.queryByRole("complementary", { name: "Agent navigation" })).toBeNull();
    const homeLink = screen.getByRole("link", { name: "All Agents" });
    expect(homeLink.getAttribute("href")).toBe("/agents");
    expect(homeLink.getAttribute("aria-current")).toBe("page");
    expect(homeLink.getAttribute("data-compact")).toBe("true");
    expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Example")).toBeNull();
    const agentLink = await screen.findByRole("link", { name: "Open Reviewer" });
    const createAgent = screen.getByRole("link", { name: "New Agent" });
    expect(createAgent.closest('[data-ui="page-header"]')).toBeTruthy();
    expect(createAgent.closest('[data-ui="agents-page-action"]')).toBeTruthy();
    expect(createAgent.getAttribute("href")).toBe("/agents/setup?action=create");
    const agentRow = agentLink.closest('[data-ui="agent-row"]');
    expect(agentRow).toBeTruthy();
    expect(agentRow?.parentElement?.classList.contains("@container/agent-roster")).toBe(true);
    expect(agentRow?.className).toContain("/agent-roster:grid-cols-");
    expect(screen.queryByText(/Monitor availability/)).toBeNull();
    expect(screen.getByText("1 Agent")).toBeTruthy();
    expect(screen.queryByText(/currently working/)).toBeNull();
    expect(screen.queryByText("Choose an Agent to continue, or create a new one.")).toBeNull();
    expect(within(agentRow as HTMLElement).queryByText("@reviewer")).toBeNull();
    expect(within(agentRow as HTMLElement).getByText("Last 30 days")).toBeTruthy();
    expect(within(agentRow as HTMLElement).getByText("32 tasks")).toBeTruthy();
    expect(within(agentRow as HTMLElement).getByText("428K tokens")).toBeTruthy();
    expect(within(agentRow as HTMLElement).queryByText("Tasks (30d)")).toBeNull();
    expect(within(agentRow as HTMLElement).queryByText("Tokens (30d)")).toBeNull();
    expect(within(agentRow as HTMLElement).queryByText("Last checked")).toBeNull();
    expect((agentRow as HTMLElement).querySelector('[data-ui="agent-row-avatar"]')?.classList.contains("size-10")).toBe(
      true,
    );
    const rowState = (agentRow as HTMLElement).querySelector('[data-ui="agent-row-state"]');
    expect(rowState).toBeNull();
    expect(within(agentRow as HTMLElement).getByText("Messaging not connected")).toBeTruthy();
    expect(within(agentRow as HTMLElement).queryByText("Cannot receive new work")).toBeNull();
    /*
     * This Agent never finished setup, so the row names the page that finishes it. It does not name
     * the missing dependency: which one is outstanding is the setup page's business, and an Agent
     * that is short of two of them would otherwise need two links to say one thing.
     */
    expect(within(agentRow as HTMLElement).queryByRole("link", { name: "Connect messaging" })).toBeNull();
    expect(
      within(agentRow as HTMLElement)
        .getAllByRole("link")
        .map((item) => item.getAttribute("href")),
    ).toEqual([`/agents/setup?agentId=${agentId}`, `/agents/${agentId}`]);
    expect((agentRow as HTMLElement).querySelector('[data-ui="agent-row-status"] [data-state]')).toBeTruthy();
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByText("Mentions only")).toBeNull();
    fireEvent.click(agentLink);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "OpenTag" })).toBeNull();
    const accountAgentsNavigation = screen.getByRole("navigation", { name: "Account Agents" });
    const backToAgents = within(accountAgentsNavigation).getByRole("link", { name: "All Agents" });
    expect(backToAgents.getAttribute("href")).toBe("/agents");
    const switcher = await screen.findByRole("button", { name: "Switch Agent, current Agent Reviewer" });
    expect(switcher.closest('[data-sidebar="header"]')).toBeTruthy();
    const workspaceNavigation = screen.getByRole("navigation", { name: "Agent" });
    expect(workspaceNavigation.closest('[data-sidebar="content"]')).toBeTruthy();
    expect(
      within(workspaceNavigation)
        .getAllByRole("link")
        .map((item) => item.textContent),
    ).toEqual(["Overview", "Tasks", "Skills", "Usage"]);
    const navigationIcons = workspaceNavigation.querySelectorAll("svg");
    expect(navigationIcons).toHaveLength(4);
    expect(Array.from(navigationIcons).every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(within(workspaceNavigation).queryByText("Settings")).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account menu" }).closest('[data-sidebar="footer"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
    const agentNavigation = screen.getByRole("complementary", { name: "Agent navigation" });
    expect(agentNavigation.getAttribute("data-collapsible")).toBeNull();
    expect(agentNavigation.getAttribute("data-state")).toBe("expanded");
    fireEvent.click(backToAgents);
    expect(await screen.findByRole("heading", { name: "All Agents" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Agent navigation" })).toBeNull();
  });

  it("surfaces and removes an unscoped Slack callback failure on the Agents landing", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents?slack_oauth_error=SLACK_UPSTREAM_UNAVAILABLE");
    render(<App />);

    expect(await screen.findByText("Slack is unavailable right now. Check the connection and try again.")).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.getByText("Slack is unavailable right now. Check the connection and try again.")).toBeTruthy();
  });

  it("carries an unscoped Slack callback failure through the incomplete-Account gate", async () => {
    installApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents?slack_oauth_error=SLACK_UPSTREAM_UNAVAILABLE");
    render(<App />);

    expect(await screen.findByText("Slack is unavailable right now. Check the connection and try again.")).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/agents/setup"));
    await waitFor(() => expect(window.location.search).toBe(`?agentId=${agentId}`));
    expect(screen.getByText("Slack is unavailable right now. Check the connection and try again.")).toBeTruthy();
  });

  it("shows each unreleased Agent page only when Internal Tools enables it", async () => {
    installApi({
      internalNavigationVisibility: { integrations: false, skills: true },
      internalToolsOffered: true,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    const workspaceNavigation = await screen.findByRole("navigation", { name: "Agent" });
    await waitFor(() =>
      expect(
        within(workspaceNavigation)
          .getAllByRole("link")
          .map((item) => item.textContent),
      ).toEqual(["Overview", "Tasks", "Skills", "Usage"]),
    );
    expect(within(workspaceNavigation).queryByRole("link", { name: "Integrations" })).toBeNull();
  });

  it("shows elapsed time without exposing conversation content for a working Agent", async () => {
    /*
     * The clock is pinned because the assertion is about a rounded interval: with a live clock the
     * fixture's "8 minutes ago" becomes "9m ago" the moment 30 seconds pass between building it and
     * rendering it, which is a wait this test never asked for and cannot control on a loaded machine.
     */
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    installApi({
      agentActivity: {
        state: "working",
        startedAt: new Date("2026-09-02T11:52:00.000Z").toISOString(),
      },
      bound: true,
      handoffReady: true,
    });
    render(<App />);

    const agentRow = (await screen.findByRole("link", { name: "Open Reviewer" })).closest('[data-ui="agent-row"]');
    expect(agentRow).toBeTruthy();
    const status = within(agentRow as HTMLElement)
      .getByText("Ready for new work")
      .closest("[data-state]");
    expect(status).toBeTruthy();
    expect(screen.getByText("1 Agent · 1 working")).toBeTruthy();
    expect(within(agentRow as HTMLElement).getByText("Working now · started 8m ago")).toBeTruthy();
  });

  it("states an offline reason once and carries no exit of its own", async () => {
    installApi({
      bound: true,
      computerStatus: () => "offline",
      handoffReady: true,
    });
    render(<App />);

    const open = await screen.findByRole("link", { name: "Open Reviewer" });
    const agentRow = open.closest('[data-ui="agent-row"]');
    expect(agentRow).toBeTruthy();
    const status = within(agentRow as HTMLElement)
      .getByText("Computer offline")
      .closest("[data-state]");
    expect(status).toBeTruthy();
    expect(within(agentRow as HTMLElement).queryByText("Cannot receive new work")).toBeNull();
    expect((agentRow as HTMLElement).querySelector('[data-ui="agent-row-state"]')).toBeNull();
    expect((status as HTMLElement).closest('[data-ui="agent-row-status"]')).toBeTruthy();
    /*
     * No recovery exit beside the reason. Which page repairs an offline Computer is the Agent's
     * business, so the card states the problem and the row link is the single way to follow it.
     */
    expect(within(status as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(agentRow as HTMLElement).getAllByRole("link")).toEqual([open]);
  });

  it("opens the Agent from the row itself rather than from a trailing affordance", async () => {
    installApi({ bound: true, handoffReady: true });
    render(<App />);

    // The row itself is the target: one link covers the card and carries its accessible name, while
    // the name renders as text so the two are not announced twice.
    const open = await screen.findByRole("link", { name: "Open Reviewer" });
    expect(open.className).toContain("absolute inset-0");
    expect(open.getAttribute("href")).toBe(`/agents/${agentId}`);
    const row = open.closest('[data-ui="agent-row"]');
    expect(row).toBeTruthy();
    expect((row as HTMLElement).querySelector('[data-ui="agent-row-action"]')).toBeNull();
    expect(within(row as HTMLElement).getAllByRole("link")).toEqual([open]);
  });

  it("sends an Agent that never finished setup back to the page that finishes it", async () => {
    installApi();
    render(<App />);

    const row = (await screen.findByRole("link", { name: "Open Reviewer" })).closest('[data-ui="agent-row"]');
    const resume = within(row as HTMLElement).getByRole("link", { name: "Continue setup" });
    expect(resume.getAttribute("href")).toBe(`/agents/setup?agentId=${agentId}`);
    /*
     * Above the overlay link that covers the whole card, which is painted last. A link the pointer
     * can see and never reach is worse than no link at all.
     */
    expect(resume.className).toContain("z-10");
    expect(resume.closest('[data-ui="agent-row-status"]')).toBeTruthy();
  });
});

describe("Workspace and Agent navigation boundaries", () => {
  beforeEach(resetWebAppState);

  it.each([
    "",
    "/tasks",
    `/tasks/${taskSessionId}`,
    "/usage",
    "/settings",
    "/settings/identity",
    "/settings/messaging",
    "/settings/computer",
    "/settings/instructions",
    "/settings/execution",
    "/settings/manage",
  ])("offers a direct global exit from Agent page %s without remounting the main frame", async (section) => {
    installApi({ bound: true, handoffReady: true });
    window.history.replaceState({}, "", `/agents/${agentId}${section}`);
    render(<App />);
    const navigation = await screen.findByRole("navigation", { name: "Agent" });
    const home = screen.getByRole("link", { name: "All Agents" });
    expect(home.getAttribute("aria-current")).not.toBe("page");
    if (section.startsWith("/settings")) {
      expect(within(navigation).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).not.toBe("page");
    }
    const frame = document.querySelector('[data-ui="content-page-frame"]');
    fireEvent.click(home);
    await screen.findByRole("heading", { name: "All Agents" });
    expect(document.querySelector('[data-ui="content-page-frame"]')).toBe(frame);
    expect(screen.getByRole("link", { name: "All Agents" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("navigation", { name: "Agent" })).toBeNull();
  });

  it("keeps the Agent shell and edited form until global navigation is allowed", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/identity`);
    render(<App />);
    const name = await screen.findByRole("textbox", { name: "Display name" });
    fireEvent.change(name, { target: { value: "Unsaved reviewer" } });
    fireEvent.click(screen.getByRole("link", { name: "All Agents" }));
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(document.querySelector('[data-scope="agent"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(window.location.pathname).toBe(`/agents/${agentId}/settings/identity`);
    expect((name as HTMLInputElement).value).toBe("Unsaved reviewer");
    fireEvent.click(screen.getByRole("link", { name: "All Agents" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await screen.findByRole("heading", { name: "All Agents" });
  });
});

it("switches Agents within Tasks without sharing their search state", async () => {
  resetWebAppState();
  installApi({ agentList: [agentListItem, secondAgentListItem] });
  window.history.replaceState({}, "", `/agents/${agentId}/tasks`);
  render(<App />);
  const search = await screen.findByRole("searchbox", { name: "Search Tasks" });
  fireEvent.change(search, { target: { value: "deployment" } });
  const sidebar = document.querySelector('[data-sidebar="sidebar"]');
  fireEvent.click(await screen.findByRole("button", { name: "Switch Agent, current Agent Reviewer" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Helper" }));
  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${secondAgentId}/tasks`));
  expect((screen.getByRole("searchbox", { name: "Search Tasks" }) as HTMLInputElement).value).toBe("");
  expect(document.querySelector('[data-sidebar="sidebar"]')).toBe(sidebar);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Tasks" }), { target: { value: "helper" } });
  fireEvent.click(await screen.findByRole("button", { name: "Switch Agent, current Agent Helper" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reviewer" }));
  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}/tasks`));
  expect((screen.getByRole("searchbox", { name: "Search Tasks" }) as HTMLInputElement).value).toBe("deployment");
});
