import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { App } from "../app.js";
import { readSoul, replaceSoul } from "./soul-editor.js";
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
    fireEvent.click(screen.getByRole("button", { name: "write your own" }));
    const editor = screen.getByRole("textbox", { name: "Soul" });
    replaceSoul(editor, "Be concise.");
    fireEvent.click(within(navigation).getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("dialog", { name: "Discard your changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(readSoul(editor)).toBe("Be concise.");
    fireEvent.click(within(navigation).getByRole("link", { name: "Overview" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard your changes?" });
    expect(within(dialog).getByText("Your edits will be lost if you leave.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Discard and leave" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved. Changes take effect with the next response.")).toBeTruthy();
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

  it.each(["pristine", "boundary-only"])("does not block leaving a %s editing session", async (kind) => {
    installApi({ bound: true });
    const config = await browserApi.agentConfig(agentId);
    vi.spyOn(browserApi, "agentConfig").mockResolvedValue({
      ...config,
      runtimeConfig: { ...config.runtimeConfig, instructions: "Keep this rule.\r\n\r\nAnother rule." },
    });
    window.history.replaceState({}, "", `/agents/${agentId}/instructions`);
    render(<App />);
    const editor = await screen.findByRole("textbox", { name: "Soul" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    if (kind === "boundary-only") replaceSoul(editor, "\n\nKeep this rule.\n\nAnother rule.\n\n");
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
    const navigation = screen.getByRole("navigation", { name: "Agent" });
    fireEvent.click(within(navigation).getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Reviewer" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Discard your changes?" })).toBeNull();
  });
});
