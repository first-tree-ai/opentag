import type { MCPAgentServer, MCPAuthorizationSummary, MCPServer } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../../api.js";
import { McpPage } from "../mcp-page.js";
import { AGENT_ID, entry, openAdd, SERVER_ID, stub, wrap } from "../mcp-test-fixtures.js";
import type { McpCatalogEntry } from "./mcp-catalog.gen.js";
import { McpDiscoverSource } from "./mcp-discover-source.js";

/**
 * The Discover source, driven against a synthetic catalog.
 *
 * The shipped catalog is operator-owned data, so no test asserts a shipped entry's name or endpoint:
 * editing `mcp-catalog.yaml` must not break a test. What is asserted is the surface's behavior — tab
 * order, category grouping, localization lookup, method copy, installed state, and how an add reuses
 * or creates the Account definition.
 */
const CATALOG = vi.hoisted(() => ({
  categories: [
    { id: "general", label: { en: "General", zh: "通用" }, order: 10 },
    { id: "engineering", label: { en: "Engineering", zh: "工程" }, order: 20 },
  ],
  entries: [
    {
      id: "alpha",
      name: "alpha",
      title: { en: "Alpha", zh: "阿尔法" },
      description: { en: "Docs and wikis.", zh: "文档与知识库。" },
      url: "https://mcp.alpha.test/mcp",
      defaultAuthKind: "oauth",
      category: "general",
      website: "https://alpha.test",
      iconUrl: "/alpha.svg",
      order: 10,
    },
    {
      id: "beta",
      name: "beta",
      title: { en: "Beta", zh: "贝塔" },
      description: { en: "Boards and tickets.", zh: "看板与工单。" },
      url: "https://mcp.beta.test/mcp",
      defaultAuthKind: "none",
      category: "engineering",
      website: "https://beta.test",
      iconUrl: "/beta.svg",
      order: 10,
    },
    {
      id: "gamma",
      name: "gamma",
      title: { en: "Gamma", zh: "伽马" },
      description: { en: "Errors and traces.", zh: "错误与链路。" },
      url: "https://mcp.gamma.test/mcp",
      defaultAuthKind: "bearer",
      category: "engineering",
      website: "https://gamma.test",
      iconUrl: "/gamma.svg",
      order: 20,
    },
  ],
}));

vi.mock("./mcp-catalog.gen.js", () => ({
  MCP_CATALOG_CATEGORIES: CATALOG.categories,
  MCP_CATALOG_ENTRIES: CATALOG.entries,
}));

afterEach(() => vi.restoreAllMocks());

const entries = CATALOG.entries as McpCatalogEntry[];

function summary(status: MCPAuthorizationSummary["status"]): MCPAuthorizationSummary {
  return {
    kind: "oauth",
    status,
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

/** A mount of the Alpha entry, so the card state can be driven without an Account read. */
function alphaMount(authorization: MCPAuthorizationSummary | null = summary("active")): MCPAgentServer {
  return entry({ effective: { ...entry().effective, url: "https://mcp.alpha.test/mcp" }, authorization });
}

async function discover(overrides: { servers?: MCPServer[]; mounted?: MCPAgentServer[]; busy?: boolean } = {}) {
  const onAdd = vi.fn();
  wrap(
    <McpDiscoverSource
      categories={CATALOG.categories}
      entries={entries}
      servers={overrides.servers ?? []}
      mounted={overrides.mounted ?? []}
      busy={overrides.busy ?? false}
      onAdd={onAdd}
    />,
  );
  await screen.findByLabelText("Search the marketplace");
  return onAdd;
}

/** Open the add dialog from the page header, then switch it to the Discover source. */
async function openDiscover() {
  await openAdd();
  fireEvent.click(await screen.findByRole("button", { name: "Discover" }));
}

/** Click the page's "Add server" button once the Agent read has settled and it is enabled. */
async function clickAddButton(which: "first" | "last") {
  const opens = await screen.findAllByRole("button", { name: "Add server" });
  const button = (which === "first" ? opens[0] : opens[opens.length - 1]) as HTMLButtonElement;
  await waitFor(() => {
    if (button.hasAttribute("disabled")) throw new Error("Still loading connections");
  });
  fireEvent.click(button);
  await screen.findByRole("dialog");
  return button;
}

function serverFixture(): MCPServer {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "alpha",
    description: null,
    url: "https://mcp.alpha.test/mcp",
    defaultAuthKind: "oauth",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    revision: 1,
    boundAgentCount: 0,
    authorizedAgentCount: 0,
    lastProbedAt: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

describe("Discover catalog surface", () => {
  it("renders category tabs in the declared order and only the active category's cards", async () => {
    await discover();
    const tabs = screen.getByRole("group", { name: "Categories" }).querySelectorAll("button");
    expect([...tabs].map((tab) => tab.textContent)).toEqual(["General", "Engineering"]);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("switches category and keeps the cards' localized copy", async () => {
    await discover();
    fireEvent.click(screen.getByRole("button", { name: "Engineering" }));
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Boards and tickets.")).toBeTruthy();
  });

  it("filters by the active locale's text, the name, and the URL", async () => {
    await discover();
    const search = screen.getByLabelText("Search the marketplace");
    fireEvent.change(search, { target: { value: "wiki" } });
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
    fireEvent.change(search, { target: { value: "mcp.beta.test" } });
    expect(screen.getByText("Beta")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nothing here" } });
    expect(screen.getByText("No MCP servers match this search.")).toBeTruthy();
  });

  it("names the method it will use for each authorization kind", async () => {
    await discover();
    expect(screen.getByRole("button", { name: "Connect with OAuth: Alpha" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Engineering" }));
    expect(screen.getByRole("button", { name: "Add without signing in: Beta" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect with an API key: Gamma" })).toBeTruthy();
  });

  it("shows an authorized mount instead of an add action", async () => {
    await discover({ mounted: [alphaMount(summary("active"))] });
    expect(screen.getByText("Authorized")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect with OAuth: Alpha" })).toBeNull();
  });

  it("distinguishes a mount that still needs authorization", async () => {
    await discover({ mounted: [alphaMount(summary("pending"))] });
    expect(screen.getByText("Authorization required")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect with OAuth: Alpha" })).toBeNull();
  });
});

describe("Discover inside the add flow", () => {
  it("offers the catalog from the empty state of an Agent with no mounts", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    // The header offers the manual source; the empty state is the second "Add server" action.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Add server" }).length).toBeGreaterThan(1));
    await clickAddButton("last");
    expect((await screen.findByRole("button", { name: "Discover" })).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByText("Alpha")).toBeTruthy();
  });

  it("adds an OAuth entry without an intermediate configuration step", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(serverFixture());
    const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(alphaMount(null));
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", url: "https://mcp.alpha.test/mcp", defaultAuthKind: "oauth" }),
    );
    expect(attach).toHaveBeenCalledWith(AGENT_ID, { mcpServerId: serverFixture().id, enabled: true });
    expect(screen.queryByLabelText("MCP URL")).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("reuses an existing Account definition with the same URL", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [serverFixture()] });
    const create = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(serverFixture());
    const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(alphaMount(null));
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith(AGENT_ID, { mcpServerId: serverFixture().id, enabled: true }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("adds an anonymous entry without any authorization prompt", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(serverFixture());
    vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(alphaMount(null));
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(alphaMount(summary("active")));
    const oauth = vi
      .spyOn(browserApi, "startMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "https://auth.test", expiresAt: "2026-09-15T00:10:00.000Z" });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Engineering" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add without signing in: Beta" }));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "none" }));
    expect(oauth).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "beta", defaultAuthKind: "none" }));
    expect(screen.queryByLabelText("API key or token", { selector: 'input[type="password"]' })).toBeNull();
  });

  it("stops a bearer entry to collect the key", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(serverFixture());
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Engineering" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect with an API key: Gamma" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("gamma");
    expect(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });
});
