import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { App } from "../app.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("Agent Instructions page", () => {
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
    fireEvent.click(within(navigation).getByRole("link", { name: "Instructions" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Instructions" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/instructions`);
    expect(within(navigation).getByRole("link", { name: "Instructions" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("heading", { name: "Model" })).toBeNull();
    const editor = screen.getByRole("textbox", { name: "Instructions" });
    fireEvent.change(editor, { target: { value: "Be concise." } });
    fireEvent.click(within(navigation).getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((editor as HTMLTextAreaElement).value).toBe("Be concise.");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Instructions saved.")).toBeTruthy();
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
    expect(await screen.findByRole("heading", { level: 1, name: "Instructions" })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}/instructions`));
    expect(screen.queryByRole("link", { name: "Back to Agent settings" })).toBeNull();
  });
});
