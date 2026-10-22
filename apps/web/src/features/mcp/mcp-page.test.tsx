import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { rememberMcpReturn } from "./mcp-return-context.js";
import { AGENT_ID, authorization, detail, entry, openAdd, openDetails, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("MCP connector list", () => {
  it("keeps a normal row quiet with one settings entry and a direct Remove action", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    const row = (await screen.findByRole("button", { name: "linear" }, { timeout: 10000 })).closest(
      "li",
    ) as HTMLElement;
    expect(within(row).queryByText(/Connected|3 tools|Disabled/)).toBeNull();
    expect(within(row).queryByRole("button", { name: /Retry|Authorize|Resume|More actions/ })).toBeNull();
    expect(within(row).queryByRole("switch")).toBeNull();
    expect(within(row).getByRole("button", { name: "Remove linear" })).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    await openDetails();
    const dialog = screen.getByRole("dialog", { name: "linear" });
    expect(within(dialog).queryByRole("button", { name: /Tools|Clear credentials|Remove/ })).toBeNull();
  });
  it("opens settings from the description and keeps Remove separate", async () => {
    stub([entry({ description: "Find team issues." })]);
    const detach = vi.spyOn(browserApi, "detachMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    const identity = await screen.findByRole("button", { name: "linear" });
    expect(identity.getAttribute("aria-describedby")).toBe(`mcp-server-${entry().mcpServerId}-description`);
    expect(identity.contains(screen.getByText("Find team issues."))).toBe(true);
    expect(identity.contains(screen.getByRole("button", { name: "Remove linear" }))).toBe(false);
    fireEvent.click(screen.getByText("Find team issues."));
    await screen.findByRole("dialog", { name: "linear" });
    fireEvent.click(screen.getByRole("button", { name: "Close linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove linear" }));
    await screen.findByRole("alertdialog", { name: "Remove linear?" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(detach).not.toHaveBeenCalled();
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
  it("shows disabled mounts quietly without silently enabling them", async () => {
    stub([entry({ enabled: false, authorization: null })]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Disabled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume: linear" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove linear" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Authorization required")).toBeNull();
    expect(update).not.toHaveBeenCalled();
    await openDetails();
    expect(update).not.toHaveBeenCalled();
  });
  it.each(["active", "expired", "missing", "probe-failed"] as const)(
    "resumes a mount and exposes its actual %s authorization result",
    async (state) => {
      const auth = authorization();
      const resumed = entry({
        authorization:
          state === "missing"
            ? null
            : state === "probe-failed"
              ? { ...auth, probeState: "failed", probeError: "MCP_UPSTREAM_UNAVAILABLE: timeout" }
              : { ...auth, status: state },
      });
      stub([{ ...resumed, enabled: false }]);
      const authorize = vi.spyOn(browserApi, "setMcpAuthorization");
      const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(async () => {
        vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [resumed] });
        return resumed;
      });
      wrap(<McpPage agentId={AGENT_ID} />);
      const resume = await screen.findByRole("button", { name: "Resume: linear" });
      resume.focus();
      fireEvent.click(resume);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Resume: linear" })).toBeNull());
      expect(update).toHaveBeenCalledExactlyOnceWith(AGENT_ID, resumed.mcpServerId, { enabled: true });
      expect(authorize).not.toHaveBeenCalled();
      expect(screen.queryByText("Disabled")).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "linear" })));
      const label = {
        active: null,
        expired: "Authorization expired",
        missing: "Authorization required",
        "probe-failed": "Request timed out",
      }[state];
      if (label) expect(screen.getByText(label)).toBeTruthy();
      else expect(screen.queryByRole("alert")).toBeNull();
    },
  );
  it("guards duplicate resumes and retains the mount after failure, allowing retry", async () => {
    stub([entry({ enabled: false })]);
    let reject: (error: Error) => void = () => {};
    const update = vi
      .spyOn(browserApi, "updateAgentMcpServer")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockImplementationOnce(async () => {
        vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [entry()] });
        return entry();
      });
    wrap(<McpPage agentId={AGENT_ID} />);
    const resume = await screen.findByRole("button", { name: "Resume: linear" });
    fireEvent.click(resume);
    await waitFor(() => expect(resume.hasAttribute("disabled")).toBe(true));
    expect(screen.getByRole("button", { name: "Remove linear" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(resume);
    expect(update).toHaveBeenCalledTimes(1);
    reject(new ApiError(503, "Cannot change this connection"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cannot change this connection");
    await waitFor(() => expect(resume.hasAttribute("disabled")).toBe(false));
    fireEvent.click(resume);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume: linear" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(update).toHaveBeenCalledTimes(2);
  });
  it("does not steal focus when settings opens while Resume is pending", async () => {
    stub([entry({ enabled: false })]);
    let finish: (value: ReturnType<typeof entry>) => void = () => {};
    vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    wrap(<McpPage agentId={AGENT_ID} />);
    const resume = await screen.findByRole("button", { name: "Resume: linear" });
    resume.focus();
    fireEvent.click(resume);
    await openDetails();
    const dialog = screen.getByRole("dialog", { name: "linear" });
    const close = within(dialog).getByRole("button", { name: "Close linear" });
    close.focus();
    vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [entry()] });
    finish(entry());
    await waitFor(() => expect(resume.isConnected).toBe(false));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(close);
  });
  it("shows loading only while a tool probe is pending", async () => {
    stub([entry({ authorization: { ...authorization(), probeState: "pending", probedAt: null } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    expect(await screen.findByText("Checking connection…")).toBeTruthy();
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
