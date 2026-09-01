import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("keeps the Account Agents page local and opens Agent navigation only after selection", async () => {
    installApi();
    render(<App />);
    const pageHeading = await screen.findByRole("heading", { level: 1, name: "Agents" });
    expect(pageHeading.classList.contains("text-xl")).toBe(true);
    expect(window.location.pathname).toBe("/agents");
    expect(screen.queryByText("Infrastructure")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agent runtime" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Computers" })).toBeNull();
    expect(screen.getByRole("main").classList.contains("decorative-page")).toBe(false);
    expect(screen.queryByRole("complementary", { name: "Agent navigation" })).toBeNull();
    const brandLink = screen.getByRole("link", { name: "OpenTag" });
    expect(brandLink.getAttribute("href")).toBe("/agents");
    const brandLogo = brandLink.querySelector("img");
    expect(brandLogo?.getAttribute("alt")).toBe("");
    expect(brandLogo?.classList.contains("size-6")).toBe(true);
    expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Example")).toBeNull();
    const agentLink = await screen.findByRole("link", { name: "Open Reviewer" });
    const createAgent = screen.getByRole("button", { name: "New Agent" });
    expect(createAgent.closest('[data-ui="page-header"]')).toBeTruthy();
    expect(createAgent.closest('[data-ui="agents-page-action"]')).toBeTruthy();
    const agentRow = agentLink.closest('[data-ui="agent-row"]');
    expect(agentRow).toBeTruthy();
    expect(agentRow?.parentElement?.classList.contains("@container/agent-roster")).toBe(true);
    expect(agentRow?.className).toContain("/agent-roster:grid-cols-");
    expect(screen.queryByText(/Monitor availability/)).toBeNull();
    expect(screen.getByText("1 Agent · 0 currently working")).toBeTruthy();
    expect(within(agentRow as HTMLElement).queryByText("@reviewer")).toBeNull();
    expect(within(agentRow as HTMLElement).getByText("Tasks (30d)")).toBeTruthy();
    expect(within(agentRow as HTMLElement).getByText("Tokens (30d)")).toBeTruthy();
    expect(within(agentRow as HTMLElement).getByText("428K")).toBeTruthy();
    expect(within(agentRow as HTMLElement).queryByText("Last checked")).toBeNull();
    expect((agentRow as HTMLElement).querySelector('[data-ui="agent-row-avatar"]')?.classList.contains("size-10")).toBe(
      true,
    );
    const rowState = (agentRow as HTMLElement).querySelector('[data-ui="agent-row-state"]');
    expect(rowState).toBeTruthy();
    expect(within(agentRow as HTMLElement).getByText("Messaging disconnected")).toBeTruthy();
    expect(within(rowState as HTMLElement).getByText("Cannot receive new work")).toBeTruthy();
    // The row reports the failure and nothing else; opening the Agent is its only follow-up.
    expect(within(agentRow as HTMLElement).queryByRole("link", { name: "Connect messaging" })).toBeNull();
    expect(
      within(agentRow as HTMLElement)
        .getAllByRole("link")
        .map((item) => item.getAttribute("href")),
    ).toEqual([`/agents/${agentId}`]);
    expect((agentRow as HTMLElement).querySelector('[data-ui="agent-row-status"] [data-state]')).toBeTruthy();
    expect(rowState?.closest('[data-ui="agent-row-status"]')).toBeTruthy();
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByText("Mentions only")).toBeNull();
    fireEvent.click(agentLink);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "OpenTag" })).toBeNull();
    const accountAgentsNavigation = screen.getByRole("navigation", { name: "Account Agents" });
    const backToAgents = within(accountAgentsNavigation).getByRole("link", { name: "Agents" });
    expect(backToAgents.getAttribute("href")).toBe("/agents");
    const mobileAgentHome = document.querySelector('[data-ui="agent-mobile-home"]');
    expect(mobileAgentHome?.textContent).toContain("Reviewer");
    expect(mobileAgentHome?.getAttribute("href")).toBe(`/agents/${agentId}`);
    const switcher = screen.getByRole("button", { name: "Switch Agent, current Agent Reviewer" });
    expect(switcher.closest('[data-sidebar="header"]')).toBeTruthy();
    const workspaceNavigation = screen.getByRole("navigation", { name: "Agent" });
    expect(
      within(workspaceNavigation)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["Home", "Tasks", "Skills", "Integrations", "Usage"]);
    const navigationIcons = workspaceNavigation.querySelectorAll("svg");
    expect(navigationIcons).toHaveLength(5);
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
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Agent navigation" })).toBeNull();
  });

  it("shows elapsed time without exposing conversation content for a working Agent", async () => {
    installApi({
      agentActivity: {
        state: "working",
        startedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
      },
      bound: true,
      handoffReady: true,
    });
    render(<App />);

    const agentRow = (await screen.findByRole("link", { name: "Open Reviewer" })).closest('[data-ui="agent-row"]');
    expect(agentRow).toBeTruthy();
    const status = within(agentRow as HTMLElement)
      .getByText("Working")
      .closest("[data-state]");
    expect(status).toBeTruthy();
    expect(within(agentRow as HTMLElement).getByText("Working now · started 8m ago")).toBeTruthy();
  });

  it("states an offline reason under the Agent name and carries no exit of its own", async () => {
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
    expect(within(agentRow as HTMLElement).getByText("Cannot receive new work")).toBeTruthy();
    expect((status as HTMLElement).closest('[data-ui="agent-row-status"]')).toBeTruthy();
    /*
     * No recovery exit beside the reason. Which page repairs an offline Computer is the Agent's
     * business, so the card states the problem and the row link is the single way to follow it.
     */
    expect(within(status as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(agentRow as HTMLElement).getAllByRole("link")).toEqual([open]);
  });

  it("opens the Agent from the row itself rather than from a trailing affordance", async () => {
    installApi();
    render(<App />);

    // The row itself is the target: one link covers the card and carries its accessible name, while
    // the name renders as text so the two are not announced twice.
    const open = await screen.findByRole("link", { name: "Open Reviewer" });
    expect(open.className).toContain("absolute inset-0");
    expect(open.getAttribute("href")).toBe(`/agents/${agentId}`);
    const row = open.closest('[data-ui="agent-row"]');
    expect(row).toBeTruthy();
    expect((row as HTMLElement).querySelector('[data-ui="agent-row-action"]')).toBeNull();
    /*
     * Even a card reporting a broken dependency carries no second link. Where the repair lives
     * depends on which dependency failed, so the row link is the whole answer: open the Agent.
     */
    expect(within(row as HTMLElement).getAllByRole("link")).toEqual([open]);
  });
});
