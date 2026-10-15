import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, entry, openRemove, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const click = (name: string) => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name }));
describe("MCP deletion", () => {
  it.each(["Cancel", "Escape"])("offers a concise confirmation and cancels with %s without a write", async (action) => {
    stub([entry()]);
    const detach = vi.spyOn(browserApi, "detachMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    expect(screen.getByRole("alertdialog", { name: "Delete linear?" })).toBeTruthy();
    expect(within(screen.getByRole("alertdialog")).queryByRole("button", { name: /^Close / })).toBeNull();
    expect(screen.getAllByRole("button").filter((button) => button.textContent === "Delete")).toHaveLength(1);
    expect(screen.getByRole("alertdialog").getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("This Agent won’t be able to use linear until you add it again.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    if (action === "Cancel") click("Cancel");
    else fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(detach).not.toHaveBeenCalled();
  });
  it.each([false, true])("deletes the installation and restores focus (empty=%s)", async (empty) => {
    const other = entry({ mcpServerId: "other", name: "notion" });
    stub(empty ? [entry()] : [entry(), other]);
    const detach = vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: empty ? [] : [other] });
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    click("Delete");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
    expect(browserApi.removeMcpServer).toHaveBeenCalledWith(SERVER_ID);
    await waitFor(() => expect(document.activeElement?.textContent).toBe(empty ? "Add custom" : "notion"));
  });
  it("retains a historical definition used by another Agent", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    vi.mocked(browserApi.removeMcpServer).mockRejectedValue(new ApiError(409, "In use", "MCP_SERVER_IN_USE"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    click("Delete");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
  it("guards deletion through both requests, then permits retry after a failure", async () => {
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
    click("Delete");
    await waitFor(() => expect(browserApi.removeMcpServer).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fail(new ApiError(503, "private infrastructure detail"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't delete linear.");
    click("Delete");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(browserApi.removeMcpServer).toHaveBeenCalledTimes(2);
  });
});
