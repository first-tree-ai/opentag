import { randomUUID } from "node:crypto";
import type { McpCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPAuthKind, MCPServer } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../../api.js";
import { McpPage } from "../mcp-page.js";
import { AGENT_ID, detail, entry, openDetails, stub, wrap } from "../mcp-test-fixtures.js";

vi.mock("@opentag/mcp-presets", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentag/mcp-presets")>();
  const template = original.MCP_CATALOG_ENTRIES[0] as McpCatalogEntry;
  const customer: McpCatalogEntry = {
    ...template,
    id: "customer",
    name: "customer",
    title: { en: "Customer", zh: "客户" },
    installable: false,
    url: undefined,
    defaultAuthKind: undefined,
    keyAuth: undefined,
    auth: { methods: ["bearer"], defaultKind: "bearer" },
    category: "data",
    setup: {
      documentationUrl: "https://provider.example.com/setup",
      help: { en: "Use your instance key.", zh: "填写实例 Key。" },
      endpoint: { placeholder: "https://tenant.example.com/mcp", pathPattern: "^/mcp/?$" },
      authHeader: "authorization",
      authScheme: "Token",
      headers: [
        { name: "x-environment-id", label: { en: "Environment ID", zh: "环境 ID" }, required: true, format: "integer" },
      ],
    },
  };
  return {
    ...original,
    MCP_CATALOG_ENTRIES: [customer],
    MCP_CATALOG_CATEGORIES: [{ id: "data", label: { en: "Data", zh: "数据" }, order: 10 }],
  };
});

beforeEach(() => vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const definitions: MCPServer[] = [];
  const mounts: MCPAgentServer[] = [];
  stub(mounts);
  vi.mocked(browserApi.agentMcpServers).mockImplementation(async () => ({ servers: [...mounts] }));
  vi.mocked(browserApi.mcpServers).mockImplementation(async () => ({ servers: [...definitions] }));
  vi.mocked(browserApi.mcpServer).mockImplementation(async (id) => {
    const server = definitions.find((value) => value.id === id);
    if (!server) throw new Error("Missing definition");
    return { server, agents: [] };
  });
  const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(async (input) => {
    const server = { ...detail(0).server, ...input, id: randomUUID() };
    definitions.push(server);
    return server;
  });
  const attach = vi.spyOn(browserApi, "attachMcpServer").mockImplementation(async (_agent, input) => {
    const server = definitions.find((value) => value.id === input.mcpServerId);
    if (!server) throw new Error("Missing definition");
    if (mounts.some((value) => value.mcpServerId === server.id)) throw new ApiError(409, "Already mounted");
    const mounted = entry({
      mcpServerId: server.id,
      name: server.name,
      effective: {
        url: server.url,
        authHeader: server.authHeader,
        authScheme: server.authScheme,
        extraHeaders: server.extraHeaders,
      },
      authorization: null,
      snapshot: null,
    });
    mounts.push(mounted);
    return mounted;
  });
  const authorize = vi.spyOn(browserApi, "setMcpAuthorization").mockImplementation(async (_agent, id, input) => {
    const mounted = mounts.find((value) => value.mcpServerId === id);
    if (!mounted) throw new Error("Missing mount");
    mounted.authorization = {
      ...entry().authorization,
      kind: input.kind,
      status: "active",
      hasCredential: true,
    } as NonNullable<MCPAgentServer["authorization"]>;
    return { ...mounted };
  });
  const probe = vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue({
    probeState: "succeeded",
    probeError: null,
    toolsCount: 1,
    toolsTruncated: false,
    protocolEra: null,
    protocolVersion: null,
  });
  const remove = vi.mocked(browserApi.removeMcpServer).mockImplementation(async (id) => {
    const index = definitions.findIndex((value) => value.id === id);
    if (index >= 0) definitions.splice(index, 1);
  });
  const detach = vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async (_agent, id) => {
    const index = mounts.findIndex((value) => value.mcpServerId === id);
    if (index >= 0) mounts.splice(index, 1);
  });
  vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(async (_agent, id, patch) => {
    const mounted = mounts.find((value) => value.mcpServerId === id);
    if (!mounted) throw new Error("Missing mount");
    mounted.effective = { ...mounted.effective, ...patch };
    mounted.overridden.url = true;
    return { ...mounted };
  });
  return { definitions, mounts, create, attach, authorize, probe, detach, remove };
}

const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function openSetup() {
  const button = await screen.findByRole("button", { name: "Discover" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole("button", { name: "Add: Customer" }));
  await screen.findByRole("dialog", { name: "Connect Customer" });
}
function fill(url = "https://tenant.example.com/mcp", environment = "123") {
  change("Connector address", url);
  change("Environment ID", environment);
  change("API key or token", "fixture-key");
}
const connect = () => fireEvent.click(screen.getByRole("button", { name: "Connect" }));
const directory = () => screen.findByRole("dialog", { name: "Discover" });

describe("customer connector setup", () => {
  it("validates the endpoint and environment before creating, then sends the key separately", async () => {
    const calls = fixture();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openSetup();
    expect(screen.getByRole("link", { name: "Setup instructions" }).getAttribute("href")).toBe(
      "https://provider.example.com/setup",
    );
    fill("https://tenant.example.com/mcp?token=secret", "bad");
    connect();
    await screen.findByRole("alert");
    expect(calls.create).not.toHaveBeenCalled();
    fill();
    connect();
    await directory();
    expect(calls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://tenant.example.com/mcp",
        defaultAuthKind: "bearer",
        authScheme: "Token",
        extraHeaders: { "x-environment-id": "123" },
      }),
    );
    expect(calls.authorize).toHaveBeenCalledWith(AGENT_ID, calls.definitions[0]?.id, {
      kind: "bearer",
      bearerKey: "fixture-key",
    });
    expect(calls.create.mock.calls[0]?.[0]).not.toHaveProperty("bearerKey");
  });

  it("cancels an untouched form without creating a connection", async () => {
    const calls = fixture();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openSetup();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await directory();
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.authorize).not.toHaveBeenCalled();
  });

  it("keeps the key on a failed probe and retries the same installation", async () => {
    const calls = fixture();
    calls.probe.mockRejectedValueOnce(new ApiError(503, "Unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openSetup();
    fill();
    connect();
    await screen.findByRole("alert");
    expect((screen.getByLabelText("API key or token") as HTMLInputElement).value).toBe("fixture-key");
    connect();
    await directory();
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.attach).toHaveBeenCalledTimes(1);
    expect(calls.probe).toHaveBeenCalledTimes(2);
  });

  it("removes an unauthenticated provisional mount when its address changes or setup is cancelled", async () => {
    const calls = fixture();
    calls.authorize.mockRejectedValue(new ApiError(503, "Unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openSetup();
    fill();
    connect();
    await screen.findByRole("alert");
    fill("https://second.example.com/mcp");
    connect();
    await waitFor(() => expect(calls.create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(calls.authorize).toHaveBeenCalledTimes(2));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel.hasAttribute("disabled")).toBe(false));
    fireEvent.click(cancel);
    await directory();
    expect(calls.mounts).toHaveLength(0);
    expect(calls.detach).toHaveBeenCalledTimes(2);
    expect(calls.remove).toHaveBeenCalledTimes(2);
    expect(calls.definitions).toHaveLength(0);
  });

  it.each(["none", "oauth", "bearer"] as const)(
    "does not reuse an incompatible %s mount",
    async (kind: MCPAuthKind) => {
      const calls = fixture();
      const existing = {
        ...detail(1).server,
        name: "customer",
        url: "https://tenant.example.com/mcp",
        defaultAuthKind: kind,
        authScheme: "Token",
        extraHeaders: { "x-environment-id": kind === "bearer" ? "456" : "123" },
      };
      calls.definitions.push(existing);
      calls.mounts.push(
        entry({
          name: existing.name,
          mcpServerId: existing.id,
          effective: {
            url: existing.url,
            authHeader: existing.authHeader,
            authScheme: existing.authScheme,
            extraHeaders: existing.extraHeaders,
          },
          authorization: { ...entry().authorization, kind, hasCredential: kind !== "none" } as NonNullable<
            MCPAgentServer["authorization"]
          >,
        }),
      );
      wrap(<McpPage agentId={AGENT_ID} />);
      await openSetup();
      fill();
      connect();
      await directory();
      expect(calls.mounts).toHaveLength(2);
      expect(calls.authorize).toHaveBeenCalledWith(AGENT_ID, expect.not.stringContaining(existing.id), {
        kind: "bearer",
        bearerKey: "fixture-key",
      });
    },
  );

  it("creates a separate definition after the first instance is overridden in this page session", async () => {
    const calls = fixture();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openSetup();
    fill();
    connect();
    const discover = within(await directory());
    fireEvent.click(discover.getByRole("button", { name: "Close Discover" }));
    await openDetails("Customer");
    change("Connector address", "https://changed.example.com/mcp");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openSetup();
    fill();
    connect();
    await directory();
    expect(calls.create).toHaveBeenCalledTimes(2);
    expect(new Set(calls.mounts.map((value) => value.mcpServerId)).size).toBe(2);
  });
});
