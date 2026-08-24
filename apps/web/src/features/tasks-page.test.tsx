import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TaskDetailPage, TasksPage } from "./tasks-page.js";

describe("Tasks demo", () => {
  it("renders the minimal Feishu-only Task list in English", () => {
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
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getAllByText(/^Feishu ·/)).toHaveLength(3);
    expect(screen.queryByLabelText("Filter by source")).toBeNull();
    expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("filters demo Tasks by Agent, status, and search text", () => {
    render(
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Filter by Agent"), { target: { value: "Scout" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Customer Feedback")).toBeTruthy();
    expect(screen.queryByText("Product Launch")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter by Agent"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "needs_attention" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Engineering Collaboration")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search Tasks"), { target: { value: "confirmed date" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Product Launch")).toBeTruthy();
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

  it("renders each request, provider event stream, and final answer in order", () => {
    render(
      <MemoryRouter initialEntries={["/tasks/q3-launch-readiness"]}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Demo data")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Feishu" }).getAttribute("href")).toBe("https://www.feishu.cn/");
    expect(screen.getByLabelText("Task source").textContent).toContain("Product Launch");

    const conversation = screen.getByLabelText("Task conversation");
    expect(within(conversation).getAllByText("Mia Zhang")).toHaveLength(2);
    expect(
      within(conversation).getByText(
        "Please review the Q3 launch plan and call out anything that is still unowned or missing a confirmed date.",
      ),
    ).toBeTruthy();
    expect(within(conversation).getByText("Read 2 sources")).toBeTruthy();
    expect(within(conversation).getByText("Read the Product Launch thread")).toBeTruthy();
    expect(within(conversation).getByText("Opened the Q3 launch brief")).toBeTruthy();
    expect(within(conversation).getByText("Searched 12 Feishu messages")).toBeTruthy();
    expect(
      within(conversation).getByText(
        "The checklist and brief disagree on three items. I’m checking the recent thread before treating any owner or date as confirmed.",
      ),
    ).toBeTruthy();
    expect(
      within(conversation).getByText(
        "Three follow-up messages were prepared with suggested owners. No ownership was recorded as confirmed.",
      ),
    ).toBeTruthy();
    expect(within(conversation).getByText("Partner announcement — Suggested owner: Jordan Lee")).toBeTruthy();
    expect(
      within(conversation).getAllByText(/Recorded locally at .*Open Feishu for the authoritative thread/),
    ).toHaveLength(2);
    expect(within(conversation).queryByText(/Turn \d/u)).toBeNull();
    expect(within(conversation).queryByText(/Chain of Thought/i)).toBeNull();

    const process = within(conversation).getByText("Worked for 8m 12s").closest("details");
    const finalAnswer = within(conversation).getByText(
      "Eight items were checked. Five are ready, two still need owners, and one has no confirmed date.",
    );
    expect(process).toBeTruthy();
    if (!process) throw new Error("Expected the Agent process details");
    expect(process.hasAttribute("open")).toBe(false);
    expect(process.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(process).getByText("3 tool calls · 0 retries · 14.2K tokens")).toBeTruthy();
    const sourceGroup = within(process).getByText("Read 2 sources").closest("details");
    expect(sourceGroup?.hasAttribute("open")).toBe(true);
    const threadCall = within(process).getByText("Read the Product Launch thread").closest("details");
    expect(threadCall?.hasAttribute("open")).toBe(false);
    fireEvent.click(within(threadCall as HTMLElement).getByText("Read the Product Launch thread"));
    expect(threadCall?.hasAttribute("open")).toBe(true);
    expect(within(threadCall as HTMLElement).getByText("18 messages read")).toBeTruthy();
    expect(within(conversation).getByText("Partner announcement copy — Needs owner")).toBeTruthy();
    expect(within(conversation).getByText("Security review sign-off — Date unconfirmed")).toBeTruthy();
    expect(within(conversation).queryByText("Launch plan reviewed")).toBeNull();
    expect(within(conversation).queryByText("Follow-ups drafted")).toBeNull();
    expect(screen.queryByText("Task details")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows live provider events without inventing a final answer or zero usage", () => {
    render(
      <MemoryRouter initialEntries={["/tasks/customer-visit-feedback"]}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const process = screen.getByText("Working").closest("details");
    expect(process?.hasAttribute("open")).toBe(true);
    expect(within(process as HTMLElement).getByText("2 tool calls · 0 retries · 6.4K input")).toBeTruthy();
    expect(within(process as HTMLElement).getAllByText("In progress")).toHaveLength(1);
    expect(screen.queryByText(/0 output/)).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("keeps provider attention and retry state attached to the execution that produced it", () => {
    render(
      <MemoryRouter initialEntries={["/tasks/onboarding-document-review"]}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const process = screen.getByText("Worked for 11m 03s").closest("details");
    expect(within(process as HTMLElement).getAllByText("Needs attention")).toHaveLength(1);
    expect(within(process as HTMLElement).getByText("2 tool calls · 1 retry · 18.6K tokens")).toBeTruthy();
    expect(
      screen.getByText(
        "The review is paused because the access checklist and security orientation steps are not available.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Access provisioning checklist — Missing input")).toBeTruthy();
  });
});
