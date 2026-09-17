import type { MCPAgentServer, MCPServerDetail } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
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
