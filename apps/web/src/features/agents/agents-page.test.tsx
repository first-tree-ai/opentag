import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentListItem, secondAgentListItem } from "../../__tests__/support/app-fixtures.js";
import { renderInRouter } from "../../__tests__/support/router.js";
import type { AgentListItem } from "./agent-model.js";
import { AgentList } from "./agents-page.js";

const readyAgent: AgentListItem = {
  ...agentListItem,
  evidenceConfirmed: true,
  availability: {
    state: "ready",
    reason: null,
    lastConfirmedAt: agentListItem.updatedAt,
    dependencies: {
      computer: { state: "ready", lastConfirmedAt: agentListItem.updatedAt },
      runtime: { provider: "codex", status: "ready" },
      channel: { state: "connected", provider: "feishu", botDisplayName: "Reviewer" },
      handoff: { state: "ready", lastConfirmedAt: agentListItem.updatedAt },
    },
  },
};

function shownAgents() {
  return screen.getAllByRole("link", { name: /^Open / }).map((link) => link.getAttribute("aria-label"));
}

describe("Agent list creation order", () => {
  it("preserves Server order across status, name, usage, activity changes and remounts", async () => {
    const newerAgent: AgentListItem = {
      ...readyAgent,
      ...secondAgentListItem,
      createdAt: "2026-08-21T00:00:00.000Z",
      availability: {
        ...readyAgent.availability,
        state: "not_connected",
        reason: "im_not_connected",
        dependencies: {
          ...readyAgent.availability.dependencies,
          channel: { state: "not_connected", provider: null, botDisplayName: null },
          handoff: { state: "not_connected", lastConfirmedAt: null },
        },
      },
    };
    const { rerender } = await renderInRouter(<AgentList agents={[readyAgent, newerAgent]} />);
    expect(shownAgents()).toEqual(["Open Reviewer", "Open Helper"]);
    expect(screen.getByText("Messaging not connected")).toBeTruthy();
    const originalRow = screen.getByRole("link", { name: "Open Reviewer" });

    const updatedAgents: AgentListItem[] = [
      { ...readyAgent, status: "suspended" },
      {
        ...newerAgent,
        name: "aaa-helper",
        displayName: "Renamed Helper",
        updatedAt: "2026-08-22T00:00:00.000Z",
        availability: readyAgent.availability,
        activity: { state: "working", startedAt: new Date().toISOString() },
        usage: { windowDays: 30, tasks: 100, failed: 0, tokens: 1_000_000 },
      },
    ];
    rerender(<AgentList agents={updatedAgents} />);
    expect(shownAgents()).toEqual(["Open Reviewer", "Open Renamed Helper"]);
    expect(screen.getByRole("link", { name: "Open Reviewer" })).toBe(originalRow);
    expect(screen.getByText(/Working/)).toBeTruthy();
    expect(screen.queryByText("100 tasks")).toBeNull();

    rerender(<AgentList agents={updatedAgents} key="reopened" />);
    expect(shownAgents()).toEqual(["Open Reviewer", "Open Renamed Helper"]);
    expect(screen.getByRole("link", { name: "Open Reviewer" })).not.toBe(originalRow);
  });
});

function withAvailability(
  agent: AgentListItem,
  availability: Partial<AgentListItem["availability"]>,
  evidenceConfirmed = true,
): AgentListItem {
  return { ...agent, evidenceConfirmed, availability: { ...agent.availability, ...availability } };
}

const reverifying = withAvailability(readyAgent, {
  state: "setting_up",
  reason: "handoff_checking",
  dependencies: {
    ...readyAgent.availability.dependencies,
    handoff: {
      state: "checking",
      lastConfirmedAt: agentListItem.updatedAt,
      providerCli: { phase: "checking_credentials" },
    },
  },
});
const deliveryFailed = withAvailability(readyAgent, {
  state: "action_required",
  reason: "handoff_unavailable",
  dependencies: {
    ...readyAgent.availability.dependencies,
    handoff: { state: "action_required", lastConfirmedAt: agentListItem.updatedAt },
  },
});
const unreadable = withAvailability(
  readyAgent,
  { state: "unconfirmed", reason: "agent_unconfirmed", lastConfirmedAt: null },
  false,
);

function rowStatus() {
  return screen.getByRole("link", { name: "Open Reviewer" }).closest("article")?.textContent ?? "";
}

describe("Agent list status through background refreshes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows current checks and failed reads immediately without retaining Ready", async () => {
    const { rerender } = await renderInRouter(<AgentList agents={[readyAgent]} />);
    expect(rowStatus()).toContain("Ready");
    rerender(<AgentList agents={[reverifying]} />);
    expect(rowStatus()).toContain("Checking messaging");
    expect(rowStatus()).not.toContain("Ready");
    rerender(<AgentList agents={[deliveryFailed]} />);
    expect(rowStatus()).toContain("Cannot receive messages");
    rerender(<AgentList agents={[unreadable]} />);
    expect(rowStatus()).toContain("Status unavailable");
    expect(screen.queryByText("Refreshing status")).toBeNull();
  });

  it("says Checking for a first-seen check, and unreadable evidence with nothing settled as unknown", async () => {
    const runtimeChecking = withAvailability(readyAgent, {
      state: "action_required",
      reason: "runtime_unavailable",
      dependencies: { ...readyAgent.availability.dependencies, runtime: { provider: "codex", status: "checking" } },
    });
    const { rerender } = await renderInRouter(<AgentList agents={[runtimeChecking]} />);
    expect(rowStatus()).toContain("Checking");
    expect(rowStatus()).not.toContain("Ready");

    rerender(<AgentList agents={[reverifying]} key="remounted" />);
    expect(rowStatus()).toContain("Checking");

    rerender(<AgentList agents={[unreadable]} key="remounted-again" />);
    expect(rowStatus()).toContain("Status unavailable");
  });

  it("never reads Ready before a first check finds a problem", async () => {
    const needsPermissions = withAvailability(readyAgent, {
      state: "action_required",
      reason: "im_reauthorization_required",
    });
    const { rerender } = await renderInRouter(<AgentList agents={[reverifying]} />);
    expect(rowStatus()).toContain("Checking");
    expect(rowStatus()).not.toContain("Ready");

    rerender(<AgentList agents={[needsPermissions]} />);
    expect(rowStatus()).toContain("Messaging permissions need updating");

    // Each read replaces the current status.
    rerender(<AgentList agents={[reverifying]} />);
    expect(rowStatus()).toContain("Checking messaging");
  });
});

describe("Agent list activity", () => {
  it("shows each Agent's running Task count, and nothing beside an idle Ready", async () => {
    const working: AgentListItem = {
      ...readyAgent,
      activity: { state: "working", startedAt: new Date().toISOString(), runningTaskCount: 2 },
    };
    const offline: AgentListItem = {
      ...readyAgent,
      ...secondAgentListItem,
      availability: { ...readyAgent.availability, state: "action_required", reason: "computer_offline" },
    };
    const { rerender } = await renderInRouter(<AgentList agents={[working, offline]} />);
    const row = (name: string) => screen.getByRole("link", { name }).closest("article")?.textContent ?? "";
    expect(row("Open Reviewer")).toContain("2 tasks running");
    expect(row("Open Helper")).not.toContain("Waiting");

    rerender(<AgentList agents={[readyAgent, offline]} />);
    expect(row("Open Reviewer")).toContain("Ready");
    expect(row("Open Reviewer")).not.toContain("Waiting");
  });
});

describe("Agent list row actions", () => {
  it("links a messaging permission problem to the messaging settings, like setup problems link to setup", async () => {
    const permissions: AgentListItem = {
      ...readyAgent,
      availability: { ...readyAgent.availability, state: "action_required", reason: "im_reauthorization_required" },
    };
    await renderInRouter(<AgentList agents={[permissions]} />);
    expect(screen.getByRole("link", { name: "Update permissions" }).getAttribute("href")).toBe(
      `/agents/${readyAgent.id}/settings/messaging`,
    );
  });
});
