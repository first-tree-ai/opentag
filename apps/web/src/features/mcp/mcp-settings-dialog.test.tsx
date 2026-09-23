import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpAccountDialog } from "./mcp-account-settings.js";
import { McpDefaultsDialog } from "./mcp-defaults-dialog.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, detail, entry, menuAction, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const localEntry = () =>
  entry({
    effective: { ...entry().effective, url: "https://agent.example.com/mcp" },
    overridden: { ...entry().overridden, url: true },
  });

describe("MCP settings drafts and scope", () => {
  it("restores actual account defaults into a draft and cancels without a write", async () => {
    stub([localEntry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Settings");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Use account default for MCP URL" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    click("Use account default for MCP URL");
    expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe(detail(1).server.url);
    expect(update).not.toHaveBeenCalled();
    click("Cancel");
    expect(update).not.toHaveBeenCalled();
  });
  it("saves an explicit restore only on Save changes", async () => {
    stub([localEntry()]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Settings");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Use account default for MCP URL" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    click("Use account default for MCP URL");
    click("Save changes");
    await waitFor(() => expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { clearUrl: true }));
  });
  it.each([
    ["Use account defaults", { clearExtraHeaders: true }],
    ["Send no extra headers", { emptyExtraHeaders: true }],
  ])("preserves the meaning of %s", async (label, patch) => {
    stub([entry({ overridden: { ...entry().overridden, extraHeaders: true } })]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Settings");
    click("Advanced settings");
    fireEvent.click(await screen.findByRole("radio", { name: label as string }));
    click("Save changes");
    await waitFor(() => expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, patch));
  });
  it("keeps the Agent draft when returning from account defaults", async () => {
    stub([localEntry()], detail(2));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Settings");
    change("MCP URL", "https://draft.example.com/mcp");
    click("Edit account defaults");
    await screen.findByText("Used by");
    expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe(detail(2).server.url);
    expect(screen.getByRole("link", { name: "Helper" })).toBeTruthy();
    click("Cancel");
    expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe("https://draft.example.com/mcp");
    click("Save changes");
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { url: "https://draft.example.com/mcp" }),
    );
  });
  it("shows an account read error without offering a guessed baseline", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServer).mockRejectedValue(new ApiError(503, "Defaults unavailable"));
    wrap(<McpDefaultsDialog serverId={SERVER_ID} onClose={vi.fn()} />);
    expect(await screen.findByText("Defaults unavailable")).toBeTruthy();
    expect(screen.queryByLabelText("MCP URL")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save defaults" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("retains dirty fields after a revision conflict and rebases untouched fields", async () => {
    stub([]);
    const saved = { ...detail(1).server, description: "My description", revision: 6 };
    const update = vi
      .spyOn(browserApi, "updateMcpServer")
      .mockRejectedValueOnce(new ApiError(409, "Concurrent edit", "MCP_SERVER_REVISION_CONFLICT"))
      .mockResolvedValue(saved);
    wrap(<McpDefaultsDialog serverId={SERVER_ID} onClose={vi.fn()} />);
    await screen.findByLabelText("Description");
    change("Description", "My description");
    click("Save defaults");
    const reload = await screen.findByRole("button", { name: "Reload latest values" });
    expect(screen.getByRole("button", { name: "Save defaults" }).hasAttribute("disabled")).toBe(true);
    vi.mocked(browserApi.mcpServer).mockResolvedValue({
      ...detail(1),
      server: { ...detail(1).server, url: "https://latest.example.com/mcp", revision: 5 },
    });
    fireEvent.click(reload);
    await waitFor(() =>
      expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe("https://latest.example.com/mcp"),
    );
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("My description");
    click("Save defaults");
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(SERVER_ID, { expectedRevision: 5, description: "My description" }),
    );
  });
  it("keeps unmounted configurations discoverable and deletes only after confirmation", async () => {
    const unused = { ...detail(0), agents: [] };
    stub([], unused);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [unused.server] });
    const remove = vi.spyOn(browserApi, "removeMcpServer").mockResolvedValue(undefined);
    wrap(<McpAccountDialog onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /linear.*https/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete configuration" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    click("Delete configuration");
    await waitFor(() => expect(remove).toHaveBeenCalledWith(SERVER_ID));
  });
  it("blocks account deletion while another Agent uses the configuration", async () => {
    stub([], detail(2));
    wrap(<McpDefaultsDialog serverId={SERVER_ID} onClose={vi.fn()} />);
    const remove = await screen.findByRole("button", { name: "Delete configuration" });
    expect(remove.hasAttribute("disabled")).toBe(true);
  });
  it("reopens an explicit empty header override as Send no extra headers without creating a change", async () => {
    stub([
      entry({
        overridden: { ...entry().overridden, extraHeaders: true },
        effective: { ...entry().effective, extraHeaders: {} },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await menuAction("Settings");
    click("Advanced settings");
    expect((await screen.findByRole("radio", { name: "Send no extra headers" })).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  });
});
