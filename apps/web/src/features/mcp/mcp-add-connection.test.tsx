import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpAddDialog } from "./mcp-add-dialog.js";
import { McpPage } from "./mcp-page.js";
import {
  AGENT_ID,
  authorization,
  detail,
  entry,
  newAddress,
  OTHER_AGENT_ID,
  SERVER_ID,
  stub,
  wrap,
} from "./mcp-test-fixtures.js";

vi.mock("@opentag/mcp-presets", () => ({
  MCP_CATALOG_ENTRIES: [
    {
      id: "linear",
      name: "linear",
      url: "https://mcp.linear.app/sse",
      defaultAuthKind: "oauth",
      title: { en: "Linear", zh: "Linear" },
      description: { en: "Issues", zh: "工单" },
    },
    {
      id: "keys",
      name: "keys",
      url: "https://keys.example.com/mcp",
      defaultAuthKind: "bearer",
      title: { en: "Keys", zh: "密钥" },
      description: { en: "Tools", zh: "工具" },
    },
  ],
  MCP_CATALOG_CATEGORIES: [],
}));

afterEach(() => vi.restoreAllMocks());
const connect = () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
const writeUrl = (value: string) => fireEvent.change(screen.getByLabelText("Connector URL"), { target: { value } });
const ready = {
  probeState: "succeeded" as const,
  probeError: null,
  toolsCount: 3,
  toolsTruncated: false,
  protocolEra: "modern" as const,
  protocolVersion: "2026-07-28",
};
function writes() {
  const create = vi
    .spyOn(browserApi, "createMcpServer")
    .mockImplementation(async (input) => ({ ...detail(0).server, ...input, extraHeaders: {} }));
  const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry({ authorization: null }));
  const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
  const probe = vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue(ready);
  return { create, attach, auth, probe };
}
describe("Independent URL connector installation", () => {
  it("keeps the first-use form minimal and writes nothing on input or cancel", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
    for (const name of [
      "Discover",
      "Configure manually",
      "Import configuration",
      "Use an existing connector",
      "Continue",
      "Advanced settings",
      "Authentication",
    ])
      expect(within(screen.getByRole("dialog")).queryByRole("button", { name })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Add custom connector" }));
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    "example.com/mcp",
    "https:///example.com/mcp",
    "https://example.com\\mcp",
    "https://a.test/mcp https://b.test/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/mcp#tools",
    '{"url":"https://example.com/mcp"}',
    "claude mcp add tools https://example.com/mcp",
  ])("rejects a non-endpoint input: %s", async (value) => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress(value);
    connect();
    expect(await screen.findByText("Enter a complete connector URL.")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });
  it("does not offer account configurations or require the account pool to load", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockRejectedValue(new Error("offline"));
    const calls = writes();
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    expect(screen.queryByRole("button", { name: /Choose a configured connector/ })).toBeNull();
    connect();
    await waitFor(() => expect(calls.create).toHaveBeenCalledTimes(1));
    expect(browserApi.mcpServers).not.toHaveBeenCalled();
  });
  it("creates an independent configuration even when the account has the same URL", async () => {
    stub([]);
    const existing = { ...detail(1).server, name: "docs-example", url: "https://docs.example.com/mcp" };
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [existing] });
    const calls = writes();
    calls.create.mockRejectedValueOnce(new ApiError(409, "Name exists", "MCP_SERVER_NAME_CONFLICT"));
    const freshId = "44444444-4444-4444-8444-444444444444";
    calls.create.mockResolvedValueOnce({ ...existing, id: freshId, name: "docs-example-2" });
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress(existing.url);
    connect();
    await waitFor(() => expect(calls.attach).toHaveBeenCalled());
    expect(calls.create).toHaveBeenNthCalledWith(2, {
      name: "docs-example-2",
      url: existing.url,
      defaultAuthKind: "none",
    });
    expect(calls.attach).toHaveBeenCalledWith(AGENT_ID, { mcpServerId: freshId, enabled: true });
  });
  it("creates, binds, and probes a new anonymous service through the existing APIs", async () => {
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
    stub([]);
    const calls = writes();
    calls.auth.mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [entry()] });
      return entry();
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress("  https://docs.example.com/mcp  ");
    connect();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.create).toHaveBeenCalledWith({
      name: "docs-example",
      url: "https://docs.example.com/mcp",
      defaultAuthKind: "none",
    });
    expect(calls.auth).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "none" });
    expect(calls.probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
    expect(await screen.findByText("Connected")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe(`mcp-server-${SERVER_ID}`));
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(screen.queryByText("linear added to Reviewer")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("link", { name: "Message channel settings" })).toBeNull();
  });
  it("does not replace an edited URL when an OAuth return's definition arrives late", async () => {
    stub([]);
    let resolve: (value: ReturnType<typeof detail>) => void = () => {};
    vi.mocked(browserApi.mcpServer).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    wrap(
      <McpAddDialog
        agentId={AGENT_ID}
        agentName="Reviewer"
        mounted={[]}
        initialServerId={SERVER_ID}
        onClose={vi.fn()}
        onAdded={vi.fn()}
        onLocate={vi.fn()}
      />,
    );
    await screen.findByLabelText("Connector URL");
    writeUrl("https://new.example.com/mcp");
    resolve(detail(1));
    await waitFor(() => expect(browserApi.mcpServer).toHaveBeenCalled());
    expect((screen.getByLabelText("Connector URL") as HTMLInputElement).value).toBe("https://new.example.com/mcp");
  });
  it.each(["pending", "failed"] as const)(
    "allows a new URL after abandoning a %s OAuth return lookup",
    async (lookup) => {
      stub([]);
      const calls = writes();
      vi.mocked(browserApi.mcpServer).mockImplementation(() =>
        lookup === "pending"
          ? new Promise(() => {})
          : Promise.reject(new ApiError(404, "Installation removed", "MCP_SERVER_NOT_FOUND")),
      );
      const onAdded = vi.fn();
      wrap(
        <McpAddDialog
          agentId={AGENT_ID}
          agentName="Reviewer"
          mounted={[]}
          initialServerId={SERVER_ID}
          onClose={vi.fn()}
          onAdded={onAdded}
          onLocate={vi.fn()}
        />,
      );
      await waitFor(() => expect(browserApi.mcpServer).toHaveBeenCalledWith(SERVER_ID));
      if (lookup === "failed") await screen.findByText("Couldn’t load connectors.");
      writeUrl("https://new.example.com/mcp");
      await waitFor(() => expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(false));
      connect();
      await waitFor(() => expect(onAdded).toHaveBeenCalled());
      expect(calls.create).toHaveBeenCalledWith({
        name: "new-example",
        url: "https://new.example.com/mcp",
        defaultAuthKind: "none",
      });
    },
  );
  it.each([entry(), entry({ enabled: false }), entry({ authorization: null })])(
    "locates the current Agent's existing connector instead of creating a duplicate",
    async (mounted) => {
      stub([mounted]);
      const calls = writes();
      const locate = vi.fn();
      wrap(
        <McpAddDialog
          agentId={AGENT_ID}
          agentName="Reviewer"
          mounted={[mounted]}
          onClose={vi.fn()}
          onAdded={vi.fn()}
          onLocate={locate}
        />,
      );
      await screen.findByLabelText("Connector URL");
      writeUrl(mounted.effective.url);
      connect();
      await waitFor(() => expect(locate).toHaveBeenCalledWith(SERVER_ID));
      expect(calls.create).not.toHaveBeenCalled();
      expect(calls.attach).not.toHaveBeenCalled();
      expect(calls.auth).not.toHaveBeenCalled();
    },
  );
  it("locates an installed catalog service when the pasted URL has connection parameters", async () => {
    const mounted = entry();
    stub([mounted]);
    const calls = writes();
    const locate = vi.fn();
    wrap(
      <McpAddDialog
        agentId={AGENT_ID}
        agentName="Reviewer"
        mounted={[mounted]}
        onClose={vi.fn()}
        onAdded={vi.fn()}
        onLocate={locate}
      />,
    );
    await screen.findByLabelText("Connector URL");
    writeUrl("https://mcp.linear.app/sse/?workspace=demo");
    connect();
    await waitFor(() => expect(locate).toHaveBeenCalledWith(SERVER_ID));
    expect(calls.create).not.toHaveBeenCalled();
  });
  it("locates a historical installation through its own overridden definition", async () => {
    const mounted = entry({
      effective: { ...entry().effective, url: "https://custom.example.com/mcp" },
      overridden: { ...entry().overridden, url: true },
    });
    stub([mounted]);
    const calls = writes();
    const locate = vi.fn();
    wrap(
      <McpAddDialog
        agentId={AGENT_ID}
        agentName="Reviewer"
        mounted={[mounted]}
        onClose={vi.fn()}
        onAdded={vi.fn()}
        onLocate={locate}
      />,
    );
    await screen.findByLabelText("Connector URL");
    writeUrl("https://mcp.linear.app/sse");
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(false));
    connect();
    await waitFor(() => expect(locate).toHaveBeenCalledWith(SERVER_ID));
    expect(calls.create).not.toHaveBeenCalled();
    expect(browserApi.mcpServers).not.toHaveBeenCalled();
  });
  it("creates another Agent's own configuration and retries OAuth without another create or bind", async () => {
    stub([]);
    const calls = writes();
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "private upstream detail"));
    wrap(
      <McpAddDialog
        agentId={OTHER_AGENT_ID}
        agentName="Helper"
        mounted={[]}
        onClose={vi.fn()}
        onAdded={vi.fn()}
        onLocate={vi.fn()}
      />,
    );
    await screen.findByLabelText("Connector URL");
    writeUrl("https://mcp.linear.app/sse");
    connect();
    await screen.findByText(/Couldn’t start sign-in/);
    connect();
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
    expect(oauth).toHaveBeenLastCalledWith(OTHER_AGENT_ID, SERVER_ID, {});
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.attach).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("private upstream detail")).toBeNull();
  });
  it("collects a preset API key only after Connect and creates a new definition", async () => {
    stub([]);
    const calls = writes();
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress("https://keys.example.com/mcp");
    expect(screen.queryByLabelText("API key")).toBeNull();
    connect();
    const input = await screen.findByLabelText("API key");
    expect(input.getAttribute("type")).toBe("password");
    expect(calls.create).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "agent-key" } });
    connect();
    await waitFor(() =>
      expect(calls.auth).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "agent-key" }),
    );
    expect(calls.create).toHaveBeenCalledTimes(1);
  });
  it("retries attachment without creating another configuration", async () => {
    stub([]);
    const calls = writes();
    calls.attach.mockRejectedValueOnce(new ApiError(503, "offline"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    connect();
    await screen.findByText(/Couldn’t connect/);
    connect();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.create).toHaveBeenCalledTimes(1);
  });
  it("starts OAuth after anonymous access is explicitly rejected, without guessing a key", async () => {
    stub([]);
    const calls = writes();
    calls.probe.mockResolvedValue({
      ...ready,
      probeState: "failed",
      probeError: `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`,
      toolsCount: null,
    });
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(502, "unknown auth"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    connect();
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(screen.queryByLabelText("API key")).toBeNull();
  });
  it("keeps a rejected bearer key editable and reports the credential error without starting OAuth", async () => {
    stub([]);
    const calls = writes();
    calls.probe.mockResolvedValue({
      ...ready,
      probeState: "failed",
      probeError: `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`,
      toolsCount: null,
    });
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress("https://keys.example.com/mcp");
    connect();
    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "wrong-key" } });
    connect();
    await screen.findByText("Invalid API key. Try again.");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("wrong-key");
    expect(oauth).not.toHaveBeenCalled();
  });
  it("does not locate its own temporary installation after the URL is edited away and back", async () => {
    stub([]);
    const calls = writes();
    const failed = entry({
      effective: { ...entry().effective, url: "https://keys.example.com/mcp" },
      authorization: { ...authorization(), probeState: "failed" },
    });
    let mounted = [] as ReturnType<typeof entry>[];
    vi.mocked(browserApi.agentMcpServers).mockImplementation(async () => ({ servers: [...mounted] }));
    calls.attach.mockImplementation(async () => {
      mounted = [failed];
      return failed;
    });
    calls.auth.mockResolvedValue(failed);
    calls.probe.mockResolvedValueOnce({
      ...ready,
      probeState: "failed",
      probeError: `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`,
      toolsCount: null,
    });
    vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async () => {
      mounted = [];
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress("https://keys.example.com/mcp");
    connect();
    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "wrong-key" } });
    connect();
    await screen.findByText("Invalid API key. Try again.");
    await waitFor(() => expect(screen.queryByText("No connectors yet")).toBeNull());
    writeUrl("https://keys.example.com/mc");
    writeUrl("https://keys.example.com/mcp");
    connect();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "valid-key" } });
    connect();
    await waitFor(() => expect(calls.create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.auth).toHaveBeenLastCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "valid-key" });
  });
  it.each([
    { ...ready, probeState: "failed" as const, probeError: "offline", message: "Couldn’t load tools. Try again." },
    {
      ...ready,
      probeState: "failed" as const,
      probeError: `${MCP_ERROR_CODES.PROBE_FAILED}: ${MCP_AUTH_REJECTION_SUMMARY}`,
      message: "Couldn’t load tools. Try again.",
    },
    { ...ready, toolsCount: 0, message: "This connector has no available tools." },
  ])("does not claim readiness when $message", async (result) => {
    stub([]);
    const calls = writes();
    calls.probe.mockResolvedValue(result);
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    connect();
    expect(await screen.findByText(result.message)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
