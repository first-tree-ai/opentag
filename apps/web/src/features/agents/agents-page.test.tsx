import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentListItem, secondAgentListItem } from "../../__tests__/support/app-fixtures.js";
import { renderInRouter } from "../../__tests__/support/router.js";
import { STEADY_READY_HOLD_MS } from "./agent-list-steady-status.js";
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

describe("A row whose messaging is being re-verified", () => {
  it("says so without offering to continue setup, unlike a row whose delivery failed", async () => {
    const reverifying: AgentListItem = {
      ...readyAgent,
      availability: {
        ...readyAgent.availability,
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
      },
    };
    const failed: AgentListItem = {
      ...readyAgent,
      ...secondAgentListItem,
      availability: {
        ...readyAgent.availability,
        state: "action_required",
        reason: "handoff_unavailable",
        dependencies: {
          ...readyAgent.availability.dependencies,
          handoff: { state: "action_required", lastConfirmedAt: agentListItem.updatedAt },
        },
      },
    };
    await renderInRouter(<AgentList agents={[reverifying, failed]} />);
    expect(screen.getByText("Checking messaging")).toBeTruthy();
    expect(screen.getByText("Cannot receive messages")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Continue setup" })).toHaveLength(1);
  });
});

describe("A Ready row while its evidence is re-read", () => {
  const checking: AgentListItem = {
    ...readyAgent,
    availability: {
      ...readyAgent.availability,
      state: "setting_up",
      reason: "handoff_checking",
      dependencies: {
        ...readyAgent.availability.dependencies,
        handoff: { state: "checking", lastConfirmedAt: null, providerCli: { phase: "checking_credentials" } },
      },
    },
  };
  const runtimeChecking: AgentListItem = {
    ...readyAgent,
    availability: {
      ...readyAgent.availability,
      state: "action_required",
      reason: "runtime_unavailable",
      dependencies: { ...readyAgent.availability.dependencies, runtime: { provider: "codex", status: "checking" } },
    },
  };
  const unconfirmed: AgentListItem = {
    ...readyAgent,
    evidenceConfirmed: false,
    availability: { ...readyAgent.availability, state: "unconfirmed", reason: "agent_unconfirmed" },
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays Ready through re-checks and failed background reads, without offering setup", async () => {
    const { rerender } = await renderInRouter(<AgentList agents={[readyAgent]} />);
    expect(screen.getByText("Ready")).toBeTruthy();
    for (const answer of [checking, runtimeChecking, unconfirmed]) {
      rerender(<AgentList agents={[answer]} />);
      expect(screen.getByText("Ready")).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Continue setup" })).toBeNull();
    }
    rerender(<AgentList agents={[readyAgent]} />);
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("keeps current activity while holding the Ready verdict", async () => {
    const { rerender } = await renderInRouter(<AgentList agents={[readyAgent]} />);
    rerender(
      <AgentList agents={[{ ...checking, activity: { state: "working", startedAt: new Date().toISOString() } }]} />,
    );
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText(/Working/)).toBeTruthy();
  });

  it("reports a real failure at once", async () => {
    const { rerender } = await renderInRouter(<AgentList agents={[readyAgent]} />);
    rerender(
      <AgentList
        agents={[
          {
            ...readyAgent,
            availability: {
              ...readyAgent.availability,
              state: "action_required",
              reason: "computer_offline",
              dependencies: {
                ...readyAgent.availability.dependencies,
                computer: { state: "action_required", lastConfirmedAt: null },
              },
            },
          },
        ]}
      />,
    );
    expect(screen.getByText("Computer offline")).toBeTruthy();
    // The failure is a verdict, so a re-check that follows it has no Ready to fall back on.
    rerender(<AgentList agents={[checking]} />);
    expect(screen.getByText("Checking messaging")).toBeTruthy();
  });

  it("reports a re-check that outlasts the hold window", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { rerender } = await renderInRouter(<AgentList agents={[readyAgent]} />);
    rerender(<AgentList agents={[checking]} />);
    expect(screen.getByText("Ready")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(STEADY_READY_HOLD_MS - 1);
    });
    expect(screen.getByText("Ready")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Checking messaging")).toBeTruthy();
  });
});
