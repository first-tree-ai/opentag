import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, entry, openDetails, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const address = () => screen.getByLabelText("Server address") as HTMLInputElement;

async function openSettings() {
  wrap(<McpPage agentId={AGENT_ID} />);
  await openDetails();
}

describe("MCP settings navigation", () => {
  it("shows address guidance only when the address is invalid", async () => {
    stub([entry()]);
    await openSettings();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(address(), { target: { value: "not-an-address" } });
    expect(address().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("Enter an HTTP(S) MCP URL");
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(address(), { target: { value: "https://valid.example.com/mcp" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(false);
  });
  it("keeps a Settings draft when returning from Tools", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    await openSettings();
    expect(screen.queryByText(/Used to connect/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Server information/ })).toBeNull();
    fireEvent.change(address(), { target: { value: "https://draft.example.com/mcp" } });
    click("Tools");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    click("Back");
    expect(address().value).toBe("https://draft.example.com/mcp");
    expect(update).not.toHaveBeenCalled();
    click("Save changes");
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { url: "https://draft.example.com/mcp" }),
    );
  });

  it.each([/^Authentication/, /^Tools/])("closes the entire dialog with X from %s", async (child) => {
    stub([entry()]);
    await openSettings();
    click(child);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Close / }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([/^Authentication/, /^Tools/])("closes the entire dialog with Escape from %s", async (child) => {
    stub([entry()]);
    await openSettings();
    click(child);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("gives account defaults distinct Back and Close actions", async () => {
    stub([entry()]);
    await openSettings();
    fireEvent.change(address(), { target: { value: "https://draft.example.com/mcp" } });
    click("Advanced settings");
    click("Edit account defaults");
    await screen.findByLabelText("Description");
    click("Back");
    expect(address().value).toBe("https://draft.example.com/mcp");
    expect(screen.getByRole("button", { name: "Advanced settings" }).getAttribute("aria-expanded")).toBe("true");
    click("Edit account defaults");
    await screen.findByLabelText("Description");
    click("Close linear account defaults");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps drafts when canceling removal and only removes after confirmation", async () => {
    stub([entry()]);
    const detach = vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    await openSettings();
    fireEvent.change(address(), { target: { value: "https://draft.example.com/mcp" } });
    click("Remove from agent");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(detach).not.toHaveBeenCalled();
    click("Cancel");
    expect(address().value).toBe("https://draft.example.com/mcp");
    click("Remove from agent");
    click("Remove");
    await waitFor(() => expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blocks Back, Close and Escape while credentials are submitted, then returns to Settings", async () => {
    stub([entry()]);
    let finish: () => void = () => {};
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(entry());
        }),
    );
    await openSettings();
    click(/^Authentication/);
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "example-token" },
    });
    click("Update credentials");
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Close Authentication" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByLabelText("Server address")).toBeNull();
    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    finish();
    await screen.findByLabelText("Server address");
    expect(screen.getByRole("button", { name: "Authentication" })).toBeTruthy();
  });

  it("rebases a live connection update without replacing the URL draft", async () => {
    const original = entry();
    const saved = entry({
      effective: { ...original.effective, authHeader: "x-api-key" },
      overridden: { ...original.overridden, authHeader: true },
    });
    stub([original]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(saved);
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [saved] });
      return {
        probeState: "succeeded",
        probeError: null,
        toolsCount: 1,
        toolsTruncated: false,
        protocolEra: null,
        protocolVersion: null,
      };
    });
    await openSettings();
    fireEvent.change(address(), { target: { value: "https://draft.example.com/mcp" } });
    click("Tools");
    click("Refresh tools");
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    click("Back");
    click("Advanced settings");
    await waitFor(() => expect((screen.getByLabelText("Auth header") as HTMLInputElement).value).toBe("x-api-key"));
    expect(address().value).toBe("https://draft.example.com/mcp");
    click("Save changes");
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(AGENT_ID, SERVER_ID, { url: "https://draft.example.com/mcp" }),
    );
  });
});
