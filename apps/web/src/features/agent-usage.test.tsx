import type { AgentUsageDetail } from "@opentag/shared/browser";
import { render, screen } from "@testing-library/react";
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
