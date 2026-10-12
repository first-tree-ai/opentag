import type { CloudUsageSummary } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { CloudUsagePage } from "./cloud-usage-page.js";

const usage: Extract<CloudUsageSummary, { enabled: true }> = {
  enabled: true,
  windowDays: 30,
  startedAt: "2026-09-05T12:00:00.000Z",
  endedAt: "2026-10-05T12:00:00.000Z",
  requests: 10,
  measuredRequests: 10,
  tokens: 300,
  inputTokens: 100,
  outputTokens: 200,
  daily: [{ date: "2026-10-01", tokens: 300 }],
};
afterEach(() => vi.restoreAllMocks());
function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CloudUsagePage />
    </QueryClientProvider>,
  );
}
describe("account-wide cloud usage", () => {
  it("shows cloud model-call totals and the trend chart without a token breakdown", async () => {
    const load = vi.spyOn(browserApi, "cloudUsage").mockResolvedValue(usage);
    const agents = vi.spyOn(browserApi, "agentUsage");
    mount();
    expect(await screen.findByRole("heading", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cloud usage" })).toBeTruthy();
    expect(screen.getByText("Model calls")).toBeTruthy();
    expect(screen.getByRole("img", { name: /300 Tokens used/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Token breakdown" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(load).toHaveBeenCalledWith(30);
    expect(agents).not.toHaveBeenCalled();
  });
  it("changes the date range using the existing usage selector", async () => {
    const load = vi.spyOn(browserApi, "cloudUsage").mockResolvedValue(usage);
    mount();
    await screen.findByText("Model calls");
    fireEvent.click(screen.getByRole("combobox", { name: "Usage period" }));
    const option = await screen.findByRole("option", { name: "Last 7 days" });
    fireEvent.pointerMove(option, { pointerType: "mouse" });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.pointerUp(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(load).toHaveBeenCalledWith(7));
  });
  it("shows incomplete data as pending coverage and renders a truthful empty state", async () => {
    vi.spyOn(browserApi, "cloudUsage").mockResolvedValue({
      ...usage,
      measuredRequests: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      daily: [],
    });
    mount();
    expect(await screen.findByRole("heading", { name: "No token usage" })).toBeTruthy();
    expect(screen.getByText(/Token data is available for 0 of 10 model calls/)).toBeTruthy();
  });
  it("supports retrying a failed read", async () => {
    vi.spyOn(browserApi, "cloudUsage").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(usage);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText("Model calls");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("explains disabled cloud billing without displaying local token data", async () => {
    vi.spyOn(browserApi, "cloudUsage").mockResolvedValue({ enabled: false });
    mount();
    expect(await screen.findByText("Cloud usage is available when cloud billing is enabled.")).toBeTruthy();
    expect(screen.queryByText("Total tokens")).toBeNull();
  });
});
