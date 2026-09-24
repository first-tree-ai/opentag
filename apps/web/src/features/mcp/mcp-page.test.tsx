import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, entry, menuAction, SERVER_ID, snapshot, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("MCP daily use", () => {
  it("keeps normal rows quiet and refresh inside the tool browser", async () => {
    stub([entry({ discoveredDescription: "Long server-provided description" })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
    expect(screen.getByRole("button", { name: "Refresh tools" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close linear tools" }));
    expect(screen.queryByText("Long server-provided description")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh tools" })).toBeNull();
    await menuAction("Server details");
    expect(await screen.findByText("Long server-provided description")).toBeTruthy();
  });
  it.each(["pending", "expired", "revoked", "error"] as const)(
    "shows an authorization action for %s",
    async (status) => {
      stub([entry({ authorization: { ...authorization(), status } })]);
      wrap(<McpPage agentId={AGENT_ID} />);
      expect(await screen.findByRole("button", { name: "Authorize" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "View saved tools" })).toBeTruthy();
    },
  );
  it("does not turn a disabled connection into an authorization error", async () => {
    stub([entry({ enabled: false, authorization: null, snapshot: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Disabled for Reviewer · Settings kept")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Allow Reviewer to use linear" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.queryByRole("button", { name: "Authorize" })).toBeNull();
    await menuAction("Authentication");
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
    expect(await within(toggle.closest("li") as HTMLElement).findByText("Cannot change this connection")).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Try later")).toBeTruthy();
    expect(probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
    expect(screen.queryByRole("button", { name: "Authorize" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View tools" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Error details" }));
    expect(await screen.findByText("MCP_PROBE_FAILED: upstream limit")).toBeTruthy();
  });
  it("shows a real pending probe even before its first timestamp", async () => {
    stub([entry({ snapshot: null, authorization: { ...authorization(), probeState: "pending", probedAt: null } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Loading tools…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View tools" })).toBeNull();
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
  it("shows tool truncation only as a disclosure", async () => {
    stub([entry({ authorization: { ...authorization(), toolsCount: 200, toolsTruncated: true } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("200 tools loaded")).toBeTruthy();
    const disclosure = screen.getByRole("button", { name: "Some tools weren’t loaded" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });
  it("shows tools as static descriptions without row actions or parameter schemas", async () => {
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
    const search = screen.getByRole("textbox", { name: "Search tools" }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "needle" } });
    const tool = screen.getByRole("listitem", { name: "search_docs" });
    const excerpt = within(tool).getByText(/needle/).textContent ?? "";
    expect(excerpt).toMatch(/^…/);
    expect(excerpt.indexOf("needle")).toBeLessThanOrEqual(17);
    expect(within(tool).queryByRole("button")).toBeNull();
    expect(search.value).toBe("needle");
    fireEvent.change(search, { target: { value: "" } });
    expect(within(tool).getByText(/Provider introduction/).textContent).toBe(description);
  });
  it("does not invent an action for a tool without a description or schema", async () => {
    stub([entry({ snapshot: { ...snapshot(), tools: [{ name: "ping", description: null, inputSchema: null }] } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
    expect(screen.getByText("An incomplete response was received. No tools were saved.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tools" }), { target: { value: "query" } });
    expect(screen.getByText("No matching tools")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("No tools loaded")).toBeTruthy();
  });
  it("uses the last saved label without a misleading last-success timestamp", async () => {
    stub([
      entry({
        authorization: { ...authorization(), probeState: "failed", probedAt: "2026-09-20T00:00:00.000Z" },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "View saved tools" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
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
    await menuAction("Remove from this Agent");
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
    await menuAction(kind === "remove" ? "Remove from this Agent" : "Revoke access");
    fireEvent.click(screen.getByRole("button", { name: kind === "remove" ? "Remove" : "Revoke access" }));
    expect(await screen.findByText("Action unavailable")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
  it("does not offer revoke for a no-credential authorization", async () => {
    stub([entry({ authorization: { ...authorization(), kind: "none", hasCredential: false } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for linear" }));
    expect(screen.queryByRole("menuitem", { name: "Revoke access" })).toBeNull();
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
});
