import type { AgentAdminConfig } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  status: "active",
  revision: 4,
  runtimeConfig: {
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
  it("saves and discards a changed display name", async () => {
    const updated = { ...config, displayName: "Reviewer Bot", revision: 5 };
    const updateAgent = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    // The caller publishes the record a write produced, which is how the field -- and every block
    // beside it on the settings screen -- comes to be looking at the revision the Server now holds.
    const onAgentChanged = vi.fn((saved?: AgentAdminConfig) => {
      view.rerender(<GeneralConfigForm config={saved ?? config} onAgentChanged={onAgentChanged} />);
    });
    const view = render(<GeneralConfigForm config={config} onAgentChanged={onAgentChanged} />);

    fireEvent.submit(screen.getByRole("heading", { name: "Name" }).closest("form") as HTMLFormElement);
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
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Reviewer Bot");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("shows a provider error and fallback for failed saves", async () => {
    const updateAgent = vi
      .spyOn(browserApi, "updateAgent")
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockRejectedValueOnce("unknown failure");
    render(<GeneralConfigForm config={config} onAgentChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Conflict" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toBe("revision conflict");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Conflict again" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Unable to save name");
    expect(screen.queryByRole("status")).toBeNull();
    expect(updateAgent).toHaveBeenCalledTimes(2);
  });
});
