import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES, type MCPAgentServer } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpAddDialog } from "./mcp-add-dialog.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, detail, entry, newAddress, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const connect = () =>
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^(Connect|Retry)$/ }));
const method = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const ready = {
  probeState: "succeeded" as const,
  probeError: null,
  toolsCount: 3,
  toolsTruncated: false,
  protocolEra: "modern" as const,
  protocolVersion: "2026-07-28",
};
function writes() {
  let binding = entry({ authorization: null });
  let mounted: MCPAgentServer[] = [];
  vi.mocked(browserApi.agentMcpServers).mockImplementation(async () => ({ servers: mounted }));
  const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(async (input) => {
    binding = entry({
      name: input.name,
      effective: {
        url: input.url,
        authHeader: input.authHeader ?? "authorization",
        authScheme: input.authScheme ?? "Bearer",
        extraHeaders: input.extraHeaders ?? {},
      },
      authorization: null,
    });
    return { ...detail(0).server, ...input };
  });
  const attach = vi.spyOn(browserApi, "attachMcpServer").mockImplementation(async () => {
    mounted = [binding];
    return binding;
  });
  const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockImplementation(async (_agent, _id, input) => {
    binding = {
      ...binding,
      authorization: { ...authorization(), kind: input.kind, hasCredential: input.kind !== "none" },
    };
    mounted = [binding];
    return binding;
  });
  const probe = vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue(ready);
  return { create, attach, auth, probe };
}

describe("MCP custom installation", () => {
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
    const invalid = await screen.findByText("Enter a complete connector URL.");
    expect(screen.getByLabelText("Connector address").getAttribute("aria-describedby")).toBe(invalid.id);
    expect(create).not.toHaveBeenCalled();
  });
  it("creates an independent configuration with the selected anonymous method", async () => {
    stub([]);
    const calls = writes();
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress("  https://docs.example.com/mcp  ");
    method("No authentication");
    connect();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.create).toHaveBeenCalledWith({
      name: "docs-example",
      url: "https://docs.example.com/mcp",
      defaultAuthKind: "none",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
    });
    expect(calls.auth).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "none" });
    expect(calls.probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
    expect(browserApi.mcpServers).not.toHaveBeenCalled();
  });
  it("submits a key and all necessary headers on the first connection", async () => {
    stub([]);
    const calls = writes();
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress("https://keys.example.com/mcp");
    method("API key or token");
    fireEvent.change(screen.getByLabelText("API key or token", { selector: "input[type=password]" }), {
      target: { value: "agent-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.change(screen.getByLabelText("Auth header"), { target: { value: "x-api-key" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "x-team" } });
    fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "team-one" } });
    connect();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultAuthKind: "bearer",
        authHeader: "x-api-key",
        authScheme: "",
        extraHeaders: { "x-team": "team-one" },
      }),
    );
    expect(calls.auth).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "agent-key" });
  });
  it("does not switch to OAuth after an explicitly selected anonymous method is rejected", async () => {
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
    await newAddress();
    method("No authentication");
    connect();
    await screen.findByText("Couldn't load tools");
    expect(screen.getByRole("radio", { name: "No authentication" }).getAttribute("aria-checked")).toBe("true");
    expect(oauth).not.toHaveBeenCalled();
  });
  it("keeps the submitted key editable after rejection and retries the same installation", async () => {
    stub([]);
    const calls = writes();
    calls.probe.mockResolvedValueOnce({
      ...ready,
      probeState: "failed",
      probeError: `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`,
      toolsCount: null,
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    method("API key or token");
    const input = screen.getByLabelText("API key or token", { selector: "input[type=password]" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wrong-key" } });
    connect();
    await screen.findByText("Authorization failed");
    expect(input.value).toBe("wrong-key");
    fireEvent.change(input, { target: { value: "new-key" } });
    connect();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.attach).toHaveBeenCalledTimes(1);
    expect(calls.auth).toHaveBeenLastCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "new-key" });
  });
  it("reuses its submitted installation after editing the URL away and back", async () => {
    stub([]);
    const calls = writes();
    calls.probe.mockResolvedValueOnce({ ...ready, probeState: "failed", probeError: "Fixture unavailable" });
    wrap(<McpPage agentId={AGENT_ID} />);
    const url = "https://docs.example.com/mcp";
    await newAddress(url);
    method("No authentication");
    connect();
    await screen.findByText("Couldn't load tools");
    fireEvent.change(screen.getByLabelText("Connector address"), { target: { value: `${url}/other` } });
    fireEvent.change(screen.getByLabelText("Connector address"), { target: { value: url } });
    connect();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.attach).toHaveBeenCalledTimes(1);
    expect(calls.probe).toHaveBeenCalledTimes(2);
  });
  it("retains a completed empty tool result", async () => {
    stub([]);
    const calls = writes();
    calls.probe.mockResolvedValue({ ...ready, toolsCount: 0 });
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    method("No authentication");
    connect();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.probe).toHaveBeenCalledTimes(1);
  });
  it("retains the URL and authentication selection when attachment fails", async () => {
    stub([]);
    const calls = writes();
    calls.attach.mockRejectedValueOnce(new ApiError(503, "offline"));
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "private detail"));
    vi.spyOn(window, "open").mockReturnValue(null);
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    connect();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't add connector. Try again.");
    expect(oauth).not.toHaveBeenCalled();
    connect();
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(1));
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.attach).toHaveBeenCalledTimes(2);
  });
  it.each([entry(), entry({ enabled: false }), entry({ authorization: null })])(
    "locates an existing installation without creating another",
    async (mounted) => {
      stub([mounted]);
      const create = vi.spyOn(browserApi, "createMcpServer");
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
      fireEvent.change(await screen.findByLabelText("Connector address"), { target: { value: mounted.effective.url } });
      connect();
      await waitFor(() => expect(locate).toHaveBeenCalledWith(SERVER_ID));
      expect(create).not.toHaveBeenCalled();
    },
  );
  it("does not replace a typed URL when restored metadata arrives late", async () => {
    stub([]);
    let finish: (value: ReturnType<typeof detail>) => void = () => {};
    vi.mocked(browserApi.mcpServer).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
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
    fireEvent.change(await screen.findByLabelText("Connector address"), {
      target: { value: "https://new.example.com/mcp" },
    });
    finish(detail(1));
    await waitFor(() => expect(browserApi.mcpServer).toHaveBeenCalled());
    expect((screen.getByLabelText("Connector address") as HTMLInputElement).value).toBe("https://new.example.com/mcp");
  });
});
