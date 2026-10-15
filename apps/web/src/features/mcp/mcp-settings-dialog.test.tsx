import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, entry, openDetails, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
async function open() {
  wrap(<McpPage agentId={AGENT_ID} />);
  await openDetails();
}

describe("MCP custom configuration", () => {
  it("cancels this Agent's draft without writing", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    await open();
    change("Connector address", "https://draft.example.com/mcp");
    click("Cancel");
    expect((screen.getByLabelText("Connector address") as HTMLInputElement).value).toBe(entry().effective.url);
    expect(update).not.toHaveBeenCalled();
  });
  it("removes all extra headers with an explicit empty map", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    await open();
    click("Advanced settings");
    click("Remove header");
    click("Save");
    await waitFor(() => expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { extraHeaders: {} }));
  });
  it("saves only the edited field without changing shared defaults", async () => {
    stub([entry()]);
    const saved = entry({ effective: { ...entry().effective, url: "https://agent.example.com/mcp" } });
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [saved] });
      return saved;
    });
    const shared = vi.spyOn(browserApi, "updateMcpServer");
    await open();
    change("Connector address", saved.effective.url);
    click("Save");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { url: saved.effective.url });
    expect(shared).not.toHaveBeenCalled();
    await openDetails();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
  it("keeps the configuration draft after a failed save", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "updateAgentMcpServer").mockRejectedValue(new ApiError(503, "internal detail"));
    await open();
    change("Connector address", "https://draft.example.com/mcp");
    click("Save");
    await screen.findByText("Couldn't save changes");
    expect((screen.getByLabelText("Connector address") as HTMLInputElement).value).toBe(
      "https://draft.example.com/mcp",
    );
  });
  it("changes header rules with the stored credential without asking for another key", async () => {
    stub([entry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization");
    await open();
    click("Advanced settings");
    change("Auth header", "x-api-key");
    change("Prefix", "");
    click("Save");
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { authHeader: "x-api-key", authScheme: "" }),
    );
    expect(authorize).not.toHaveBeenCalled();
  });
  it("opening Advanced settings alone does not create a change", async () => {
    stub([entry({ effective: { ...entry().effective, extraHeaders: {} } })]);
    await open();
    click("Advanced settings");
    expect(screen.queryByLabelText("Header name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: /account default/i })).toBeNull();
  });
});
