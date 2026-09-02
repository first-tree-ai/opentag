import type { UserProfile } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { browserApi } from "../api.js";
import { InternalToolsPage } from "./internal-tools-page.js";

const user: UserProfile = {
  id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  email: "onboarding-test@company.example",
  displayName: "Onboarding Test",
};

async function renderTools() {
  vi.spyOn(browserApi, "internalNavigationVisibility").mockResolvedValue({ integrations: false, skills: false });
  const onResetSucceeded = vi.fn();
  await renderInRouter(<InternalToolsPage user={user} onResetSucceeded={onResetSucceeded} />, { path: "/internal" });
  return { onResetSucceeded };
}

/** Confirms the named operation through its dialog, which is the only way either one runs. */
async function confirm(trigger: string, confirmAction: string) {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: confirmAction }));
}

describe("internal tools page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the lighter re-board and the destructive reset as separate operations", async () => {
    await renderTools();

    expect(screen.getByRole("button", { name: "Re-board" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset and start onboarding" })).toBeTruthy();
  });

  it("keeps Skills and Integrations out of navigation until each preview is enabled", async () => {
    const update = vi
      .spyOn(browserApi, "updateInternalNavigationVisibility")
      .mockResolvedValue({ integrations: false, skills: true });
    await renderTools();

    const skills = await screen.findByRole("switch", { name: "Show Skills" });
    const integrations = await screen.findByRole("switch", { name: "Show Integrations" });
    expect(skills.getAttribute("aria-checked")).toBe("false");
    expect(integrations.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(skills);

    await waitFor(() => expect(skills.getAttribute("aria-checked")).toBe("true"));
    expect(update).toHaveBeenCalledExactlyOnceWith({ integrations: false, skills: true });
    expect(integrations.getAttribute("aria-checked")).toBe("false");
  });

  it("re-boards without asking the Server to destroy anything", async () => {
    const reset = vi.spyOn(browserApi, "resetAccountSetup").mockResolvedValue();
    const { onResetSucceeded } = await renderTools();

    await confirm("Re-board", "Re-board");

    await waitFor(() => expect(onResetSucceeded).toHaveBeenCalledExactlyOnceWith("reboard"));
    expect(reset).toHaveBeenCalledExactlyOnceWith("reboard");
  });

  it("resets everything only when the destructive operation is the one confirmed", async () => {
    const reset = vi.spyOn(browserApi, "resetAccountSetup").mockResolvedValue();
    const { onResetSucceeded } = await renderTools();

    await confirm("Reset and start onboarding", "Reset and start onboarding");

    await waitFor(() => expect(onResetSucceeded).toHaveBeenCalledExactlyOnceWith("all"));
    expect(reset).toHaveBeenCalledExactlyOnceWith("all");
  });

  it("says what each operation costs before it is confirmed, and runs nothing on cancel", async () => {
    const reset = vi.spyOn(browserApi, "resetAccountSetup").mockResolvedValue();
    await renderTools();

    fireEvent.click(screen.getByRole("button", { name: "Re-board" }));
    const reboarding = await screen.findByRole("dialog");
    expect(within(reboarding).getByText(/Agents, Computers and messaging connections all stay/)).toBeTruthy();
    fireEvent.click(within(reboarding).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Reset and start onboarding" }));
    const resetting = await screen.findByRole("dialog");
    expect(within(resetting).getByText(/deletes your current Agents/)).toBeTruthy();
    fireEvent.click(within(resetting).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(reset).not.toHaveBeenCalled();
  });

  it("reports a failure and hands over nothing", async () => {
    vi.spyOn(browserApi, "resetAccountSetup").mockRejectedValueOnce(new Error("The Account could not be reset"));
    const { onResetSucceeded } = await renderTools();

    await confirm("Re-board", "Re-board");

    const failure = await screen.findByRole("alert");
    expect(within(failure).getByText("The Account could not be reset")).toBeTruthy();
    expect(onResetSucceeded).not.toHaveBeenCalled();
  });

  it("links the tools that keep a page of their own instead of inlining them", async () => {
    await renderTools();

    const pages = screen.getByRole("navigation", { name: "Internal tool pages" });
    expect(
      within(pages)
        .getByRole("link", { name: /Agent Setup lab/ })
        .getAttribute("href"),
    ).toBe("/internal/agent-setup");
  });
});
