import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    expect(screen.getByText("100 tasks")).toBeTruthy();

    rerender(<AgentList agents={updatedAgents} key="reopened" />);
    expect(shownAgents()).toEqual(["Open Reviewer", "Open Renamed Helper"]);
    expect(screen.getByRole("link", { name: "Open Reviewer" })).not.toBe(originalRow);
  });
});
