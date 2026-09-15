import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskActivityTimeline } from "./task-activity-timeline.js";

afterEach(() => vi.restoreAllMocks());

function history(ids: string[], { more = true, taskId = "task-a" } = {}) {
  return (
    <main data-ui="content">
      <TaskActivityTimeline key={taskId} oldestDeliveryId={ids[0]}>
        {more ? <button type="button">Load earlier activity</button> : null}
        {ids.map((id) => (
          <section key={id} data-ui="task-exchange">
            <article data-ui="task-message-request">{id}</article>
          </section>
        ))}
      </TaskActivityTimeline>
    </main>
  );
}

function measureHistory() {
  const viewport = screen.getByRole("main");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === viewport) return { top: 0, bottom: 400 } as DOMRect;
    const exchange = this.closest('[data-ui="task-exchange"]') ?? this;
    const index = [...viewport.querySelectorAll('[data-ui="task-exchange"]')].indexOf(exchange);
    const controlHeight = screen.queryByRole("button") ? 50 : 0;
    // TaskTurnView removes top padding only from the first exchange. Once older history is
    // prepended, its message gains that padding even when the exchange's outer edge is anchored.
    const padding = this !== exchange && index > 0 ? 24 : 0;
    const top = controlHeight + index * 200 + padding - viewport.scrollTop;
    return { top, bottom: top + 200 } as DOMRect;
  });
  return viewport;
}

it.each([true, false])("preserves the visible exchange when prepending history (more pages: %s)", (more) => {
  const view = render(history(["3", "4", "5"]));
  const viewport = measureHistory();
  // The viewer can move while a request is pending; use the position immediately before the update.
  viewport.scrollTop = 300;
  const before = screen.getByText("4").getBoundingClientRect().top;

  view.rerender(history(["1", "2", "3", "4", "5"], { more }));

  expect(screen.getByText("4").getBoundingClientRect().top).toBe(before);
  expect(viewport.scrollTop).toBe(more ? 700 : 650);
});

it("preserves the message when the previous first exchange gains top padding", () => {
  const view = render(history(["3", "4", "5"]));
  const viewport = measureHistory();
  viewport.scrollTop = 100;
  const before = screen.getByText("3").getBoundingClientRect().top;
  view.rerender(history(["1", "2", "3", "4", "5"]));
  expect(screen.getByText("3").getBoundingClientRect().top).toBe(before);
});

it("keeps the reading position when a new exchange arrives at the bottom", () => {
  const view = render(history(["1", "2", "3"]));
  const viewport = measureHistory();
  viewport.scrollTop = 250;
  view.rerender(history(["1", "2", "3", "4"]));
  expect(viewport.scrollTop).toBe(250);
});

it("does not carry a scroll adjustment across Tasks", () => {
  const view = render(history(["3", "4", "5"]));
  const viewport = measureHistory();
  viewport.scrollTop = 300;
  view.rerender(history(["1", "2", "3", "4", "5"], { taskId: "task-b" }));
  expect(viewport.scrollTop).toBe(300);
});

it("does not jump when the conversation is below the viewport", () => {
  const view = render(history(["3", "4", "5"]));
  const viewport = screen.getByRole("main");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === viewport) return { top: 0, bottom: 400 } as DOMRect;
    const exchange = this.closest('[data-ui="task-exchange"]') ?? this;
    const index = [...viewport.querySelectorAll('[data-ui="task-exchange"]')].indexOf(exchange);
    const top = 700 + index * 200 - viewport.scrollTop;
    return { top, bottom: top + 200 } as DOMRect;
  });
  view.rerender(history(["1", "2", "3", "4", "5"]));
  expect(viewport.scrollTop).toBe(0);
});
