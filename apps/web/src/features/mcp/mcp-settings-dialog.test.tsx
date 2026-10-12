import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, entry, openDetails, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const localEntry = () =>
  entry({
    effective: { ...entry().effective, url: "https://agent.example.com/mcp" },
    overridden: { ...entry().overridden, url: true },
  });

describe("MCP settings drafts and scope", () => {
  it("edits this Agent's URL and cancels without writing", async () => {
    stub([localEntry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    expect(screen.queryByRole("button", { name: /account default/ })).toBeNull();
    change("Server address", "https://draft.example.com/mcp");
    click("Cancel");
    expect(update).not.toHaveBeenCalled();
  });
  it("removes all extra headers with an explicit empty map", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    click("Advanced settings");
    click("Remove header");
    click("Save changes");
    await waitFor(() => expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { extraHeaders: {} }));
  });
  it("saves only the edited field and follows later updates to inherited headers", async () => {
    stub([entry()]);
    const saved = entry({
      effective: {
        ...entry().effective,
        url: "https://agent.example.com/mcp",
        extraHeaders: { "x-workspace-id": "updated-shared-workspace" },
      },
      overridden: { ...entry().overridden, url: true },
    });
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [saved] });
      return saved;
    });
    const updateShared = vi.spyOn(browserApi, "updateMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    change("Server address", saved.effective.url);
    click("Save changes");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { url: saved.effective.url });
    expect(updateShared).not.toHaveBeenCalled();
    await openDetails();
    click("Advanced settings");
    expect((screen.getByLabelText("Header value") as HTMLInputElement).value).toBe("updated-shared-workspace");
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  });
  it("saves before opening authentication and retains the draft when a save fails", async () => {
    stub([localEntry()]);
    const saved = entry({
      effective: { ...entry().effective, url: "https://draft.example.com/mcp" },
      authorization: null,
    });
    const update = vi
      .spyOn(browserApi, "updateAgentMcpServer")
      .mockRejectedValueOnce(new ApiError(503, "Save unavailable"))
      .mockImplementation(async () => {
        vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [saved] });
        return saved;
      });
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    change("Server address", "https://draft.example.com/mcp");
    click("Authentication");
    expect(screen.getByText("Save connection changes before authentication.")).toBeTruthy();
    click("Save and continue");
    await screen.findByText("Save unavailable");
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe("https://draft.example.com/mcp");
    expect(authorize).not.toHaveBeenCalled();
    click("Save and continue");
    await screen.findByRole("dialog", { name: "Authentication" });
    expect(update).toHaveBeenLastCalledWith(AGENT_ID, SERVER_ID, { url: "https://draft.example.com/mcp" });
    expect(authorize).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Server address")).toBeNull();
    click("Back");
    await screen.findByRole("dialog", { name: "linear" });
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe(saved.effective.url);
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  });
  it("continues without a write if connection changes are withdrawn", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    change("Server address", "https://draft.example.com/mcp");
    click("Authentication");
    change("Server address", entry().effective.url);
    click("Continue");
    await screen.findByRole("dialog", { name: "Authentication" });
    expect(update).not.toHaveBeenCalled();
  });
  it("changes token settings using the stored credential without requesting another key", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    click("Advanced settings");
    change("Auth header", "x-api-key");
    change("Token prefix", "");
    click("Save changes");
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { authHeader: "x-api-key", authScheme: "" }),
    );
    expect(authorize).not.toHaveBeenCalled();
  });
  it("opens empty extra headers without creating a change", async () => {
    stub([entry({ effective: { ...entry().effective, extraHeaders: {} } })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    click("Advanced settings");
    expect(screen.queryByLabelText("Header name")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("MCP tools authentication preserves connection drafts", () => {
  it("saves before authentication from Tools and returns to the same search", async () => {
    stub([entry({ authorization: null })]);
    const oauth = vi.spyOn(browserApi, "startMcpOAuth");
    const saved = entry({
      authorization: null,
      effective: { ...entry().effective, url: "https://draft.example.com/mcp" },
    });
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [saved] });
      return saved;
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    change("Server address", saved.effective.url);
    click("Tools");
    change("Search tools", "issue");
    click("Reconnect");
    await screen.findByRole("dialog", { name: "linear" });
    expect(screen.getByText("Save connection changes before authentication.")).toBeTruthy();
    expect(oauth).not.toHaveBeenCalled();
    click("Keep editing");
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe(saved.effective.url);
    click("Tools");
    expect((screen.getByLabelText("Search tools") as HTMLInputElement).value).toBe("issue");
    click("Reconnect");
    click("Save and continue");
    await screen.findByRole("dialog", { name: "Authentication" });
    expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { url: saved.effective.url });
    expect(oauth).not.toHaveBeenCalled();
    click("Back");
    await screen.findByRole("dialog", { name: "Tools" });
    expect((screen.getByLabelText("Search tools") as HTMLInputElement).value).toBe("issue");
    click("Back");
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe(saved.effective.url);
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  });
});
