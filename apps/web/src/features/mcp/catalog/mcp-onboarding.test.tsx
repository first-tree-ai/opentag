import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../../api.js";
import { McpPage } from "../mcp-page.js";
import { AGENT_ID, stub, wrap } from "../mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("MCP onboarding", () => {
  it("keeps connector choices in Discover rather than on the empty page", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("heading", { level: 2, name: "No connectors yet" });
    expect(screen.queryByText("Quick start")).toBeNull();
    expect(screen.queryByRole("button", { name: "Browse all connectors" })).toBeNull();
    for (const title of ["Exa", "Notion", "Linear", "Airtable"]) expect(screen.queryByText(title)).toBeNull();
    const discover = screen.getByRole("button", { name: "Discover" });
    await waitFor(() => expect(discover.hasAttribute("disabled")).toBe(false));
    fireEvent.click(discover);
    const dialog = within(await screen.findByRole("dialog", { name: "Discover" }));
    for (const title of ["Exa", "Notion", "Linear", "Airtable"])
      expect(await dialog.findByRole("button", { name: `Add: ${title}` })).toBeTruthy();
  });

  it.each(["Google Drive", "Gmail"])("starts adding %s directly and retains the search on failure", async (title) => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockRejectedValue(new ApiError(503, "Fixture unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    const discover = await screen.findByRole("button", { name: "Discover" });
    await waitFor(() => expect(discover.hasAttribute("disabled")).toBe(false));
    fireEvent.click(discover);
    const search = await screen.findByLabelText("Search connectors");
    search.focus();
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: title } });
    fireEvent.click(await screen.findByRole("button", { name: `Add: ${title}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByText("Connection failed");
    expect(create).toHaveBeenCalledTimes(1);
    expect(dialog.getByRole("button", { name: `Reconnect: ${title}` })).toBeTruthy();
    expect((search as HTMLInputElement).value).toBe(title);
    expect(dialog.queryByRole("button", { name: "Add: Linear" })).toBeNull();
  });

  it("focuses the dialog heading on open and preserves user focus after the directory loads", async () => {
    stub([]);
    let finish: (value: { servers: [] }) => void = () => {};
    vi.spyOn(browserApi, "mcpServers").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    wrap(<McpPage agentId={AGENT_ID} />);
    const discover = await screen.findByRole("button", { name: "Discover" });
    await waitFor(() => expect(discover.hasAttribute("disabled")).toBe(false));
    fireEvent.click(discover);
    const dialog = await screen.findByRole("dialog", { name: "Discover" });
    const heading = within(dialog).getByRole("heading", { name: "Discover" });
    await waitFor(() => expect(document.activeElement?.contains(heading)).toBe(true));
    const close = within(dialog).getByRole("button", { name: "Close Discover" });
    close.focus();
    finish({ servers: [] });
    const search = await screen.findByLabelText("Search connectors");
    expect(document.activeElement).toBe(close);
    search.focus();
    expect(document.activeElement).toBe(search);
  });
});
