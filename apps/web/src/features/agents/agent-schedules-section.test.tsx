import type { AgentSchedule, AgentScheduleListItem } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { overwriteGetLocale } from "../../paraglide/runtime.js";
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
  it.each([
    ["accepted", null],
    ["unreachable", "Couldn’t start"],
    ["rejected", "Trigger refused"],
    ["unknown", "Start unconfirmed"],
    ["skipped", "Skipped"],
  ] as const)("shows only exceptional %s trigger feedback before opening details", async (outcome, label) => {
    const item = schedule({
      lastDispatch: { scheduledFor: TIME, attemptedAt: null, messageId: null, outcome, code: null },
    });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    const detail = vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount();
    await screen.findByRole("button", { name: "Daily check" });
    if (label) expect(screen.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    else expect(screen.queryByText(/Received by the runtime|Latest handoff/)).toBeNull();
    expect(screen.getByRole("img", { name: "Enabled" })).toBeTruthy();
    expect(screen.queryByText(item.prompt)).toBeNull();
    expect(detail).not.toHaveBeenCalled();
  });

  it.each([
    [
      "accepted",
      "The runtime received this occurrence. This does not confirm task completion; check Tasks for progress and results.",
    ],
    ["unreachable", "This occurrence could not reach the runtime. Check the Agent’s Computer status."],
    ["rejected", "The runtime did not accept this occurrence. Check the reason code and the Agent’s Computer status."],
    [
      "unknown",
      "The handoff has not been confirmed yet. The task may have started; check Tasks before starting it again.",
    ],
    ["skipped", "This occurrence was skipped. See the reason code."],
  ] as const)("explains %s without claiming the business task completed", async (outcome, explanation) => {
    const item = schedule({
      lastDispatch: { scheduledFor: TIME, attemptedAt: TIME, messageId: null, outcome, code: "runtime_not_ready" },
    });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Daily check" }));
    const diagnostics = await within(screen.getByRole("dialog")).findByRole("button", { name: /Last trigger/ });
    expect(diagnostics.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(explanation)).toBeNull();
    fireEvent.click(diagnostics);
    expect(await screen.findByText(explanation)).toBeTruthy();
    expect(screen.getByText("runtime_not_ready")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByText("Next scheduled time", { exact: true })).toBeTruthy();
    expect(screen.queryByText("The schedule will not retry this occurrence.") !== null).toBe(outcome !== "accepted");
  });

  it.each(["unreachable", "rejected"] as const)(
    "explains an exhausted one-time %s handoff without implying another occurrence",
    async (outcome) => {
      const item = schedule({
        schedule: { kind: "at", at: TIME },
        nextTriggerAt: null,
        lastDispatch: { scheduledFor: TIME, attemptedAt: TIME, messageId: null, outcome, code: "runtime_not_ready" },
      });
      vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
      vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

      mount();
      expect(await screen.findByText("One-time schedule exhausted")).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: new RegExp(outcome === "unreachable" ? "Couldn’t start" : "Trigger refused"),
        }),
      ).toBeTruthy();
      expect(screen.queryByText("Enabled")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Daily check" }));
      fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /Last trigger/ }));
      expect(await screen.findByText("The schedule will not retry this occurrence.")).toBeTruthy();
      expect(screen.getByText("runtime_not_ready")).toBeTruthy();
      expect(screen.queryByText(/before the next scheduled time|Future occurrences/)).toBeNull();
    },
  );

  it("keeps a past failed handoff visible when the schedule is paused", async () => {
    const item = schedule({
      enabled: false,
      nextTriggerAt: null,
      lastDispatch: { scheduledFor: TIME, attemptedAt: null, messageId: null, outcome: "unreachable", code: null },
    });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    mount();
    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Couldn’t start/ })).toBeTruthy();
    expect(screen.queryByText(/Next scheduled time/)).toBeNull();
  });

  it("keeps the full task behind the Account detail read", async () => {
    const item = schedule();
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    const detail = vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount();
    expect(await screen.findByText("Daily check")).toBeTruthy();
    expect(screen.queryByText(item.prompt)).toBeNull();
    expect(detail).not.toHaveBeenCalled();
    expect(screen.queryByText(/Latest handoff:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Daily check" }));
    expect(await screen.findByText(item.prompt)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Last trigger/ }));
    expect(screen.getByText(/Lark channel test-chat, thread test-thread/)).toBeTruthy();
    expect(detail).toHaveBeenCalledWith(AGENT_ID, SCHEDULE_ID);
  });

  it("opens a deep-linked schedule even when it is outside the loaded page", async () => {
    const item = schedule();
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount(SCHEDULE_ID);
    expect(await screen.findByText(item.prompt)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Daily check" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Actions for Daily check" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith(AGENT_ID, SCHEDULE_ID, 3));
    expect(await screen.findByText("Paused")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Daily check" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(AGENT_ID, SCHEDULE_ID, 4));
  });

  it("retries a failed first read without claiming the list is empty", async () => {
    const item = schedule();
    vi.spyOn(browserApi, "agentSchedules")
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    mount();
    expect(await screen.findByText("Schedules could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("No schedules for this Agent yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Daily check" })).toBeTruthy();
  });

  it("loads the next summary page without fetching either private task", async () => {
    const first = schedule();
    const second = schedule({ id: "next-page-schedule", name: "Weekly review" });
    const list = vi
      .spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(first)], nextCursor: "page-2" })
      .mockResolvedValue({ items: [summaryOf(second)], nextCursor: null });
    const detail = vi.spyOn(browserApi, "agentSchedule");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("button", { name: "Weekly review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Daily check" })).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith(AGENT_ID, { cursor: "page-2" });
    expect(detail).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("preserves loaded summaries and offers recovery when the next page fails", async () => {
    vi.spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(schedule())], nextCursor: "page-2" })
      .mockRejectedValue(new Error("Unavailable"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Schedules could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Daily check" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("prevents overlapping mutations while keeping summary details available", async () => {
    const current = schedule();
    const paused = schedule({ enabled: false, nextTriggerAt: null, revision: 4 });
    const second = schedule({ id: "second", name: "Weekly review" });
    let finish!: (item: AgentSchedule) => void;
    const pause = vi.spyOn(browserApi, "pauseAgentSchedule").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(current), summaryOf(second)], nextCursor: null })
      .mockResolvedValue({ items: [summaryOf(paused), summaryOf(second)], nextCursor: null });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Daily check" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    expect((screen.getByRole("button", { name: "Actions for Weekly review" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Daily check" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Weekly review" }));
    expect(pause).toHaveBeenCalledOnce();
    await act(async () => finish(paused));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Actions for Weekly review" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("keeps a refused delete open, defaults to Cancel and restores the menu trigger", async () => {
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(schedule())], nextCursor: null });
    vi.spyOn(browserApi, "deleteAgentSchedule").mockRejectedValue(new Error("Conflict"));
    mount();
    const trigger = await screen.findByRole("button", { name: "Actions for Daily check" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Daily check" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("refreshes a conflicted deletion and uses the new observed revision on explicit retry", async () => {
    const updated = schedule({ revision: 4, enabled: false, nextTriggerAt: null, name: "Updated check" });
    vi.spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(schedule())], nextCursor: null })
      .mockResolvedValueOnce({ items: [summaryOf(updated)], nextCursor: null })
      .mockResolvedValue({ items: [], nextCursor: null });
    const details = vi.spyOn(browserApi, "agentSchedule");
    const remove = vi
      .spyOn(browserApi, "deleteAgentSchedule")
      .mockRejectedValueOnce(new ApiError(409, "Revision conflict"))
      .mockResolvedValue(undefined);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Daily check" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Updated check" });
    expect(within(dialog).getByRole("alert").textContent).toContain("This schedule changed");
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(remove).toHaveBeenCalledExactlyOnceWith(AGENT_ID, SCHEDULE_ID, 3);
    expect(details).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenLastCalledWith(AGENT_ID, SCHEDULE_ID, 4));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("closes a conflicted deletion if the refreshed list no longer contains its target", async () => {
    vi.spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(schedule())], nextCursor: null })
      .mockResolvedValue({ items: [], nextCursor: null });
    const remove = vi.spyOn(browserApi, "deleteAgentSchedule").mockRejectedValue(new ApiError(409, "Conflict"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Daily check" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Schedules" })));
    expect(remove).toHaveBeenCalledOnce();
  });

  it("blocks deletion after a failed refresh until an explicit read recovers the latest revision", async () => {
    const updated = schedule({ revision: 5 });
    const list = vi
      .spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(schedule())], nextCursor: null })
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ items: [summaryOf(updated)], nextCursor: null });
    const remove = vi.spyOn(browserApi, "deleteAgentSchedule").mockRejectedValue(new ApiError(409, "Conflict"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Daily check" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    const retry = await within(dialog).findByRole("button", { name: "Retry" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(remove).toHaveBeenCalledOnce();
    fireEvent.click(retry);
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(list).toHaveBeenCalledTimes(3);
    fireEvent.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenLastCalledWith(AGENT_ID, SCHEDULE_ID, 5));
  });

  it("returns focus to the section after deleting its last schedule", async () => {
    vi.spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(schedule())], nextCursor: null })
      .mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(browserApi, "deleteAgentSchedule").mockResolvedValue(undefined);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Daily check" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Schedules" })));
    expect(screen.queryByRole("button", { name: "Daily check" })).toBeNull();
  });

  it("closes a private detail when switching Agents and ignores its late result", async () => {
    const item = schedule();
    let finish!: (item: AgentSchedule) => void;
    vi.spyOn(browserApi, "agentSchedules").mockImplementation(async (id) => ({
      items: id === AGENT_ID ? [summaryOf(item)] : [],
      nextCursor: null,
    }));
    vi.spyOn(browserApi, "agentSchedule").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <AgentSchedulesSection agentId={AGENT_ID} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Daily check" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(
      <QueryClientProvider client={client}>
        <AgentSchedulesSection agentId="another-agent" />
      </QueryClientProvider>,
    );
    await act(async () => finish(item));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(item.prompt)).toBeNull();
  });

  it.each([
    ["30 9 * * 1-5", "Weekdays at 9:30 AM"],
    ["0 18 * * *", "Daily at 6:00 PM"],
    ["0 9 * * 1", "Every Monday at 9:00 AM"],
    ["0 9 1 * 1", "Cron: 0 9 1 * 1"],
    ["*/15 9-17 * * 1-5", "Cron: */15 9-17 * * 1-5"],
  ])("describes %s without guessing complex cron semantics", async (expression, label) => {
    const item = schedule({ schedule: { kind: "cron", expression } });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);
    mount();
    expect(await screen.findByText(label)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Daily check" }));
    expect(
      await within(screen.getByRole("dialog")).findByText((text) => text === `${label} · Asia/Shanghai`),
    ).toBeTruthy();
  });
});

it("shows next time relatively, refreshes it without reading private details and expands long instructions explicitly", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-10-26T08:00:00Z").getTime());
  const interval = vi.spyOn(window, "setInterval");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
  const item = schedule({ nextTriggerAt: "2026-10-26T10:00:00Z", prompt: "Check the build. ".repeat(50) });
  vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
  const detail = vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);
  mount();
  expect(await screen.findByText("Next in 2 hours")).toBeTruthy();
  expect(screen.queryByText(item.prompt)).toBeNull();
  expect(detail).not.toHaveBeenCalled();
  const tick = interval.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
  expect(typeof tick).toBe("function");
  clock.mockReturnValue(new Date("2026-10-26T09:00:00Z").getTime());
  act(() => {
    if (typeof tick === "function") tick();
  });
  expect(screen.getByText("Next in 1 hour")).toBeTruthy();
  expect(detail).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Daily check" }));
  const expand = await screen.findByRole("button", { name: "Show full instructions" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(expand);
  expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  expect(within(screen.getByRole("dialog")).getByText("Every 1 minute · Asia/Shanghai")).toBeTruthy();
  expect(screen.getByText("Lark conversation thread")).toBeTruthy();
  expect(screen.queryByText(/test-chat/)).toBeNull();
});

it.each([
  ["2026-10-26T08:00:30Z", "Due now"],
  ["2026-10-26T08:20:00Z", "Next in 20 minutes"],
  ["2026-10-28T08:00:00Z", "Next in 2 days"],
  ["2026-10-26T07:58:00Z", "Was due 2 minutes ago"],
])("labels the observed next occurrence %s as %s without fetching its prompt", async (nextTriggerAt, label) => {
  vi.spyOn(Date, "now").mockReturnValue(new Date("2026-10-26T08:00:00Z").getTime());
  const item = schedule({ nextTriggerAt });
  vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
  const detail = vi.spyOn(browserApi, "agentSchedule");
  mount();
  expect(await screen.findByText(label)).toBeTruthy();
  expect(detail).not.toHaveBeenCalled();
});

it("describes a Slack conversation without inventing its name and keeps identifiers in diagnostics", async () => {
  const item = schedule({
    target: {
      sessionId: TARGET_ID,
      provider: "slack",
      sessionKind: "channel",
      channelId: "example-chat",
      threadKey: null,
    },
  });
  vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
  vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Daily check" }));
  expect(await screen.findByText("Slack conversation")).toBeTruthy();
  expect(screen.queryByText(/example-chat/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Last trigger/ }));
  expect(screen.getByText("Slack channel example-chat")).toBeTruthy();
});

it("revalidates each due occurrence once and follows the server's next time without private reads", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-26T08:00:00Z"));
  const interval = vi.spyOn(window, "setInterval");
  const first = schedule({ nextTriggerAt: "2026-10-26T08:01:00Z" });
  const advanced = schedule({
    nextTriggerAt: "2026-10-26T08:04:00Z",
    lastDispatch: {
      scheduledFor: "2026-10-26T08:01:00Z",
      attemptedAt: "2026-10-26T08:01:00Z",
      outcome: "accepted",
      code: null,
      messageId: null,
    },
  });
  const list = vi
    .spyOn(browserApi, "agentSchedules")
    .mockResolvedValueOnce({ items: [summaryOf(first)], nextCursor: null })
    .mockResolvedValue({ items: [summaryOf(advanced)], nextCursor: null });
  const detail = vi.spyOn(browserApi, "agentSchedule");
  mount();
  await screen.findByText("Next in 1 minute");
  const tick = interval.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
  const advance = async (time: string) => {
    clock.mockReturnValue(Date.parse(time));
    await act(async () => {
      if (typeof tick === "function") tick();
    });
  };
  await advance("2026-10-26T08:01:00Z");
  await screen.findByText("Next in 3 minutes");
  expect(list).toHaveBeenCalledTimes(2);
  await advance("2026-10-26T08:02:00Z");
  expect(list).toHaveBeenCalledTimes(2);
  await advance("2026-10-26T08:04:00Z");
  expect(list).toHaveBeenCalledTimes(3);
  await advance("2026-10-26T08:05:00Z");
  await advance("2026-10-26T08:06:00Z");
  expect(list).toHaveBeenCalledTimes(3);
  expect(screen.getByText("Was due 2 minutes ago")).toBeTruthy();
  expect(detail).not.toHaveBeenCalled();
});

it("retains summaries after a failed due refresh and recovers only on explicit retry", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-26T08:00:00Z"));
  const interval = vi.spyOn(window, "setInterval");
  const first = schedule({ nextTriggerAt: "2026-10-26T08:01:00Z" });
  const list = vi
    .spyOn(browserApi, "agentSchedules")
    .mockResolvedValueOnce({ items: [summaryOf(first)], nextCursor: null })
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue({ items: [summaryOf(schedule({ nextTriggerAt: "2026-10-26T09:00:00Z" }))], nextCursor: null });
  const detail = vi.spyOn(browserApi, "agentSchedule");
  mount();
  await screen.findByText("Next in 1 minute");
  const tick = interval.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
  clock.mockReturnValue(Date.parse("2026-10-26T08:02:00Z"));
  await act(async () => {
    if (typeof tick === "function") tick();
  });
  await screen.findByText("Schedules could not be loaded.");
  expect(screen.getByRole("button", { name: "Daily check" })).toBeTruthy();
  clock.mockReturnValue(Date.parse("2026-10-26T08:03:00Z"));
  await act(async () => {
    if (typeof tick === "function") tick();
  });
  expect(list).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Next in 57 minutes");
  expect(list).toHaveBeenCalledTimes(3);
  expect(detail).not.toHaveBeenCalled();
});

it("does not refresh paused occurrences on the minute tick", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-26T08:00:00Z"));
  const interval = vi.spyOn(window, "setInterval");
  const list = vi
    .spyOn(browserApi, "agentSchedules")
    .mockResolvedValue({ items: [summaryOf(schedule({ enabled: false }))], nextCursor: null });
  mount();
  await screen.findByText("Paused");
  expect(screen.queryByRole("img", { name: "Paused" })).toBeNull();
  const tick = interval.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
  clock.mockReturnValue(Date.parse("2026-10-26T10:00:00Z"));
  await act(async () => {
    if (typeof tick === "function") tick();
  });
  expect(list).toHaveBeenCalledTimes(1);
});

it("offers expansion only when instructions overflow and responds to layout changes", async () => {
  let resize: (() => void) | undefined;
  const OriginalObserver = globalThis.ResizeObserver;
  class LayoutObserver extends OriginalObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      resize = () => callback([], this);
    }
  }
  vi.stubGlobal("ResizeObserver", LayoutObserver);
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  const item = schedule({
    prompt: "Instructions that are longer than sixty characters but fit in the dialog at its current width.",
  });
  vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
  vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);
  try {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Daily check" }));
    await screen.findByText(item.prompt);
    expect(screen.queryByRole("button", { name: "Show full instructions" })).toBeNull();
    height.mockReturnValue(120);
    act(() => resize?.());
    fireEvent.click(screen.getByRole("button", { name: "Show full instructions" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    height.mockReturnValue(40);
    act(() => resize?.());
    expect(screen.queryByRole("button", { name: "Show full instructions" })).toBeNull();
  } finally {
    vi.stubGlobal("ResizeObserver", OriginalObserver);
  }
});

it("uses the Chinese messaging brand in both destination context and diagnostics", async () => {
  overwriteGetLocale(() => "zh");
  const item = schedule();
  vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
  vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);
  try {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Daily check" }));
    expect(await screen.findByText("飞书 会话话题")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /上次触发/ }));
    expect(screen.getByText("飞书 频道 test-chat，话题 test-thread")).toBeTruthy();
  } finally {
    overwriteGetLocale(() => "en");
  }
});
