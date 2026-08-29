import type { AgentUsageDetail } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { AgentUsageOverview, AgentUsageTab } from "./agent-usage.js";

const usage: AgentUsageDetail = {
  windowDays: 30,
  startedAt: "2026-07-27T00:00:00.000Z",
  endedAt: "2026-08-25T23:59:59.999Z",
  tasks: 32,
  measuredTasks: 31,
  failed: 0,
  inputTokens: 400_000,
  cachedInputTokens: 350_000,
  outputTokens: 28_000,
  tokens: 428_000,
  daily: [],
};

describe("AgentUsageOverview", () => {
  afterEach(() => vi.restoreAllMocks());

  it("describes partial totals without referring to charts that are not shown", async () => {
    vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);

    render(
      <MemoryRouter>
        <AgentUsageOverview agentId="agent-1" />
      </MemoryRouter>,
    );

    const coverage = await screen.findByText("Partial data.");
    expect(coverage.closest("[role='status']")?.textContent).toBe(
      "Partial data. Token data is available for 31 of 32 tasks. Token totals are partial.",
    );
  });

  it("offers the shortest windows on the Agent home and names the one-day window in hours", async () => {
    const read = vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);

    render(
      <MemoryRouter>
        <AgentUsageOverview agentId="agent-1" />
      </MemoryRouter>,
    );

    const period = await screen.findByLabelText("Usage period");
    expect([...(period as HTMLSelectElement).options].map((option) => option.textContent)).toEqual([
      "Last 24 hours",
      "Last 7 days",
      "Last 30 days",
    ]);
    fireEvent.change(period, { target: { value: "1" } });
    await waitFor(() => expect(read).toHaveBeenCalledWith("agent-1", 1));
  });

  it("uses chart headings without repeating their meaning in helper copy", async () => {
    vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);

    render(
      <MemoryRouter>
        <AgentUsageTab agentId="agent-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Token breakdown" })).toBeTruthy();
    expect(screen.queryByText("Total Tokens recorded each day.")).toBeNull();
    expect(screen.queryByText("Input and output within the selected period.")).toBeNull();
  });
});
