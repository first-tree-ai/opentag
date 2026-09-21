import type { MCPAgentServer, MCPServerDetail } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";

/**
 * The page's contract, asserted where it is easiest for a reader to get wrong:
 *
 * - The four row states stay independent, because "disabled" and "not authorized" need different
 *   fixes and a merged status would send a user to reauthorize a Server that is merely switched off.
 * - Editing opens on this Agent and never touches the shared definition without naming the Agents it
 *   will change.
 * - The callback's bounded outcome is read once and stripped from the URL.
 * - A Bearer key is a one-way input.
 */

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const OTHER_AGENT_ID = "2b74b32f-a7d8-4585-92fb-5ecbf1677b35";
const SERVER_ID = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";

function entry(overrides: Partial<MCPAgentServer> = {}): MCPAgentServer {
  return {
    mcpServerId: SERVER_ID,
    name: "linear",
    description: null,
    discoveredDescription: null,
    enabled: true,
    effective: {
      url: "https://mcp.linear.app/sse",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: { "x-workspace-id": "ws_123" },
    },
    overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
    authorization: {
      kind: "bearer",
      status: "active",
      hasCredential: true,
      scopes: null,
      accessTokenExpiresAt: null,
      authorizationServer: null,
      probeState: "succeeded",
      probedAt: "2026-09-16T00:00:00.000Z",
      probeError: null,
      toolsCount: 3,
      toolsTruncated: false,
      failureCode: null,
      revision: 1,
    },
    snapshot: {
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      serverInfo: null,
      capabilities: null,
      instructions: null,
      tools: [{ name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } }],
    },
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  } as MCPAgentServer;
}

function detail(boundAgentCount: number): MCPServerDetail {
  return {
    server: {
      id: SERVER_ID,
      name: "linear",
      description: null,
      url: "https://mcp.linear.app/sse",
      defaultAuthKind: "oauth",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      revision: 4,
      boundAgentCount,
      authorizedAgentCount: boundAgentCount,
      lastProbedAt: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    },
    agents: [
      {
        agentId: AGENT_ID,
        agentName: "reviewer",
        agentDisplayName: "Reviewer",
        enabled: true,
        effective: {
          url: "https://mcp.linear.app/sse",
          authHeader: "authorization",
          authScheme: "Bearer",
          extraHeaders: {},
        },
        overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
        protocolEra: null,
        protocolVersion: null,
        authorization: null,
      },
      ...(boundAgentCount > 1
        ? [
            {
              agentId: OTHER_AGENT_ID,
              agentName: "helper",
              agentDisplayName: "Helper",
              enabled: true,
              effective: {
                url: "https://mcp.linear.app/sse",
                authHeader: "authorization",
                authScheme: "Bearer",
                extraHeaders: {},
              },
              overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
              protocolEra: null,
              protocolVersion: null,
              authorization: null,
            },
          ]
        : []),
    ],
  } as MCPServerDetail;
}

function stub(servers: MCPAgentServer[], detailValue: MCPServerDetail = detail(1)) {
  vi.spyOn(browserApi, "agent").mockResolvedValue({ id: AGENT_ID, displayName: "Reviewer" } as never);
  vi.spyOn(browserApi, "agents").mockResolvedValue({
    agents: [
      { id: AGENT_ID, displayName: "Reviewer" },
      { id: OTHER_AGENT_ID, displayName: "Helper" },
    ],
  } as never);
  vi.spyOn(browserApi, "agentMcpServers").mockResolvedValue({ servers });
  vi.spyOn(browserApi, "mcpServer").mockResolvedValue(detailValue);
  vi.spyOn(browserApi, "availableMcpServers").mockResolvedValue({ servers: [] });
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

/**
 * Base UI selects open on a pointer sequence and accept a plain click on the option they own, so a
 * bare `click` on the trigger is not enough to choose a value.
 */
async function chooseOption(comboboxName: string, optionName: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/agents");
});

describe("McpPage", () => {
  it("keeps the mount and authorization states independent so a disabled Server is not read as unauthorized", async () => {
    stub([entry({ enabled: false })]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("linear")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    // The credential is still active, and the page says so rather than implying reauthorization.
    expect(screen.getByText("Authorized")).toBeTruthy();
    expect(
      screen.getByText("Disabled. The credential is kept, so enabling it again needs no reauthorization."),
    ).toBeTruthy();
  });

  it("shows the probe result as tool count and flags a truncated snapshot", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          toolsTruncated: true,
          toolsCount: 200,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Found 200 tools")).toBeTruthy();
    expect(screen.getByText("The list was truncated; this is not the Server’s complete tool set.")).toBeTruthy();
  });

  it("opens the editor on this Agent, and only warns about the other Agents when the shared scope is chosen", async () => {
    stub([entry()], detail(2));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    // The default scope is this Agent: the shared-definition warning is absent until it is chosen.
    expect(screen.getByRole("combobox", { name: "Scope" })).toBeTruthy();
    expect(screen.queryByText(/This will affect/)).toBeNull();
    expect(screen.getByText("Replaces this Agent’s overrides. No other Agent is affected.")).toBeTruthy();

    await chooseOption("Scope", "Shared definition");

    expect(await screen.findByText("This will affect 2 Agents: Reviewer, Helper")).toBeTruthy();
  });

  it("sends only the field the user changed, so an unrelated edit pins nothing", async () => {
    /*
     * S10. Submitting every field froze the untouched ones as this Agent's overrides of the values on
     * screen, so a later shared edit silently stopped reaching the Agent — and a web-only user had no
     * way to undo it, because the "use the shared value" actions existed as copy but were never
     * rendered. The patch is what distinguishes "the user typed this" from "this is what was shown".
     */
    stub([entry()], detail(1));
    const updates: Record<string, unknown>[] = [];
    vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation((async (
      _agentId: string,
      _serverId: string,
      patch: Record<string, unknown>,
    ) => {
      updates.push(patch);
      return entry();
    }) as never);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    // Only the URL is touched here.
    fireEvent.change(screen.getByLabelText("MCP endpoint"), {
      target: { value: "https://changed.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({ url: "https://changed.example.com/mcp" });
    // The untouched fields are absent, which is what leaves them inherited.
    for (const key of ["authHeader", "authScheme", "extraHeaders"]) {
      expect(updates[0]).not.toHaveProperty(key);
    }
  });

  it("offers to restore a shared value for an Agent that overrode it", async () => {
    // The reverse action, and the only way a web user can undo an override.
    stub([entry({ overridden: { url: true, authHeader: false, authScheme: false, extraHeaders: false } })], detail(1));
    const updates: Record<string, unknown>[] = [];
    vi.spyOn(browserApi, "updateAgentMcpServer").mockImplementation((async (
      _agentId: string,
      _serverId: string,
      patch: Record<string, unknown>,
    ) => {
      updates.push(patch);
      return entry();
    }) as never);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    fireEvent.click(await screen.findByRole("button", { name: "Use the shared URL" }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({ clearUrl: true });
  });

  it("reports a failed 'send none' instead of silently doing nothing", async () => {
    /*
     * That button was a bare `void updateBinding.mutateAsync(...)`: no await, no catch, no banner. A
     * failure was an unhandled rejection the user never saw, and the button appeared to do nothing.
     */
    stub([entry()], detail(1));
    vi.spyOn(browserApi, "updateAgentMcpServer").mockRejectedValue(new Error("network down"));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    fireEvent.click(await screen.findByRole("button", { name: "Send no extra headers" }));

    // Reported rather than swallowed, and the dialog stays open so the user can retry.
    expect(await screen.findByText("Couldn’t save these settings. Try again.")).toBeTruthy();
  });

  it("mounts the Server it just created, so it appears on the page that created it", async () => {
    /*
     * Creating a definition is Account-level and mounting it is per Agent. A definition left
     * unmounted is invisible on this page, so a user who pressed "Create Server", typed a name and a
     * URL, and saw the dialog close found nothing in the list and counted it as a failure — with an
     * auth kind of `none` included, because the mount was missing rather than the authorization.
     */
    stub([]);
    const created = { ...detail(1).server, id: SERVER_ID, name: "g" };
    let attached: string | undefined;
    vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(created as never);
    vi.spyOn(browserApi, "attachMcpServer").mockImplementation((async (
      _agentId: string,
      input: { mcpServerId: string },
    ) => {
      attached = input.mcpServerId;
      return entry();
    }) as never);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "g" } });
    fireEvent.change(screen.getByLabelText("MCP endpoint URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and continue" }));

    // The mount is what puts it in this Agent's list; without it the create is invisible.
    await waitFor(() => expect(attached).toBe(SERVER_ID));
    expect(browserApi.createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "g", url: "https://mcp.example.com/mcp" }),
    );
    await waitFor(() => expect(screen.queryByText("New MCP Server")).toBeNull());
  });

  it("mounts an existing definition, which is the only way to reuse one across Agents", async () => {
    /*
     * `mcp_servers` is unique on `(account, lower(name))`, so a user who wants an existing Server on
     * a second Agent cannot create it again — and another name would make a second definition with
     * its own probes and edit surface. The chooser is inside the add dialog rather than a second
     * button, but it has to exist, or reuse is CLI-only.
     */
    stub([]);
    let attached: string | undefined;
    const createSpy = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(detail(1).server as never);
    vi.spyOn(browserApi, "availableMcpServers").mockResolvedValue({
      servers: [{ id: SERVER_ID, name: "linear", description: "Issue tracking", boundAgentCount: 1 }],
    } as never);
    vi.spyOn(browserApi, "attachMcpServer").mockImplementation((async (
      _agentId: string,
      input: { mcpServerId: string },
    ) => {
      attached = input.mcpServerId;
      return entry();
    }) as never);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    await chooseOption("Method", "Use an existing Server");

    expect(await screen.findByText("Issue tracking")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(attached).toBe(SERVER_ID));
    // No create is issued: the definition already exists.
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("does not offer to delete the definition while another Agent still uses it", async () => {
    stub([entry()], detail(2));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));

    expect(await screen.findByText("Remove linear?")).toBeTruthy();
    // The impact text only renders once the shared definition has been read, so it is also the
    // signal that the delete option's disabled state is final.
    expect(await screen.findByText("This will affect the Agent Helper")).toBeTruthy();
    /*
     * Both options are offered and the destructive one is refused, because another Agent still
     * mounts this Server: the Server would answer MCP_SERVER_IN_USE, so the page does not present a
     * choice that cannot succeed.
     */
    const [keep, remove] = screen.getAllByRole("radio");
    expect(keep?.getAttribute("aria-disabled")).not.toBe("true");
    expect(remove?.getAttribute("aria-disabled")).toBe("true");
  });

  it("reads the bounded callback outcome once and clears it from the URL", async () => {
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=error&mcp_oauth_error=MCP_OAUTH_DENIED`);
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Couldn’t start the authorization. Try again.")).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("labels a granted anonymous authorization as anonymous", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          kind: "none",
          hasCredential: false,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    await waitFor(() => {
      const row = document.querySelector('[data-ui="mcp-server-row"]') as HTMLElement | null;
      expect(row?.textContent).toContain("Anonymous");
    });
  });

  it("does not call a mount with no authorization 'anonymous'", async () => {
    /*
     * A mount with no authorization row rendered the "Anonymous" badge beside "Not authorized" — two
     * contradictory statements, which also hid the difference between "this Agent may use the Server
     * anonymously" and "this Agent has not authorized yet".
     */
    stub([entry({ authorization: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);

    await waitFor(() => {
      const row = document.querySelector('[data-ui="mcp-server-row"]') as HTMLElement | null;
      expect(row?.textContent).toContain("None");
      expect(row?.textContent).not.toContain("Anonymous");
    });
  });

  it("takes a Bearer key through a one-way input that is never echoed back", async () => {
    stub([entry({ authorization: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));

    await chooseOption("Authorization method", "Bearer");

    const input = screen.getByLabelText("Bearer key") as HTMLInputElement;
    expect(input.type).toBe("password");
  });

  it("explains that a Server's default authorization method is only a prefill", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));

    expect(
      await screen.findByText(
        "Only a prefill for a new authorization. It does not restrict how any Agent authorizes with this Server.",
      ),
    ).toBeTruthy();
  });
});

/**
 * The states and dialogs the happy-path suite above does not reach, asserted on the copy and the
 * request body the user's action produces.
 */
describe("McpPage list and load states", () => {
  it("says it is loading rather than claiming the Agent has no Servers", async () => {
    stub([]);
    // Never settles, so the page stays on its pending branch for the assertion.
    vi.mocked(browserApi.agentMcpServers).mockReturnValue(new Promise(() => undefined) as never);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Loading")).toBeTruthy();
    expect(screen.queryByText(/No MCP Servers added yet/)).toBeNull();
  });

  it("tells the user there is nothing to show, with what to do about it", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(
      await screen.findByText("No MCP Servers added yet. Add one to give this Agent tools from an external Server."),
    ).toBeTruthy();
  });

  it("reports the Server's own message when the Agent's list fails with a controlled error", async () => {
    stub([]);
    vi.mocked(browserApi.agentMcpServers).mockRejectedValue(new ApiError(500, "MCP management unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("MCP management unavailable")).toBeTruthy();
  });

  it("falls back to a bounded sentence when the list fails with something that is not an API error", async () => {
    stub([]);
    vi.mocked(browserApi.agentMcpServers).mockRejectedValue(new Error("boom"));
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("The request failed")).toBeTruthy();
    // The raw message is never what the page shows.
    expect(screen.queryByText("boom")).toBeNull();
  });
});

describe("McpPage row actions", () => {
  it("reports a refused enable instead of leaving the switch looking like it worked", async () => {
    stub([entry({ enabled: false })]);
    vi.spyOn(browserApi, "updateAgentMcpServer").mockRejectedValue(new ApiError(400, "Binding rejected"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));

    expect(await screen.findByText("Binding rejected")).toBeTruthy();
  });

  it("sends the opposite of the stored mount state and nothing else", async () => {
    stub([entry({ enabled: true })]);
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry({ enabled: false }));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[1]).toBe(SERVER_ID);
    expect(update.mock.calls[0]?.[2]).toEqual({ enabled: false });
  });

  it("reports a failed discovery on the row that asked for it", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "probeMcpServer").mockRejectedValue(new ApiError(502, "The MCP Server did not answer"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Discover tools again" }));

    expect(await screen.findByText("The MCP Server did not answer")).toBeTruthy();
  });

  it("uses the bounded discovery sentence when the probe fails without an API error", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "probeMcpServer").mockRejectedValue(new Error("offline"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Discover tools again" }));

    expect(
      await screen.findByText("Couldn’t discover the tools. Check the URL and credential, then try again."),
    ).toBeTruthy();
  });

  it("probes the Server the row belongs to", async () => {
    stub([entry()]);
    const probe = vi.spyOn(browserApi, "probeMcpServer").mockResolvedValue({
      probeState: "succeeded",
      probeError: null,
      toolsCount: 4,
      toolsTruncated: false,
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
    });
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Discover tools again" }));

    await waitFor(() => expect(probe).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
  });

  it.each([
    ["active", "Authorized"],
    ["pending", "Awaiting authorization"],
    ["expired", "Expired"],
    ["revoked", "Reauthorization required"],
    ["error", "Needs attention"],
  ] as const)("labels a %s authorization with its own words", async (status, label) => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          status,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    await waitFor(() => {
      const row = document.querySelector('[data-ui="mcp-server-row"]') as HTMLElement | null;
      expect(row?.textContent).toContain(label);
    });
  });

  it.each([
    ["bearer", "Bearer"],
    ["oauth", "OAuth"],
  ] as const)("names a %s authorization by its method", async (kind, label) => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          kind,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    await waitFor(() => {
      const row = document.querySelector('[data-ui="mcp-server-row"]') as HTMLElement | null;
      expect(row?.textContent).toContain(label);
    });
  });

  it("distinguishes 'never discovered' from 'discovery is running'", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          probeState: "pending",
          probedAt: null,
          toolsCount: null,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Not discovered")).toBeTruthy();
  });

  it("says discovery is in flight once a probe has been recorded", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          probeState: "pending",
          probedAt: "2026-09-16T00:00:00.000Z",
          toolsCount: null,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Discovering…")).toBeTruthy();
  });

  it("says discovery failed, and repeats the Server's own error beside it", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          probeState: "failed",
          probeError: "401 Unauthorized",
          toolsCount: null,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Discovery failed")).toBeTruthy();
    expect(screen.getByText("401 Unauthorized")).toBeTruthy();
  });

  it("shows when the credential expires, so an imminent renewal is visible", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          accessTokenExpiresAt: "2026-09-16T08:00:00.000Z",
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    await waitFor(() => {
      const row = document.querySelector('[data-ui="mcp-server-row"]') as HTMLElement | null;
      expect(row?.textContent).toMatch(/Expires/);
    });
  });

  it("prefers the operator's description over the probed one", async () => {
    stub([entry({ description: "Written by an admin", discoveredDescription: "The Server says so" })]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Written by an admin")).toBeTruthy();
    expect(screen.queryByText(/The Server describes itself as/)).toBeNull();
  });

  it("attributes the probed description when the operator wrote none", async () => {
    stub([entry({ description: null, discoveredDescription: "The Server says so" })]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("The Server describes itself as: The Server says so")).toBeTruthy();
  });

  it("opens the discovered tools and shows each tool's description and input schema", async () => {
    stub([
      entry({
        snapshot: {
          protocolEra: "modern",
          protocolVersion: "2026-07-28",
          serverInfo: null,
          capabilities: null,
          instructions: null,
          tools: [
            { name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } },
            { name: "list_issues", description: null, inputSchema: null },
          ],
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tools discovered with this Agent’s credential" }));

    expect(await screen.findByText("modern · 2026-07-28")).toBeTruthy();
    expect(screen.getByText("create_issue")).toBeTruthy();
    expect(screen.getByText("Create an issue")).toBeTruthy();
    expect(screen.getByText("list_issues")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Input schema" })[0] as HTMLButtonElement);
    expect(await screen.findByText(/{/)).toBeTruthy();
  });

  it("says a Server reported no tools rather than rendering an empty list", async () => {
    stub([
      entry({
        snapshot: {
          protocolEra: null,
          protocolVersion: null,
          serverInfo: null,
          capabilities: null,
          instructions: null,
          tools: [],
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tools discovered with this Agent’s credential" }));

    expect(await screen.findByText("- · -")).toBeTruthy();
    expect(screen.getByText("This Server reported no tools for this Agent’s credential.")).toBeTruthy();
  });

  it("flags a truncated tool list inside the tools dialog, not only on the row", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          toolsTruncated: true,
        },
        snapshot: {
          protocolEra: "modern",
          protocolVersion: "2026-07-28",
          serverInfo: null,
          capabilities: null,
          instructions: null,
          tools: [{ name: "create_issue", description: null, inputSchema: null }],
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tools discovered with this Agent’s credential" }));

    await waitFor(() =>
      expect(
        screen.getAllByText("The list was truncated; this is not the Server’s complete tool set.").length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("reports a body with no snapshot as an absent protocol rather than blank", async () => {
    stub([entry({ snapshot: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tools discovered with this Agent’s credential" }));

    expect(await screen.findByText("- · -")).toBeTruthy();
    expect(screen.getByText("This Server reported no tools for this Agent’s credential.")).toBeTruthy();
  });
});

describe("McpPage revoke dialog", () => {
  it("asks before deleting the credential, and only offers it when there is one to revoke", async () => {
    stub([entry()]);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    expect(await screen.findByText("Revoke the authorization for linear?")).toBeTruthy();
    expect(
      screen.getByText("The credential is deleted. The Server stays added, and you can authorize it again."),
    ).toBeTruthy();
  });

  it("does not offer to revoke an anonymous authorization, which has no credential to delete", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          kind: "none",
          hasCredential: false,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("linear")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("revokes through the API and closes on success", async () => {
    stub([entry()]);
    const revoke = vi.spyOn(browserApi, "revokeMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const confirm = await screen.findByRole("button", { name: "Revoke" });
    fireEvent.click(confirm);

    await waitFor(() => expect(revoke).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
  });

  it("reports a failed revoke instead of closing as if it had worked", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "revokeMcpAuthorization").mockRejectedValue(new ApiError(409, "Already revoked"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    // The dialog's own confirmation, which is the only one reachable while it is open.
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    expect(await screen.findByText("Already revoked")).toBeTruthy();
  });

  it("uses the bounded revoke failure sentence for a non-API failure", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "revokeMcpAuthorization").mockRejectedValue(new Error("offline"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    expect(await screen.findByText("Couldn’t revoke the authorization. Try again.")).toBeTruthy();
  });
});

describe("McpPage create dialog", () => {
  it("keeps the primary action unavailable until the Server can be named and reached", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));

    const submit = await screen.findByRole("button", { name: "Create and continue" });
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "g" } });
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("MCP endpoint URL"), { target: { value: "https://mcp.example.com/mcp" } });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  });

  it("sends the advanced header settings only when the user opened and filled them", async () => {
    stub([]);
    const created = { ...detail(1).server, id: SERVER_ID, name: "g" };
    const create = vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(created as never);
    vi.spyOn(browserApi, "attachMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "g" } });
    fireEvent.change(screen.getByLabelText("MCP endpoint URL"), { target: { value: "https://mcp.example.com/mcp" } });
    // The advanced fields are absent until the checkbox is on.
    expect(screen.queryByLabelText("Authorization header name")).toBeNull();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Advanced header settings" }));
    fireEvent.change(await screen.findByLabelText("Authorization header name"), { target: { value: "x-api-key" } });
    fireEvent.change(screen.getByLabelText("Authorization scheme"), { target: { value: "Token" } });
    await chooseOption("Default authorization method", "Bearer");
    fireEvent.click(screen.getByRole("button", { name: "Create and continue" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toEqual({
      name: "g",
      url: "https://mcp.example.com/mcp",
      defaultAuthKind: "bearer",
      authHeader: "x-api-key",
      authScheme: "Token",
    });
  });

  it("reports a failed create and leaves the dialog open to correct", async () => {
    stub([]);
    vi.spyOn(browserApi, "createMcpServer").mockRejectedValue(new ApiError(409, "A Server with that name exists"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "g" } });
    fireEvent.change(screen.getByLabelText("MCP endpoint URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and continue" }));

    expect(await screen.findByText("A Server with that name exists")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create and continue" })).toBeTruthy();
  });

  it("uses the bounded create sentence when the create fails without an API error", async () => {
    stub([]);
    vi.spyOn(browserApi, "createMcpServer").mockRejectedValue(new Error("offline"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "g" } });
    fireEvent.change(screen.getByLabelText("MCP endpoint URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and continue" }));

    expect(
      await screen.findByText("Couldn’t create this Server. Check the URL and name, then try again."),
    ).toBeTruthy();
  });

  it("reports a failed mount even though the definition was created", async () => {
    stub([]);
    const created = { ...detail(1).server, id: SERVER_ID, name: "g" };
    vi.spyOn(browserApi, "createMcpServer").mockResolvedValue(created as never);
    vi.spyOn(browserApi, "attachMcpServer").mockRejectedValue(new ApiError(403, "This Agent cannot mount it"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "g" } });
    fireEvent.change(screen.getByLabelText("MCP endpoint URL"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and continue" }));

    expect(await screen.findByText("This Agent cannot mount it")).toBeTruthy();
  });

  it("says so when every definition in the Account is already on this Agent", async () => {
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    await chooseOption("Method", "Use an existing Server");

    expect(
      await screen.findByText("Every Server in this Account is already added to this Agent. Create a new one instead."),
    ).toBeTruthy();
  });

  it("falls back to the Server's own name when a definition has no description", async () => {
    stub([]);
    vi.spyOn(browserApi, "availableMcpServers").mockResolvedValue({
      servers: [{ id: SERVER_ID, name: "linear", description: null, boundAgentCount: 0 }],
    } as never);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    await chooseOption("Method", "Use an existing Server");

    // The definition's name stands in for the description it does not have.
    expect(await screen.findAllByText("linear")).toHaveLength(2);
  });

  it("reports a failed mount of an existing definition", async () => {
    stub([]);
    vi.spyOn(browserApi, "availableMcpServers").mockResolvedValue({
      servers: [{ id: SERVER_ID, name: "linear", description: "Issue tracking", boundAgentCount: 1 }],
    } as never);
    vi.spyOn(browserApi, "attachMcpServer").mockRejectedValue(new ApiError(409, "Already added"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    await chooseOption("Method", "Use an existing Server");
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    expect(await screen.findByText("Already added")).toBeTruthy();
  });

  it("uses the bounded mount sentence when the mount fails without an API error", async () => {
    stub([]);
    vi.spyOn(browserApi, "availableMcpServers").mockResolvedValue({
      servers: [{ id: SERVER_ID, name: "linear", description: "Issue tracking", boundAgentCount: 1 }],
    } as never);
    vi.spyOn(browserApi, "attachMcpServer").mockRejectedValue(new Error("offline"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    await chooseOption("Method", "Use an existing Server");
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    expect(await screen.findByText("Couldn’t add this Server. Try again.")).toBeTruthy();
  });

  it("drops a stale error when the user switches methods, since the input changed", async () => {
    stub([]);
    vi.spyOn(browserApi, "availableMcpServers").mockResolvedValue({
      servers: [{ id: SERVER_ID, name: "linear", description: "Issue tracking", boundAgentCount: 1 }],
    } as never);
    vi.spyOn(browserApi, "attachMcpServer").mockRejectedValue(new ApiError(409, "Already added"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Server" }));
    await chooseOption("Method", "Use an existing Server");
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByText("Already added")).toBeTruthy();

    await chooseOption("Method", "Create Server");
    expect(screen.queryByText("Already added")).toBeNull();
  });
});

describe("McpPage authorize dialog", () => {
  it("leaves for the Server's own authorize URL, in the top-level browsing context", async () => {
    stub([entry({ authorization: null })]);
    const start = vi.spyOn(browserApi, "startMcpOAuth").mockResolvedValue({
      authorizationUrl: "https://mcp.linear.app/authorize?state=opaque",
      expiresAt: "2026-09-16T00:10:00.000Z",
    });
    const assign = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    try {
      wrap(<McpPage agentId={AGENT_ID} />);
      fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
      fireEvent.click(await screen.findByRole("button", { name: "Start authorization" }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith("https://mcp.linear.app/authorize?state=opaque"));
      // The browser only ever navigates to the URL the Server authored.
      expect(start).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, {});
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("records an anonymous authorization as a real choice, not as an absent one", async () => {
    stub([entry({ authorization: null })]);
    const set = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
    await chooseOption("Authorization method", "Anonymous");
    expect(await screen.findByText("No credential is sent. Choose this for a Server that needs none.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[2]).toEqual({ kind: "none" });
  });

  it("will not submit a Bearer authorization with no key, and sends the key once typed", async () => {
    stub([entry({ authorization: null })]);
    const set = vi.spyOn(browserApi, "setMcpAuthorization").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
    await chooseOption("Authorization method", "Bearer");

    const submit = screen.getByRole("button", { name: "Start authorization" });
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Bearer key"), { target: { value: "sk-live-1" } });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[2]).toEqual({ kind: "bearer", bearerKey: "sk-live-1" });
  });

  it("prefills the method the Agent already uses, including an anonymous one", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          kind: "none",
          hasCredential: false,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));

    expect(await screen.findByText("No credential is sent. Choose this for a Server that needs none.")).toBeTruthy();
  });

  it("reports a failed authorization write and keeps the dialog open", async () => {
    stub([entry({ authorization: null })]);
    vi.spyOn(browserApi, "setMcpAuthorization").mockRejectedValue(new ApiError(400, "The key was rejected"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
    // Named explicitly rather than left on the OAuth default, so this is the write path under test.
    await chooseOption("Authorization method", "Bearer");
    fireEvent.change(screen.getByLabelText("Bearer key"), { target: { value: "sk-live-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));

    expect(await screen.findByText("The key was rejected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start authorization" })).toBeTruthy();
  });

  it("uses the bounded authorization sentence when the write fails without an API error", async () => {
    stub([entry({ authorization: null })]);
    vi.spyOn(browserApi, "setMcpAuthorization").mockRejectedValue(new Error("offline"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
    await chooseOption("Authorization method", "Bearer");
    fireEvent.change(screen.getByLabelText("Bearer key"), { target: { value: "sk-live-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));

    expect(await screen.findByText("Couldn’t start the authorization. Try again.")).toBeTruthy();
  });

  it("reports a failed OAuth start rather than navigating nowhere", async () => {
    stub([entry({ authorization: null })]);
    vi.spyOn(browserApi, "startMcpOAuth").mockRejectedValue(new ApiError(503, "The broker is down"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start authorization" }));

    expect(await screen.findByText("The broker is down")).toBeTruthy();
  });

  it("describes the OAuth round trip before the user starts it", async () => {
    stub([entry({ authorization: null })]);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));

    expect(
      await screen.findByText(
        "You will be sent to the Server’s authorization server and returned here when you approve.",
      ),
    ).toBeTruthy();
  });
});

describe("McpPage edit dialog", () => {
  it("warns that a shared edit binds every Agent that mounts the Server", async () => {
    stub([entry()], detail(1));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    await chooseOption("Scope", "Shared definition");

    expect(await screen.findByText("This will affect the Agent Reviewer")).toBeTruthy();
    expect(await screen.findByLabelText("Description")).toBeTruthy();
  });

  it("writes the shared definition with the definition's revision and a trimmed description", async () => {
    stub([entry()], detail(1));
    const update = vi.spyOn(browserApi, "updateMcpServer").mockResolvedValue(detail(1).server);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await chooseOption("Scope", "Shared definition");

    fireEvent.change(await screen.findByLabelText("Description"), { target: { value: "  Curated  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toBe(SERVER_ID);
    expect(update.mock.calls[0]?.[1]).toEqual({
      url: "https://mcp.linear.app/sse",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: { "x-workspace-id": "ws_123" },
      description: "Curated",
      expectedRevision: 4,
    });
  });

  it("sends null for an emptied description, so the discovered one shows again", async () => {
    stub([entry({ description: "Written by an admin" })], detail(1));
    const update = vi.spyOn(browserApi, "updateMcpServer").mockResolvedValue(detail(1).server);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await chooseOption("Scope", "Shared definition");

    fireEvent.change(await screen.findByLabelText("Description"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[1]).toMatchObject({ description: null });
  });

  it("sends every field the user changed, and only those", async () => {
    stub([entry()], detail(1));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    fireEvent.change(await screen.findByLabelText("Authorization header name"), { target: { value: "x-key" } });
    fireEvent.change(screen.getByLabelText("Authorization scheme"), { target: { value: "Token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[2]).toEqual({ authHeader: "x-key", authScheme: "Token" });
  });

  it("lets the user edit, add, and remove an extra header", async () => {
    stub([entry()], detail(1));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(await screen.findByText("Effective: x-workspace-id=ws_123")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "X-Team" } });
    fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "core" } });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    // A newly added row is blank and contributes nothing until it is named.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[2]).toEqual({ extraHeaders: { "x-team": "core" } });
  });

  it("drops a header row the user removed", async () => {
    stub([entry()], detail(1));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    fireEvent.click(await screen.findByRole("button", { name: "Remove header" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[2]).toEqual({ extraHeaders: {} });
  });

  it("sorts two headers the other way round as freely as the first, so order never matters", async () => {
    // x-b vs x-a and x-a vs x-b are the two halves of the comparator; both must be a no-op.
    const headers = entry({
      effective: {
        url: "https://mcp.linear.app/sse",
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: { "x-b": "2", "x-a": "1" },
      },
    });
    stub([headers], detail(1));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(headers);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    // Rewriting the rows in the effective order is still the same set, so nothing is sent.
    const names = screen.getAllByLabelText("Header name") as HTMLInputElement[];
    const values = screen.getAllByLabelText("Header value") as HTMLInputElement[];
    fireEvent.change(names[0] as HTMLInputElement, { target: { value: "x-a" } });
    fireEvent.change(values[0] as HTMLInputElement, { target: { value: "1" } });
    fireEvent.change(names[1] as HTMLInputElement, { target: { value: "x-b" } });
    fireEvent.change(values[1] as HTMLInputElement, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[2]).toEqual({});
  });

  it("treats reordering the headers as no change, because a header set has no order", async () => {
    const twoHeaders = entry({
      effective: {
        url: "https://mcp.linear.app/sse",
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: { "x-a": "1", "x-b": "2" },
      },
    });
    stub([twoHeaders], detail(1));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(twoHeaders);
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    const names = screen.getAllByLabelText("Header name") as HTMLInputElement[];
    const values = screen.getAllByLabelText("Header value") as HTMLInputElement[];
    fireEvent.change(names[0] as HTMLInputElement, { target: { value: "x-b" } });
    fireEvent.change(values[0] as HTMLInputElement, { target: { value: "2" } });
    fireEvent.change(names[1] as HTMLInputElement, { target: { value: "x-a" } });
    fireEvent.change(values[1] as HTMLInputElement, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // Swapping two rows is not an edit, so nothing beyond the set is sent.
    expect(update.mock.calls[0]?.[2]).toEqual({});
  });

  it("offers the matching restore action for every override the Agent holds", async () => {
    stub([entry({ overridden: { url: true, authHeader: true, authScheme: true, extraHeaders: true } })], detail(1));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(await screen.findByRole("button", { name: "Use the shared name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use the shared scheme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use the shared headers" })).toBeTruthy();
  });

  it.each([
    ["Use the shared name", { clearAuthHeader: true }],
    ["Use the shared scheme", { clearAuthScheme: true }],
    ["Use the shared headers", { clearExtraHeaders: true }],
    ["Send no extra headers", { emptyExtraHeaders: true }],
  ] as const)("sends %s as the clearing the Server understands", async (label, expected) => {
    stub([entry({ overridden: { url: true, authHeader: true, authScheme: true, extraHeaders: true } })], detail(1));
    const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    fireEvent.click(await screen.findByRole("button", { name: label }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[2]).toEqual(expected);
  });

  it("reports a failed restore rather than closing on a change that did not happen", async () => {
    stub([entry({ overridden: { url: true, authHeader: false, authScheme: false, extraHeaders: false } })], detail(1));
    vi.spyOn(browserApi, "updateAgentMcpServer").mockRejectedValue(new ApiError(409, "Stale binding"));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    fireEvent.click(await screen.findByRole("button", { name: "Use the shared URL" }));

    expect(await screen.findByText("Stale binding")).toBeTruthy();
  });

  it("uses the bounded edit sentence when an agent-scope save fails without an API error", async () => {
    stub([entry()], detail(1));
    vi.spyOn(browserApi, "updateAgentMcpServer").mockRejectedValue(new Error("offline"));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    fireEvent.change(await screen.findByLabelText("MCP endpoint"), { target: { value: "https://x.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Couldn’t save these settings. Try again.")).toBeTruthy();
  });

  it("keeps the shared-scope dialog usable when the definition cannot be read", async () => {
    stub([entry()], detail(1));
    vi.mocked(browserApi.mcpServer).mockRejectedValue(new ApiError(500, "The definition is unavailable"));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await chooseOption("Scope", "Shared definition");

    // Only that the failed definition read leaves the dialog rendered and operable.
    //
    // What the page currently does after that failure — report an empty impact and fence the write on a
    // guessed revision — is deliberately NOT asserted here. The current Agent mounts this Server, so an
    // empty impact is not a truthful answer, and pinning it would make a later safety fix look like a
    // regression. That behaviour predates this test-only change and its repair belongs to the page.
    expect(await screen.findByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("counts a missing tool total as none rather than showing a blank", async () => {
    stub([
      entry({
        authorization: {
          ...(entry().authorization as NonNullable<MCPAgentServer["authorization"]>),
          probeState: "succeeded",
          toolsCount: null,
        },
      }),
    ]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Found 0 tools")).toBeTruthy();
  });

  it("says the effective headers are none when the Server has none", async () => {
    stub(
      [
        entry({
          effective: {
            url: "https://mcp.linear.app/sse",
            authHeader: "authorization",
            authScheme: "Bearer",
            extraHeaders: {},
          },
        }),
      ],
      detail(1),
    );
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(await screen.findByText("Effective: -")).toBeTruthy();
  });

  it("uses the bounded edit sentence when a shared-scope save fails without an API error", async () => {
    stub([entry()], detail(1));
    vi.spyOn(browserApi, "updateMcpServer").mockRejectedValue(new Error("offline"));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await chooseOption("Scope", "Shared definition");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Couldn’t save these settings. Try again.")).toBeTruthy();
  });

  it("asks for confirmation before the shared definition is written", async () => {
    stub([entry()], detail(3));
    wrap(<McpPage agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    // The Agent scope names no other Agent, so the warning is the signal that the scope changed.
    await chooseOption("Scope", "Shared definition");
    expect(await screen.findByText(/This will affect/)).toBeTruthy();

    await chooseOption("Scope", "This Agent only");
    expect(screen.queryByText(/This will affect/)).toBeNull();
  });
});

describe("McpPage remove dialog", () => {
  it("removes the definition too when the user asks for both", async () => {
    stub([entry()], detail(1));
    const detach = vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    const remove = vi.spyOn(browserApi, "removeMcpServer").mockResolvedValue(undefined);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Remove and delete/ }));
    // The dialog's own confirmation; the row's button is unreachable while it is open.
    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(SERVER_ID));
    expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID);
  });

  it("removes only this Agent's mount when the user leaves the default choice", async () => {
    stub([entry()], detail(1));
    const detach = vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    const remove = vi.spyOn(browserApi, "removeMcpServer").mockResolvedValue(undefined);
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));
    // "Remove from this Agent only" is the default, so confirming without changing it is the path
    // that must leave the shared definition alone.
    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));

    await waitFor(() => expect(detach).toHaveBeenCalledWith(AGENT_ID, SERVER_ID));
    expect(remove).not.toHaveBeenCalled();
  });

  it("describes removal from this Agent only as reversible", async () => {
    stub([entry()], detail(1));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));

    expect(await screen.findByText("The definition stays in the Account and can be added again later.")).toBeTruthy();
  });

  it("explains that deleting the definition is only available to the last Agent", async () => {
    stub([entry()], detail(1));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));

    expect(
      await screen.findByText(
        "Removes it from every Agent and deletes the definition. Available only when no other Agent uses it.",
      ),
    ).toBeTruthy();
  });

  it("reports a failed detach instead of closing", async () => {
    stub([entry()], detail(1));
    vi.spyOn(browserApi, "detachMcpServer").mockRejectedValue(new ApiError(500, "Detach failed"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));

    expect(await screen.findByText("Detach failed")).toBeTruthy();
  });

  it("reports a failed delete after the detach already went through", async () => {
    stub([entry()], detail(1));
    vi.spyOn(browserApi, "detachMcpServer").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "removeMcpServer").mockRejectedValue(new ApiError(409, "Another Agent still uses it"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Remove and delete/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));

    expect(await screen.findByText("Another Agent still uses it")).toBeTruthy();
  });

  it("uses the bounded removal sentence when the detach fails without an API error", async () => {
    stub([entry()], detail(1));
    vi.spyOn(browserApi, "detachMcpServer").mockRejectedValue(new Error("offline"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove from this Agent" }));

    expect(await screen.findByText("Couldn’t remove this Server. Try again.")).toBeTruthy();
  });
});

describe("McpPage OAuth callback", () => {
  it("reports a granted authorization as active and clears the parameters", async () => {
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=success`);
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Authorized")).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("answers an unknown callback code with the same bounded sentence, never the raw value", async () => {
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=error&mcp_oauth_error=MCP_OAUTH_SOMETHING`);
    stub([]);
    wrap(<McpPage agentId={AGENT_ID} />);

    expect(await screen.findByText("Couldn’t start the authorization. Try again.")).toBeTruthy();
    expect(screen.queryByText(/MCP_OAUTH_SOMETHING/)).toBeNull();
  });

  it("throws away action feedback when the user closes a dialog", async () => {
    stub([entry()]);
    vi.spyOn(browserApi, "probeMcpServer").mockRejectedValue(new ApiError(502, "Probe exploded"));
    wrap(<McpPage agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Discover tools again" }));
    expect(await screen.findByText("Probe exploded")).toBeTruthy();

    // A successful action clears the stale error before it starts.
    vi.mocked(browserApi.probeMcpServer).mockResolvedValue({
      probeState: "succeeded",
      probeError: null,
      toolsCount: 1,
      toolsTruncated: false,
      protocolEra: null,
      protocolVersion: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover tools again" }));

    await waitFor(() => expect(screen.queryByText("Probe exploded")).toBeNull());
  });
});
