import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, detail, entry, openDetails, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
describe("MCP existing authentication settings", () => {
  it("saves OAuth extra headers before starting discovery", async () => {
    const original = entry({ authorization: null });
    stub([original]);
    const saved = entry({
      authorization: null,
      effective: { ...original.effective, extraHeaders: { "x-team": "design" } },
      overridden: { ...original.overridden, extraHeaders: true },
    });
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(async () => {
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [saved] });
      return saved;
    });
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "x-team" } });
    fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "design" } });
    fireEvent.click(screen.getByRole("button", { name: /Authentication/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await screen.findByRole("dialog", { name: "Authentication" });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { extraHeaders: { "x-team": "design" } });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(oauth.mock.invocationCallOrder[0] as number);
  });
  it("does not revoke a stored credential when reauthorization fails", async () => {
    stub([entry()]);
    const revoke = vi.spyOn(browserApi, "revokeMcpAuthorization");
    vi.spyOn(browserApi, "setMcpAuthorization").mockRejectedValue(new ApiError(503, "Credential update failed"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: /Authentication/ }));
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
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: /Authentication/ }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "API key or token" }).getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    expect(screen.getByRole("radio", { name: "No authentication" }).getAttribute("aria-checked")).toBe("true");
  });
});
