import type { McpCatalogEntry } from "@opentag/mcp-presets";
import {
  CANVA_DEVELOPER_PORTAL_MCP_URL,
  type MCPAgentServer,
  type MCPAuthorizationSummary,
  type MCPServer,
} from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../../api.js";
import { McpPage } from "../mcp-page.js";
import { AGENT_ID, entry, stub, wrap } from "../mcp-test-fixtures.js";

/**
 * Discover against a deployment that replaces a catalog endpoint.
 *
 * Canva serves deployment clients on a different endpoint than the one the catalog ships, so the
 * card must create its Server where the deployment's client works, and only after the deployment's
 * endpoints have loaded. The catalog is synthetic apart from the entry ID the shared contract names.
 */
const CATALOG = vi.hoisted(() => ({
  categories: [{ id: "design", label: { en: "Design", zh: "设计" }, order: 10 }],
  entries: [
    {
      id: "canva",
      name: "canva",
      title: { en: "Canva", zh: "Canva" },
      description: { en: "Create designs.", zh: "创建设计。" },
      url: "https://mcp.canva.com/mcp",
      defaultAuthKind: "oauth",
      category: "design",
      website: "https://www.canva.com",
      iconUrl: "/canva.png",
      order: 10,
    },
  ],
}));

vi.mock("@opentag/mcp-presets", () => ({
  MCP_CATALOG_CATEGORIES: CATALOG.categories,
  MCP_CATALOG_ENTRIES: CATALOG.entries,
}));

const SERVER_ID = "55555555-5555-4555-8555-555555555555";
const WAITLIST_URL = "https://mcp.canva.com/mcp";
const PORTAL_REPLACEMENT = { endpoints: [{ catalogId: "canva", url: CANVA_DEVELOPER_PORTAL_MCP_URL }] };

function connected(): MCPAuthorizationSummary {
  return {
    kind: "oauth",
    status: "active",
    hasCredential: true,
    scopes: null,
    accessTokenExpiresAt: null,
    authorizationServer: null,
    probeState: "succeeded",
    probedAt: null,
    probeError: null,
    toolsCount: 3,
    toolsTruncated: false,
    failureCode: null,
    revision: 1,
  };
}

/** The Agent's mount of the Canva Server on `url`. */
function canvaMount(url: string, authorization: MCPAuthorizationSummary | null): MCPAgentServer {
  return entry({
    mcpServerId: SERVER_ID,
    name: "canva",
    effective: { ...entry().effective, url },
    authorization,
  }) as MCPAgentServer;
}
const entries = CATALOG.entries as McpCatalogEntry[];

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

function server(url: string): MCPServer {
  return {
    id: SERVER_ID,
    name: "canva",
    description: null,
    url,
    defaultAuthKind: "oauth",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    revision: 1,
    boundAgentCount: 0,
    authorizedAgentCount: 0,
    lastProbedAt: null,
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  };
}

/** Record the definition the card creates, and stop the flow at the OAuth start. */
function stubCanvaWrites() {
  const create = vi
    .spyOn(browserApi, "createMcpServer")
    .mockImplementation(async (input) => server(input.url as string));
  vi.spyOn(browserApi, "attachMcpServer").mockImplementation(async () => {
    const created = create.mock.calls[0]?.[0];
    return entry({
      mcpServerId: SERVER_ID,
      name: "canva",
      effective: { ...entry().effective, url: (created?.url as string) ?? entries[0]?.url },
      authorization: null,
    }) as MCPAgentServer;
  });
  vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new Error("stop at the OAuth start"));
  return { create };
}

async function addCanva() {
  const button = await screen.findByRole("button", { name: "Discover" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole("button", { name: "Add: Canva" }));
}

describe("Discover with deployment catalog endpoints", () => {
  it("creates the Canva Server on the Developer Portal endpoint when the deployment has a Canva client", async () => {
    stub([]);
    vi.mocked(browserApi.mcpCatalogEndpoints).mockResolvedValue({
      endpoints: [{ catalogId: "canva", url: CANVA_DEVELOPER_PORTAL_MCP_URL }],
    });
    const { create } = stubCanvaWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await addCanva();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ name: "canva", url: CANVA_DEVELOPER_PORTAL_MCP_URL });
  });

  it("keeps the shipped Canva endpoint when the deployment replaces nothing", async () => {
    stub([]);
    const { create } = stubCanvaWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await addCanva();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ url: "https://mcp.canva.com/mcp" });
  });

  it("keeps the shipped catalog usable when the deployment's endpoints cannot be read", async () => {
    stub([]);
    vi.mocked(browserApi.mcpCatalogEndpoints).mockRejectedValue(new Error("unavailable"));
    const { create } = stubCanvaWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await addCanva();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ url: "https://mcp.canva.com/mcp" });
  });

  it("offers no card until the deployment's endpoints have loaded", async () => {
    stub([]);
    let finish: (value: { endpoints: { catalogId: string; url: string }[] }) => void = () => {};
    vi.mocked(browserApi.mcpCatalogEndpoints).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { create } = stubCanvaWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    const button = await screen.findByRole("button", { name: "Discover" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Add: Canva" })).toBeNull();
    finish({ endpoints: [{ catalogId: "canva", url: CANVA_DEVELOPER_PORTAL_MCP_URL }] });
    fireEvent.click(await screen.findByRole("button", { name: "Add: Canva" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ url: CANVA_DEVELOPER_PORTAL_MCP_URL });
  });

  /*
   * The production upgrade path: an Account that added Canva before the deployment configured its
   * Canva client already has a Server named `canva` on the waitlist endpoint. Creating another one
   * would collide on the Account's name constraint, and the existing one still works.
   */
  it("keeps an Agent's working waitlist Canva connection as connected after the replacement", async () => {
    stub([canvaMount(WAITLIST_URL, connected())]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [server(WAITLIST_URL)] });
    vi.mocked(browserApi.mcpCatalogEndpoints).mockResolvedValue(PORTAL_REPLACEMENT);
    const { create } = stubCanvaWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    const button = await screen.findByRole("button", { name: "Discover" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Discover" });
    await within(dialog).findByText("Connected");
    expect(within(dialog).queryByRole("button", { name: "Add: Canva" })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("reuses an Account's waitlist Canva Server instead of creating a second one", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [server(WAITLIST_URL)] });
    vi.mocked(browserApi.mcpCatalogEndpoints).mockResolvedValue(PORTAL_REPLACEMENT);
    const { create } = stubCanvaWrites();
    const attach = vi.mocked(browserApi.attachMcpServer);
    attach.mockImplementation(async () => canvaMount(WAITLIST_URL, null));
    wrap(<McpPage agentId={AGENT_ID} />);
    await addCanva();
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    expect(attach.mock.calls[0]?.[1]).toMatchObject({ mcpServerId: SERVER_ID });
    expect(create).not.toHaveBeenCalled();
  });
});
