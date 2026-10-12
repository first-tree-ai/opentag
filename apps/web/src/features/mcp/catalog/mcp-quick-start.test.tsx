import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../../api.js";
import { McpPage } from "../mcp-page.js";
import { AGENT_ID, stub, wrap } from "../mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("MCP onboarding", () => {
  it("offers the four office starting points with a brand-only Exa title", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByText("Quick start");
    for (const title of ["Exa", "Notion", "Linear", "Airtable"]) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText("Google Drive")).toBeNull();
    expect(screen.queryByText("Gmail")).toBeNull();
    expect(screen.queryByText("Limited access")).toBeNull();
    expect(screen.queryByText("Preview access required")).toBeNull();
    expect(screen.queryByText("No API key needed")).toBeNull();
    expect(screen.queryByText("Authorize on the service’s website")).toBeNull();
    expect(screen.getByRole("button", { name: "Discover services" })).toBeTruthy();
  });

  it.each(["Google Drive", "Gmail"])("shows %s requirements before creating or authorizing", async (title) => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    wrap(<McpPage agentId={AGENT_ID} />);
    const discover = await screen.findByRole("button", { name: "Discover services" });
    await waitFor(() => expect(discover.hasAttribute("disabled")).toBe(false));
    fireEvent.click(discover);
    const search = await screen.findByLabelText("Search services");
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: title } });
    fireEvent.click(await screen.findByRole("button", { name: `Add: ${title}` }));
    const dialog = within(await screen.findByRole("dialog"));
    const requirements = await dialog.findByText(/Your Google Cloud project must have preview access/);
    await waitFor(() => expect(document.activeElement).toBe(requirements));
    expect(create).not.toHaveBeenCalled();
    expect(oauth).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect((search as HTMLInputElement).value).toBe(title);
    expect(dialog.queryByRole("button", { name: "Add: Linear" })).toBeNull();
  });

  it("focuses search after the account directory finishes loading", async () => {
    stub([]);
    let finish: (value: { servers: [] }) => void = () => {};
    vi.spyOn(browserApi, "mcpServers").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    wrap(<McpPage agentId={AGENT_ID} />);
    const discover = await screen.findByRole("button", { name: "Discover services" });
    await waitFor(() => expect(discover.hasAttribute("disabled")).toBe(false));
    fireEvent.click(discover);
    await screen.findByRole("dialog");
    finish({ servers: [] });
    const search = await screen.findByLabelText("Search services");
    await waitFor(() => expect(document.activeElement).toBe(search));
  });
});
