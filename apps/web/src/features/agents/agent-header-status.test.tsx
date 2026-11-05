import type { AgentDetail, AgentStatusSnapshot, MeResponse } from "@opentag/shared/browser";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { agentSummary, userId } from "../../__tests__/support/app-fixtures.js";
import { renderInRouter } from "../../__tests__/support/router.js";
import { withLocaleAsync } from "../../__tests__/support/with-locale.js";
import { AccountContext } from "../session/session-context.js";
import { AgentObjectHeader } from "./agent-detail-page.js";
import type { AgentDetailView } from "./agent-model.js";
import { applyAgentStatus } from "./agent-model.js";

const TIME = "2026-11-05T00:00:00.000Z";
const me = { user: { id: userId, displayName: "Ada" } } as MeResponse;

function agentView(
  overrides: Partial<AgentStatusSnapshot> = {},
  activity: AgentDetail["activity"] = { state: "idle" },
): AgentDetailView {
  if (!agentSummary.computer) throw new Error("Expected bound Agent fixture");
  const snapshot: AgentStatusSnapshot = {
    agentId: agentSummary.id,
    agentRevision: 1,
    agentUpdatedAt: TIME,
    agentStatus: "active",
    observedAt: TIME,
    checkedAt: TIME,
    state: "ready",
    reason: null,
    computer: { ...agentSummary.computer, kind: "local", online: true, lastSeenAt: TIME },
    runtimeProvider: "codex",
    runtimeStatus: "ready",
    messaging: {
      id: "44444444-4444-4444-8444-444444444444",
      agentId: agentSummary.id,
      provider: "feishu",
      bindingState: "active",
      bot: { displayName: "Actual Bot", avatarUrl: null },
      receiveMode: "mention_only",
      lastInboundAt: null,
      lastValidatedAt: TIME,
      lastRuntimeObservationAt: TIME,
    },
    ...overrides,
  };
  return applyAgentStatus({ ...agentSummary, activity }, snapshot);
}

async function renderHeader(agent: AgentDetailView, overview = true) {
  await renderInRouter(
    <AccountContext value={{ me, endSession: vi.fn(), refreshMe: vi.fn().mockResolvedValue(me), reloadMe: vi.fn() }}>
      <AgentObjectHeader agent={agent} showOverviewStatus={overview} showHandle={!overview} />
    </AccountContext>,
  );
  const header = screen.getByRole("heading", { name: agent.displayName.trim() }).closest("header");
  if (!header) throw new Error("Missing Agent header");
  return header;
}

describe("Overview name-area status", () => {
  it.each([
    ["en", "Ready"],
    ["zh", "已就绪"],
  ] as const)("keeps a ready idle Agent quiet in %s", async (locale, label) => {
    await withLocaleAsync(locale, async () => {
      const header = await renderHeader(agentView());
      expect(within(header).getByText(label)).toBeTruthy();
      expect(
        within(header).getByRole("region", {
          name: locale === "zh" ? `Agent 状态：${label}` : `Agent status: ${label}`,
        }),
      ).toBeTruthy();
      expect(header.textContent).not.toMatch(/Waiting|等待中/);
      expect(header.querySelector('[data-ui="agent-overview-activity"]')).toBeNull();
    });
  });

  it("adds a running count as secondary detail while keeping Ready", async () => {
    const header = await renderHeader(agentView({}, { state: "working", startedAt: TIME, runningTaskCount: 2 }));
    expect(within(header).getByText("Ready")).toBeTruthy();
    expect(header.querySelector('[data-ui="agent-overview-activity"]')?.textContent).toBe("2 tasks running");
    expect(within(header).queryByText("Working")).toBeNull();
  });

  it("retains the existing elapsed fallback for a Server without a running count", async () => {
    const header = await renderHeader(agentView({}, { state: "working", startedAt: TIME }));
    expect(within(header).getByText("Ready")).toBeTruthy();
    expect(within(header).getByText(/Working now · started/)).toBeTruthy();
  });

  it("does not invent activity when readiness is known but activity is unknown", async () => {
    const header = await renderHeader(agentView({}, { state: "unknown" }));
    expect(within(header).getByText("Ready")).toBeTruthy();
    expect(header.querySelector('[data-ui="agent-overview-activity"]')).toBeNull();
    expect(header.textContent).not.toContain("Waiting");
  });

  it.each([
    [{ state: "initializing", reason: "first_validation", runtimeStatus: "checking" }, "Initializing"],
    [{ state: "problem", reason: "runtime_unavailable", runtimeStatus: "install" }, "Codex not installed"],
    [{ state: "computer_offline", reason: "computer_offline" }, "Computer offline"],
  ] as const)("preserves the Server verdict %j", async (override, label) => {
    const header = await renderHeader(agentView(override, { state: "working", startedAt: TIME, runningTaskCount: 2 }));
    expect(within(header).getByText(label)).toBeTruthy();
    expect(header.querySelector('[data-ui="agent-overview-activity"]')).toBeNull();
    expect(header.textContent).not.toMatch(/Waiting|Setting up messaging/);
  });

  it("puts paused status, receiving explanation and the existing Resume control in the name area", async () => {
    const header = await renderHeader(
      agentView({ state: "problem", reason: "agent_paused", agentStatus: "suspended" }),
    );
    expect(within(header).getAllByText("Paused")).toHaveLength(1);
    expect(within(header).getByText("This Agent is paused. Resume it to start receiving messages again.")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Resume Agent" })).toBeTruthy();
    expect(header.querySelector('[data-ui="agent-lifecycle-notice"]')).toBeNull();
  });

  it("keeps Computer offline priority while a paused Agent still has its Resume control", async () => {
    const header = await renderHeader(
      agentView({ state: "computer_offline", reason: "computer_offline", agentStatus: "suspended" }),
    );
    expect(within(header).getByText("Computer offline")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Resume Agent" })).toBeTruthy();
    expect(within(header).queryByText("Ready")).toBeNull();
  });

  it("shows unavailable evidence without retaining an old Ready or work detail", async () => {
    const agent = agentView({}, { state: "working", startedAt: TIME, runningTaskCount: 2 });
    agent.availability = { ...agent.availability, state: "unconfirmed" };
    const header = await renderHeader(agent);
    expect(within(header).getByText("Status unavailable")).toBeTruthy();
    expect(within(header).queryByText("Ready")).toBeNull();
    expect(header.querySelector('[data-ui="agent-overview-activity"]')).toBeNull();
  });

  it("leaves the shared legacy header unchanged without opt-in", async () => {
    const header = await renderHeader(agentView(), false);
    expect(within(header).getByText("@reviewer")).toBeTruthy();
    expect(within(header).getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(header.querySelector('[data-ui="agent-overview-status"]')).toBeNull();
  });

  it("preserves the complete long title and exact Settings destination", async () => {
    const agent = { ...agentView(), displayName: "A long Agent name ".repeat(12) };
    const header = await renderHeader(agent);
    const heading = within(header).getByRole("heading", { name: agent.displayName.trim() });
    expect(heading.querySelector("span")?.getAttribute("title")).toBe(agent.displayName);
    expect(within(header).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      `/agents/${agent.id}/settings`,
    );
  });
});
