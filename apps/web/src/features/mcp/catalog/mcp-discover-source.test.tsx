import type { MCPAgentServer, MCPAuthorizationSummary, MCPServer } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../../api.js";
import { McpPage } from "../mcp-page.js";
import { AGENT_ID, entry, openAdd, stub, wrap } from "../mcp-test-fixtures.js";
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
      oauthScopes: ["alpha.read", "alpha.write"],
      category: "general",
      website: "https://alpha.test",
      iconUrl: "/alpha.svg",
      order: 10,
    },
    {
      id: "delta",
      name: "delta",
      title: { en: "Delta", zh: "德尔塔" },
      description: { en: "Notes and tasks.", zh: "笔记与任务。" },
      url: "https://mcp.delta.test/mcp",
      defaultAuthKind: "oauth",
      category: "general",
      website: "https://delta.test",
      iconUrl: "/delta.svg",
      order: 20,
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

const ALPHA_ID = "11111111-1111-4111-8111-111111111111";
const BETA_ID = "22222222-2222-4222-8222-222222222222";
const GAMMA_ID = "33333333-3333-4333-8333-333333333333";
const DELTA_ID = "44444444-4444-4444-8444-444444444444";

function idFor(name: string): string {
  if (name === "beta") return BETA_ID;
  if (name === "gamma") return GAMMA_ID;
  if (name === "delta") return DELTA_ID;
  return ALPHA_ID;
}

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

/** The definition a create or a reuse produces for one catalog entry. */
function serverFor(name: string): MCPServer {
  return {
    id: idFor(name),
    name,
    description: null,
    url: `https://mcp.${name}.test/mcp`,
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

/** The mount of one definition, so card state and mutation targets can be driven without a read. */
function mountFor(server: MCPServer, authorization: MCPAuthorizationSummary | null): MCPAgentServer {
  return entry({
    mcpServerId: server.id,
    name: server.name,
    effective: { ...entry().effective, url: server.url },
    authorization,
  });
}

/** Every write the catalog flow performs, keyed by the catalog entry's own definition. */
function stubCatalogWrites() {
  const create = vi
    .spyOn(browserApi, "createMcpServer")
    .mockImplementation(async (input) => serverFor((input as { name: string }).name));
  const attach = vi
    .spyOn(browserApi, "attachMcpServer")
    .mockImplementation(async (_agentId, body) => mountFor(serverFor(nameForId(body.mcpServerId)), null));
  const authorize = vi
    .spyOn(browserApi, "setMcpAuthorization")
    .mockImplementation(async (_agentId, id) => mountFor(serverFor(nameForId(id)), summary("active")));
  return { create, attach, authorize };
}

function nameForId(id: string): string {
  if (id === BETA_ID) return "beta";
  if (id === GAMMA_ID) return "gamma";
  if (id === DELTA_ID) return "delta";
  return "alpha";
}

async function discover(overrides: { servers?: MCPServer[]; mounted?: MCPAgentServer[] } = {}) {
  const onAdd = vi.fn();
  wrap(
    <McpDiscoverSource
      categories={CATALOG.categories}
      entries={entries}
      servers={overrides.servers ?? []}
      mounted={overrides.mounted ?? []}
      busy={false}
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

/** Choose a category tab inside the open dialog. */
function chooseCategory(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
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
    chooseCategory("Engineering");
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
    chooseCategory("Engineering");
    expect(screen.getByRole("button", { name: "Add without signing in: Beta" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect with an API key: Gamma" })).toBeTruthy();
  });

  it("shows an authorized mount instead of an add action", async () => {
    await discover({ mounted: [mountFor(serverFor("alpha"), summary("active"))] });
    expect(screen.getByText("Authorized")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect with OAuth: Alpha" })).toBeNull();
  });

  it("distinguishes a mount that still needs authorization", async () => {
    await discover({ mounted: [mountFor(serverFor("alpha"), summary("pending"))] });
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
    const { create, attach } = stubCatalogWrites();
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", url: "https://mcp.alpha.test/mcp", defaultAuthKind: "oauth" }),
    );
    expect(attach).toHaveBeenCalledWith(AGENT_ID, { mcpServerId: ALPHA_ID, enabled: true });
    expect(screen.queryByLabelText("MCP URL")).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("sends the entry's declared OAuth scopes with the start request", async () => {
    stub([]);
    stubCatalogWrites();
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(oauth).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID, { scopes: ["alpha.read", "alpha.write"] });
  });

  it("sends no explicit scopes for an entry that declares none", async () => {
    stub([]);
    stubCatalogWrites();
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Delta" }));
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(oauth).toHaveBeenCalledWith(AGENT_ID, DELTA_ID, {});
  });

  it("reuses an existing Account definition with the same URL", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [serverFor("alpha")] });
    const { create, attach } = stubCatalogWrites();
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await waitFor(() => expect(attach).toHaveBeenCalledWith(AGENT_ID, { mcpServerId: ALPHA_ID, enabled: true }));
    expect(create).not.toHaveBeenCalled();
  });

  it("reuses an existing Account definition for a bearer entry too", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [serverFor("gamma")] });
    const { create, attach, authorize } = stubCatalogWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    chooseCategory("Engineering");
    fireEvent.click(await screen.findByRole("button", { name: "Connect with an API key: Gamma" }));
    // The key form opens on the shared definition, not on a new one.
    expect(await screen.findByText(/Authorize separately for/)).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "sample-key" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add server" }));
    await waitFor(() =>
      expect(authorize).toHaveBeenCalledWith(AGENT_ID, GAMMA_ID, { kind: "bearer", bearerKey: "sample-key" }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledWith(AGENT_ID, { mcpServerId: GAMMA_ID, enabled: true });
  });

  it("adds an anonymous entry without any authorization prompt", async () => {
    stub([]);
    const { create, authorize } = stubCatalogWrites();
    const oauth = vi
      .spyOn(browserApi, "startMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "https://auth.test", expiresAt: "2026-09-15T00:10:00.000Z" });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    chooseCategory("Engineering");
    fireEvent.click(await screen.findByRole("button", { name: "Add without signing in: Beta" }));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(AGENT_ID, BETA_ID, { kind: "none" }));
    expect(oauth).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "beta", defaultAuthKind: "none" }));
    expect(screen.queryByLabelText("API key or token", { selector: 'input[type="password"]' })).toBeNull();
  });

  it("stops a bearer entry to collect the key", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    chooseCategory("Engineering");
    fireEvent.click(await screen.findByRole("button", { name: "Connect with an API key: Gamma" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("gamma");
    expect(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not carry a failed add's mount to an anonymous card", async () => {
    stub([]);
    const { attach, authorize } = stubCatalogWrites();
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    // The first card mounts Alpha, then fails at authorization.
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await screen.findByText("OAuth unavailable");
    expect(attach).toHaveBeenCalledWith(AGENT_ID, { mcpServerId: ALPHA_ID, enabled: true });
    // A different card must get its own definition and its own mount.
    chooseCategory("Engineering");
    fireEvent.click(await screen.findByRole("button", { name: "Add without signing in: Beta" }));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(AGENT_ID, BETA_ID, { kind: "none" }));
    expect(attach).toHaveBeenLastCalledWith(AGENT_ID, { mcpServerId: BETA_ID, enabled: true });
    expect(authorize).not.toHaveBeenCalledWith(AGENT_ID, ALPHA_ID, expect.anything());
  });

  it("does not carry a failed add's mount into a bearer card's key submit", async () => {
    stub([]);
    const { attach, authorize } = stubCatalogWrites();
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await screen.findByText("OAuth unavailable");
    chooseCategory("Engineering");
    fireEvent.click(await screen.findByRole("button", { name: "Connect with an API key: Gamma" }));
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "sample-key" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add server" }));
    await waitFor(() =>
      expect(authorize).toHaveBeenCalledWith(AGENT_ID, GAMMA_ID, { kind: "bearer", bearerKey: "sample-key" }),
    );
    expect(attach).toHaveBeenLastCalledWith(AGENT_ID, { mcpServerId: GAMMA_ID, enabled: true });
    expect(authorize).not.toHaveBeenCalledWith(AGENT_ID, ALPHA_ID, expect.anything());
  });

  it("clears a failed catalog attempt when the user switches to an existing Server", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({
      servers: [{ ...serverFor("gamma"), defaultAuthKind: "bearer" }],
    });
    const { attach, authorize } = stubCatalogWrites();
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await screen.findByText("OAuth unavailable");
    // Leave the catalog for the manual source and pick a different Server.
    fireEvent.click(screen.getByRole("button", { name: "Use an existing Server" }));
    fireEvent.click(await screen.findByRole("button", { name: /gamma.*https/ }));
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "sample-key" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add server" }));
    await waitFor(() =>
      expect(authorize).toHaveBeenCalledWith(AGENT_ID, GAMMA_ID, { kind: "bearer", bearerKey: "sample-key" }),
    );
    expect(attach).toHaveBeenLastCalledWith(AGENT_ID, { mcpServerId: GAMMA_ID, enabled: true });
    expect(authorize).not.toHaveBeenCalledWith(AGENT_ID, ALPHA_ID, expect.anything());
  });

  it("clears a failed catalog attempt when the user pastes a new URL", async () => {
    stub([]);
    const { create, attach, authorize } = stubCatalogWrites();
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with OAuth: Alpha" }));
    await screen.findByText("OAuth unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Use an existing Server" }));
    fireEvent.change(await screen.findByLabelText("MCP URL"), {
      target: { value: "https://mcp.delta.test/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("radio", { name: "API key or token" }));
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "sample-key" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add server" }));
    await waitFor(() =>
      expect(authorize).toHaveBeenCalledWith(AGENT_ID, DELTA_ID, { kind: "bearer", bearerKey: "sample-key" }),
    );
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ url: "https://mcp.delta.test/mcp" }));
    expect(attach).toHaveBeenLastCalledWith(AGENT_ID, { mcpServerId: DELTA_ID, enabled: true });
    expect(authorize).not.toHaveBeenCalledWith(AGENT_ID, ALPHA_ID, expect.anything());
  });
});
