import { MCP_CATALOG_ENTRIES, type McpInstallableCatalogEntry } from "@opentag/mcp-presets";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, detail, entry, newAddress, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const github = MCP_CATALOG_ENTRIES.find((entry) => entry.id === "github") as McpInstallableCatalogEntry;
function reuseSetup(extraHeaders: Record<string, string> = {}) {
  stub([]);
  vi.spyOn(window, "open").mockReturnValue(null);
  const server = { ...detail(1).server, name: "github", url: github.url, extraHeaders };
  const binding = entry({
    name: "github",
    effective: { url: server.url, authHeader: server.authHeader, authScheme: server.authScheme, extraHeaders },
    authorization: null,
  });
  vi.mocked(browserApi.reusableMcpInstallation).mockResolvedValue({ server });
  vi.mocked(browserApi.connectMcpOAuth).mockImplementation(async () => {
    vi.mocked(browserApi.agentMcpServers).mockResolvedValue({
      servers: [{ ...binding, authorization: { ...authorization(), kind: "oauth" } }],
    });
    return { connected: true };
  });
  const create = vi.spyOn(browserApi, "createMcpServer");
  const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(binding);
  const oauth = vi.spyOn(browserApi, "startMcpOAuth");
  const probe = vi.spyOn(browserApi, "probeMcpServer");
  return { create, attach, oauth, probe };
}
function expectReused(calls: ReturnType<typeof reuseSetup>) {
  expect(calls.attach).toHaveBeenCalledExactlyOnceWith(AGENT_ID, { mcpServerId: SERVER_ID, enabled: true });
  expect(browserApi.connectMcpOAuth).toHaveBeenCalledExactlyOnceWith(AGENT_ID, SERVER_ID, github.oauthScopes);
  expect(calls.create).not.toHaveBeenCalled();
  expect(calls.oauth).not.toHaveBeenCalled();
  expect(calls.probe).not.toHaveBeenCalled();
}
describe("ordinary second-Agent installation", () => {
  it("adds GitHub from Discover using the existing definition and authentication", async () => {
    const calls = reuseSetup(
      Object.fromEntries(Object.entries(github.extraHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    const discover = await screen.findByRole("button", { name: "Discover" });
    await waitFor(() => expect(discover.hasAttribute("disabled")).toBe(false));
    fireEvent.click(discover);
    fireEvent.click(await screen.findByRole("button", { name: "Add: GitHub" }));
    await waitFor(() => expect(browserApi.connectMcpOAuth).toHaveBeenCalledTimes(1));
    expect(browserApi.reusableMcpInstallation).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ url: github.url, defaultAuthKind: "oauth" }),
      github.oauthScopes,
    );
    expectReused(calls);
  }, 20_000);
  it("adds GitHub by URL without another definition, consent or foreground probe", async () => {
    const calls = reuseSetup();
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress(github.url);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectReused(calls);
  }, 20_000);
});
