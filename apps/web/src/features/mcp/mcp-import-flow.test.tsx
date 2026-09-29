import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, detail, entry, openAdd, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

const IMPORT_OPEN = "Import from config";
const PARSE = "Find servers";
const SUBMIT = "Add server";
const REMOTE_FRAGMENT = JSON.stringify({
  mcpServers: { nevent: { type: "http", url: "https://mcp.nevent.ai" } },
});

/** The Server echoes the definition it stored, so the dialog's own header comparison stays honest. */
const echoServer = async (input: Parameters<typeof browserApi.createMcpServer>[0]) => ({
  ...detail(0).server,
  ...input,
  extraHeaders: input.extraHeaders ?? {},
});

async function openImport() {
  fireEvent.click(await screen.findByRole("button", { name: IMPORT_OPEN }));
  await screen.findByLabelText("Configuration");
}

async function paste(text: string) {
  if (!screen.queryByLabelText("Configuration")) await openImport();
  fireEvent.change(screen.getByLabelText("Configuration"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: PARSE }));
}

function submitImport(label = SUBMIT) {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
}

describe("MCP import method", () => {
  it("is reachable from the Add server dialog", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    expect(await screen.findByRole("button", { name: IMPORT_OPEN })).toBeTruthy();
    await openImport();
    expect(screen.getByRole("button", { name: PARSE })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to search" }));
    expect(await screen.findByLabelText("MCP URL")).toBeTruthy();
  });

  it("creates nothing until a listed server is chosen and confirmed", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    const attach = vi.spyOn(browserApi, "attachMcpServer");
    const auth = vi.spyOn(browserApi, "setMcpAuthorization");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(REMOTE_FRAGMENT);
    expect(await screen.findByText("Server found. Choose it to import.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /nevent/ })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(create).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });

  it("lists a remote server beside an unsupported local one", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(
      JSON.stringify({
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
        },
      }),
    );
    expect(await screen.findByRole("button", { name: /linear/ })).toBeTruthy();
    expect(screen.getByText("Local server — not supported yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /everything/ })).toBeNull();
  });

  it("offers no import for a paste that holds only local servers", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste("claude mcp add local-tools --transport stdio -- npx -y @modelcontextprotocol/server-everything");
    expect(
      await screen.findByText("Only local MCP servers were found. OpenTag connects to remote servers only."),
    ).toBeTruthy();
    expect(screen.getByText("Local server — not supported yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /local-tools/ })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("reports text it cannot read without offering anything", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste("@@@ not a configuration @@@");
    expect(await screen.findByText(/No MCP server was found in this text/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^nevent/ })).toBeNull();
  });

  it("locates a server this Agent already mounts instead of importing it", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/sse" } } }));
    expect(await screen.findByText("Added to Reviewer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("creates, attaches, and authorizes an imported server in order", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(echoServer);
    const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry({ authorization: null }));
    const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(
      JSON.stringify({
        mcpServers: {
          nevent: {
            type: "http",
            url: "https://mcp.nevent.ai",
            headers: { Authorization: "Bearer sk-imported", "X-Workspace-Id": "design" },
          },
        },
      }),
    );
    expect(await screen.findByText("A credential was found. It is saved for this Agent only.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /nevent/ }));
    expect(
      (screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }) as HTMLInputElement).value,
    ).toBe("sk-imported");
    submitImport();
    await waitFor(() =>
      expect(auth).toHaveBeenCalledWith(AGENT_ID, detail(0).server.id, { kind: "bearer", bearerKey: "sk-imported" }),
    );
    expect(create).toHaveBeenCalledWith({
      name: "nevent",
      url: "https://mcp.nevent.ai",
      defaultAuthKind: "bearer",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: { "x-workspace-id": "design" },
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("sk-imported");
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0] as number);
    expect(attach.mock.invocationCallOrder[0]).toBeLessThan(auth.mock.invocationCallOrder[0] as number);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("falls back to browser authorization when the paste carries no credential", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(echoServer);
    vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry({ authorization: null }));
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(REMOTE_FRAGMENT);
    fireEvent.click(await screen.findByRole("button", { name: /nevent/ }));
    expect(screen.getByRole("radio", { name: "Authorize in browser (OAuth)" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    submitImport("Add and authorize");
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      name: "nevent",
      url: "https://mcp.nevent.ai",
      defaultAuthKind: "oauth",
      extraHeaders: {},
    });
  });

  it("retries attachment without creating a second configuration", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(echoServer);
    const attach = vi
      .spyOn(browserApi, "attachMcpServer")
      .mockRejectedValueOnce(new ApiError(503, "Attach unavailable"))
      .mockResolvedValue(entry({ authorization: null }));
    vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(REMOTE_FRAGMENT);
    fireEvent.click(await screen.findByRole("button", { name: /nevent/ }));
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    submitImport();
    expect(await screen.findByText("The configuration is saved. Retry to add it to this Agent.")).toBeTruthy();
    submitImport();
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("imports exactly the server the user picks out of several", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(echoServer);
    const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry({ authorization: null }));
    const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(
      JSON.stringify({
        mcpServers: {
          alpha: { type: "http", url: "https://alpha.example.com/mcp" },
          beta: { type: "http", url: "https://beta.example.com/mcp" },
          gamma: { type: "http", url: "https://gamma.example.com/mcp" },
        },
      }),
    );
    expect(await screen.findByText("3 servers found. Choose one to import.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /beta/ }));
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    submitImport();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({
      name: "beta",
      url: "https://beta.example.com/mcp",
      defaultAuthKind: "none",
      extraHeaders: {},
    });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("drops the parsed list when the paste is edited", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(
      JSON.stringify({
        mcpServers: {
          nevent: { type: "http", url: "https://mcp.nevent.ai", headers: { Authorization: "Bearer sk-imported" } },
        },
      }),
    );
    expect(await screen.findByRole("button", { name: /nevent/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Configuration"), { target: { value: "mcpServers: {}" } });
    expect(screen.queryByRole("button", { name: /nevent/ })).toBeNull();
    expect(screen.queryByText("A credential was found. It is saved for this Agent only.")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("never sends a paste's sensitive header to the shared definition", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(echoServer);
    const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry({ authorization: null }));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry({ authorization: null }));
    const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(
      JSON.stringify({
        mcpServers: {
          jira: {
            type: "http",
            url: "https://jira.example.com/mcp",
            headers: { "X-Client-Secret": "sk-client-secret", "X-Workspace-Id": "design" },
          },
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /jira/ }));
    submitImport();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const sent = create.mock.calls[0]?.[0] as { extraHeaders?: Record<string, string> };
    expect(sent.extraHeaders).toEqual({ "x-workspace-id": "design" });
    expect(JSON.stringify(sent)).not.toContain("sk-client-secret");
    // The Agent-level override carries the header the paste named; the value itself never does.
    expect(update).toHaveBeenCalledWith(AGENT_ID, detail(0).server.id, {
      authHeader: "x-client-secret",
      authScheme: "",
    });
    await waitFor(() =>
      expect(auth).toHaveBeenCalledWith(AGENT_ID, detail(0).server.id, {
        kind: "bearer",
        bearerKey: "sk-client-secret",
      }),
    );
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(auth.mock.invocationCallOrder[0] as number);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("keeps the pasted draft when returning from the configuration step", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await paste(REMOTE_FRAGMENT);
    fireEvent.click(await screen.findByRole("button", { name: /nevent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).value).toBe(REMOTE_FRAGMENT);
  });
});
