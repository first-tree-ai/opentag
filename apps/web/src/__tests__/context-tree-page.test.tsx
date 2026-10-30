import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { App } from "../app.js";
import * as queryModule from "../query/client.js";
import { queryKeys } from "../query/keys.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);
  afterEach(() => vi.restoreAllMocks());

  it("opens the Agent's Context Tree from its own navigation entry, outside Settings", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/context-tree`);
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Memory" })).toBeTruthy();
    const navigation = await screen.findByRole("navigation", { name: "Agent" });
    const entry = within(navigation).getByRole("link", { name: "Memory" });
    expect(entry.getAttribute("href")).toBe(`/agents/${agentId}/context-tree`);
    expect(entry.getAttribute("aria-current")).toBe("page");
  });

  it("keeps the Memory heading and offers retry for a failed initial settings read", async () => {
    installApi({ bound: true });
    const read = vi.spyOn(browserApi, "agentConfig").mockRejectedValue(new Error("Temporary settings read failure"));
    window.history.replaceState({}, "", `/agents/${agentId}/context-tree`);
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Memory" })).toBeTruthy();
    expect(await screen.findByText("Memory settings could not be loaded.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No Context Trees yet" })).toBeNull();
    read.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Connect Context Tree" })).toBeTruthy();
  });

  it("preserves the open draft through a transient refresh failure and reenables writes after recovery", async () => {
    installApi({ bound: true });
    const client = queryModule.createQueryClient();
    vi.spyOn(queryModule, "createQueryClient").mockReturnValue(client);
    window.history.replaceState({}, "", `/agents/${agentId}/context-tree`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Context Tree" }));
    const input = screen.getByRole("textbox", { name: "GitHub repository link" });
    fireEvent.change(input, { target: { value: "https://github.com/example/preserved-draft" } });
    const read = vi.spyOn(browserApi, "agentConfig").mockRejectedValue(new Error("Transient refresh failure"));
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.agents.config(agentId) });
    });
    expect((screen.getByRole("textbox", { name: "GitHub repository link" }) as HTMLInputElement).value).toBe(
      "https://github.com/example/preserved-draft",
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true),
    );
    const heading = document.querySelector<HTMLElement>('[data-ui="page-header"] h1');
    const notice = screen.getByText("Transient refresh failure");
    expect(heading).toBeTruthy();
    if (!heading) throw new Error("Memory heading was not rendered");
    expect(heading.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    read.mockRestore();
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.agents.config(agentId) });
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect((screen.getByRole("textbox", { name: "GitHub repository link" }) as HTMLInputElement).value).toBe(
      "https://github.com/example/preserved-draft",
    );
  });

  it("hides an open settings draft after a terminal authorization refusal", async () => {
    installApi({ bound: true });
    const client = queryModule.createQueryClient();
    vi.spyOn(queryModule, "createQueryClient").mockReturnValue(client);
    window.history.replaceState({}, "", `/agents/${agentId}/context-tree`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Context Tree" }));
    vi.spyOn(browserApi, "agentConfig").mockRejectedValue(new ApiError(403, "Forbidden"));
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.agents.config(agentId) });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("textbox", { name: "GitHub repository link" })).toBeNull();
    expect(screen.getByText("Memory settings could not be loaded.")).toBeTruthy();
  });
});
