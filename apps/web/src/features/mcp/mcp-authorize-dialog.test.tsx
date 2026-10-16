import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { installableEntries } from "./catalog/mcp-catalog-model.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, entry, openDetails, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const click = (name: string) => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name }));
const key = () =>
  screen.getByLabelText("API key or token", { selector: "input:not([type=radio])" }) as HTMLInputElement;

describe("MCP inline authentication", () => {
  it("keeps method selection local until Save and has no clear-credentials action", async () => {
    stub([entry()]);
    const authorize = vi
      .spyOn(browserApi, "setMcpAuthorization")
      .mockResolvedValue(entry({ authorization: { ...authorization(), kind: "none" } }));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    expect(authorize).not.toHaveBeenCalled();
    expect(browserApi.revokeMcpAuthorization).not.toHaveBeenCalled();
    click("Cancel");
    expect(screen.getByRole("radio", { name: "API key or token" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    click("Save");
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "none" }));
    expect(screen.queryByRole("button", { name: /Clear credentials/ })).toBeNull();
  });
  it("keeps an entered key on request failure and saves a replacement without a candidate probe", async () => {
    stub([entry()]);
    const authorize = vi
      .spyOn(browserApi, "setMcpAuthorization")
      .mockRejectedValueOnce(new ApiError(503, "private detail"))
      .mockResolvedValue(entry());
    const probe = vi.spyOn(browserApi, "probeMcpServer");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails();
    click("Update");
    fireEvent.change(key(), { target: { value: "new-key" } });
    click("Show key");
    expect(key().type).toBe("text");
    click("Hide key");
    click("Save");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't save changes");
    expect(key().value).toBe("new-key");
    click("Save");
    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    expect(authorize).toHaveBeenLastCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "new-key" });
    expect(probe).not.toHaveBeenCalled();
  });
  it("keeps OAuth start failures recoverable in the same dialog", async () => {
    stub([
      entry({
        name: "firecrawl",
        effective: { ...entry().effective, url: "https://mcp.firecrawl.dev/v2/mcp-oauth", extraHeaders: {} },
        authorization: { ...authorization(), kind: "oauth", hasCredential: false },
      }),
    ]);
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "private detail"));
    vi.spyOn(window, "open").mockReturnValue(null);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails("Firecrawl");
    click("Authorize");
    const failure = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(failure.textContent).toBe("Authorization failed");
    expect(failure.parentElement).toBe(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Authorize" }).parentElement,
    );
    const actionRow = failure.parentElement;
    if (!actionRow) throw new Error("Missing authorization action row");
    expect(within(actionRow).queryByRole("button", { name: "Use API key or token" })).toBeNull();
    click("Authorize");
    await waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
  it("shows a preset's visible read-only address and only supported alternative methods", async () => {
    const preset = installableEntries(MCP_CATALOG_ENTRIES).find((item) => item.id === "firecrawl");
    if (!preset?.keyAuth) throw new Error("Missing Firecrawl methods");
    const binding = entry({
      name: "firecrawl",
      effective: { ...entry().effective, url: preset.url, extraHeaders: {} },
      authorization: { ...authorization(), kind: "oauth", status: "expired" },
    });
    stub([binding]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization");
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails("Firecrawl");
    const expiry = within(screen.getByRole("dialog")).getByText("Authorization expired");
    expect(expiry.parentElement).toBe(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Reauthorize" }).parentElement,
    );
    expect((screen.getByLabelText("Connector address") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: /Advanced|Tools|Delete|Clear|Save/ })).toBeNull();
    click("Use API key or token");
    expect((screen.getByLabelText("Connector address") as HTMLInputElement).value).toBe(preset.keyAuth.url);
    fireEvent.change(key(), { target: { value: "draft-key" } });
    expect(update).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    click("Cancel");
    expect((screen.getByLabelText("Connector address") as HTMLInputElement).value).toBe(preset.url);
    expect(screen.getByRole("button", { name: "Use API key or token" })).toBeTruthy();
    expect(browserApi.revokeMcpAuthorization).not.toHaveBeenCalled();
  });
  it("saves an alternate preset key without restoring the old method after a rejected probe", async () => {
    const preset = installableEntries(MCP_CATALOG_ENTRIES).find((item) => item.id === "firecrawl");
    if (!preset?.keyAuth) throw new Error("Missing Firecrawl methods");
    let current = entry({
      name: preset.name,
      effective: { ...entry().effective, url: preset.url, extraHeaders: {} },
      authorization: { ...authorization(), kind: "oauth" },
    });
    stub([current]);
    vi.mocked(browserApi.agentMcpServers).mockImplementation(async () => ({ servers: [current] }));
    vi.mocked(browserApi.revokeMcpAuthorization).mockImplementation(async () => {
      current = {
        ...current,
        authorization: { ...authorization(), kind: "oauth", status: "revoked", hasCredential: false },
      };
      return current;
    });
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation(async (_agent, _id, patch) => {
      current = { ...current, effective: { ...current.effective, ...patch } };
      return current;
    });
    const authorize = vi.spyOn(browserApi, "setMcpAuthorization").mockImplementation(async () => {
      current = {
        ...current,
        authorization: {
          ...authorization(),
          kind: "bearer",
          probeState: "failed",
          probeError: `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`,
        },
      };
      return current;
    });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails("Firecrawl");
    click("Use API key or token");
    fireEvent.change(key(), { target: { value: "replacement-key" } });
    click("Save");
    await screen.findByRole("button", { name: "Update" });
    expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { url: preset.keyAuth.url });
    expect(authorize).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { kind: "bearer", bearerKey: "replacement-key" });
    expect(current.authorization?.kind).toBe("bearer");
    expect(current.authorization?.hasCredential).toBe(true);
    expect((screen.getByLabelText("Connector address") as HTMLInputElement).value).toBe(preset.keyAuth.url);
  });
  it("does not offer a method switch for a single-method preset", async () => {
    const preset = installableEntries(MCP_CATALOG_ENTRIES).find((item) => item.id === "notion");
    if (!preset) throw new Error("Missing Notion");
    stub([
      entry({
        name: preset.name,
        effective: { ...entry().effective, url: preset.url, extraHeaders: {} },
        authorization: { ...authorization(), kind: "oauth" },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openDetails("Notion");
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });
});
