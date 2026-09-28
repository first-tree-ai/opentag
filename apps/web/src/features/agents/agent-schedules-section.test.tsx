import type { AgentSchedule, AgentScheduleListItem } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { AgentSchedulesSection } from "./agent-schedules-section.js";

const AGENT_ID = "10c4a3b9-1631-4e4b-8922-23932ea36237";
const SCHEDULE_ID = "5238c0ee-a939-4bc0-8772-66d46c9df934";
const TARGET_ID = "2af661c1-f3d9-4c8e-9e9b-e31c49f298ce";
const TIME = "2026-09-28T01:00:00.000Z";

function schedule(overrides: Partial<AgentSchedule> = {}): AgentSchedule {
  return {
    id: SCHEDULE_ID,
    agentId: AGENT_ID,
    target: {
      sessionId: TARGET_ID,
      provider: "feishu",
      sessionKind: "thread",
      channelId: "test-chat",
      threadKey: "test-thread",
    },
    name: "Daily check",
    prompt: "Check the build and include END-OF-TASK in the result.",
    schedule: { kind: "every", intervalSeconds: 60, anchorAt: TIME },
    timezone: "Asia/Shanghai",
    enabled: true,
    nextTriggerAt: "2026-09-28T01:01:00.000Z",
    revision: 3,
    lastDispatch: null,
    detailUrl: `https://example.com/agents/${AGENT_ID}?schedule=${SCHEDULE_ID}`,
    createdAt: TIME,
    updatedAt: TIME,
    ...overrides,
  };
}

function summaryOf(full: AgentSchedule): AgentScheduleListItem {
  const { prompt: _prompt, detailUrl: _detailUrl, ...summary } = full;
  return summary;
}

function mount(scheduleId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentSchedulesSection agentId={AGENT_ID} scheduleId={scheduleId} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("AgentSchedulesSection", () => {
  it("keeps the full task behind the Account detail read", async () => {
    const item = schedule();
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    const detail = vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount();
    expect(await screen.findByText("Daily check")).toBeTruthy();
    expect(screen.queryByText(item.prompt)).toBeNull();
    expect(detail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(await screen.findByText(item.prompt)).toBeTruthy();
    expect(screen.getByText(/feishu channel test-chat, thread test-thread/)).toBeTruthy();
    expect(detail).toHaveBeenCalledWith(AGENT_ID, SCHEDULE_ID);
  });

  it("opens a deep-linked schedule even when it is outside the loaded page", async () => {
    const item = schedule();
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount(SCHEDULE_ID);
    expect(await screen.findByText(item.prompt)).toBeTruthy();
    expect(screen.getByText("Daily check")).toBeTruthy();
  });

  it("shows an inaccessible old deep link without leaking task content", async () => {
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockRejectedValue(new ApiError(404, "Not found"));

    mount(SCHEDULE_ID);
    expect(await screen.findByText("This schedule no longer exists or is not accessible.")).toBeTruthy();
    expect(screen.queryByText("Full task")).toBeNull();
  });

  it("uses the observed revision for pause and delete", async () => {
    const current = schedule();
    const paused = schedule({ enabled: false, nextTriggerAt: null, revision: 4 });
    vi.spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(current)], nextCursor: null })
      .mockResolvedValue({ items: [summaryOf(paused)], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(paused);
    const pause = vi.spyOn(browserApi, "pauseAgentSchedule").mockResolvedValue(paused);
    const remove = vi.spyOn(browserApi, "deleteAgentSchedule").mockResolvedValue(undefined);

    mount();
    expect(await screen.findByText("Daily check")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith(AGENT_ID, SCHEDULE_ID, 3));
    expect(await screen.findByText("Paused")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(AGENT_ID, SCHEDULE_ID, 4));
  });
});
