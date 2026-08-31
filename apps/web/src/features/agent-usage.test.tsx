import type { AgentUsageDetail } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { ApiError, browserApi } from "../api.js";
import { queryKeys } from "../query/keys.js";
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

function RefreshUsageButton() {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      onClick={() => void queryClient.refetchQueries({ queryKey: queryKeys.agents.usage("agent-1", 30) })}
    >
      Refresh usage
    </button>
  );
}

describe("AgentUsageOverview", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps data coverage detail out of the Agent home summary", async () => {
    vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);

    await renderInRouter(<AgentUsageOverview agentId="agent-1" />);

    expect(await screen.findByText("428K")).toBeTruthy();
    expect(screen.queryByText("Partial data")).toBeNull();
  });

  it("uses chart headings without repeating their meaning in helper copy", async () => {
    vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);

    await renderInRouter(<AgentUsageTab agentId="agent-1" />);

    expect(await screen.findByRole("heading", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Token breakdown" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Usage period" }).textContent).toBe("Last 30 days");
    expect(screen.getByRole("table", { name: "Token breakdown" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Type", "Usage"]);
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

    expect(await screen.findByText("Partial data")).toBeTruthy();
    expect(screen.getAllByText("Partial data")).toHaveLength(1);
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
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("428K")).toBeTruthy();
    expect(screen.queryByText("Partial data")).toBeNull();
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
    expect(await screen.findByText("Token data unavailable")).toBeTruthy();
    expect(screen.getByRole("img", { name: /10 Tokens used/ })).toBeTruthy();
    expect(usageWindowLabel(1)).toBe("Last 24 hours");
  });

  it("surfaces a terminal refetch error instead of showing cached usage", async () => {
    const loadUsage = vi
      .spyOn(browserApi, "agentUsage")
      .mockResolvedValueOnce(usage)
      .mockRejectedValueOnce(new ApiError(404, "Usage not found"));

    await renderInRouter(
      <>
        <AgentUsageOverview agentId="agent-1" />
        <RefreshUsageButton />
      </>,
    );

    expect(await screen.findByText("428K")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Usage not found");
    expect(screen.queryByText("428K")).toBeNull();
    expect(loadUsage).toHaveBeenCalledTimes(2);
  });
});
