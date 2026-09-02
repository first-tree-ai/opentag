import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { agentId, installApi, json, memberUserId, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("keeps the Agent home focused on status, usage, and Tasks", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Investigate the failed deployment" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Usage" }).getAttribute("href")).toBe(`/agents/${agentId}/usage`);
    /*
     * Status sits beside Usage without adding another visible card title. Its two rows name the
     * execution environment and messaging dependency directly, so Settings remains the header's only trailing
     * link.
     */
    expect(screen.queryByText("Connection")).toBeNull();
    const status = screen.getByRole("region", { name: "Agent status" });
    expect(within(status).getByText("Computer")).toBeTruthy();
    expect(within(status).getByText("Messaging")).toBeTruthy();
    expect(within(status).getByText("Ada's Mac · macOS · Codex")).toBeTruthy();
    expect(within(status).getByText("Lark · @reviewer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Lark · @reviewer" })).toBeNull();
    const header = screen.getByRole("heading", { name: "Reviewer" }).closest("header");
    expect(
      within(header as HTMLElement)
        .getAllByRole("link")
        .map((item) => item.textContent?.trim()),
    ).toEqual(["Settings"]);
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(`/agents/${agentId}/settings`);
    expect(screen.queryByRole("heading", { name: "Current work" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Messaging" })).toBeNull();
    expect(screen.queryByLabelText("More Agent actions")).toBeNull();
    const agentNavigation = screen.getByRole("navigation", { name: "Agent" });
    expect(within(agentNavigation).getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(within(agentNavigation).queryByText("Settings")).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("shows another Admin's creation identity as audit information, not management ownership", async () => {
    installApi({ agentCreator: { userId: memberUserId, displayName: "Grace" }, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByText("Created by Grace")).toBeTruthy();
    expect(screen.queryByText(/Managed by/)).toBeNull();
  });

  it("opens Usage as a sibling Agent section without rereading the full Agent detail", async () => {
    let agentReads = 0;
    installApi({
      agentRead: () => {
        agentReads += 1;
      },
      bound: true,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "View Usage" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Usage" })).toBeTruthy();
    expect(agentReads).toBe(1);
    const agentNavigation = screen.getByRole("navigation", { name: "Agent" });
    expect(within(agentNavigation).getByRole("button", { name: "Usage" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps Agent context visible while opening Settings", async () => {
    let agentReads = 0;
    let releaseAgentRead = () => {};
    const pendingAgentRead = new Promise<void>((resolve) => {
      releaseAgentRead = resolve;
    });
    installApi({
      agentRead: () => {
        agentReads += 1;
        return agentReads === 1 ? undefined : pendingAgentRead;
      },
      bound: true,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Agent settings" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Account Agents" })).toBeNull();
    await waitFor(() => expect(agentReads).toBe(2));
    expect(screen.queryByLabelText("Loading current server state")).toBeNull();
    await act(async () => releaseAgentRead());
  });

  it.each([403, 404])("replaces a cached Agent with a terminal detail response (%d)", async (status) => {
    let agentReads = 0;
    installApi({
      agentRead: () => {
        agentReads += 1;
      },
      agentReadStatus: () => (agentReads > 1 ? status : undefined),
      bound: true,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Agent settings" })).toBeTruthy();
    await waitFor(() => expect(agentReads).toBe(2));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent unavailable");
    expect(screen.queryByRole("heading", { name: "Reviewer" })).toBeNull();
  });

  it("shows confirmed active work without exposing conversation content", async () => {
    installApi({
      bound: true,
      agentActivity: { state: "working", startedAt: "2026-08-24T09:00:00.000Z" },
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect((await screen.findAllByText("Working")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("link", { name: "Investigate the failed deployment" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("Private conversation content");
  });

  it("groups all admin-only controls in a lightweight Settings directory", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agent settings" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Agent settings" })).toBeNull();
    // One list in the order a viewer thinks about an Agent, with the irreversible actions held apart.
    const setup = await screen.findByRole("region", { name: "Agent setup" });
    expect(
      [...setup.querySelectorAll('[data-ui="agent-settings-entry"] strong')].map((entry) => entry.textContent),
    ).toEqual(["Name", "Messaging", "Computer", "Instructions", "Model"]);
    const dangerZone = screen.getByRole("region", { name: "Danger zone" });
    expect(within(dangerZone).getByRole("heading", { name: "Danger zone" })).toBeTruthy();
    expect(dangerZone.className).not.toContain("border-t");
    expect(screen.getByRole("link", { name: /^Pause or delete/ })).toBeTruthy();
    expect(dangerZone.querySelector('[data-ui="agent-settings-entry-icon"]')?.className).toContain("text-kumo-danger");
    expect(screen.queryByRole("heading", { name: "How it works" })).toBeNull();
    // jsdom 30 no longer contributes inter-element whitespace to accessible names, so the
    // label/value boundary may collapse; \s? keeps these queries engine-agnostic.
    const instructionsLink = screen.getByRole("link", { name: /^Instructions\s?\S/ });
    expect(instructionsLink.className).toContain("focus-visible:ring-2");
    expect(within(instructionsLink).getByText("No custom instructions").className).toContain("text-kumo-subtle");
    expect(screen.getByRole("link", { name: /^Model\s?\S/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Messaging/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Name\s?Reviewer$/ })).toBeTruthy();
    expect(screen.getByText("Computer")).toBeTruthy();
    // Every row in the list opens; a row that is a link only sometimes cannot be predicted.
    expect(screen.getByRole("link", { name: /^Computer\s?\S/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pause or delete/ })).toBeTruthy();
    expect(screen.getByText("No custom instructions")).toBeTruthy();
    expect(screen.getByText("Codex · Provider defaults")).toBeTruthy();
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);
    expect(screen.getByText("Ada's Mac · macOS · Online")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("returns to the Agent home when Messaging was opened from its Manage shortcut", async () => {
    installApi({ bindingState: "provisioning", bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    const status = await screen.findByRole("region", { name: "Agent status" });
    expect(within(status).getByText("Setup in progress")).toBeTruthy();
    const setupLink = within(status).getByRole("link", { name: "View setup" });
    expect(setupLink.closest('[data-ui="agent-status-message-channel"]')).toBeTruthy();
    fireEvent.click(setupLink);
    expect(await screen.findByRole("heading", { name: "Messaging" })).toBeTruthy();
    const backLink = screen.getByRole("link", { name: "Back to Reviewer" });
    expect(backLink.getAttribute("href")).toBe(`/agents/${agentId}`);
    fireEvent.click(backLink);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
  });

  it("opens Connected computer recovery only when the Computer needs attention", async () => {
    installApi({ computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings`);
    render(<App />);

    const computerLabel = await screen.findByText("Computer");
    const computerLink = computerLabel.closest("a");
    expect(screen.getByText("Ada's Mac · macOS · Offline")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    if (!(computerLink instanceof HTMLAnchorElement)) {
      throw new Error("Expected the Connected computer recovery row to be a link");
    }
    expect(computerLink.getAttribute("href")).toBe(`/agents/${agentId}/settings/computer`);
  });

  it("edits the Agent display name without exposing its permanent handle", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/identity`);
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    expect(screen.getByRole("heading", { name: "Name" })).toBeTruthy();
    expect(screen.queryByText("Choose the name teammates see.")).toBeNull();
    expect(screen.queryByLabelText("Handle")).toBeNull();
    expect(screen.queryByText(/handle cannot be changed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    fireEvent.change(displayName, { target: { value: "Research Reviewer" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(displayName.value).toBe("Reviewer");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("pauses and deletes an Agent from Manage with destructive confirmation", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    const unavailableDeleteButton = await screen.findByRole("button", { name: "Delete Agent" });
    expect(unavailableDeleteButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Permanently deletes this Agent and disconnects its messaging app. Pause the Agent first."),
    ).toBeTruthy();
    fireEvent.click(unavailableDeleteButton);
    expect(screen.queryByRole("dialog", { name: "Delete Reviewer?" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Pause Agent" }));
    expect(await screen.findByRole("button", { name: "Resume Agent" })).toBeTruthy();
    const deleteButton = screen.getByRole("button", { name: "Delete Agent" });
    expect(deleteButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    const confirmedDeleteButton = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirmedDeleteButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
    expect(confirmedDeleteButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirmedDeleteButton);
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
  });

  it("evicts a deleted Agent before a failed list refresh can retain it", async () => {
    let listReads = 0;
    installApi({
      agentListStatus: () => {
        listReads += 1;
        return listReads > 1 ? 503 : undefined;
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Open Reviewer" }));
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("link", { name: /Pause or delete/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause Agent" }));
    expect(await screen.findByRole("button", { name: "Resume Agent" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
    fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByRole("heading", { name: "No Agents yet" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Reviewer" })).toBeNull();
    expect(listReads).toBeGreaterThanOrEqual(2);
  });

  it("keeps lifecycle failures visible inside the confirmation dialog and allows retry", async () => {
    installApi({
      agentActivity: { state: "working", startedAt: "2026-08-24T12:00:00.000Z" },
    });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failSuspend = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}/suspend` && init?.method === "POST" && failSuspend) {
        failSuspend = false;
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Unable to pause right now" } },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Pause Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause Reviewer?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Agent" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Couldn’t pause this Agent");

    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pause Reviewer?" })).toBeNull());
    const resumeButton = await screen.findByRole("button", { name: "Resume Agent" });
    await waitFor(() => expect(document.activeElement).toBe(resumeButton));
  });

  it("keeps delete failures visible inside the confirmation dialog and clears them after retry", async () => {
    installApi({ initialStatus: "suspended" });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failDelete = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}` && init?.method === "DELETE" && failDelete) {
        failDelete = false;
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Unable to delete right now" } },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
    fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Couldn’t delete this Agent");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    expect(screen.queryByText("Couldn’t delete this Agent. Try again.")).toBeNull();
  });
});
