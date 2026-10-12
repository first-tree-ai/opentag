import type { McpCatalogEntry } from "@opentag/mcp-presets";
import type { MCPAgentServer, MCPAuthorizationSummary, MCPServer } from "@opentag/shared/browser";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../../api.js";
import { fakeMcpOAuthBrowser } from "../mcp-oauth-test-fixtures.js";
import { McpPage } from "../mcp-page.js";
import { AGENT_ID, entry, openAdd, stub, wrap } from "../mcp-test-fixtures.js";
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

vi.mock("@opentag/mcp-presets", () => ({
  MCP_CATALOG_CATEGORIES: CATALOG.categories,
  MCP_CATALOG_ENTRIES: CATALOG.entries,
}));

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  vi.spyOn(window, "open").mockReturnValue(null);
});
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
    const binding = mountFor(serverFor(nameForId(id)), { ...summary("active"), kind: input.kind });
    const index = mounts.findIndex((entry) => entry.mcpServerId === id);
    mounts[index] = binding;
    return binding;
  });
  vi.mocked(browserApi.mcpServer).mockImplementation(async (id) => ({
    server: (await browserApi.mcpServers()).servers.find((server) => server.id === id) ?? serverFor(nameForId(id)),
    agents: [],
  }));
  vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue({
    probeState: "succeeded",
    probeError: null,
    toolsCount: 3,
    toolsTruncated: false,
    protocolEra: null,
    protocolVersion: null,
  });
  return { create, attach, authorize, mounts, detach };
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
  it("starts with all entries and preserves the declared category order", async () => {
    await discover();
    const tabs = screen.getByRole("group", { name: "Categories" }).querySelectorAll("button");
    expect([...tabs].map((tab) => tab.textContent)).toEqual(["All", "General", "Engineering"]);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
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
    const search = screen.getByLabelText("Search connectors");
    fireEvent.change(search, { target: { value: "wiki" } });
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
    fireEvent.change(search, { target: { value: "mcp.beta.test" } });
    expect(screen.getByText("Beta")).toBeTruthy();
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
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View: Alpha" })).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add: Alpha" })).toBeNull();
  });

  it("keeps authorization details out of an added card", async () => {
    await discover({ mounted: [mountFor(serverFor("alpha"), summary("pending"))] });
    expect(screen.getByRole("button", { name: "Connect: Alpha" })).toBeTruthy();
    expect(screen.queryByText("Authorization required")).toBeNull();
    expect(screen.queryByRole("button", { name: "View: Alpha" })).toBeNull();
  });
});

describe("Discover to Agent management", () => {
  it("keeps the URL Add dialog separate from the independent directory", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    expect(screen.queryByRole("button", { name: "Use an existing connector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Discover" }));
    expect(screen.getAllByRole("button", { name: "Add custom" })).toHaveLength(1);
    await openAdd();
    expect(await screen.findByLabelText("Connector URL")).toBeTruthy();
    for (const name of ["Discover", "Use an existing connector", "Import configuration", "Configure manually"]) {
      expect(within(screen.getByRole("dialog")).queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByLabelText("Search connectors")).toBeNull();
  });

  it.each(["Alpha", "Delta"])(
    "keeps %s startup failures in Discover and removes only the new binding",
    async (title) => {
      stub([]);
      const { create, attach } = stubCatalogWrites();
      const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "upstream detail"));
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      fireEvent.click(screen.getByRole("button", { name: `Add: ${title}` }));
      await screen.findByText("Couldn’t start sign-in. Try again.");
      expect(screen.getByRole("dialog", { name: "Discover" })).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: /authentication/ })).toBeNull();
      expect(screen.queryByText(/^Set up /)).toBeNull();
      expect(oauth).toHaveBeenCalledWith(
        AGENT_ID,
        title === "Alpha" ? ALPHA_ID : DELTA_ID,
        title === "Alpha" ? { scopes: ["alpha.read", "alpha.write"] } : {},
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(attach).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: `Add: ${title}` }).hasAttribute("disabled")).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: `Add: ${title}` }));
      await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
      expect(create).toHaveBeenCalledTimes(1);
      expect(attach).toHaveBeenCalledTimes(2);
    },
  );

  it("admits only one mount while an Add write is in flight", async () => {
    stub([]);
    const { create, attach } = stubCatalogWrites();
    let finish: (server: MCPServer) => void = () => {};
    create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "upstream detail"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    const add = screen.getByRole("button", { name: "Add: Alpha" });
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(attach).not.toHaveBeenCalled();
    finish(serverFor("alpha"));
    await screen.findByText("Couldn’t start sign-in. Try again.");
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("does not send catalog scopes to a restored binding's custom endpoint", async () => {
    stub([]);
    const { attach, mounts } = stubCatalogWrites();
    attach.mockImplementation(async () => {
      const binding = { ...mountFor(serverFor("alpha"), null), snapshot: null };
      binding.effective = { ...binding.effective, url: "https://custom.alpha.test/mcp" };
      mounts.push(binding);
      return binding;
    });
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "upstream detail"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Alpha" }));
    await screen.findByText("Couldn’t start sign-in. Try again.");
    expect(oauth).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID, {});
    expect(update).not.toHaveBeenCalled();
  });

  it("immediately probes an anonymous mount that is already authorized", async () => {
    stub([]);
    const { attach, authorize, mounts } = stubCatalogWrites();
    attach.mockImplementation(async () => {
      const binding = mountFor(serverFor("beta"), { ...summary("active"), kind: "none", probeState: "pending" });
      mounts.push(binding);
      return binding;
    });
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockImplementation(async () => {
      mounts[0] = mountFor(serverFor("beta"), { ...summary("active"), kind: "none" });
      return {
        probeState: "succeeded",
        probeError: null,
        toolsCount: 3,
        toolsTruncated: false,
        protocolEra: "modern",
        protocolVersion: "2025-03-26",
      };
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Beta" }));
    await within(screen.getByRole("dialog")).findByText("Connected");
    expect(probe).toHaveBeenCalledWith(AGENT_ID, BETA_ID);
    expect(authorize).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Discover" })).toBeTruthy();
  });

  it("retains Discover while anonymous credentials and tool discovery finish", async () => {
    stub([]);
    const { authorize, mounts } = stubCatalogWrites();
    let finish: () => void = () => {};
    authorize.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            const pending = {
              ...mountFor(serverFor("beta"), {
                ...summary("active"),
                kind: "none",
                probeState: "pending",
                toolsCount: 0,
              }),
              snapshot: null,
            };
            mounts[0] = pending;
            resolve(pending);
          };
        }),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Beta" }));
    await screen.findByText("Connecting…");
    expect(screen.getByRole("dialog", { name: "Discover" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^(Add|Connect): Beta$/ }).hasAttribute("disabled")).toBe(true);
    finish();
    await within(screen.getByRole("dialog", { name: "Discover" })).findByText("Connected");
    expect(screen.getByRole("dialog", { name: "Discover" })).toBeTruthy();
    expect(authorize).toHaveBeenCalledWith(AGENT_ID, BETA_ID, { kind: "none" });
  });

  it("keeps probe failures and retries in Discover", async () => {
    stub([]);
    const { create, attach, authorize, mounts } = stubCatalogWrites();
    authorize.mockImplementation(async () => {
      const failed = mountFor(serverFor("beta"), {
        ...summary("active"),
        kind: "none",
        probeState: "failed",
        probeError: "Upstream unavailable",
        toolsCount: 0,
      });
      mounts[0] = failed;
      return failed;
    });
    const probe = vi
      .spyOn(browserApi, "probeMcpServer")
      .mockResolvedValueOnce({
        probeState: "failed",
        probeError: "Upstream unavailable",
        toolsCount: null,
        toolsTruncated: false,
        protocolEra: null,
        protocolVersion: null,
      })
      .mockImplementation(async () => {
        mounts[0] = mountFor(serverFor("beta"), { ...summary("active"), kind: "none" });
        return {
          probeState: "succeeded",
          probeError: null,
          toolsCount: 3,
          toolsTruncated: false,
          protocolEra: null,
          protocolVersion: null,
        };
      });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Beta" }));
    await screen.findByText("Couldn’t load tools. Try again.");
    const retry = screen.getByRole("button", { name: /^(Add|Connect): Beta$/ });
    expect(screen.getByRole("dialog", { name: "Discover" })).toBeTruthy();
    fireEvent.click(retry);
    expect(await within(screen.getByRole("dialog")).findByText("Connected", { exact: true })).toBeTruthy();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(within(screen.getByText("Beta").closest("li") as HTMLElement).getByText("Connected")).toBeTruthy();
  });

  it("opens the shared key form without method selection and saves to the same mount", async () => {
    stub([]);
    const { create, attach, authorize } = stubCatalogWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Gamma" }));
    const key = await screen.findByLabelText("API key or token", { selector: 'input[type="password"]' });
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByRole("radio")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Advanced connection settings" })).toBeNull();
    expect(screen.getByLabelText("Search connectors").closest("[hidden]")).toBeTruthy();
    fireEvent.change(key, { target: { value: "sample-key" } });
    fireEvent.click(dialog.getByRole("button", { name: "Connect" }));
    await screen.findByRole("dialog", { name: "Discover" });
    await within(screen.getByRole("dialog", { name: "Discover" })).findByText("Connected");
    expect(authorize).toHaveBeenCalledWith(AGENT_ID, GAMMA_ID, { kind: "bearer", bearerKey: "sample-key" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("removes a new key setup on cancel and reuses its definition on retry", async () => {
    stub([]);
    const { create, attach, authorize, detach } = stubCatalogWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Gamma" }));
    await screen.findByLabelText("API key or token", { selector: 'input[type="password"]' });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(detach).toHaveBeenCalledWith(AGENT_ID, GAMMA_ID));
    await screen.findByRole("dialog", { name: "Discover" });
    fireEvent.click(screen.getByRole("button", { name: "Add: Gamma" }));
    await screen.findByLabelText("API key or token", { selector: 'input[type="password"]' });
    expect(authorize).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("keeps key errors and typed credentials in the shared authentication form", async () => {
    stub([]);
    const { authorize, create, attach } = stubCatalogWrites();
    authorize.mockRejectedValueOnce(new ApiError(503, "upstream detail"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Gamma" }));
    const key = await screen.findByLabelText("API key or token", { selector: 'input[type="password"]' });
    fireEvent.change(key, { target: { value: "sample-key" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Couldn’t connect. Try again.")).toBeTruthy();
    expect((key as HTMLInputElement).value).toBe("sample-key");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
    await screen.findByRole("dialog", { name: "Discover" });
    await within(screen.getByRole("dialog", { name: "Discover" })).findByText("Connected");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("keeps adding errors in the directory and retries without duplicate definitions", async () => {
    stub([]);
    const { attach, create } = stubCatalogWrites();
    attach.mockRejectedValueOnce(new ApiError(503, "Attach unavailable"));
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "upstream detail"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.change(screen.getByLabelText("Search connectors"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Add: Alpha" }));
    await screen.findByText("Attach unavailable");
    expect((screen.getByLabelText("Search connectors") as HTMLInputElement).value).toBe("Alpha");
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add: Alpha" }));
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed authorization separate from the next service's mount", async () => {
    stub([]);
    const { authorize, attach } = stubCatalogWrites();
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "upstream detail"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Alpha" }));
    await screen.findByText("Couldn’t start sign-in. Try again.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add: Beta" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Add: Beta" }));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(AGENT_ID, BETA_ID, { kind: "none" }));
    expect(attach).toHaveBeenLastCalledWith(AGENT_ID, { mcpServerId: BETA_ID, enabled: true });
  });

  it("uses the Account definition's authentication kind and preserves inherited headers", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({
      servers: [{ ...serverFor("alpha"), defaultAuthKind: "bearer" }],
    });
    const { attach, create, authorize } = stubCatalogWrites();
    const inherited = { "x-workspace": "existing-workspace" };
    attach.mockImplementation(async () => ({
      ...mountFor(serverFor("alpha"), null),
      effective: { ...entry().effective, url: serverFor("alpha").url, extraHeaders: inherited },
    }));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Alpha" }));
    fireEvent.change(await screen.findByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "sample-key" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(authorize).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID, { kind: "bearer", bearerKey: "sample-key" }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("Discover authorization window", () => {
  it("keeps search and category intact, verifies success, and permits another installation", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      stub([]);
      const { mounts } = stubCatalogWrites();
      vi.spyOn(browserApi, "startMcpOAuth").mockResolvedValue({
        authorizationUrl: "https://provider.test/authorize",
        expiresAt: "2026-10-12T12:00:00Z",
      });
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      chooseCategory("General");
      fireEvent.change(screen.getByLabelText("Search connectors"), { target: { value: "Alpha" } });
      fireEvent.click(screen.getByRole("button", { name: "Add: Alpha" }));
      await screen.findByText("Complete sign-in in the authorization window.");
      expect(browser.open).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("dialog", { name: "Discover" })).toBeTruthy();
      mounts[0] = mountFor(serverFor("alpha"), summary("active"));
      await act(async () => browser.send({ mcpServerId: ALPHA_ID, outcome: { kind: "success" } }));
      const card = screen.getByText("Alpha").closest("li");
      if (!card) throw new Error("Missing catalog card");
      await within(card).findByText("Connected");
      expect((screen.getByLabelText("Search connectors") as HTMLInputElement).value).toBe("Alpha");
      fireEvent.change(screen.getByLabelText("Search connectors"), { target: { value: "" } });
      expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: "Add: Delta" }).hasAttribute("disabled")).toBe(false);
    } finally {
      browser.restore();
    }
  });
  it.each(["deny", "close"])(
    "cleans up a new installation on %s and retains its definition for retry",
    async (action) => {
      const browser = fakeMcpOAuthBrowser();
      try {
        stub([]);
        const { create, detach, mounts } = stubCatalogWrites();
        vi.spyOn(browserApi, "startMcpOAuth").mockResolvedValue({
          authorizationUrl: "https://provider.test/authorize",
          expiresAt: "2026-10-12T12:00:00Z",
        });
        wrap(<McpPage agentId={AGENT_ID} />);
        await openDiscover();
        fireEvent.click(screen.getByRole("button", { name: "Add: Alpha" }));
        await screen.findByText("Complete sign-in in the authorization window.");
        if (action === "deny")
          await act(async () =>
            browser.send({ mcpServerId: ALPHA_ID, outcome: { kind: "error", code: "MCP_OAUTH_DENIED" } }),
          );
        else {
          browser.popup.closed = true;
          await screen.findByText("If the authorization window was closed, cancel this attempt to try again.");
          fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        }
        await screen.findByText("Sign-in was cancelled. You can try again.");
        await waitFor(() => expect(detach).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID));
        expect(mounts).toHaveLength(0);
        expect(create).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("dialog", { name: "Discover" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Add: Alpha" })).toBeTruthy();
      } finally {
        browser.restore();
      }
    },
  );
  it("cancelling a pre-existing connection never removes its binding or credential", async () => {
    const browser = fakeMcpOAuthBrowser();
    try {
      const prior = mountFor(serverFor("alpha"), summary("expired"));
      stub([prior]);
      vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [serverFor("alpha")] });
      const detach = vi.spyOn(browserApi, "detachMcpServer");
      vi.spyOn(browserApi, "startMcpOAuth").mockResolvedValue({
        authorizationUrl: "https://provider.test/authorize",
        expiresAt: "2026-10-12T12:00:00Z",
      });
      wrap(<McpPage agentId={AGENT_ID} />);
      await openDiscover();
      fireEvent.click(screen.getByRole("button", { name: "Connect: Alpha" }));
      await screen.findByText("Complete sign-in in the authorization window.");
      await act(async () =>
        browser.send({ mcpServerId: ALPHA_ID, outcome: { kind: "error", code: "MCP_OAUTH_DENIED" } }),
      );
      await screen.findByText("Sign-in was cancelled. You can try again.");
      expect(detach).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Connect: Alpha" }).hasAttribute("disabled")).toBe(false);
    } finally {
      browser.restore();
    }
  });
  it("offers an explicit link when a popup is blocked and allows cancellation", async () => {
    stub([]);
    const { detach } = stubCatalogWrites();
    vi.spyOn(browserApi, "startMcpOAuth").mockResolvedValue({
      authorizationUrl: "https://provider.test/authorize",
      expiresAt: "2026-10-12T12:00:00Z",
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDiscover();
    fireEvent.click(screen.getByRole("button", { name: "Add: Alpha" }));
    await screen.findByText("The authorization window did not open.");
    expect(screen.getByRole("button", { name: "Open authorization page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(detach).toHaveBeenCalledWith(AGENT_ID, ALPHA_ID));
    expect(screen.getByRole("dialog", { name: "Discover" })).toBeTruthy();
  });
});
