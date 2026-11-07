import type { AgentSchedule, AgentScheduleListItem } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { AgentSchedulesSection } from "./agent-schedules-section.js";
import { shortScheduleTime } from "./schedule-rule.js";

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
    ["accepted", null, null, ""],
    ["unreachable", null, "text-kumo-danger", "didn't run: the computer was offline"],
    ["rejected", null, "text-kumo-danger", "didn't run: the Agent didn't accept it"],
    ["skipped", "late", "text-kumo-danger", "didn't run: the time was missed"],
    ["rejected", "agent_suspended", "text-kumo-danger", "didn't run: the Agent was paused"],
    ["unknown", null, "text-kumo-warning", "not confirmed"],
    ["accepted", "provider_process_exited", "text-kumo-danger", "failed"],
  ] as const)("says what happened to a %s (%s) last run in the reader's terms", async (outcome, code, tone, suffix) => {
    const item = schedule({
      lastDispatch: { scheduledFor: TIME, attemptedAt: null, messageId: null, outcome, code },
    });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    const detail = vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount();
    const time = shortScheduleTime(TIME, item.timezone);
    expect(await screen.findByText(time)).toBeTruthy();
    const last = screen.getByText(time).parentElement;
    expect(last?.textContent).toBe(suffix ? `Last ${time} ${suffix}` : `Last ${time}`);
    if (tone) expect(last?.classList.contains(tone)).toBe(true);
    else expect(last?.className).toBe("");
    expect(screen.getByText("Every minute")).toBeTruthy();
    // Running on schedule is the default state, so it carries no label.
    expect(screen.queryByText("Enabled")).toBeNull();
    expect(screen.queryByText(item.prompt)).toBeNull();
    expect(detail).not.toHaveBeenCalled();
  });

  it("names why a delivered Run failed in its detail, for the IM failure message's link", async () => {
    const item = schedule({
      lastDispatch: {
        scheduledFor: TIME,
        attemptedAt: TIME,
        messageId: null,
        outcome: "accepted",
        code: "provider_process_exited",
      },
    });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Daily check" }));
    const note = await screen.findByText(
      "This Run failed with code provider_process_exited. It won't be rerun; the next run follows the schedule.",
    );
    // A stable reason can be 64 characters with no space to break at.
    expect(note.classList.contains("wrap-anywhere")).toBe(true);
    expect(m.agents_schedules_run_failed_note({ code: "x", next: "不会补跑。" }, { locale: "zh" })).toBe(
      "这次运行失败，错误代码 x。不会补跑。",
    );
  });

  it.each([
    ["unreachable", "It won't be rerun; the next run follows the schedule."],
    ["rejected", "It won't be rerun; the next run follows the schedule."],
    ["skipped", "It won't be rerun; the next run follows the schedule."],
    ["unknown", "It may have started. Check Tasks before starting it again."],
  ] as const)("adds only what the row does not say for a %s last run", async (outcome, note) => {
    const item = schedule({
      lastDispatch: { scheduledFor: TIME, attemptedAt: TIME, messageId: null, outcome, code: "runtime_not_ready" },
    });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Daily check" }));
    expect(await screen.findByText(item.prompt)).toBeTruthy();
    expect(screen.getByText("Lark · thread")).toBeTruthy();
    if (note) expect(screen.getByText(note)).toBeTruthy();
    expect(screen.queryByText("runtime_not_ready")).toBeNull();
    expect(screen.queryByText(/test-chat|test-thread/)).toBeNull();
    expect(screen.queryByText("Next scheduled time")).toBeNull();
  });

  it.each(["unreachable", "rejected"] as const)(
    "does not promise another run after an exhausted one-time %s occurrence",
    async (outcome) => {
      const item = schedule({
        schedule: { kind: "at", at: TIME },
        nextTriggerAt: null,
        lastDispatch: { scheduledFor: TIME, attemptedAt: TIME, messageId: null, outcome, code: null },
      });
      vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
      vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

      mount();
      expect(await screen.findByText("Finished")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Daily check" }));
      expect(await screen.findByText("It won't be rerun.")).toBeTruthy();
      expect(screen.queryByText(/next run/)).toBeNull();
    },
  );

  it("labels a paused schedule and keeps its past failed run visible", async () => {
    const item = schedule({
      enabled: false,
      nextTriggerAt: null,
      lastDispatch: { scheduledFor: TIME, attemptedAt: null, messageId: null, outcome: "unreachable", code: null },
    });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    mount();
    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByText(/didn't run: the computer was offline$/)).toBeTruthy();
    expect(screen.queryByText(/^Next /)).toBeNull();
  });

  it("names the internal Session a schedule belongs to, in the row and in its details", async () => {
    const item = schedule({ target: { ...schedule().target, internal: true } });
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);
    mount();
    expect(await screen.findByText(`Internal Session ${TARGET_ID.slice(0, 8)}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Daily check" }));
    expect(await screen.findByText(`Internal Session ${TARGET_ID}`)).toBeTruthy();
    expect(screen.queryByText("Feishu · thread")).toBeNull();
  });

  it("keeps the full task behind the Account detail read", async () => {
    const item = schedule();
    vi.spyOn(browserApi, "agentSchedules").mockResolvedValue({ items: [summaryOf(item)], nextCursor: null });
    const detail = vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(item);

    mount();
    expect(await screen.findByText("Daily check")).toBeTruthy();
    expect(screen.queryByText(item.prompt)).toBeNull();
    expect(detail).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Last /)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Daily check" }));
    expect(await screen.findByText(item.prompt)).toBeTruthy();
    expect(screen.getByText("Lark · thread")).toBeTruthy();
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

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show details" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Daily check" }));
    expect(screen.getByRole("button", { name: "Daily check" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(AGENT_ID, SCHEDULE_ID, 4));
  });

  it("keeps keyboard focus on the control when Pause turns into Resume", async () => {
    const current = schedule();
    const paused = schedule({ enabled: false, nextTriggerAt: null, revision: 4 });
    vi.spyOn(browserApi, "agentSchedules")
      .mockResolvedValueOnce({ items: [summaryOf(current)], nextCursor: null })
      .mockResolvedValue({ items: [summaryOf(paused)], nextCursor: null });
    vi.spyOn(browserApi, "agentSchedule").mockResolvedValue(paused);
    let settle: (value: typeof paused) => void = () => undefined;
    vi.spyOn(browserApi, "pauseAgentSchedule").mockImplementation(
      () => new Promise((resolve) => (settle = resolve)) as never,
    );

    mount();
    const button = await screen.findByRole("button", { name: "Pause" });
    button.focus();
    fireEvent.click(button);
    // Still enabled and focused while the change is pending, so focus never falls to the page.
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    settle(paused);
    expect(await screen.findByRole("button", { name: "Resume" })).toBe(document.activeElement);
  });
});
