import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { rememberMcpReturn } from "./mcp-return-context.js";
import { AGENT_ID, authorization, detail, entry, openAdd, openDetails, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("MCP connector list", () => {
  it("keeps a normal row quiet and opens details from its identity or menu", async () => {
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    const row = (await screen.findByRole("button", { name: "linear" })).closest("li") as HTMLElement;
    expect(within(row).queryByText(/Connected|3 tools|Disabled/)).toBeNull();
    expect(within(row).queryByRole("button", { name: /Retry|Authorize|View error/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions for linear" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Details", "Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    await screen.findByRole("dialog", { name: "linear" });
    expect(screen.queryByRole("button", { name: /Tools|Clear credentials|Delete/ })).toBeNull();
  });
  it("opens Details from the description and keeps the controls separate", async () => {
    stub([entry({ description: "Find team issues." })]);
    vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry({ enabled: false }));
    wrap(<McpPage agentId={AGENT_ID} />);
    const identity = await screen.findByRole("button", { name: "linear" });
    expect(identity.getAttribute("aria-describedby")).toBe(`mcp-server-${entry().mcpServerId}-description`);
    expect(identity.contains(screen.getByText("Find team issues."))).toBe(true);
    expect(identity.contains(screen.getByRole("switch"))).toBe(false);
    fireEvent.click(screen.getByText("Find team issues."));
    await screen.findByRole("dialog", { name: "linear" });
    fireEvent.click(screen.getByRole("button", { name: "Close linear" }));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(browserApi.updateAgentMcpServer).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it.each([
    ["expired", null, "Authorization expired"],
    ["error", "MCP_OAUTH_TOKEN_INVALID", "Authorization failed"],
  ] as const)("shows the known reason for %s", async (status, failureCode, label) => {
    stub([entry({ authorization: { ...authorization(), status, failureCode } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    const reason = await screen.findByText(label);
    expect(reason.closest("button")?.getAttribute("aria-label")).toBe("linear");
    expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
    await openDetails();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });
  it("does not call a local credential reset a provider revocation", async () => {
    stub([
      entry({ authorization: { ...authorization(), status: "revoked", hasCredential: false, failureCode: null } }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Authorization required")).toBeTruthy();
    expect(screen.queryByText(/revoked|Not connected/)).toBeNull();
  });
  it("uses only the switch to show a disabled connector", async () => {
    stub([entry({ enabled: false, authorization: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("Disabled")).toBeNull();
    expect(screen.queryByRole("button", { name: /Authorize|Retry/ })).toBeNull();
    await openDetails();
  });
  it("guards duplicate toggles and shows an inline failure without an error popover", async () => {
    stub([entry()]);
    let reject: (error: Error) => void = () => {};
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(true));
    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledTimes(1);
    reject(new ApiError(503, "Cannot change this connection"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cannot change this connection");
    expect(screen.queryByRole("button", { name: /View error/ })).toBeNull();
  });
  it("shows loading only while a tool probe is pending", async () => {
    stub([entry({ authorization: { ...authorization(), probeState: "pending", probedAt: null } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Loading tools…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
  it("keeps the list and Details quiet when saved tools are being refreshed", async () => {
    stub([entry({ authorization: { ...authorization(), kind: "oauth", probeState: "pending" } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("button", { name: "linear" });
    expect(screen.queryByText("Loading tools…")).toBeNull();
    await openDetails();
    expect(screen.getByRole("button", { name: "Reauthorize" })).toBeTruthy();
    expect(screen.queryByText("Loading tools…")).toBeNull();
  });
  it("treats a completed empty tool list as a neutral result", async () => {
    stub([entry({ authorization: { ...authorization(), toolsCount: 0 } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("No tools available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry|Authorize/ })).toBeNull();
  });
  it("uses a partial tool list without extra disclosure", async () => {
    stub([entry({ authorization: { ...authorization(), toolsTruncated: true } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    expect(screen.queryByText(/incomplete|truncated|3 tools/i)).toBeNull();
  });
  it("does not confuse a read failure with an empty list", async () => {
    stub([]);
    vi.mocked(browserApi.agentMcpServers).mockRejectedValue(new ApiError(503, "MCP unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("MCP unavailable")).toBeTruthy();
    expect(screen.queryByText("No connectors yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("offers Discover and Add custom from an empty list", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("heading", { name: "No connectors yet" });
    expect(screen.getByRole("button", { name: "Discover" })).toBeTruthy();
    await openAdd();
    expect(screen.getByRole("dialog", { name: "Add custom connector" })).toBeTruthy();
  });
});

describe("MCP authorization returns", () => {
  it("restores Discover search from the first render after same-tab authorization", async () => {
    rememberMcpReturn({ agentId: AGENT_ID, serverId: entry().mcpServerId, source: "discover", query: "Linear" });
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=success&server=${entry().mcpServerId}`);
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    const dialog = await screen.findByRole("dialog", { name: "Discover" });
    await waitFor(() =>
      expect((within(dialog).getByLabelText("Search connectors") as HTMLInputElement).value).toBe("Linear"),
    );
  });
  it.each(["bearer", "none"] as const)(
    "preserves an installed preset's %s definition before its first authorization",
    async (kind) => {
      const row = entry({
        name: "linear",
        authorization: null,
        effective: { ...entry().effective, url: "https://mcp.linear.app/mcp", extraHeaders: {} },
      });
      const metadata = detail(1);
      stub([row], { ...metadata, server: { ...metadata.server, url: row.effective.url, defaultAuthKind: kind } });
      const oauth = vi.spyOn(browserApi, "startMcpOAuth");
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDetails("Linear");
      const dialog = await screen.findByRole("dialog", { name: "Linear" });
      if (kind === "bearer")
        await within(dialog).findByLabelText("API key or token", { selector: "input[type=password]" });
      else {
        await within(dialog).findByText("No authentication");
        expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
      }
      expect(oauth).not.toHaveBeenCalled();
    },
  );
  it("clears a successful OAuth return without displaying a connected badge", async () => {
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=success&server=${entry().mcpServerId}`);
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await screen.findByRole("button", { name: "linear" });
    expect(window.location.search).toBe("");
    expect(screen.queryByText("Connected")).toBeNull();
    expect(browserApi.imBinding).not.toHaveBeenCalled();
  });
  it("does not expose unknown OAuth failure codes", async () => {
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=error&mcp_oauth_error=ARBITRARY`);
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Authorization failed")).toBeTruthy();
    expect(screen.queryByText(/ARBITRARY/)).toBeNull();
  });
  it("returns a failed detail authorization to the same inline authentication section", async () => {
    rememberMcpReturn({ agentId: AGENT_ID, serverId: entry().mcpServerId, source: "edit" });
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=error&server=${entry().mcpServerId}`);
    stub([entry({ authorization: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    const dialog = await screen.findByRole("dialog", { name: "linear" });
    expect(await within(dialog).findByText("Authorization failed")).toBeTruthy();
    expect(within(dialog).getByLabelText("Connector address")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Back" })).toBeNull();
  });
});
