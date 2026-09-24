import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import {
  AGENT_ID,
  detail,
  entry,
  menuAction,
  newAddress,
  openAdd,
  SERVER_ID,
  stub,
  wrap,
} from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const chooseAuth = (label: string) => fireEvent.click(screen.getByRole("radio", { name: label }));
const submitAdd = () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add server" }));
describe("MCP unified add journey", () => {
  it("explains the URL source and creates nothing before final submission", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress("https://mcp.linear.app/mcp");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("linear");
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe("https://mcp.linear.app/mcp");
    expect(screen.getByText("Paste the MCP URL provided by the service.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(create).not.toHaveBeenCalled();
  });
  it("preserves a manual name and a credential draft when returning", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "team-tools" } });
    chooseAuth("API key or token");
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "sample-key" },
    });
    fireEvent.change(screen.getByLabelText("MCP URL"), { target: { value: "https://other.example.com/mcp" } });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("team-tools");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      (screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }) as HTMLInputElement).value,
    ).toBe("sample-key");
  });
  it("validates URLs before continuing and immutable names before creating", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    fireEvent.change(await screen.findByLabelText("MCP URL"), {
      target: { value: "https://user:secret@example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/without credentials or a fragment/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("MCP URL"), { target: { value: "https://tools.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Invalid Name" } });
    expect(screen.getByRole("button", { name: "Add and authorize" }).hasAttribute("disabled")).toBe(true);
  });
  it("uses account names and URLs, keeps URL matches as choices, and prefills their actual auth method", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({
      servers: [{ ...detail(1).server, defaultAuthKind: "bearer" }],
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    const search = await screen.findByLabelText("Search this account or paste an MCP URL");
    fireEvent.change(search, { target: { value: "linear" } });
    fireEvent.submit(search.closest("form") as HTMLFormElement);
    expect(document.activeElement?.textContent).toContain("linear");
    expect(screen.queryByText(/Enter an HTTP/)).toBeNull();
    fireEvent.change(search, { target: { value: "https://mcp.linear.app/sse" } });
    fireEvent.submit(search.closest("form") as HTMLFormElement);
    expect(screen.queryByLabelText("Name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /linear.*https/ }));
    expect(screen.getByRole("radio", { name: "API key or token" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Authorize separately for Reviewer/)).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
  it("allows a different configuration for an exact URL without treating URLs as identities", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [detail(1).server] });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    fireEvent.change(await screen.findByLabelText("Search this account or paste an MCP URL"), {
      target: { value: detail(1).server.url },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use different connection settings" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("linear-2");
  });
  it("locates an existing mount rather than adding it again", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    stub([entry()]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [detail(1).server] });
    const attach = vi.spyOn(browserApi, "attachMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    expect(await screen.findByText("Added to Reviewer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(attach).not.toHaveBeenCalled();
  });
  it("keeps account read failures separate from an empty account", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockRejectedValue(new ApiError(503, "Account configurations unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    expect(await screen.findByText("Account configurations unavailable")).toBeTruthy();
    expect(screen.queryByLabelText("MCP URL")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("creates, attaches and authorizes a no-auth connection in order", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(detail(0).server);
    const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry({ authorization: null }));
    const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    chooseAuth("No authentication");
    submitAdd();
    await waitFor(() => expect(auth).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "none" }));
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0] as number);
    expect(attach.mock.invocationCallOrder[0]).toBeLessThan(auth.mock.invocationCallOrder[0] as number);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("retries attachment without creating a second configuration", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(detail(0).server);
    const attach = vi
      .spyOn(browserApi, "attachMcpServer")
      .mockRejectedValueOnce(new ApiError(503, "Attach unavailable"))
      .mockResolvedValue(entry());
    vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    chooseAuth("No authentication");
    submitAdd();
    expect(await screen.findByText("The configuration is saved. Retry to add it to this Agent.")).toBeTruthy();
    submitAdd();
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("retries OAuth after successful attachment without repeating create or attach", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(detail(0).server);
    const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry());
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress();
    fireEvent.click(screen.getByRole("button", { name: "Add and authorize" }));
    expect(await screen.findByText(/was added. Authorization is not complete/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Authorize in browser" }));
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
  });
  it("reuses a selected record and submits only this Agent's credential", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({
      servers: [{ ...detail(1).server, defaultAuthKind: "bearer" }],
    });
    const create = vi.spyOn(browserApi, "createMcpServer");
    vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry());
    const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    fireEvent.click(await screen.findByRole("button", { name: /linear.*https/ }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Add server" }).hasAttribute("disabled"),
    ).toBe(true);
    const token = screen.getByLabelText("API key or token", { selector: 'input[type="password"]' });
    expect(token.getAttribute("type")).toBe("password");
    fireEvent.change(token, { target: { value: "agent-key" } });
    submitAdd();
    await waitFor(() =>
      expect(auth).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "agent-key" }),
    );
    expect(create).not.toHaveBeenCalled();
  });
  it("saves OAuth extra headers before starting discovery", async () => {
    stub([entry({ authorization: null })]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Authentication");
    fireEvent.click(screen.getByRole("button", { name: "Advanced connection settings" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Custom headers" }));
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "x-team" } });
    fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "design" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize in browser" }));
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { extraHeaders: { "x-team": "design" } });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(oauth.mock.invocationCallOrder[0] as number);
  });
  it("does not revoke a stored credential when reauthorization fails", async () => {
    stub([entry()]);
    const revoke = vi.spyOn(browserApi, "revokeMcpAuthorization");
    vi.spyOn(browserApi, "setMcpAuthorization").mockRejectedValue(new ApiError(503, "Credential update failed"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Authentication");
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "new-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    expect(await screen.findByText("Credential update failed")).toBeTruthy();
    expect(revoke).not.toHaveBeenCalled();
  });
  it("prefills the account authentication default for an unfinished connection and allows another method", async () => {
    stub([entry({ authorization: null })]);
    vi.mocked(browserApi.mcpServer).mockResolvedValue({
      ...detail(1),
      server: { ...detail(1).server, defaultAuthKind: "bearer" },
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Authentication");
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "API key or token" }).getAttribute("aria-checked")).toBe("true"),
    );
    chooseAuth("No authentication");
    expect(screen.getByRole("radio", { name: "No authentication" }).getAttribute("aria-checked")).toBe("true");
  });
});
