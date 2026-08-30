import type { AgentUsageDetail } from "@opentag/shared/browser";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { browserApi } from "../api.js";
import { AgentUsageOverview, AgentUsageTab, usageWindowLabel } from "./agent-usage.js";

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

  it("normalizes non-error failures and explains unavailable token coverage", async () => {
    vi.spyOn(browserApi, "agentUsage").mockRejectedValueOnce("provider unavailable");
    await renderInRouter(<AgentUsageOverview agentId="agent-string-error" />);
    expect((await screen.findByRole("alert")).textContent).toContain("provider unavailable");
    cleanup();

    vi.restoreAllMocks();
    vi.spyOn(browserApi, "agentUsage").mockRejectedValueOnce({});
    await renderInRouter(<AgentUsageOverview agentId="agent-unknown-error" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Usage is temporarily unavailable");
    cleanup();

    vi.restoreAllMocks();
    vi.spyOn(browserApi, "agentUsage").mockResolvedValue({
      ...usage,
      tasks: 2,
      measuredTasks: 0,
      tokens: 10,
      inputTokens: 6,
      outputTokens: 4,
      daily: [
        {
          date: "2026-08-25",
          inputTokens: 6,
          cachedInputTokens: 0,
          outputTokens: 4,
          tokens: 10,
          tasks: 2,
          measuredTasks: 0,
        },
      ],
    });
    await renderInRouter(<AgentUsageTab agentId="agent-covered" />);
    expect(await screen.findByText("Token data unavailable.")).toBeTruthy();
    expect(screen.getByRole("img", { name: /10 Tokens used/ })).toBeTruthy();
    expect(usageWindowLabel(1)).toBe("Last 24 hours");
  });
});
