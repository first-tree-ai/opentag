import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, entry, openRemove, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const click = (name: string) => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name }));
describe("MCP removal", () => {
  it.each(["Cancel", "Escape"])("offers a concise confirmation and cancels with %s without a write", async (action) => {
    stub([entry()]);
    const detach = vi.spyOn(browserApi, "detachMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    const trigger = await screen.findByRole("button", { name: "Remove linear" });
    trigger.focus();
    await openRemove();
    expect(screen.getByRole("alertdialog", { name: "Remove linear?" })).toBeTruthy();
    expect(within(screen.getByRole("alertdialog")).queryByRole("button", { name: /^Close / })).toBeNull();
    expect(within(screen.getByRole("alertdialog")).getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    expect(screen.getByRole("alertdialog").getAttribute("aria-describedby")).toBeTruthy();
    expect(
      screen.getByText("This Agent will no longer be able to use linear. You can add it again at any time."),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    if (action === "Cancel") click("Cancel");
    else fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(detach).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it.each([false, true])("removes the installation and restores focus (empty=%s)", async (empty) => {
    const other = entry({ mcpServerId: "other", name: "notion" });
    stub(empty ? [entry()] : [entry(), other]);
    const detach = vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: empty ? [] : [other] });
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    click("Remove");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
    expect(browserApi.removeMcpServer).toHaveBeenCalledWith(SERVER_ID);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        empty
          ? screen.getByRole("region", { name: "Connectors" })
          : screen.getByRole("button", { name: "Remove notion" }),
      ),
    );
  });
  it("retains a historical definition used by another Agent", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    vi.mocked(browserApi.removeMcpServer).mockRejectedValue(new ApiError(409, "In use", "MCP_SERVER_IN_USE"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    click("Remove");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
  it("returns to the preceding removal control when the next row is busy", async () => {
    const previous = entry({ mcpServerId: "previous", name: "alpha" });
    const next = entry({ mcpServerId: "next", name: "gamma", enabled: false });
    stub([previous, entry(), next]);
    vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [previous, next] });
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume: gamma" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove gamma" }).hasAttribute("disabled")).toBe(true),
    );
    await openRemove();
    click("Remove");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove alpha" })));
  });
  it("removes a disabled connector without enabling it or replacing authorization", async () => {
    stub([entry({ enabled: false })]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization");
    const detach = vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [] });
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    click("Remove");
    await screen.findByRole("heading", { name: "No connectors yet" });
    expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
    expect(update).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
  it("guards removal through both requests, then permits retry after a failure", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    let fail: (error: Error) => void = () => {};
    vi.mocked(browserApi.removeMcpServer)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue(undefined);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    click("Remove");
    await waitFor(() => expect(browserApi.removeMcpServer).toHaveBeenCalledTimes(1));
    expect(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fail(new ApiError(503, "private infrastructure detail"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't remove linear.");
    click("Remove");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(browserApi.removeMcpServer).toHaveBeenCalledTimes(2);
  });
});
