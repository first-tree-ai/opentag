import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TaskDetailPage, TasksPage } from "./tasks-page.js";

describe("Tasks demo", () => {
  it("renders the minimal Work, Source, and Activity list in English", () => {
    const { container } = render(
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Work",
      "Source",
      "Activity",
    ]);
    expect(screen.getAllByRole("row")).toHaveLength(7);
    expect(screen.getAllByText(/^Feishu ·/)).toHaveLength(3);
    expect(screen.getByText(/^Email ·/)).toBeTruthy();
    expect(screen.getByText(/^GitHub ·/)).toBeTruthy();
    expect(screen.getByText(/^Jira ·/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("filters demo Tasks by source and search text", () => {
    render(
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Filter by source"), { target: { value: "github" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("opentag/web #123")).toBeTruthy();
    expect(screen.queryByText("Product Launch")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter by source"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search Tasks"), { target: { value: "security questionnaire" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("security@northstar.example")).toBeTruthy();
  });

  it("shows a compact empty result state", () => {
    render(
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Search Tasks"), { target: { value: "no matching task" } });
    expect(screen.getByRole("heading", { name: "No Tasks found" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders the request and Agent response as a conversation", () => {
    render(
      <MemoryRouter initialEntries={["/tasks/q3-launch-readiness"]}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Launch plan reviewed" })).toBeTruthy();
    expect(screen.getByLabelText("Task source").textContent).toContain("Product Launch");
    const conversation = screen.getByLabelText("Task conversation");
    expect(within(conversation).getAllByText("Mia Zhang")).toHaveLength(2);
    expect(
      within(conversation).getByText(
        "Please review the Q3 launch plan and call out anything that is still unowned or missing a confirmed date.",
      ),
    ).toBeTruthy();
    expect(within(conversation).getByText("Opened the launch brief")).toBeTruthy();
    expect(
      within(conversation).getByText(
        "Please turn the three unresolved items into follow-ups and tag the likely owners.",
      ),
    ).toBeTruthy();
    expect(within(conversation).getByRole("heading", { name: "Follow-ups drafted" })).toBeTruthy();
    expect(within(conversation).getAllByText("Delivered to Product Launch")).toHaveLength(2);
    const work = screen.getByText("2 actions · Feishu · Google Drive · 8m 12s").closest("details");
    const taskDetails = screen.getByText("Task details").closest("details");
    expect(work?.hasAttribute("open")).toBe(false);
    expect(taskDetails?.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("does not turn unavailable provider tokens into zero", () => {
    render(
      <MemoryRouter initialEntries={["/tasks/jira-onboarding-coverage"]}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const details = screen.getByText("Task details").closest("details");
    expect(details).toBeTruthy();
    const tokens = within(details as HTMLElement).getByText("Tokens").parentElement;
    expect(tokens?.textContent).toBe("TokensUnavailable");
    expect(
      screen.getByText("The Task record is incomplete because the final provider response was not received."),
    ).toBeTruthy();
  });
});
