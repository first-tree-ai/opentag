import type { McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPAuthorizationSummary, MCPServer } from "@opentag/shared/browser";
import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../../api.js";
import { fakeMcpOAuthBrowser } from "../mcp-oauth-test-fixtures.js";
import { McpPage } from "../mcp-page.js";
import { AGENT_ID, entry, stub, wrap } from "../mcp-test-fixtures.js";
import { McpDiscoverSource } from "./mcp-discover-source.js";

/**
 * The Discover source, driven against a synthetic catalog.
 *
 * The shipped catalog is operator-owned data, so no test asserts a shipped entry's name or endpoint:
 * editing `mcp-catalog.yaml` must not break a test. What is asserted is the surface's behavior — tab
 * order, category grouping, localization lookup, method copy, installed state, and how an add creates
 * an independent definition.
 */
const CATALOG = vi.hoisted(() => ({
  categories: [
    { id: "general", label: { en: "General", zh: "通用" }, order: 10 },
    { id: "engineering", label: { en: "Engineering", zh: "工程" }, order: 20 },
    { id: "small", label: { en: "Small category", zh: "小分类" }, order: 30 },
  ],
  entries: [
    {
      id: "alpha",
      name: "alpha",
      title: { en: "Alpha", zh: "阿尔法" },
      description: { en: "Docs and wikis.", zh: "文档与知识库。" },
      registryId: "mcp/alpha",
      whenToUse: { en: "Use for alpha.", zh: "用于 alpha。" },
      installable: true,
      status: "active",
      capabilities: ["search"],
      auth: { methods: ["oauth"], defaultKind: "oauth", oauth: {} },
      risk: { sideEffects: "none", dataAccess: "private" },
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
      registryId: "mcp/delta",
      whenToUse: { en: "Use for delta.", zh: "用于 delta。" },
      installable: true,
      status: "active",
      capabilities: ["search"],
      auth: { methods: ["oauth"], defaultKind: "oauth", oauth: {} },
      risk: { sideEffects: "none", dataAccess: "private" },
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
      registryId: "mcp/beta",
      whenToUse: { en: "Use for beta.", zh: "用于 beta。" },
      installable: true,
      status: "active",
      capabilities: ["search"],
      auth: { methods: ["none"], defaultKind: "none" },
      risk: { sideEffects: "none", dataAccess: "private" },
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
      registryId: "mcp/gamma",
      whenToUse: { en: "Use for gamma.", zh: "用于 gamma。" },
      installable: true,
      status: "active",
      capabilities: ["search"],
      auth: { methods: ["bearer"], defaultKind: "bearer" },
      risk: { sideEffects: "none", dataAccess: "private" },
      url: "https://mcp.gamma.test/mcp",
      defaultAuthKind: "bearer",
      category: "engineering",
      website: "https://gamma.test",
      iconUrl: "/gamma.svg",
      order: 20,
    },
  ],
}));

vi.mock("@opentag/mcp-presets", () => ({
  MCP_CATALOG_CATEGORIES: CATALOG.categories,
  MCP_CATALOG_ENTRIES: CATALOG.entries,
}));

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

const entries = CATALOG.entries as McpInstallableCatalogEntry[];

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

/** The definition a create produces for one catalog entry. */
function serverFor(name: string): MCPServer {
  return {
    id: idFor(name),
    name,
    description: null,
    url: `https://mcp.${name}.test/mcp`,
    defaultAuthKind: entries.find((entry) => entry.name === name)?.defaultAuthKind ?? "oauth",
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
  const mounts: MCPAgentServer[] = [];
  vi.mocked(browserApi.agentMcpServers).mockImplementation(async () => ({ servers: [...mounts] }));
  const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(async (input) => serverFor(input.name));
  const attach = vi.spyOn(browserApi, "attachMcpServer").mockImplementation(async (_agentId, body) => {
    const binding = { ...mountFor(serverFor(nameForId(body.mcpServerId)), null), snapshot: null };
    mounts.push(binding);
    return binding;
  });
  const detach = vi.spyOn(browserApi, "detachMcpServer").mockImplementation(async (_agentId, id) => {
    const index = mounts.findIndex((entry) => entry.mcpServerId === id);
    if (index >= 0) mounts.splice(index, 1);
  });
  const authorize = vi.spyOn(browserApi, "setMcpAuthorization").mockImplementation(async (_agentId, id, input) => {
    const binding = mountFor(serverFor(nameForId(id)), {
      ...summary("active"),
      kind: input.kind,
      hasCredential: input.kind !== "none",
    });
    const index = mounts.findIndex((entry) => entry.mcpServerId === id);
    mounts[index] = binding;
    return binding;
  });
  vi.mocked(browserApi.mcpServer).mockImplementation(async (id) => ({
    server: (await browserApi.mcpServers()).servers.find((server) => server.id === id) ?? serverFor(nameForId(id)),
    agents: [],
  }));
  const probe = vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue({
    probeState: "succeeded",
    probeError: null,
    toolsCount: 3,
    toolsTruncated: false,
    protocolEra: null,
    protocolVersion: null,
  });
  vi.mocked(browserApi.revokeMcpAuthorization).mockImplementation(async (_agent, id, expectedState) => {
    const index = mounts.findIndex((row) => row.mcpServerId === id);
    const current = mounts[index];
    if (expectedState && current?.authorization?.status === "active")
      throw new ApiError(409, "Completed", MCP_ERROR_CODES.OAUTH_FLOW_INVALID);
    const revoked = {
      ...(current ?? mountFor(serverFor(nameForId(id)), null)),
      authorization: { ...summary("revoked"), hasCredential: false },
      snapshot: null,
    };
    if (index >= 0) mounts[index] = revoked;
    return revoked;
  });
  const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockImplementation(async (_agent, id) => {
    const index = mounts.findIndex((row) => row.mcpServerId === id);
    if (index >= 0) mounts[index] = mountFor(serverFor(nameForId(id)), { ...summary("pending"), hasCredential: false });
    return { authorizationUrl: `https://provider.test/authorize?state=${id}`, expiresAt: "2099-01-01T00:00:00Z" };
  });
  return { create, attach, authorize, mounts, detach, probe, oauth };
}

function nameForId(id: string): string {
  if (id === BETA_ID) return "beta";
  if (id === GAMMA_ID) return "gamma";
  if (id === DELTA_ID) return "delta";
  return "alpha";
}

function catalogText(title: string): HTMLElement {
  const catalog = document.querySelector('[data-ui="mcp-catalog"]');
  if (!catalog) throw new Error("Missing catalog");
  return within(catalog as HTMLElement).getByText(title);
}

async function discover(
  overrides: {
    servers?: MCPServer[];
    mounted?: MCPAgentServer[];
    entries?: readonly McpInstallableCatalogEntry[];
    initialView?: { query: string; categoryId: string };
  } = {},
) {
  const onAdd = vi.fn();
  wrap(
    <McpDiscoverSource
      categories={CATALOG.categories}
      entries={overrides.entries ?? entries}
      servers={overrides.servers ?? []}
      mounted={overrides.mounted ?? []}
      busy={false}
      onAdd={onAdd}
      initialView={overrides.initialView}
    />,
  );
  await screen.findByLabelText("Search connectors");
  return onAdd;
}

/** The directory is a first-class page action, independent of custom connections. */
async function openDiscover() {
  const button = await screen.findByRole("button", { name: "Discover" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  await screen.findByRole("dialog");
  await screen.findByLabelText("Search connectors");
}

/** Choose a category tab inside the open dialog. */
function chooseCategory(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("Discover catalog surface", () => {
  it("hides small category navigation while retaining its entries in All and search", async () => {
    const singleEntry = {
      ...entries[0],
      id: "solo",
      name: "solo",
      title: { en: "Solo", zh: "单项" },
      category: "small",
    } as McpInstallableCatalogEntry;
    await discover({ entries: [...entries, singleEntry], initialView: { query: "", categoryId: "small" } });
    const tabs = () => [...screen.getByRole("group", { name: "Categories" }).querySelectorAll("button")];
    expect(tabs().map((tab) => tab.textContent)).toEqual(["All", "General", "Engineering"]);
    expect(catalogText("Alpha")).toBeTruthy();
    expect(catalogText("Beta")).toBeTruthy();
    expect(screen.getByText("Solo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("Search connectors"), { target: { value: "Solo" } });
    expect(screen.getByText("Solo")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(tabs().map((tab) => tab.textContent)).toEqual(["All", "General", "Engineering"]);
    expect(screen.queryByRole("button", { name: "Small category" })).toBeNull();
  });

  it("switches category and keeps the cards' localized copy", async () => {
    await discover();
    chooseCategory("Engineering");
    expect(catalogText("Beta")).toBeTruthy();
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Boards and tickets.")).toBeTruthy();
  });

  it("filters by the active locale's text, the name, and the URL", async () => {
    await discover();
    const search = screen.getByLabelText("Search connectors");
    fireEvent.change(search, { target: { value: "wiki" } });
    expect(catalogText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
    fireEvent.change(search, { target: { value: "mcp.beta.test" } });
    expect(catalogText("Beta")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nothing here" } });
    expect(screen.getByText("No connectors match this search.")).toBeTruthy();
  });

  it("uses one add action without exposing authentication methods while browsing", async () => {
    await discover();
    expect(screen.getByRole("button", { name: "Add: Alpha" })).toBeTruthy();
    chooseCategory("Engineering");
    expect(screen.getByRole("button", { name: "Add: Beta" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add: Gamma" })).toBeTruthy();
    expect(screen.queryByText("API key needed")).toBeNull();
    expect(screen.queryByText("No API key needed")).toBeNull();
    expect(screen.queryByText("Authorize on the service’s website")).toBeNull();
    expect(screen.queryByRole("link", { name: "Website" })).toBeNull();
  });

  it("shows an added mount instead of an add action", async () => {
    const onAdd = await discover({ mounted: [mountFor(serverFor("alpha"), summary("active"))] });
    expect(screen.getByRole("img", { name: "Added" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View: Alpha" })).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add: Alpha" })).toBeNull();
  });

  it("keeps authorization details out of an added card", async () => {
    await discover({ mounted: [mountFor(serverFor("alpha"), summary("pending"))] });
    expect(screen.getByRole("button", { name: "Authorize: Alpha" })).toBeTruthy();
    expect(screen.queryByText("Authorization required")).toBeNull();
    expect(screen.queryByRole("button", { name: "View: Alpha" })).toBeNull();
  });
});

const ready = {
  probeState: "succeeded" as const,
  probeError: null,
  toolsCount: 3,
  toolsTruncated: false,
  protocolEra: null,
  protocolVersion: null,
};
const catalog = () => within(screen.getByRole("dialog", { name: "Discover" }));
const card = (title: string) => within(catalog().getByText(title).closest("li") as HTMLElement);
const add = (title: string) => fireEvent.click(screen.getByRole("button", { name: `Add: ${title}` }));
const complete = async (browser: ReturnType<typeof fakeMcpOAuthBrowser>, mounts: MCPAgentServer[]) => {
  mounts[0] = mountFor(serverFor("alpha"), summary("active"));
  await act(async () => browser.send({ mcpServerId: ALPHA_ID, outcome: { kind: "success" } }));
};

describe("Discover installation and recovery", () => {
  it("preserves a failed installation and retries OAuth without creating or attaching again", async () => {
    stub([]);
    const calls = stubCatalogWrites();
    calls.oauth.mockRejectedValue(new ApiError(503, "private detail"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    add("Alpha");
    await card("Alpha").findByText("Authorization failed");
    fireEvent.click(card("Alpha").getByRole("button", { name: "Authorize: Alpha" }));
    await waitFor(() => expect(calls.oauth).toHaveBeenCalledTimes(2));
    expect(calls.attach).toHaveBeenCalledTimes(1);
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.detach).not.toHaveBeenCalled();
  });
  it("guards duplicate clicks while creating a definition", async () => {
    stub([]);
    const calls = stubCatalogWrites();
    let finish: (value: MCPServer) => void = () => {};
    calls.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    calls.oauth.mockRejectedValue(new ApiError(503, "private detail"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    const button = screen.getByRole("button", { name: "Add: Alpha" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls.create).toHaveBeenCalledTimes(1));
    finish(serverFor("alpha"));
    await card("Alpha").findByText("Authorization failed");
    expect(calls.attach).toHaveBeenCalledTimes(1);
  });
  it("saves the key in the same installation and returns to the directory", async () => {
    stub([]);
    const calls = stubCatalogWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    add("Gamma");
    const input = await screen.findByLabelText("API key or token", { selector: "input[type=password]" });
    expect(screen.queryByRole("radio")).toBeNull();
    const keyDialog = within(screen.getByRole("dialog"));
    expect(keyDialog.queryByRole("button", { name: /^Close |^Back$/ })).toBeNull();
    expect(keyDialog.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "example-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("dialog", { name: "Discover" });
    await card("Gamma").findByRole("img", { name: "Added" });
    expect(calls.authorize).toHaveBeenCalledWith(AGENT_ID, GAMMA_ID, { kind: "bearer", bearerKey: "example-key" });
    expect(calls.attach).toHaveBeenCalledTimes(1);
  });
  it("keeps a key draft on request failure", async () => {
    stub([]);
    const calls = stubCatalogWrites();
    calls.authorize.mockRejectedValueOnce(new ApiError(503, "private detail"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    add("Gamma");
    const input = (await screen.findByLabelText("API key or token", {
      selector: "input[type=password]",
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "draft-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const failure = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(failure.textContent).toBe("Couldn't load tools");
    expect(input.getAttribute("aria-describedby")).toBe(failure.id);
    expect(input.value).toBe("draft-key");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("dialog", { name: "Discover" });
    expect(calls.authorize).toHaveBeenCalledTimes(2);
  });
  it("shows a neutral completed empty list with only the check mark", async () => {
    const binding = mountFor(serverFor("beta"), {
      ...summary("active"),
      kind: "none",
      hasCredential: false,
      toolsCount: 0,
    });
    await discover({ mounted: [binding] });
    const target = within(catalogText("Beta").closest("li") as HTMLElement);
    expect(target.getByText("No tools available")).toBeTruthy();
    expect(target.getByRole("img", { name: "Added" })).toBeTruthy();
    expect(target.queryByRole("button")).toBeNull();
  });
  it.each([0, 3])("keeps a saved result with %i tools quiet during background refresh", async (toolsCount) => {
    const binding = mountFor(serverFor("beta"), {
      ...summary("active"),
      kind: "none",
      hasCredential: false,
      probeState: "pending",
      probedAt: "2026-09-16T00:00:00.000Z",
      toolsCount,
    });
    if (toolsCount === 0 && binding.snapshot) binding.snapshot.tools = [];
    await discover({ mounted: [binding] });
    const target = within(catalogText("Beta").closest("li") as HTMLElement);
    expect(target.getByRole("img", { name: "Added" })).toBeTruthy();
    expect(target.queryByText("Loading tools…")).toBeNull();
    expect(target.queryByRole("button")).toBeNull();
    if (toolsCount === 0) expect(target.getByText("No tools available")).toBeTruthy();
  });
  it("keeps initial tool loading visible when there is no completed snapshot", async () => {
    const binding = mountFor(serverFor("beta"), { ...summary("active"), probeState: "pending", toolsCount: null });
    binding.snapshot = null;
    await discover({ mounted: [binding] });
    const target = within(catalogText("Beta").closest("li") as HTMLElement);
    expect(target.getByText("Loading tools…")).toBeTruthy();
    expect(target.queryByRole("img", { name: "Added" })).toBeNull();
  });
  it("uses the same network reason and Retry as the list", async () => {
    const binding = mountFor(serverFor("beta"), {
      ...summary("active"),
      kind: "none",
      hasCredential: false,
      probeState: "failed",
      probeError: `${MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE}: timed out`,
    });
    await discover({ mounted: [binding] });
    expect(screen.getByText("Request timed out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry: Beta" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Added" })).toBeNull();
  });
});

describe("Discover authorization lifecycle", () => {
  it("keeps a blocked OAuth retry visible and cancellable after reopening Details", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      calls.mounts.push(mountFor(serverFor("alpha"), null));
      calls.oauth.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      fireEvent.click(card("Alpha").getByRole("button", { name: "Authorize: Alpha" }));
      await card("Alpha").findByText("Cannot reach service");
      fireEvent.click(screen.getByRole("button", { name: "Close Discover" }));
      fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
      browser.open.mockReturnValue(null);
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
      const dialog = within(screen.getByRole("dialog"));
      await dialog.findByRole("button", { name: "Open window" });
      expect(dialog.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
      expect(dialog.getByRole("button", { name: "Close Alpha" }).hasAttribute("disabled")).toBe(false);
      fireEvent.click(dialog.getByRole("button", { name: "Close Alpha" }));
      fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
      await within(screen.getByRole("dialog")).findByRole("button", { name: "Open window" });
      expect(calls.oauth).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await screen.findByRole("button", { name: "Authorize" });
      fireEvent.click(screen.getByRole("button", { name: "Close Alpha" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Discover" }).hasAttribute("disabled")).toBe(false),
      );
      expect(calls.probe).not.toHaveBeenCalled();
    } finally {
      browser.restore();
    }
  });
  it("retains search and category after success and shows only a check mark", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      chooseCategory("General");
      fireEvent.change(screen.getByLabelText("Search connectors"), { target: { value: "Alpha" } });
      add("Alpha");
      await card("Alpha").findByText("Authorizing…");
      await complete(browser, calls.mounts);
      await card("Alpha").findByRole("img", { name: "Added" });
      expect(card("Alpha").getByText("Docs and wikis.")).toBeTruthy();
      expect(card("Alpha").queryByText(/Connected|Added/)).toBeNull();
      expect((screen.getByLabelText("Search connectors") as HTMLInputElement).value).toBe("Alpha");
      fireEvent.change(screen.getByLabelText("Search connectors"), { target: { value: "" } });
      expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      browser.restore();
    }
  });
  it("restores the catalog's actual scroll area after closing and reopening", async () => {
    stub([]);
    stubCatalogWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    const list = document.querySelector('[data-ui="mcp-catalog"]') as HTMLElement;
    list.scrollTop = 120;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole("button", { name: "Close Discover" }));
    await openDiscover();
    expect(document.querySelector('[data-ui="mcp-catalog"]')?.scrollTop).toBe(120);
  });
  it("continues authorization after Discover is closed", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      add("Alpha");
      await card("Alpha").findByText("Authorizing…");
      const close = screen.getByRole("button", { name: "Close Discover" });
      expect(close.hasAttribute("disabled")).toBe(false);
      fireEvent.click(close);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(browser.popup.close).not.toHaveBeenCalled();
      const row = within(document.getElementById(`mcp-server-${ALPHA_ID}`) as HTMLElement);
      await row.findByText("Authorizing…");
      expect(row.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(row.queryByRole("button", { name: /^(Reauthorize|Authorize)$/ })).toBeNull();
      await complete(browser, calls.mounts);
      await waitFor(() => expect(calls.probe).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID));
      expect(calls.detach).not.toHaveBeenCalled();
      await openDiscover();
      await card("Alpha").findByRole("img", { name: "Added" });
    } finally {
      browser.restore();
    }
  });
  it("can cancel the Discover authorization from Details after closing the directory", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      add("Alpha");
      await card("Alpha").findByText("Authorizing…");
      fireEvent.click(screen.getByRole("button", { name: "Close Discover" }));
      fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(calls.detach).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID));
      expect(calls.probe).not.toHaveBeenCalled();
      await openDiscover();
      expect(await card("Alpha").findByRole("button", { name: "Add: Alpha" })).toBeTruthy();
    } finally {
      browser.restore();
    }
  });
  it("shows a Details authorization in Discover without starting another attempt", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      calls.mounts.push(mountFor(serverFor("alpha"), null));
      wrap(<McpPage agentId={AGENT_ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
      fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
      await screen.findByRole("button", { name: "Cancel" });
      fireEvent.click(screen.getByRole("button", { name: "Close Alpha" }));
      await openDiscover();
      await card("Alpha").findByText("Authorizing…");
      expect(card("Alpha").queryByRole("button", { name: "Authorize: Alpha" })).toBeNull();
      expect(calls.oauth).toHaveBeenCalledTimes(1);
      fireEvent.click(card("Alpha").getByRole("button", { name: "Cancel: Alpha" }));
      await card("Alpha").findByRole("button", { name: "Authorize: Alpha" });
      expect(calls.detach).not.toHaveBeenCalled();
    } finally {
      browser.restore();
    }
  });
  it("clears a Details failure when Discover successfully authorizes the connector", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      calls.mounts.push(mountFor(serverFor("alpha"), null));
      calls.oauth.mockRejectedValueOnce(new ApiError(503, "private detail"));
      wrap(<McpPage agentId={AGENT_ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
      fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
      await within(screen.getByRole("dialog")).findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Close Alpha" }));
      await openDiscover();
      browser.popup.closed = false;
      fireEvent.click(card("Alpha").getByRole("button", { name: "Authorize: Alpha" }));
      await card("Alpha").findByText("Authorizing…");
      await complete(browser, calls.mounts);
      await card("Alpha").findByRole("img", { name: "Added" });
      fireEvent.click(screen.getByRole("button", { name: "Close Discover" }));
      const row = within(document.getElementById(`mcp-server-${ALPHA_ID}`) as HTMLElement);
      expect(row.queryByText("Authorization failed")).toBeNull();
    } finally {
      browser.restore();
    }
  });
  it("retries an authorized OAuth tool load from Discover without opening a window", async () => {
    const installed = mountFor(serverFor("alpha"), {
      ...summary("active"),
      probeState: "failed",
      probeError: `${MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE}: timed out`,
    });
    stub([installed]);
    const calls = stubCatalogWrites();
    calls.mounts.push(installed);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(await card("Alpha").findByRole("button", { name: "Retry: Alpha" }));
    await waitFor(() => expect(calls.probe).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID));
    expect(calls.oauth).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });
  it("explicitly cancels the matching first installation and restores +", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      add("Alpha");
      await card("Alpha").findByText("Authorizing…");
      fireEvent.click(screen.getByRole("button", { name: "Cancel: Alpha" }));
      await waitFor(() => expect(calls.detach).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID));
      await screen.findByRole("button", { name: "Add: Alpha" });
      expect(browserApi.revokeMcpAuthorization).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID, ALPHA_ID);
      expect(browserApi.removeMcpServer).toHaveBeenCalledWith(ALPHA_ID);
      expect(screen.queryByText(/cancelled|canceled/i)).toBeNull();
      calls.oauth.mockRejectedValue(new ApiError(503, "private detail"));
      add("Alpha");
      await card("Alpha").findByText("Authorization failed");
      expect(calls.create).toHaveBeenCalledTimes(2);
    } finally {
      browser.restore();
    }
  });
  it("preserves credentials when completion wins a cancellation race", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      add("Alpha");
      await card("Alpha").findByText("Authorizing…");
      calls.mounts[0] = mountFor(serverFor("alpha"), summary("active"));
      fireEvent.click(screen.getByRole("button", { name: "Cancel: Alpha" }));
      await card("Alpha").findByRole("img", { name: "Added" });
      expect(calls.detach).not.toHaveBeenCalled();
      expect(browserApi.removeMcpServer).not.toHaveBeenCalled();
    } finally {
      browser.restore();
    }
  });
  it("retains successful authorization after a tool failure and retries tools only", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const calls = stubCatalogWrites();
      calls.probe.mockResolvedValueOnce({
        ...ready,
        probeState: "failed",
        probeError: "MCP_PROBE_FAILED: private detail",
        toolsCount: null,
      });
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      add("Alpha");
      await card("Alpha").findByText("Authorizing…");
      await complete(browser, calls.mounts);
      await card("Alpha").findByText("Couldn't load tools");
      fireEvent.click(card("Alpha").getByRole("button", { name: "Retry: Alpha" }));
      await card("Alpha").findByRole("img", { name: "Added" });
      expect(calls.oauth).toHaveBeenCalledTimes(1);
      expect(calls.probe).toHaveBeenCalledTimes(2);
      expect(calls.detach).not.toHaveBeenCalled();
    } finally {
      browser.restore();
    }
  });
  it("offers Open and Cancel when the authorization popup is blocked", async () => {
    stub([]);
    const calls = stubCatalogWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    add("Alpha");
    await screen.findByText("Authorization page did not open");
    expect(screen.getByRole("button", { name: "Open window" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel: Alpha" }));
    await waitFor(() => expect(calls.detach).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID));
  });
});
