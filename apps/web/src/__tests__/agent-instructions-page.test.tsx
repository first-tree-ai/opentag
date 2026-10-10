import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { App } from "../app.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("Agent Soul page", () => {
  beforeEach(resetWebAppState);
  afterEach(() => vi.restoreAllMocks());

  it("opens from the sidebar, protects the draft, and saves instructions independently", async () => {
    installApi({ bound: true });
    const config = await browserApi.agentConfig(agentId);
    const save = vi.spyOn(browserApi, "updateAgent").mockResolvedValue({
      ...config,
      revision: config.revision + 1,
      runtimeConfig: {
        ...config.runtimeConfig,
        instructions: "Be concise.",
        revision: config.runtimeConfig.revision + 1,
      },
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    const navigation = await screen.findByRole("navigation", { name: "Agent" });
    fireEvent.click(within(navigation).getByRole("link", { name: "Soul" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Soul" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/instructions`);
    expect(within(navigation).getByRole("link", { name: "Soul" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("heading", { name: "Model" })).toBeNull();
    const editor = screen.getByRole("textbox", { name: "Soul" });
    fireEvent.change(editor, { target: { value: "Be concise." } });
    fireEvent.click(within(navigation).getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("dialog", { name: "Discard your changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((editor as HTMLTextAreaElement).value).toBe("Be concise.");
    fireEvent.click(within(navigation).getByRole("link", { name: "Overview" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard your changes?" });
    expect(within(dialog).getByText("Your edits will be lost if you leave.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Discard and leave" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByText("Changes applied.")).toBeTruthy();
    expect(save).toHaveBeenCalledWith(agentId, {
      expectedRevision: config.revision,
      runtimeConfig: { instructions: "Be concise." },
    });
    fireEvent.click(within(navigation).getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Reviewer" })).toBeTruthy();
  });

  it("redirects existing Settings instruction links to the dedicated page", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/instructions`);
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Soul" })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}/instructions`));
    expect(screen.queryByRole("link", { name: "Back to Agent settings" })).toBeNull();
  });
});
