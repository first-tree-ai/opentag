import type { AgentAdminConfig } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../../api.js";
import { GeneralConfigForm } from "./general-config-form.js";

const config: AgentAdminConfig = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  createdByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  selfConfigurationEnabled: false,
  status: "active",
  revision: 4,
  runtimeConfig: {
    permissions: { approvalPolicy: "on-request", allowCommands: [] },
    contextTrees: [],
    revision: 7,
    model: null,
    reasoningEffort: null,
    instructions: "Review carefully.",
    maxDurationMs: 45_500,
  },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

describe("GeneralConfigForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves and discards a changed display name", async () => {
    const updated = { ...config, displayName: "Reviewer Bot", revision: 5 };
    const updateAgent = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    const onAgentChanged = vi.fn();
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={onAgentChanged} />);

    expect(screen.getByRole("heading", { name: "Name" }).closest("form")).toBeNull();
    const displayName = screen.getByLabelText("Display name");
    expect(displayName.parentElement?.className).toContain("[&>input]:w-full");
    const form = displayName.closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    expect(updateAgent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Reviewer Bot" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Reviewer");

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Reviewer Bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledOnce());
    expect(updateAgent).toHaveBeenCalledWith(config.id, { expectedRevision: 4, displayName: "Reviewer Bot" });
    expect((await screen.findByRole("status")).textContent).toBe("Name saved.");
    expect(onAgentChanged).toHaveBeenCalledOnce();
  });

  it("shows a provider error and fallback for failed saves", async () => {
    const updateAgent = vi
      .spyOn(browserApi, "updateAgent")
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockRejectedValueOnce("unknown failure");
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Conflict" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("status")).textContent).toBe("revision conflict");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Conflict again" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("status")).textContent).toBe("Unable to save name");
    expect(updateAgent).toHaveBeenCalledTimes(2);
  });

  it("keeps the Name page to the name; self-configuration lives with the model and permissions", () => {
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
    expect(screen.queryByRole("switch", { name: "Self-configuration" })).toBeNull();
  });

  it("blocks a second save while the name is saving", async () => {
    let release: ((value: AgentAdminConfig) => void) | undefined;
    const pending = new Promise<AgentAdminConfig>((resolve) => {
      release = resolve;
    });
    const updateAgent = vi.spyOn(browserApi, "updateAgent").mockReturnValue(pending);
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
    const displayName = screen.getByLabelText("Display name");
    const form = displayName.closest("form") as HTMLFormElement;
    fireEvent.change(displayName, { target: { value: "Draft name" } });

    fireEvent.submit(form);
    const saving = screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement;
    expect(saving.disabled).toBe(false);
    expect(saving.getAttribute("aria-busy")).toBe("true");
    fireEvent.submit(form);
    expect(updateAgent).toHaveBeenCalledOnce();

    release?.({ ...config, displayName: "Draft name", revision: 5 });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull());
  });

  it("keeps keyboard focus in the form after the save bar goes away", async () => {
    const updated = { ...config, displayName: "Reviewer Bot", revision: 5 };
    vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
    const displayName = screen.getByLabelText("Display name");
    fireEvent.change(displayName, { target: { value: "Reviewer Bot" } });
    const save = screen.getByRole("button", { name: "Save changes" });
    save.focus();
    fireEvent.click(save);

    await screen.findByText("Name saved.");
    await waitFor(() => expect(document.activeElement).toBe(displayName));
  });
});
