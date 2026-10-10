import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, entry, openDetails, openRemove, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const click = (name: string, confirmation = false) =>
  fireEvent.click(within(screen.getByRole(confirmation ? "alertdialog" : "dialog")).getByRole("button", { name }));
describe("MCP details and removal journey", () => {
  it("returns from tools and removal with draft, disclosure state, scroll and focus intact", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    const detach = vi.spyOn(browserApi, "detachMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    fireEvent.change(screen.getByLabelText("MCP URL"), { target: { value: "https://draft.example.com/mcp" } });
    click("Advanced settings");
    click("Server information");
    screen.getByRole("dialog").scrollTop = 80;
    click("Tools");
    fireEvent.change(screen.getByRole("textbox", { name: "Search tools" }), { target: { value: "issue" } });
    click("Back to server details");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Tools" })));
    expect(screen.getByRole("dialog").scrollTop).toBe(80);
    expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe("https://draft.example.com/mcp");
    expect(screen.getByRole("button", { name: "Advanced settings" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Server information" }).getAttribute("aria-expanded")).toBe("true");
    click("Tools");
    expect((screen.getByRole("textbox", { name: "Search tools" }) as HTMLInputElement).value).toBe("issue");
    click("Back to server details");
    click("Remove from agent");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    click("Cancel", true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove from agent" })));
    expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe("https://draft.example.com/mcp");
    expect(update).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "closes on success and focuses the remaining entry or Add server (empty=%s)",
    async (empty) => {
      const other = entry({ mcpServerId: "other", name: "notion" });
      stub(empty ? [entry()] : [entry(), other]);
      const detach = vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async () => {
        vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: empty ? [] : [other] });
      });
      const remove = vi.spyOn(browserApi, "removeMcpServer");
      wrap(<McpPage agentId={AGENT_ID} />);
      await openRemove();
      click("Remove", true);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("button", { name: "linear" })).toBeNull();
      expect(screen.getByText("linear removed from agent")).toBeTruthy();
      await waitFor(() => expect(document.activeElement?.textContent).toBe(empty ? "Add server" : "notion"));
      expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
      expect(remove).not.toHaveBeenCalled();
    },
  );
  it("guards pending removal, shows a recoverable error and retries in place", async () => {
    stub([entry()]);
    let reject: (error: Error) => void = () => {};
    const detach = vi
      .spyOn(browserApi, "detachMcpServer")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockImplementationOnce(async () => {
        vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [] });
      });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    click("Remove", true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(true));
    click("Remove", true);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(detach).toHaveBeenCalledTimes(1);
    reject(new ApiError(503, "Internal infrastructure detail"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't remove linear. Try again.");
    expect(screen.queryByText("Internal infrastructure detail")).toBeNull();
    click("Remove", true);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(detach).toHaveBeenCalledTimes(2);
  });
});
