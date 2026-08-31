import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("shows detailed Agent Token usage and changes the selected period", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(await screen.findByRole("img", { name: /428K Tokens used · Last 30 days/ })).toBeTruthy();
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.queryByText("Failed Tasks")).toBeNull();
    expect(screen.queryByText("Average per measured Task")).toBeNull();
    expect(screen.getByText("Partial data.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Partial data. Token data is available for 31 of 32 tasks. Token totals and charts are partial.",
    );
    expect(screen.getByRole("heading", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Token breakdown" })).toBeTruthy();
    expect(screen.getAllByText(/0 Tokens$/).length).toBeGreaterThan(0);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText("Cached input")).toBeTruthy();
    expect(screen.queryByText("Turns")).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "Usage period" }));
    const sevenDayOption = await screen.findByRole("option", { name: "Last 7 days" });
    fireEvent.pointerMove(sevenDayOption, { pointerType: "mouse" });
    fireEvent.pointerDown(sevenDayOption, { pointerType: "mouse" });
    fireEvent.pointerUp(sevenDayOption, { pointerType: "mouse" });
    fireEvent.click(sevenDayOption);
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => String(input) === `/api/v1/agents/${agentId}/usage?days=7`),
      ).toBe(true),
    );
    expect(await screen.findByRole("img", { name: /428K Tokens used · Last 7 days/ })).toBeTruthy();
  });

  it("explains when no Tasks report Token usage", async () => {
    installApi({
      agentUsage: {
        tasks: 4,
        measuredTasks: 0,
        failed: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        daily: [],
      },
    });
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    expect((await screen.findByText("Token data unavailable.")).closest("[role='status']")?.textContent).toBe(
      "Token data unavailable. None of the 4 tasks reported token usage. Token totals and charts may be empty.",
    );
  });

  it("keeps the Usage loading skeleton aligned with the two summary metrics", async () => {
    installApi();
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    let releaseUsage = () => {};
    const pendingUsage = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).startsWith(`/api/v1/agents/${agentId}/usage?`)) await pendingUsage;
      if (!baseFetch) throw new Error("Expected the base fetch implementation");
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    const loading = await screen.findByLabelText("Loading Agent usage");
    expect(loading.children).toHaveLength(2);
    releaseUsage();
    expect(await screen.findByText("Partial data.")).toBeTruthy();
  });
});
