import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpAddDialog } from "./mcp-add-dialog.js";
import { McpPage } from "./mcp-page.js";
import {
  AGENT_ID,
  detail,
  entry,
  newAddress,
  OTHER_AGENT_ID,
  openAdd,
  SERVER_ID,
  stub,
  wrap,
} from "./mcp-test-fixtures.js";

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
describe("URL and configured connectors", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
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
  it("keeps choices collapsed, selects without connecting, and clears selection on editing", async () => {
    stub([]);
    const a = detail(0).server;
    const b = { ...a, id: "44444444-4444-4444-8444-444444444444", name: "docs", url: "https://docs.example.com/mcp" };
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [a, b] });
    const calls = writes();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    const picker = await screen.findByRole("button", { name: "Choose a configured connector (2)" });
    expect(picker.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /linear.*https/ })).toBeNull();
    fireEvent.click(picker);
    expect(picker.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByLabelText("Search connectors")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /linear.*https/ }));
    expect((screen.getByLabelText("Connector URL") as HTMLInputElement).value).toBe(a.url);
    const selected = screen.getByRole("button", { name: "Selected: linear · Change" });
    expect(selected.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(selected);
    expect(screen.queryByRole("button", { name: /linear.*https/ })).toBeNull();
    fireEvent.click(selected);
    expect(screen.getByRole("button", { name: /linear.*https/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /docs.*https/ }));
    expect((screen.getByLabelText("Connector URL") as HTMLInputElement).value).toBe(b.url);
    expect(screen.getByRole("button", { name: "Selected: docs · Change" }).getAttribute("aria-expanded")).toBe("false");
    writeUrl("https://new.example.com/mcp");
    fireEvent.click(screen.getByRole("button", { name: "Choose a configured connector (2)" }));
    expect(screen.getByRole("button", { name: /docs.*https/ }).getAttribute("aria-pressed")).toBe("false");
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.attach).not.toHaveBeenCalled();
    expect(calls.auth).not.toHaveBeenCalled();
  });
  it("offers every configured connector in one list without search or recent shortcuts", async () => {
    stub([]);
    const servers = Array.from({ length: 8 }, (_, i) => ({
      ...detail(0).server,
      id: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
      name: `tools-${i}`,
      url: `https://tools-${i}.example.com/mcp`,
      createdAt: `2026-09-${String(i + 10).padStart(2, "0")}T00:00:00.000Z`,
    }));
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    const picker = await screen.findByRole("button", { name: "Choose a configured connector (8)" });
    fireEvent.click(picker);
    expect(screen.getAllByRole("button", { name: /tools-.*https/ })).toHaveLength(8);
    expect(screen.queryByLabelText("Search connectors")).toBeNull();
    fireEvent.click(picker);
    expect(screen.queryByRole("button", { name: /tools-.*https/ })).toBeNull();
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: /tools-0.*https/ }));
    expect(screen.getByRole("button", { name: "Selected: tools-0 · Change" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect((screen.getByLabelText("Connector URL") as HTMLInputElement).value).toBe(servers[0]?.url);
  });
  it("preloads the pool before opening and offers retry when loading fails", async () => {
    stub([]);
    let reject: (reason: unknown) => void = () => {};
    vi.mocked(browserApi.mcpServers).mockReturnValue(
      new Promise((_resolve, r) => {
        reject = r;
      }),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    const add = await screen.findByRole("button", { name: "Add custom" });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    reject(new Error("offline"));
    await newAddress();
    expect(await screen.findByText("Couldn’t load connectors.")).toBeTruthy();
    expect((screen.getByLabelText("Connector URL") as HTMLInputElement).value).toBe("https://mcp.example.com/mcp");
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [detail(0).server] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Choose a configured connector (1)" })).toBeTruthy();
    expect(screen.queryByText("Couldn’t load connectors.")).toBeNull();
    expect((screen.getByLabelText("Connector URL") as HTMLInputElement).value).toBe("https://mcp.example.com/mcp");
  });
  it("lets an ambiguous URL be resolved through the configured connector list", async () => {
    stub([]);
    const servers = Array.from({ length: 6 }, (_, i) => ({
      ...detail(0).server,
      id: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
      name: `service-${i}`,
      url: i < 2 ? "https://shared.example.com/mcp" : `https://service-${i}.example.com/mcp`,
      createdAt: `2026-09-${String(i + 10).padStart(2, "0")}T00:00:00.000Z`,
    }));
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers });
    const calls = writes();
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress("https://shared.example.com/mcp");
    connect();
    await screen.findByText("Choose an existing connector for this URL.");
    fireEvent.click(screen.getByRole("button", { name: "Choose a configured connector (6)" }));
    fireEvent.click(screen.getByRole("button", { name: /service-0.*https/ }));
    expect(screen.getByRole("button", { name: "Selected: service-0 · Change" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.attach).not.toHaveBeenCalled();
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
  it("does not replace an edited URL when an OAuth return's server pool arrives late", async () => {
    stub([]);
    let resolve: (value: { servers: ReturnType<typeof detail>["server"][] }) => void = () => {};
    vi.mocked(browserApi.mcpServers).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    wrap(
      <McpAddDialog
        agentId={AGENT_ID}
        agentName="Reviewer"
        mounted={[entry()]}
        initialServerId={SERVER_ID}
        onClose={vi.fn()}
        onAdded={vi.fn()}
        onLocate={vi.fn()}
      />,
    );
    await screen.findByLabelText("Connector URL");
    writeUrl("https://new.example.com/mcp");
    resolve({ servers: [detail(1).server] });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading connectors" })).toBeNull());
    expect(screen.queryByRole("button", { name: "linear" })).toBeNull();
    expect((screen.getByLabelText("Connector URL") as HTMLInputElement).value).toBe("https://new.example.com/mcp");
  });
  it.each([
    ["connected", entry()],
    ["disabled", entry({ enabled: false })],
    ["not connected", entry({ authorization: null })],
  ] as const)("hides the picker when every existing server is already in this Agent (%s)", async (_status, mounted) => {
    stub([mounted]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [detail(1).server] });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByRole("button", { name: /Choose a configured connector/ })).toBeNull();
    expect(dialog.queryByRole("button", { name: "linear" })).toBeNull();
    expect(dialog.getByLabelText("Connector URL")).toBeTruthy();
  });
  it("excludes mounted services from the count and list while keeping choices text-only", async () => {
    const servers = Array.from({ length: 6 }, (_, i) => ({
      ...detail(1).server,
      id: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
      name: `service-${i}`,
      url: `https://service-${i}.example.com/mcp`,
    }));
    const mounted = servers[0];
    if (!mounted) throw new Error("Missing mounted service");
    stub([entry({ mcpServerId: mounted.id })]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Choose a configured connector (5)" }));
    expect(dialog.queryByRole("button", { name: /service-0.*https/ })).toBeNull();
    expect(dialog.getAllByRole("button", { name: /service-.*https/ })).toHaveLength(5);
    expect(dialog.getByRole("button", { name: /service-1.*https/ }).querySelector("svg, img")).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: /service-5.*https/ }));
    expect(dialog.getByRole("button", { name: "Selected: service-5 · Change" })).toBeTruthy();
    expect((dialog.getByLabelText("Connector URL") as HTMLInputElement).value).toBe(servers[5]?.url);
  });
  it("collects a known API key only after Connect, without creating a new definition", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({
      servers: [{ ...detail(0).server, defaultAuthKind: "bearer" }],
    });
    const calls = writes();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    fireEvent.click(await screen.findByRole("button", { name: "Choose a configured connector (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /linear.*https/ }));
    expect(screen.queryByLabelText("API key")).toBeNull();
    connect();
    const input = await screen.findByLabelText("API key");
    expect(input.getAttribute("type")).toBe("password");
    expect(calls.attach).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "agent-key" } });
    connect();
    await waitFor(() =>
      expect(calls.auth).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "agent-key" }),
    );
    expect(calls.create).not.toHaveBeenCalled();
  });
  it("reuses the configuration for another Agent and retries OAuth without another bind", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [detail(1).server] });
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
    fireEvent.click(await screen.findByRole("button", { name: "Choose a configured connector (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /linear.*https/ }));
    connect();
    await screen.findByText(/Couldn’t start sign-in/);
    connect();
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
    expect(oauth).toHaveBeenLastCalledWith(OTHER_AGENT_ID, SERVER_ID, {});
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.attach).toHaveBeenCalledTimes(1);
    expect(calls.auth).not.toHaveBeenCalled();
    expect(screen.queryByText("private upstream detail")).toBeNull();
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
    vi.mocked(browserApi.mcpServers).mockResolvedValue({
      servers: [{ ...detail(0).server, defaultAuthKind: "bearer" }],
    });
    const calls = writes();
    calls.probe.mockResolvedValue({
      ...ready,
      probeState: "failed",
      probeError: `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`,
      toolsCount: null,
    });
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    fireEvent.click(await screen.findByRole("button", { name: "Choose a configured connector (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /linear.*https/ }));
    connect();
    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "wrong-key" } });
    connect();
    await screen.findByText("Invalid API key. Try again.");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("wrong-key");
    expect(oauth).not.toHaveBeenCalled();
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
