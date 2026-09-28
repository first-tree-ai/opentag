import type { MCPAgentServer, MCPServerDetail } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, type RenderResult, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { browserApi } from "../../api.js";
import { TooltipProvider } from "../../ui/design-system.js";
export const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
export const OTHER_AGENT_ID = "2b74b32f-a7d8-4585-92fb-5ecbf1677b35";
export const SERVER_ID = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";

export function entry(overrides: Partial<MCPAgentServer> = {}): MCPAgentServer {
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

export function detail(boundAgentCount: number): MCPServerDetail {
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

export function stub(servers: MCPAgentServer[], detailValue: MCPServerDetail = detail(1)) {
  vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
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
  vi.spyOn(browserApi, "mcpServers").mockResolvedValue({ servers: [] });
}

export function wrap(children: ReactNode): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: () => children });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

export async function menuAction(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: "More actions for linear" }));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
export async function openAdd() {
  const buttons = await screen.findAllByRole("button", { name: "Add server" });
  await waitFor(() => {
    if (buttons[0]?.hasAttribute("disabled")) throw new Error("Still loading connections");
  });
  fireEvent.click(buttons[0] as HTMLButtonElement);
  await screen.findByRole("dialog");
}
export async function newAddress(url = "https://mcp.example.com/mcp") {
  await openAdd();
  fireEvent.change(await screen.findByLabelText("MCP URL"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

export function authorization() {
  const auth = entry().authorization;
  if (!auth) throw new Error("Missing fixture authorization");
  return auth;
}

export function snapshot() {
  const value = entry().snapshot;
  if (!value) throw new Error("Missing snapshot fixture");
  return value;
}
