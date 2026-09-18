import type {
  ListAgentMCPServersResponse,
  ListAvailableMCPServersResponse,
  MCPServer,
  MCPServerDetail,
} from "@opentag/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { LIVE_REFETCH_INTERVAL_MS, liveResourceQueryOptions } from "../../query/live.js";

/**
 * Reads and writes for the MCP Agent page.
 *
 * The per-Agent read polls on the ordinary live cadence because an authorization completes out of
 * band: the browser leaves for the authorization server and comes back, and the probe result lands
 * afterwards. Polling the row is what makes the tool count appear without a reload — which is why
 * `probeState` is persisted on the row rather than inferred from a read timestamp.
 */

export function useMcpServers() {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.mcp.servers(),
    queryFn: (): Promise<{ servers: MCPServer[] }> => browserApi.mcpServers(),
  });
}

export function useMcpServerDetail(mcpServerId: string | undefined) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.mcp.server(mcpServerId ?? ""),
    queryFn: (): Promise<MCPServerDetail> => browserApi.mcpServer(mcpServerId as string),
    enabled: mcpServerId !== undefined,
  });
}

export function useAgentMcpServers(agentId: string) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.mcp.agentServers(agentId),
    queryFn: (): Promise<ListAgentMCPServersResponse> => browserApi.agentMcpServers(agentId),
  });
}

export function useAvailableMcpServers(agentId: string, enabled: boolean) {
  return useQuery({
    ...liveResourceQueryOptions,
    queryKey: queryKeys.mcp.availableServers(agentId),
    queryFn: (): Promise<ListAvailableMCPServersResponse> => browserApi.availableMcpServers(agentId),
    enabled,
  });
}

/**
 * Every write invalidates the Agent's own MCP reads and the Account pool: adding, editing, or
 * removing a mount changes both the Agent's view and the definition's aggregate counts. A shared
 * definition edit also invalidates every other Agent that uses it, which the pool invalidation and
 * the live cadence between them cover.
 */
function useMcpInvalidation(agentId: string) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.agentServers(agentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.availableServers(agentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.servers() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.serverRoot() }),
    ]);
  };
}

export function useCreateMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (input: Parameters<typeof browserApi.createMcpServer>[0]) => browserApi.createMcpServer(input),
    onSuccess: invalidate,
  });
}

export function useUpdateMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (input: { mcpServerId: string } & Parameters<typeof browserApi.updateMcpServer>[1]) =>
      browserApi.updateMcpServer(input.mcpServerId, bodyOf(input)),
    onSuccess: invalidate,
  });
}

export function useRemoveMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.removeMcpServer(mcpServerId),
    onSuccess: invalidate,
  });
}

export function useAttachMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.attachMcpServer(agentId, { mcpServerId, enabled: true }),
    onSuccess: invalidate,
  });
}

export function useDetachMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.detachMcpServer(agentId, mcpServerId),
    onSuccess: invalidate,
  });
}

export function useUpdateMcpBinding(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (input: { mcpServerId: string } & Parameters<typeof browserApi.updateAgentMcpServer>[2]) =>
      browserApi.updateAgentMcpServer(agentId, input.mcpServerId, bodyOf(input)),
    onSuccess: invalidate,
  });
}

export function useSetMcpAuthorization(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (input: { mcpServerId: string } & Parameters<typeof browserApi.setMcpAuthorization>[2]) =>
      browserApi.setMcpAuthorization(agentId, input.mcpServerId, bodyOf(input)),
    onSuccess: invalidate,
  });
}

export function useRevokeMcpAuthorization(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.revokeMcpAuthorization(agentId, mcpServerId),
    onSuccess: invalidate,
  });
}

/**
 * Split a mutation input into the routing id and the request body.
 *
 * Each dialog holds one object carrying both, because `mcpServerId` is what the API helper needs for
 * the URL while the rest is the body. Passing that object straight through as the body sends
 * `mcpServerId` too, and every one of these request schemas is `.strict()` — so the Server answered
 * `VALIDATION_ERROR: Unrecognized key "mcpServerId"` on OAuth start, authorization, binding updates,
 * and shared-definition edits alike. TypeScript does not catch it: excess-property checking applies
 * to object literals, and an object built elsewhere is assignable to a narrower type.
 */
function bodyOf<T extends { mcpServerId: string }>(input: T): Omit<T, "mcpServerId"> {
  const { mcpServerId: _mcpServerId, ...body } = input;
  return body;
}

export function useStartMcpOAuth(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (input: { mcpServerId: string } & Parameters<typeof browserApi.startMcpOAuth>[2]) =>
      browserApi.startMcpOAuth(agentId, input.mcpServerId, bodyOf(input)),
    onSuccess: invalidate,
  });
}

export function useProbeMcpServer(agentId: string) {
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: (mcpServerId: string) => browserApi.probeMcpServer(agentId, mcpServerId),
    onSuccess: invalidate,
  });
}

/** The polling cadence, re-exported so a test can assert the page's actual refresh behavior. */
export const MCP_PAGE_REFETCH_INTERVAL_MS = LIVE_REFETCH_INTERVAL_MS;
