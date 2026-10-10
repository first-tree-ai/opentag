import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { rememberMcpReturn } from "./mcp-return-context.js";
import {
  AGENT_ID,
  authorization,
  entry,
  openDetails,
  openRemove,
  openTools,
  SERVER_ID,
  snapshot,
  stub,
  wrap,
} from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("MCP daily use", () => {
  it("keeps normal rows quiet and offers refresh inside the tool browser", async () => {
    stub([entry({ discoveredDescription: "Long server-provided description" })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    expect(screen.getByRole("button", { name: "Refresh tools" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tool list incomplete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close linear tools" }));
    expect(screen.queryByText("Long server-provided description")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh tools" })).toBeNull();
    await openDetails();
    expect(screen.queryByRole("button", { name: "Server information" })).toBeNull();
    expect(screen.queryByText("Long server-provided description")).toBeNull();
  });
  it("uses identity navigation without menus or a permanent tools action", async () => {
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("button", { name: "linear" });
    expect(screen.queryByRole("button", { name: /More actions|View tools/ })).toBeNull();
    fireEvent.click(screen.getByText(entry().effective.url));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open linear details" }));
    expect(await screen.findByRole("dialog", { name: "linear" })).toBeTruthy();
  });
  it.each([[], null])("opens an empty saved snapshot with tools=%j", async (tools) => {
    stub([entry({ snapshot: { ...snapshot(), tools } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    expect(await screen.findByText("No tools available")).toBeTruthy();
  });
  it.each(["pending", "expired", "revoked", "error"] as const)(
    "shows an authorization action for %s",
    async (status) => {
      stub([entry({ authorization: { ...authorization(), status } })]);
      wrap(<McpPage agentId={AGENT_ID} />);
      expect(await screen.findByRole("button", { name: "Reconnect" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^View tools/ })).toBeNull();
    },
  );
  it("does not turn a disabled connection into an authorization error", async () => {
    stub([entry({ enabled: false, authorization: null, snapshot: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Disabled for Reviewer · Settings kept")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Allow Reviewer to use linear" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: /Authentication/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
  it("guards duplicate toggles and reports errors on that row", async () => {
    stub([entry()]);
    let reject: (error: Error) => void = () => {};
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(
      () =>
        new Promise((_r, j) => {
          reject = j;
        }),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(true));
    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { enabled: false });
    reject(new ApiError(500, "Cannot change this connection"));
    expect(await screen.findByText("Cannot change this connection")).toBeTruthy();
    expect(
      within(toggle.closest("li") as HTMLElement).getByRole("button", {
        name: /^Action failed/,
        description: "View error details",
      }),
    ).toBeTruthy();
  });
  it("offers Retry for a probe failure without asking for credentials", async () => {
    stub([
      entry({
        snapshot: null,
        authorization: {
          ...authorization(),
          probeState: "failed",
          probeError: "MCP_PROBE_FAILED: upstream limit",
        },
      }),
    ]);
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockRejectedValue(new ApiError(502, "Try later"));
    wrap(<McpPage agentId={AGENT_ID} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText("MCP_PROBE_FAILED: upstream limit")).toBeNull();
    const errorDetails = screen.getByRole("button", { name: /^Connection failed/, description: "View error details" });
    fireEvent.click(errorDetails);
    expect(await screen.findByText("MCP_PROBE_FAILED: upstream limit")).toBeTruthy();
    fireEvent.click(errorDetails);
    fireEvent.click(retry);
    expect(await screen.findByText("Try later")).toBeTruthy();
    expect(probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^View tools/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Action failed/, description: "View error details" }).textContent,
    ).toContain("Action failed");
  });
  it("shows a real pending probe even before its first timestamp", async () => {
    stub([entry({ snapshot: null, authorization: { ...authorization(), probeState: "pending", probedAt: null } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Loading tools…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^View tools/ })).toBeNull();
  });
  it("does not show an empty list after a read error", async () => {
    stub([]);
    vi.mocked(browserApi.agentMcpServers).mockRejectedValue(new ApiError(503, "MCP unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("MCP unavailable")).toBeTruthy();
    expect(screen.queryByText("No servers added")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("shows an actionable empty state only after a successful read", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("No servers added")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add server" }).length).toBeGreaterThan(0);
  });
  it("shows tool truncation only as a disclosure in the tool browser", async () => {
    stub([entry({ authorization: { ...authorization(), toolsCount: 200, toolsTruncated: true } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("button", { name: "linear" });
    expect(screen.queryByText(/\d+ tools loaded/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tool list incomplete" })).toBeNull();
    await openTools();
    const dialog = await screen.findByRole("dialog");
    const disclosure = within(dialog).getByRole("button", { name: "Tool list incomplete" });
    const explanation =
      "The tool list may be incomplete, so this Agent may not have access to all of this Server’s tools.";
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(explanation)).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText(explanation)).toBeTruthy();
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close linear tools" }));
    expect(screen.queryByRole("button", { name: "Tool list incomplete" })).toBeNull();
  });
  it("shows tools as static descriptions without row actions or parameter schemas", async () => {
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tools" }), { target: { value: "issue" } });
    const tool = screen.getByRole("listitem", { name: "create_issue" });
    expect(within(tool).getByText("Create an issue")).toBeTruthy();
    expect(within(tool).queryByRole("button")).toBeNull();
    expect(within(tool).queryByText(/"type": "object"/)).toBeNull();
    expect((screen.getByRole("textbox", { name: "Search tools" }) as HTMLInputElement).value).toBe("issue");
  });
  it("shows context around a search hit near the end of a long description", async () => {
    const description = `${"Provider introduction. ".repeat(10)}\nFind the rare needle.`;
    stub([entry({ snapshot: { ...snapshot(), tools: [{ name: "search_docs", description, inputSchema: null }] } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    const search = screen.getByRole("textbox", { name: "Search tools" }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "needle" } });
    const tool = screen.getByRole("listitem", { name: "search_docs" });
    const excerpt = within(tool).getByText(/needle/).textContent ?? "";
    expect(excerpt).toBe("Find the rare needle.");
    expect(within(tool).queryByRole("button")).toBeNull();
    expect(search.value).toBe("needle");
    fireEvent.change(search, { target: { value: "" } });
    expect(within(tool).getByText("Provider introduction.")).toBeTruthy();
  });
  it("does not invent an action for a tool without a description or schema", async () => {
    stub([entry({ snapshot: { ...snapshot(), tools: [{ name: "ping", description: null, inputSchema: null }] } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    expect(within(screen.getByRole("listitem", { name: "ping" })).queryByRole("button")).toBeNull();
  });
  it("distinguishes a search miss from a truncated empty snapshot", async () => {
    stub([
      entry({
        snapshot: { ...snapshot(), tools: [] },
        authorization: { ...authorization(), toolsCount: 0, toolsTruncated: true },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    expect(screen.getByText("An incomplete response was received. No tools were saved.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tools" }), { target: { value: "query" } });
    expect(screen.getByText("No matching tools")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("No tools loaded")).toBeTruthy();
  });
  it("keeps the tools entry stable and explains the saved snapshot in the browser", async () => {
    stub([
      entry({
        authorization: { ...authorization(), probeState: "failed", probedAt: "2026-09-20T00:00:00.000Z" },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Connection failed")).toBeTruthy();
    await openTools();
    expect(screen.getByText("Last saved tool list")).toBeTruthy();
    expect(screen.queryByText(/Updated /)).toBeNull();
  });
  it("refreshes from the tool browser and prevents duplicate requests", async () => {
    stub([entry()]);
    let finish: () => void = () => {};
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              probeState: "succeeded",
              probeError: null,
              toolsCount: 1,
              toolsTruncated: false,
              protocolEra: null,
              protocolVersion: null,
            });
        }),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    const refresh = screen.getByRole("button", { name: "Refresh tools" });
    fireEvent.click(refresh);
    await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Last saved tool list")).toBeTruthy();
    fireEvent.click(refresh);
    expect(probe).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
  });
  it("removes only this Agent, with separate confirmation and no account deletion", async () => {
    stub([entry()]);
    const detach = vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    const remove = vi.spyOn(browserApi, "removeMcpServer").mockResolvedValue(undefined);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openRemove();
    expect(detach).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(["remove", "revoke"] as const)("keeps a failed %s confirmation open", async (kind) => {
    stub([entry()]);
    vi.spyOn(browserApi, kind === "remove" ? "detachMcpServer" : "revokeMcpAuthorization").mockRejectedValue(
      new ApiError(500, "Action unavailable"),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    if (kind === "remove") await openRemove();
    else {
      await openDetails();
      fireEvent.click(screen.getByRole("button", { name: /Authentication/ }));
      fireEvent.click(screen.getByRole("button", { name: "Clear credentials…" }));
    }
    fireEvent.click(screen.getByRole("button", { name: kind === "remove" ? "Remove" : "Clear credentials" }));
    expect(
      await screen.findByText(kind === "remove" ? "Couldn't remove linear. Try again." : "Action unavailable"),
    ).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
  it("does not offer revoke for a no-credential authorization", async () => {
    stub([entry({ authorization: { ...authorization(), kind: "none", hasCredential: false } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Authentication" }));
    expect(screen.queryByRole("button", { name: "Clear credentials…" })).toBeNull();
  });
  it("associates OAuth completion with the returned server and clears bounded URL parameters", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=success&server=${SERVER_ID}`);
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(await screen.findByRole("status")).toBeTruthy();
  });
  it("does not display an upstream OAuth error code as user copy", async () => {
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=error&mcp_oauth_error=ARBITRARY`);
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Couldn’t start the authorization. Try again.")).toBeTruthy();
    expect(screen.queryByText(/ARBITRARY/)).toBeNull();
  });
  it("returns to the saved tool search and scroll position after canceling reconnect", async () => {
    stub([entry({ authorization: { ...authorization(), status: "expired" } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tools" }), { target: { value: "issue" } });
    const list = screen.getByRole("region", { name: "Tools discovered with this Agent’s credential" });
    list.scrollTop = 120;
    fireEvent.scroll(list);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reconnect" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByRole("textbox", { name: "Search tools" }) as HTMLInputElement).value).toBe("issue");
    expect(screen.getByRole("region", { name: "Tools discovered with this Agent’s credential" }).scrollTop).toBe(120);
  });
  it("restores tools after an OAuth success without showing another success screen", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    rememberMcpReturn({ agentId: AGENT_ID, serverId: SERVER_ID, source: "tools", query: "issue", scrollTop: 80 });
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=success&server=${SERVER_ID}`);
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("dialog", { name: "Tools" });
    expect((screen.getByRole("textbox", { name: "Search tools" }) as HTMLInputElement).value).toBe("issue");
    expect(screen.queryByText("linear authorized for Reviewer")).toBeNull();
    expect(window.location.search).toBe("");
  });
  it("returns an OAuth failure to authentication with a path back to settings", async () => {
    rememberMcpReturn({ agentId: AGENT_ID, serverId: SERVER_ID, source: "edit" });
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=error&server=${SERVER_ID}`);
    stub([entry({ authorization: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("dialog", { name: "Authentication" });
    expect(screen.getByText("Sign-in was not completed. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("dialog", { name: "linear" });
    fireEvent.click(screen.getByRole("button", { name: /Authentication/ }));
    expect(screen.queryByText("Sign-in was not completed. Try again.")).toBeNull();
  });
});

describe("MCP disabled service inspection", () => {
  it("allows retrying tool discovery without enabling the service", async () => {
    stub([entry({ enabled: false, snapshot: null, authorization: { ...authorization(), probeState: "failed" } })]);
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue({
      probeState: "succeeded",
      probeError: null,
      toolsCount: 0,
      toolsTruncated: false,
      protocolEra: null,
      protocolVersion: null,
    });
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openTools();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
    expect(update).not.toHaveBeenCalled();
  });
});

describe("MCP tools OAuth error consumption", () => {
  it("does not revive an old sign-in error after returning through details", async () => {
    rememberMcpReturn({ agentId: AGENT_ID, serverId: SERVER_ID, source: "tools", query: "issue" });
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=error&server=${SERVER_ID}`);
    stub([entry({ authorization: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("dialog", { name: "Authentication" });
    expect(screen.getByText("Sign-in was not completed. Try again.")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect((screen.getByLabelText("Search tools") as HTMLInputElement).value).toBe("issue");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reconnect" }));
    await screen.findByRole("dialog", { name: "Authentication" });
    expect(screen.queryByText("Sign-in was not completed. Try again.")).toBeNull();
  });
});
