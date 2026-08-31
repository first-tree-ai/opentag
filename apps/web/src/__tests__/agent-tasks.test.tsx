import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  agentId,
  installApi,
  json,
  openAccountMenu,
  resetWebAppState,
  taskSessionId,
  taskSummary,
} from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("keeps the loaded Tasks when loading the next page fails", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).startsWith("/api/v1/sessions?") && String(input).includes("cursor=")) {
        return json({ error: { code: "INTERNAL_ERROR", category: "transient", message: "Paging failed" } }, 500);
      }
      if (String(input) === "/api/v1/sessions" || String(input).startsWith("/api/v1/sessions?")) {
        return json({ tasks: [taskSummary], nextCursor: "cursor-2" });
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    const task = await screen.findByRole("link", { name: "Investigate the failed deployment" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    // A failed append reports itself; it does not throw away the rows the viewer already has.
    expect(await screen.findByText("Could not load more Tasks.")).toBeTruthy();
    expect(task.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Tasks are temporarily unavailable.")).toBeNull();
  });

  it("shows stored Tasks and opens a Task detail", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/tasks`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByText("Read-only debug view")).toBeNull();
    const task = await screen.findByRole("link", {
      name: "Investigate the failed deployment",
    });
    fireEvent.click(task);
    expect(await screen.findByText("Stored runtime output")).toBeTruthy();
    expect(screen.getByLabelText("Task details").textContent).toContain("Reviewer");
    expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/tasks/${taskSessionId}`);
  });

  it("opens a Task detail as a read-only activity record", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/tasks/${taskSessionId}`);
    render(<App />);

    expect(await screen.findByText("Stored runtime output")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(screen.queryByText("Read-only debug view")).toBeNull();
    expect(screen.queryByText("Runtime details")).toBeNull();
  });

  it.each(["/settings", "/settings/members", "/members", "/teams"])(
    "does not preserve removed Team/member settings route %s",
    async (path) => {
      installApi();
      window.history.replaceState({}, "", path);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
      expect(window.location.pathname).toBe(path);
    },
  );

  it("keeps Skills and Integrations reachable from the object navigation", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/skills`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Demo Integrations" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/integrations`);
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("sends no management scope even when the Account holds several memberships", async () => {
    installApi({ multipleMemberships: true });
    window.history.replaceState({}, "", "/agents");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(getItem).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path) === "/api/v1/agents")).toBe(true),
    );
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes("/api/v1/workspaces/"))).toBe(false);
    getItem.mockRestore();
  });

  it("keeps Workspace management and switching out of the account menu", async () => {
    installApi({ multipleMemberships: true });
    render(<App />);
    const { menu } = await openAccountMenu();

    // The absence checks only mean something once the menu itself is on screen.
    expect(within(menu).getByRole("menuitem", { name: "Account" })).toBeTruthy();
    expect(within(menu).queryByRole("group", { name: "Workspaces" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Workspace" })).toBeNull();
    expect(within(menu).queryByText("Secondary")).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Computers" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Admins" })).toBeNull();
  });
});
