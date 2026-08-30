import type { AgentUsageDetail } from "@opentag/shared/browser";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
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

    await renderInRouter(<AgentUsageOverview agentId="agent-1" />);

    const coverage = await screen.findByText("Partial data.");
    expect(coverage.closest("[role='status']")?.textContent).toBe(
      "Partial data. Token data is available for 31 of 32 tasks. Token totals are partial.",
    );
  });

  it("uses chart headings without repeating their meaning in helper copy", async () => {
    vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);

    await renderInRouter(<AgentUsageTab agentId="agent-1" />);

    expect(await screen.findByRole("heading", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Token breakdown" })).toBeTruthy();
    expect(screen.queryByText("Total Tokens recorded each day.")).toBeNull();
    expect(screen.queryByText("Input and output within the selected period.")).toBeNull();
  });

  it("reads one window once for the overview and the tab that show it together", async () => {
    const loadUsage = vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);

    await renderInRouter(
      <>
        <AgentUsageOverview agentId="agent-1" />
        <AgentUsageTab agentId="agent-1" />
      </>,
    );

    expect((await screen.findAllByText("Partial data.")).length).toBe(2);
    expect(loadUsage).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure reason visible and retries the same usage request", async () => {
    const loadUsage = vi
      .spyOn(browserApi, "agentUsage")
      .mockRejectedValueOnce(new Error("Usage aggregation is delayed. Try again shortly."))
      .mockResolvedValueOnce(usage);

    await renderInRouter(<AgentUsageOverview agentId="agent-1" />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Usage aggregation is delayed. Try again shortly.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry Agent usage" }));

    expect(await screen.findByText("Partial data.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(loadUsage).toHaveBeenCalledTimes(2);
    expect(loadUsage).toHaveBeenNthCalledWith(2, "agent-1", 30);
  });
});
