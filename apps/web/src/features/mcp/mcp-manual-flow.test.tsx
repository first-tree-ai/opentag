import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLocaleAsync } from "../../__tests__/support/with-locale.js";
import { ApiError, browserApi } from "../../api.js";
import { McpAddDialog } from "./mcp-add-dialog.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, detail, entry, newAddress, openAdd, stub, wrap } from "./mcp-test-fixtures.js";

/**
 * The manual configuration source: the entry for a Server whose address, name, and authorization the
 * user types from nothing. The Account pool's paste-a-URL shortcut stays in place, so these journeys
 * also pin that the new source is additive.
 */

afterEach(() => vi.restoreAllMocks());

const MANUAL_SOURCE = "Configure manually";
const EXISTING_SOURCE = "Use an existing Server";
const MANUAL_URL = "https://mcp.example.com/mcp";
const MANUAL_NAME = "manual-tools";

/** The Server echoes the definition it stored, so the dialog's own header comparison stays honest. */
const echoServer = async (input: Parameters<typeof browserApi.createMcpServer>[0]) => ({
  ...detail(0).server,
  ...input,
  extraHeaders: input.extraHeaders ?? {},
});

/** Open the add dialog from the page header, then switch it to the manual source. */
async function openManual() {
  await openAdd();
  fireEvent.click(await screen.findByRole("button", { name: MANUAL_SOURCE }));
  await screen.findByLabelText("MCP URL");
}

/** The web app root, so the message catalogues can be read as they are committed. */
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Fill what a manual Server needs. The address goes first so the name suggestion is superseded. */
function fillManual(url = MANUAL_URL, name = MANUAL_NAME) {
  fireEvent.change(screen.getByLabelText("MCP URL"), { target: { value: url } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
}

const manualSubmit = (label = "Add server") => within(screen.getByRole("dialog")).getByRole("button", { name: label });

function submitManual(label = "Add server") {
  fireEvent.click(manualSubmit(label));
}

const password = () => screen.getByLabelText("API key or token", { selector: 'input[type="password"]' });

function stubManualWrites() {
  const create = vi.spyOn(browserApi, "createMcpServer").mockImplementation(echoServer);
  const attach = vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry({ authorization: null }));
  const auth = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
  return { create, attach, auth };
}

const expectNothingWritten = (writes: ReturnType<typeof stubManualWrites>) => {
  expect(writes.create).not.toHaveBeenCalled();
  expect(writes.attach).not.toHaveBeenCalled();
  expect(writes.auth).not.toHaveBeenCalled();
};

describe("MCP manual configuration source", () => {
  it("offers the manual source beside the three existing ones", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await screen.findByRole("button", { name: MANUAL_SOURCE });
    for (const name of ["Discover", EXISTING_SOURCE, "Import configuration", MANUAL_SOURCE]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // The page header opens on the Account pool, so the manual source starts unpressed.
    expect(screen.getByRole("button", { name: EXISTING_SOURCE }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: MANUAL_SOURCE }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: MANUAL_SOURCE }));
    expect(screen.getByRole("button", { name: MANUAL_SOURCE }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: EXISTING_SOURCE }).getAttribute("aria-pressed")).toBe("false");
  });

  it("reaches the manual form from every other source without reopening the dialog", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    await screen.findByRole("button", { name: MANUAL_SOURCE });
    for (const name of ["Discover", "Import configuration", EXISTING_SOURCE]) {
      fireEvent.click(screen.getByRole("button", { name }));
      fireEvent.click(screen.getByRole("button", { name: MANUAL_SOURCE }));
      expect(screen.getByLabelText("MCP URL")).toBeTruthy();
      expect(screen.getByRole("dialog")).toBeTruthy();
    }
  });

  it("shows the whole new-Server form without a search or a paste", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [detail(1).server] });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    expect(screen.getByLabelText("MCP URL")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Authorize in browser (OAuth)" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "API key or token" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "No authentication" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "API key or token" }));
    fireEvent.click(screen.getByRole("button", { name: "Advanced connection settings" }));
    expect(screen.getByLabelText("Auth header")).toBeTruthy();
    expect(screen.getByLabelText("Token prefix")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add header" })).toBeTruthy();
    // Neither the Account pool list nor the paste field has to come first.
    expect(screen.queryByText("Servers in your OpenTag account")).toBeNull();
    expect(screen.queryByLabelText("Configuration")).toBeNull();
  });

  it("carries its own Cancel, submit, and error exactly once", async () => {
    stub([]);
    const create = vi.spyOn(browserApi, "createMcpServer").mockRejectedValue(new ApiError(503, "Create unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    // The draft starts on OAuth, so the single submit control is labelled for that outcome.
    expect(within(dialog).getAllByRole("button", { name: "Add and authorize" })).toHaveLength(1);
    fillManual();
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    expect(within(dialog).getAllByRole("button", { name: "Add server" })).toHaveLength(1);
    submitManual();
    expect(await screen.findByText("Create unavailable")).toBeTruthy();
    expect(screen.getAllByText("Create unavailable")).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("has no Back of its own while the configuration step keeps one", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [detail(1).server] });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: EXISTING_SOURCE }));
    fireEvent.click(await screen.findByRole("button", { name: /linear.*https/ }));
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("starts a fresh draft instead of reusing the Account Server the user just left", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [detail(1).server] });
    wrap(<McpPage agentId={AGENT_ID} />);
    await openAdd();
    fireEvent.click(await screen.findByRole("button", { name: /linear.*https/ }));
    expect(screen.getByText(/Authorize separately for Reviewer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: MANUAL_SOURCE }));
    expect(screen.queryByText(/Authorize separately for Reviewer/)).toBeNull();
    expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("This name is already used in your OpenTag account.")).toBeNull();
  });

  it("keeps the draft when the current source is clicked again", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    fireEvent.change(screen.getByLabelText("MCP URL"), { target: { value: MANUAL_URL } });
    fireEvent.click(screen.getByRole("button", { name: MANUAL_SOURCE }));
    expect((screen.getByLabelText("MCP URL") as HTMLInputElement).value).toBe(MANUAL_URL);
  });

  it("creates, attaches, and authorizes a no-auth manual Server in order", async () => {
    stub([]);
    const writes = stubManualWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    fillManual();
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    submitManual();
    await waitFor(() => expect(writes.auth).toHaveBeenCalledWith(AGENT_ID, detail(0).server.id, { kind: "none" }));
    expect(writes.create).toHaveBeenCalledWith({
      name: MANUAL_NAME,
      url: MANUAL_URL,
      defaultAuthKind: "none",
      extraHeaders: {},
    });
    expect(writes.create.mock.invocationCallOrder[0]).toBeLessThan(writes.attach.mock.invocationCallOrder[0] as number);
    expect(writes.attach.mock.invocationCallOrder[0]).toBeLessThan(writes.auth.mock.invocationCallOrder[0] as number);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("stops a manual API-key Server to collect the credential", async () => {
    stub([]);
    const writes = stubManualWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    fillManual();
    fireEvent.click(screen.getByRole("radio", { name: "API key or token" }));
    expect(manualSubmit().hasAttribute("disabled")).toBe(true);
    expectNothingWritten(writes);
    fireEvent.change(password(), { target: { value: "manual-key" } });
    submitManual();
    await waitFor(() =>
      expect(writes.auth).toHaveBeenCalledWith(AGENT_ID, detail(0).server.id, {
        kind: "bearer",
        bearerKey: "manual-key",
      }),
    );
    expect(writes.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: MANUAL_NAME, defaultAuthKind: "bearer" }),
    );
    expect(writes.attach).toHaveBeenCalledTimes(1);
  });

  it("sends a manual OAuth Server to the authorization server after mounting it", async () => {
    stub([]);
    const writes = stubManualWrites();
    const oauth = vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "OAuth unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    fillManual();
    expect(screen.getByRole("radio", { name: "Authorize in browser (OAuth)" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    submitManual("Add and authorize");
    await waitFor(() => expect(oauth).toHaveBeenCalled());
    expect(await screen.findByText("OAuth unavailable")).toBeTruthy();
    expect(writes.create.mock.invocationCallOrder[0]).toBeLessThan(writes.attach.mock.invocationCallOrder[0] as number);
    expect(writes.attach.mock.invocationCallOrder[0]).toBeLessThan(oauth.mock.invocationCallOrder[0] as number);
  });

  it("blocks an address that is not a usable MCP URL and says why", async () => {
    stub([]);
    const writes = stubManualWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    fireEvent.change(screen.getByLabelText("MCP URL"), {
      target: { value: "https://user:secret@example.com/mcp" },
    });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: MANUAL_NAME } });
    // The field shows its message and announces the same text once.
    expect(screen.getAllByText(/without credentials or a fragment/).length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toContain("without credentials or a fragment");
    expect(manualSubmit("Add and authorize").hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("MCP URL"), { target: { value: MANUAL_URL } });
    expect(screen.queryAllByText(/without credentials or a fragment/)).toHaveLength(0);
    expect(manualSubmit("Add and authorize").hasAttribute("disabled")).toBe(false);
    expectNothingWritten(writes);
  });

  it("blocks a name the account already uses", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockResolvedValue({ servers: [{ ...detail(1).server, name: MANUAL_NAME }] });
    const writes = stubManualWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    fillManual();
    expect(screen.getAllByText("This name is already used in your OpenTag account.").length).toBeGreaterThan(0);
    expect(manualSubmit("Add and authorize").hasAttribute("disabled")).toBe(true);
    expectNothingWritten(writes);
  });

  it("blocks a bearer draft without a credential and a header that repeats the auth header", async () => {
    stub([]);
    const writes = stubManualWrites();
    wrap(<McpPage agentId={AGENT_ID} />);
    await openManual();
    fillManual();
    fireEvent.click(screen.getByRole("radio", { name: "API key or token" }));
    expect(manualSubmit().hasAttribute("disabled")).toBe(true);
    fireEvent.change(password(), { target: { value: "manual-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Advanced connection settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "authorization" } });
    expect(screen.getAllByText(/must not repeat the auth header/).length).toBeGreaterThan(0);
    expect(manualSubmit().hasAttribute("disabled")).toBe(true);
    expectNothingWritten(writes);
  });

  it("keeps the Account pool's paste-a-URL shortcut", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    await newAddress(MANUAL_URL);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("example");
  });

  it("keeps the step's Cancel when the manual source cannot render its form", async () => {
    stub([]);
    vi.mocked(browserApi.mcpServers).mockRejectedValue(new ApiError(503, "Account configurations unavailable"));
    wrap(
      <McpAddDialog
        agentId={AGENT_ID}
        agentName="Reviewer"
        mounted={[]}
        initialSource="manual"
        onClose={() => undefined}
        onAdded={() => undefined}
        onLocate={() => undefined}
      />,
    );
    expect(await screen.findByText("Account configurations unavailable")).toBeTruthy();
    // The form needs the Account read, so it is absent; the step must still be closable from its footer.
    expect(screen.queryByLabelText("MCP URL")).toBeNull();
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  });

  it("defines the manual source label in both catalogues", () => {
    const read = (locale: "en" | "zh") =>
      JSON.parse(readFileSync(resolve(webRoot, "messages", "mcp", `${locale}.json`), "utf8")) as Record<string, string>;
    const en = read("en");
    const zh = read("zh");
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(en.mcp_source_manual).toBe(MANUAL_SOURCE);
    expect(zh.mcp_source_manual).toBe("手动配置");
  });

  it("renders the source label in Chinese", async () => {
    await withLocaleAsync("zh", async () => {
      stub([]);
      wrap(
        <McpAddDialog
          agentId={AGENT_ID}
          agentName="Reviewer"
          mounted={[]}
          onClose={() => undefined}
          onAdded={() => undefined}
          onLocate={() => undefined}
        />,
      );
      expect(await screen.findByRole("button", { name: "手动配置" })).toBeTruthy();
      expect(screen.getByLabelText("MCP 地址")).toBeTruthy();
    });
  });
});
